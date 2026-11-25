import { createHash } from "node:crypto";
import type { Server, Socket } from "node:net";
import {
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  McpServer,
  type JSONRPCMessage,
  type RequestId,
} from "@modelcontextprotocol/server";
import { agentTools, type ApiServices, type ChatFocus, type UsageCounter } from "@sondine/api";
import {
  agentClient,
  agentClientByTokenHash,
  contextEpisodeOf,
  selfPersonId,
  recordAgentCall,
  type AgentCallDetail,
  type ChatReads,
  type OpenedDatabase,
} from "@sondine/db";
import { Context, Effect, Layer } from "effect";
import { Api } from "../api-services";
import { CHAT_TOKEN_PATTERN, ChatKeys, type ChatKeysService } from "../chat/chat-keys";
import { limitText, toolAllowed, withinLimit, type LimitLookups } from "../chat/chat-limit";
import { CoreConfig } from "../config";
import { Database } from "../database";
import { log } from "../log";
import { closePrivate, listenPrivate } from "../private-socket";
import { AgentAccess, type AgentAccessService } from "./agent-access";
import { makeToolRunner, serverInstructions } from "./agent-tools";
import { UsageStatistics } from "../usage/usage-layer";
import { SocketTransport, type PolicyReply } from "./socket-transport";

// Core's side of agent access (ADR 011). While the user's switch is on, core
// listens on `run/mcp.sock` (0600, in the 0700 run directory: only this user
// can connect). The relay's first line carries the agent's key; core finds
// the agent by the key's sha256 and answers one line, then the socket is that
// agent's MCP session. Each tool call is checked twice at the edge: when it
// arrives (the agent still has access) and right before its answer leaves
// (still has access, and nothing was deleted since it arrived; otherwise the
// answer is withheld). What already left cannot be called back.
//
// Sondine's own discussions (ADR 027) come through the same edge with an
// `sdc_` key that lives in core's memory: core also listens while one
// exists, a discussion's calls go to the discussion rather than the agents'
// log, and turning discussions off closes their sessions only.

/** Calls one session may have in flight. Outside agents may open any number of sessions. */
export const MAX_CALLS_IN_FLIGHT = 2;
/** Connections still to say hello. */
const MAX_PENDING_HELLOS = 8;
const HELLO_TIMEOUT_MS = 5_000;
const MAX_HELLO_BYTES = 1_024;

export type HelloRefusal = "unknown" | "revoked" | "disabled" | "busy" | "bad-hello";

const REVOKED_TEXT =
  "This agent's access to Sondine was revoked or turned off. The user can connect it again in Sondine ▸ Settings ▸ Agents.";
const DELETED_TEXT =
  "Something was deleted or changed in Sondine while this was read, so this answer was withheld. Call the tool again.";
const BUSY_TEXT = "Sondine answers two calls at a time per session; wait for one to finish.";
const CHAT_ENDED_TEXT = "This discussion ended or was turned off in Sondine.";

/** The key format agents carry: `sdn_` and 32 random bytes, base64url. */
export const TOKEN_PATTERN = /^sdn_[A-Za-z0-9_-]{43}$/;

export const hashToken = (token: string): Buffer => createHash("sha256").update(token).digest();

const toolError = (id: RequestId, body: string): JSONRPCMessage => ({
  jsonrpc: "2.0",
  id,
  result: { content: [{ type: "text", text: body }], isError: true },
});

const requestError = (id: RequestId, message: string): JSONRPCMessage => ({
  jsonrpc: "2.0",
  id,
  error: { code: -32600, message },
});

/** What the log keeps for a tool name Sondine does not offer. */
const UNKNOWN_TOOL = "unknown_tool";

/** Private fields a tool's result carries to the edge, removed before it leaves. */
const DETAIL_META = "sondine/detail";
const READS_META = "sondine/reads";
const NO_READS: ChatReads = { episodes: [], people: [], items: [] };

export interface AgentHostOptions {
  readonly socketPath: string;
  readonly db: OpenedDatabase;
  readonly access: AgentAccessService;
  /** Sondine's own discussions' keys (ADR 027). */
  readonly chat: ChatKeysService;
  readonly services: ApiServices;
  /** The anonymous statistics (ADR 042). */
  readonly usage?: UsageCounter;
  readonly appVersion: string;
  readonly timeZone: string;
  readonly now?: () => number;
}

/** Who a session belongs to: an outside agent, or one of Sondine's discussions. */
interface Caller {
  /** Outside agents open as many sessions as they like; a discussion holds one per key. */
  readonly kind: "agent" | "discussion";
  readonly label: string;
  readonly stillAllowed: () => boolean;
  readonly endedText: string;
  readonly record: (
    tool: string,
    startedAt: number,
    outcome: "ok" | "error" | "refused",
    detail: AgentCallDetail,
    bytes: number,
    reads: ChatReads,
  ) => void;
  /** A discussion's limit now (ADR 037): answers outside it are withheld. */
  readonly limit?: () => ChatFocus | null;
}

export interface AgentHostHandle {
  /** Listens now if the switch is on or a discussion holds a key, and follows both from then on. */
  readonly follow: () => void;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
}

export function makeAgentHost(options: AgentHostOptions): AgentHostHandle {
  const { db, access, chat, socketPath } = options;
  const now = options.now ?? Date.now;
  const tools = agentTools();
  const runTool = makeToolRunner(options.services, options.timeZone, options.usage);
  let server: Server | null = null;
  let pendingHellos = 0;
  let sessions = 0;
  /** Every accepted socket, greeted or not. */
  const sockets = new Set<Socket>();
  const toolNames = new Set<string>(tools.map((tool) => tool.name));
  // Starts and stops run one after the other, in the order asked.
  let chain: Promise<void> = Promise.resolve();
  const serially = (step: () => Promise<void>) => {
    chain = chain.then(step, step);
    return chain;
  };

  const stillAllowed = (agentId: number) => {
    if (!access.enabled()) return false;
    const agent = agentClient(db, agentId);
    return agent !== null && agent.revokedAtMs === null;
  };

  const record = (
    agentId: number,
    tool: string,
    startedAt: number,
    outcome: "ok" | "error" | "refused",
    detail: AgentCallDetail,
    bytes: number,
  ) => {
    try {
      recordAgentCall(db, {
        clientId: agentId,
        atMs: startedAt,
        tool,
        detail,
        outcome,
        durationMs: now() - startedAt,
        resultBytes: bytes,
      });
    } catch (error) {
      // A removed agent's last call has no row to attach to.
      log.warn("agents.log-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const agentCaller = (agentId: number): Caller => ({
    kind: "agent",
    label: `agent-${agentId}`,
    stillAllowed: () => stillAllowed(agentId),
    endedText: REVOKED_TEXT,
    record: (tool, startedAt, outcome, detail, bytes) =>
      record(agentId, tool, startedAt, outcome, detail, bytes),
  });

  const chatCaller = (hash: Buffer): Caller => ({
    kind: "discussion",
    label: "discussion",
    stillAllowed: () => chat.lookup(hash) !== null,
    endedText: CHAT_ENDED_TEXT,
    record: (tool, _startedAt, outcome, detail, _bytes, reads) =>
      chat.lookup(hash)?.onCall({ tool, outcome, detail, reads }),
    limit: () => chat.lookup(hash)?.limit() ?? null,
  });

  const dayOf = new Intl.DateTimeFormat("en-CA", {
    timeZone: options.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const limitLookups: LimitLookups = {
    episode: async (episodeId) => {
      try {
        const { episode } = await options.services.episodes.get({ episodeId });
        return {
          day: dayOf.format(episode.startedAtMs),
          people: [...episode.people, ...episode.recognized].map((person) => person.id),
        };
      } catch {
        return null;
      }
    },
    itemEpisode: (itemId) => contextEpisodeOf(db, itemId),
    selfId: () => selfPersonId(db),
  };

  const openSession = (
    caller: Caller,
    socket: Socket,
    rest: Buffer,
    register: (close: () => void) => () => void,
  ) => {
    const mcp = new McpServer(
      { name: "sondine", version: options.appVersion },
      { instructions: serverInstructions(options.timeZone) },
    );
    for (const tool of tools) {
      mcp.registerTool(
        tool.name,
        {
          description: tool.meta.description,
          inputSchema: tool.input,
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: tool.meta.idempotentHint,
            openWorldHint: false,
          },
        },
        async (args: unknown) => {
          // Nothing of a withheld answer leaves, so the discussion read none of it.
          const withheld = (limit: ChatFocus) => ({
            content: [{ type: "text" as const, text: limitText(limit) }],
            isError: true,
            _meta: { [DETAIL_META]: {}, [READS_META]: NO_READS },
          });
          const before = caller.limit?.() ?? null;
          if (before !== null && !toolAllowed(before, tool.name, args, dayOf.format(now()))) {
            return withheld(before);
          }
          const { result, detail, reads } = await runTool(tool, args);
          // The limit is read again after each check: « Limiter » turned on
          // while the answer was read still holds it back.
          let checked: string | null = null;
          for (;;) {
            const limit = caller.limit?.() ?? null;
            if (limit === null || JSON.stringify(limit) === checked) break;
            if (
              !toolAllowed(limit, tool.name, args, dayOf.format(now())) ||
              !(await withinLimit(limit, reads, limitLookups))
            ) {
              return withheld(limit);
            }
            checked = JSON.stringify(limit);
          }
          return { ...result, _meta: { [DETAIL_META]: detail, [READS_META]: reads } };
        },
      );
    }

    // Every request the agent has open, by id: a reused id is refused, so each
    // answer leaving matches one request, and a tool's answer is always checked.
    const open = new Set<RequestId>();
    const calls = new Map<RequestId, { tool: string; startedAt: number; generation: number }>();
    const transport = new SocketTransport(socket, rest, {
      inbound(message): PolicyReply | null {
        if (isJSONRPCNotification(message)) {
          // A cancelled call gets no answer: its slot frees now.
          if (message.method === "notifications/cancelled") {
            const id = (message.params as { requestId?: RequestId } | undefined)?.requestId;
            if (id !== undefined && calls.delete(id)) open.delete(id);
          }
          return null;
        }
        if (!isJSONRPCRequest(message)) return null;
        if (open.has(message.id)) {
          return {
            reply: requestError(message.id, "This request id is already in use."),
            thenClose: false,
          };
        }
        if (message.method !== "tools/call") {
          open.add(message.id);
          return null;
        }
        const requested = (message.params as { name?: unknown } | undefined)?.name;
        // Only names Sondine offers reach the log: anything else is just "unknown".
        const name = toolNames.has(String(requested)) ? String(requested) : UNKNOWN_TOOL;
        const startedAt = now();
        if (!caller.stillAllowed()) {
          caller.record(name, startedAt, "refused", {}, 0, NO_READS);
          return { reply: toolError(message.id, caller.endedText), thenClose: true };
        }
        if (calls.size >= MAX_CALLS_IN_FLIGHT) {
          return { reply: toolError(message.id, BUSY_TEXT), thenClose: false };
        }
        open.add(message.id);
        calls.set(message.id, { tool: name, startedAt, generation: access.contentGeneration() });
        return null;
      },
      outbound(message): PolicyReply {
        if (!isJSONRPCResultResponse(message) && !isJSONRPCErrorResponse(message)) {
          return { reply: message, thenClose: false };
        }
        const id = message.id;
        if (id === undefined) return { reply: message, thenClose: false };
        open.delete(id);
        const call = calls.get(id);
        if (call === undefined) return { reply: message, thenClose: false };
        calls.delete(id);
        if (!caller.stillAllowed()) {
          caller.record(call.tool, call.startedAt, "refused", {}, 0, NO_READS);
          return { reply: toolError(id, caller.endedText), thenClose: true };
        }
        if (access.contentGeneration() !== call.generation) {
          caller.record(call.tool, call.startedAt, "error", {}, 0, NO_READS);
          return { reply: toolError(id, DELETED_TEXT), thenClose: false };
        }
        if (isJSONRPCErrorResponse(message)) {
          caller.record(call.tool, call.startedAt, "error", {}, 0, NO_READS);
          return { reply: message, thenClose: false };
        }
        const { _meta: meta, ...rest } = message.result as Record<string, unknown> & {
          _meta?: Record<string, unknown>;
        };
        const { [DETAIL_META]: carried, [READS_META]: carriedReads, ...sdkMeta } = meta ?? {};
        const detail = (carried ?? {}) as AgentCallDetail;
        const reads = (carriedReads ?? NO_READS) as ChatReads;
        const result = Object.keys(sdkMeta).length === 0 ? rest : { ...rest, _meta: sdkMeta };
        const reply: JSONRPCMessage = { jsonrpc: "2.0", id, result };
        const bytes = Buffer.byteLength(JSON.stringify(result));
        caller.record(
          call.tool,
          call.startedAt,
          result["isError"] === true ? "error" : "ok",
          detail,
          bytes,
          reads,
        );
        return { reply, thenClose: false };
      },
    });
    if (caller.kind === "agent") sessions += 1;
    const unregister = register(() => void transport.close());
    transport.onclose = () => {
      if (caller.kind === "agent") sessions -= 1;
      unregister();
      log.info("agents.session-closed", { caller: caller.label, sessions });
    };
    transport.onerror = (error) =>
      log.warn("agents.session-error", { caller: caller.label, message: error.message });
    void mcp.connect(transport).catch((error: unknown) => {
      log.warn("agents.session-failed", {
        caller: caller.label,
        message: error instanceof Error ? error.message : String(error),
      });
      void transport.close();
    });
    log.info("agents.session-opened", { caller: caller.label, sessions });
  };

  const refuse = (socket: Socket, reason: HelloRefusal) => {
    log.info("agents.refused", { reason });
    socket.end(`${JSON.stringify({ ok: false, reason })}\n`);
    setTimeout(() => socket.destroy(), 1_000).unref();
  };

  const greet = (socket: Socket, line: string, rest: Buffer, listener: Server) => {
    // A hello that outlived its listener (access turned off meanwhile) opens nothing.
    if (server !== listener) return refuse(socket, "disabled");
    let token: unknown;
    try {
      const hello = JSON.parse(line) as { v?: unknown; token?: unknown };
      token = hello.v === 1 ? hello.token : undefined;
    } catch {
      token = undefined;
    }
    if (typeof token === "string" && CHAT_TOKEN_PATTERN.test(token)) {
      const hash = hashToken(token);
      const key = chat.lookup(hash);
      if (key === null) return refuse(socket, chat.enabled() ? "unknown" : "disabled");
      // Until the MCP transport exists, closing the session is closing the socket.
      let closer: () => void = () => void socket.destroy();
      const unregister = chat.registerSession(key.id, () => closer());
      // One session per discussion key.
      if (unregister === null) return refuse(socket, "busy");
      socket.write(`${JSON.stringify({ ok: true })}\n`);
      openSession(chatCaller(hash), socket, rest, (close) => {
        closer = close;
        return unregister;
      });
      return;
    }
    if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return refuse(socket, "bad-hello");
    if (!access.enabled()) return refuse(socket, "disabled");
    const agent = agentClientByTokenHash(db, hashToken(token));
    if (agent === null) return refuse(socket, "unknown");
    if (agent.revokedAtMs !== null) return refuse(socket, "revoked");
    socket.write(`${JSON.stringify({ ok: true })}\n`);
    openSession(agentCaller(agent.id), socket, rest, (close) =>
      access.registerSession(agent.id, close),
    );
  };

  const accept = (socket: Socket, listener: Server) => {
    if (pendingHellos >= MAX_PENDING_HELLOS) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    pendingHellos += 1;
    let received = Buffer.alloc(0);
    let done = false;
    const finish = () => {
      if (done) return false;
      done = true;
      pendingHellos -= 1;
      clearTimeout(timer);
      socket.off("data", onData);
      return true;
    };
    const timer = setTimeout(() => {
      if (finish()) refuse(socket, "bad-hello");
    }, HELLO_TIMEOUT_MS);
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const newline = received.indexOf(0x0a);
      if (newline === -1) {
        if (received.length > MAX_HELLO_BYTES && finish()) refuse(socket, "bad-hello");
        return;
      }
      if (!finish()) return;
      socket.pause();
      greet(
        socket,
        received.subarray(0, newline).toString("utf8"),
        received.subarray(newline + 1),
        listener,
      );
      socket.resume();
    };
    socket.on("data", onData);
    socket.on("error", () => {
      if (finish()) socket.destroy();
    });
    socket.on("close", () => finish());
  };

  /** Agent access is on, or a discussion holds a key. */
  const wanted = () => access.enabled() || chat.count() > 0;

  const start = () =>
    serially(async () => {
      if (server !== null || !wanted()) return;
      const next = await listenPrivate(socketPath, "agents", (socket, listener) =>
        accept(socket, listener),
      );
      if (next === null) return;
      server = next;
      access.setListening(true);
      chat.setListening(true);
      log.info("agents.listening", {});
    }).catch((error: unknown) => {
      log.error("agents.listen-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });

  const halt = async () => {
    const current = server;
    server = null;
    access.setListening(false);
    chat.setListening(false);
    access.closeSessions();
    // Hellos still waiting, and sessions still flushing: none outlives the listener.
    for (const socket of sockets) socket.destroy();
    if (current === null) return;
    await closePrivate(current, socketPath);
    log.info("agents.stopped", {});
  };

  const stop = () => serially(halt);

  /**
   * Listens or stops as `wanted` says. A stop asked for, then overtaken by a
   * new discussion key before its turn, does not run: the new key's relay
   * would find no socket.
   */
  const follow = () =>
    wanted()
      ? start()
      : serially(async () => {
          if (!wanted()) await halt();
        });

  return {
    follow() {
      access.onEnabledChange((enabled) => {
        if (!enabled) access.closeSessions();
        void follow();
      });
      chat.onChange(() => void follow());
      if (wanted()) void start();
    },
    start,
    stop,
  };
}

export class AgentHost extends Context.Service<AgentHost, AgentHostHandle>()(
  "sondine/core/AgentHost",
) {}

export const agentHostLayer = Layer.effect(
  AgentHost,
  Effect.gen(function* () {
    const config = yield* CoreConfig;
    const host = makeAgentHost({
      socketPath: config.agentSocket,
      db: yield* Database,
      access: yield* AgentAccess,
      chat: yield* ChatKeys,
      services: yield* Api,
      usage: yield* UsageStatistics,
      appVersion: config.appVersion,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    host.follow();
    yield* Effect.addFinalizer(() => Effect.promise(() => host.stop()));
    return AgentHost.of(host);
  }),
);
