import { randomUUID } from "node:crypto";
import type {
  AssistantAccount,
  AssistantEvent,
  AssistantFailure,
  AssistantListener,
  AssistantModel,
  AssistantProvider,
  AssistantSession,
  AssistantSessionOptions,
  AssistantStatus,
} from "./contract.ts";
import {
  endProcess,
  field,
  readJsonLines,
  startProcess,
  stderrTail,
  type Environment,
} from "./processes.ts";

// Claude through the user's own `claude` CLI (ADR 027), driven over its
// headless interface: `-p` with stream-json in and out. No SDK is bundled
// (it is not open source). The flags leave the model Sondine's tools only:
// no built-in tool, no setting, hook, memory, CLAUDE.md, plugin, slash
// command or MCP server of the user's, no session written to disk: the CLI
// never offers the model another tool. The CLI's `initialize` control request
// tells who is signed in and which models exist without reaching a model;
// `interrupt` stops a turn (and a turn that does not stop within 5 s ends its
// process). Both are the control messages the official SDKs send, not a
// documented CLI contract: a CLI that refuses them is "unsupported". The
// tripwire stops a session that shows another tool or an unknown kind of
// content anyway; it detects, the flags enforce.

/** Variables that keep the CLI from reaching anything but the model. */
export const QUIET_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_AUTOUPDATER: "1",
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
  CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
};

/** Every session and probe: nothing of the user's configuration, nothing on disk. */
export const CLAUDE_LOCKED_ARGUMENTS: readonly string[] = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--tools",
  "",
  "--strict-mcp-config",
  "--setting-sources",
  "",
  "--settings",
  '{"disableAllHooks":true}',
  "--disable-slash-commands",
  "--no-session-persistence",
  "--permission-mode",
  "dontAsk",
  "--permission-prompts",
  "none",
];

const DETECT_TIMEOUT_MS = 20_000;
/** After an interrupt, the turn's end; then the process is ended. */
const INTERRUPT_GRACE_MS = 5_000;
/** The oldest version these flags and control messages were checked with. */
export const CLAUDE_MIN_VERSION = "2.1.319";
/** Content blocks an answer may hold; anything else stops the session. */
export const KNOWN_BLOCKS: ReadonlySet<string> = new Set([
  "text",
  "thinking",
  "redacted_thinking",
  "tool_use",
]);

const versionParts = (value: string) =>
  (/^(\d+)\.(\d+)\.(\d+)/u.exec(value) ?? []).slice(1).map(Number);

/** `a >= b` for dotted numeric versions; an unreadable version is not newer. */
export function versionAtLeast(version: string, minimum: string): boolean {
  const a = versionParts(version);
  const b = versionParts(minimum);
  if (a.length !== 3 || b.length !== 3) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return true;
}

/** The MCP configuration of a session: Sondine's relay only, and no secret (the key is in the environment). */
export function claudeMcpConfig(server: AssistantSessionOptions["tools"]): string {
  if (server === null) return JSON.stringify({ mcpServers: {} });
  return JSON.stringify({
    mcpServers: {
      [server.server.name]: {
        type: "stdio",
        command: server.server.command,
        args: [...server.server.args],
      },
    },
  });
}

export const claudeToolName = (server: string, tool: string) => `mcp__${server}__${tool}`;

export function claudeSessionArguments(options: AssistantSessionOptions): string[] {
  const args = [
    ...CLAUDE_LOCKED_ARGUMENTS,
    "--include-partial-messages",
    "--model",
    options.model,
    "--system-prompt",
    options.instructions,
  ];
  if (options.effort !== null) args.push("--effort", options.effort);
  if (options.tools !== null) {
    const { server, names } = options.tools;
    args.push(
      "--mcp-config",
      claudeMcpConfig(options.tools),
      "--allowedTools",
      names.map((name) => claudeToolName(server.name, name)).join(","),
    );
  }
  return args;
}

function accountOf(response: Record<string, unknown>): AssistantAccount | null {
  const account = field.object(response, "account");
  if (account === null) return null;
  const email = field.string(account, "email");
  const subscription = field.string(account, "subscriptionType");
  if (subscription !== null && subscription !== "") {
    return { email, plan: subscription, billing: "subscription" };
  }
  if (email !== null || field.string(account, "apiKeySource") !== null) {
    return { email, plan: null, billing: "api-key" };
  }
  return null;
}

/**
 * The CLI's models. Its `default` entry is an alias of a named one (the same
 * `resolvedModel`): the named one is kept and marked as the default.
 */
export function modelsOf(response: Record<string, unknown>): AssistantModel[] {
  const entries = field.array(response, "models");
  const resolvedDefault = field.string(
    entries.find((entry) => field.string(entry, "value") === "default"),
    "resolvedModel",
  );
  const named = (entry: unknown) =>
    field.string(entry, "value") !== "default" &&
    resolvedDefault !== null &&
    field.string(entry, "resolvedModel") === resolvedDefault;
  const aliasDropped = entries.some(named);
  return entries.flatMap((entry): AssistantModel[] => {
    const id = field.string(entry, "value");
    if (id === null || (id === "default" && aliasDropped)) return [];
    const efforts = field.boolean(entry, "supportsEffort")
      ? field
          .array(entry, "supportedEffortLevels")
          .filter((e): e is string => typeof e === "string")
      : [];
    return [
      {
        id,
        name: field.string(entry, "displayName") ?? id,
        description: field.string(entry, "description"),
        efforts,
        // The CLI's own default effort is "high" for every model that takes one.
        defaultEffort: efforts.includes("high") ? "high" : (efforts[0] ?? null),
        isDefault: aliasDropped ? named(entry) : id === "default",
      },
    ];
  });
}

const unsupported = (tail: string) =>
  /unknown option|unrecognized|invalid value|error: option/iu.test(tail);

export interface ClaudeProviderOptions {
  /** The `claude` executable and the environment to start it with; null when it is not installed. */
  readonly locate: () => Promise<{ readonly executable: string | null; readonly env: Environment }>;
  readonly detectTimeoutMs?: number;
  readonly log?: (event: string, fields: Record<string, string | number | boolean | null>) => void;
}

export function createClaudeProvider(options: ClaudeProviderOptions): AssistantProvider {
  const log = options.log ?? (() => {});

  const detect = async (signal?: AbortSignal): Promise<AssistantStatus> => {
    const { executable, env } = await options.locate();
    const base = {
      provider: "claude" as const,
      executable,
      version: null,
      home:
        env["CLAUDE_CONFIG_DIR"] ?? (env["HOME"] === undefined ? null : `${env["HOME"]}/.claude`),
      account: null,
      models: [],
    };
    if (executable === null) return { ...base, state: "missing", problem: null };
    const child = startProcess(executable, CLAUDE_LOCKED_ARGUMENTS, {
      env: { ...env, ...QUIET_ENV },
    });
    const tail = stderrTail(child.stderr);
    try {
      const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("timed out")),
          options.detectTimeoutMs ?? DETECT_TIMEOUT_MS,
        );
        const abort = () => reject(new Error("cancelled"));
        signal?.addEventListener("abort", abort, { once: true });
        readJsonLines(
          child.stdout,
          (message) => {
            if (message["type"] !== "control_response") return;
            const body = field.object(message, "response");
            clearTimeout(timer);
            if (field.string(body, "subtype") === "success") {
              resolve(field.object(body, "response") ?? {});
            } else reject(new Error("refused"));
          },
          () => {},
        );
        child.on("error", (error) => reject(error));
        child.on("exit", () => reject(new Error("exited")));
        child.stdin.write(
          `${JSON.stringify({ type: "control_request", request_id: randomUUID(), request: { subtype: "initialize" } })}\n`,
        );
      });
      const version = field.string(response, "claude_code_version");
      const account = accountOf(response);
      const models = modelsOf(response);
      if (version === null || !versionAtLeast(version, CLAUDE_MIN_VERSION)) {
        return {
          ...base,
          version,
          state: "unsupported",
          problem: `Sondine needs Claude Code ${CLAUDE_MIN_VERSION} or newer.`,
        };
      }
      if (account === null) {
        return {
          ...base,
          version,
          models,
          state: "signed-out",
          problem: "Nobody is signed in to Claude Code.",
        };
      }
      return { ...base, version, account, models, state: "ready", problem: null };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log("assistants.claude-detect-failed", { reason });
      return unsupported(tail())
        ? {
            ...base,
            state: "unsupported",
            problem: "This version of Claude Code does not take Sondine's options.",
          }
        : { ...base, state: "failed", problem: "Claude Code did not answer." };
    } finally {
      await endProcess(child, 500);
    }
  };

  const open = (
    session: AssistantSessionOptions,
    listener: AssistantListener,
  ): AssistantSession => {
    let child: ReturnType<typeof startProcess> | null = null;
    let ended = false;
    let closing = false;
    let turnRunning = false;
    let interruptRequested = false;
    /** Messages sent before the process started. */
    const queued: string[] = [];
    let tail: () => string = () => "";
    let interruptTimer: NodeJS.Timeout | null = null;
    const allowed = new Set(
      session.tools === null
        ? []
        : session.tools.names.map((name) => claudeToolName(session.tools!.server.name, name)),
    );
    const prefix = session.tools === null ? "" : `mcp__${session.tools.server.name}__`;
    /** Text deltas seen per message id: a message that streamed none gives its text at once. */
    const streamed = new Set<string>();
    let currentMessage: string | null = null;
    /** An authentication failure the CLI reported in an assistant message. */
    let lastError: string | null = null;

    const emit = (event: AssistantEvent) => {
      if (ended) return;
      if (event.type === "failed") ended = true;
      listener(event);
    };

    const fail = (failure: AssistantFailure) => {
      if (ended) return;
      turnRunning = false;
      emit({ type: "failed", failure });
      if (interruptTimer !== null) clearTimeout(interruptTimer);
      if (child !== null) void endProcess(child, 500);
    };

    const trip = (what: string) => {
      log("assistants.claude-tripwire", { tool: what.slice(0, 80) });
      fail({
        code: "refused-tool",
        message: "Claude offered a tool other than Sondine's, so Sondine stopped it.",
      });
    };

    const write = (message: unknown) => {
      if (child === null || ended) return;
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const userMessage = (text: string) => ({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    });

    const onMessage = (message: Record<string, unknown>) => {
      const type = message["type"];
      if (type === "system" && message["subtype"] === "init") {
        // Fail closed: an init that does not list its tools and servers is not trusted.
        if (!Array.isArray(message["tools"]) || !Array.isArray(message["mcp_servers"])) {
          return trip("an init without its tool list");
        }
        const tools = field.array(message, "tools").map(String);
        const servers = field.array(message, "mcp_servers").map((s) => field.string(s, "name"));
        const offTool = tools.find((tool) => !allowed.has(tool));
        if (offTool !== undefined) return trip(offTool);
        const ownServer = session.tools?.server.name ?? null;
        const offServer = servers.find((name) => name !== ownServer);
        if (offServer !== undefined) return trip(`server ${String(offServer)}`);
        return;
      }
      if (type === "stream_event") {
        const event = field.object(message, "event");
        const kind = field.string(event, "type");
        if (kind === "message_start") {
          currentMessage = field.string(field.object(event, "message"), "id");
        } else if (kind === "content_block_start") {
          const block = field.object(event, "content_block");
          const blockType = field.string(block, "type");
          if (blockType === "tool_use" || blockType === "server_tool_use") {
            const name = field.string(block, "name") ?? "";
            if (!allowed.has(name)) return trip(name);
          }
        } else if (kind === "content_block_delta") {
          const delta = field.object(event, "delta");
          if (field.string(delta, "type") === "text_delta") {
            const text = field.string(delta, "text") ?? "";
            if (currentMessage !== null) streamed.add(currentMessage);
            if (text !== "") emit({ type: "text", delta: text });
          }
        }
        return;
      }
      if (type === "assistant") {
        const body = field.object(message, "message");
        const id = field.string(body, "id");
        const error = field.string(message, "error");
        if (error !== null) lastError = error;
        for (const block of field.array(body, "content")) {
          const blockType = field.string(block, "type") ?? "";
          if (!KNOWN_BLOCKS.has(blockType)) return trip(`a ${blockType} block`);
          if (blockType === "tool_use") {
            const name = field.string(block, "name") ?? "";
            if (!allowed.has(name)) return trip(name);
            emit({
              type: "tool-started",
              callId: field.string(block, "id") ?? randomUUID(),
              tool: name.slice(prefix.length),
              input: (block as Record<string, unknown>)["input"] ?? null,
            });
          } else if (blockType === "text" && (id === null || !streamed.has(id))) {
            const text = field.string(block, "text") ?? "";
            if (text !== "") emit({ type: "text", delta: text });
          }
        }
        return;
      }
      if (type === "user") {
        for (const block of field.array(field.object(message, "message"), "content")) {
          if (field.string(block, "type") !== "tool_result") continue;
          emit({
            type: "tool-ended",
            callId: field.string(block, "tool_use_id") ?? "",
            ok: field.boolean(block, "is_error") !== true,
          });
        }
        return;
      }
      if (type === "result") {
        turnRunning = false;
        if (interruptTimer !== null) clearTimeout(interruptTimer);
        interruptTimer = null;
        streamed.clear();
        const interrupted = interruptRequested;
        interruptRequested = false;
        const failedAuth = lastError === "authentication_failed";
        lastError = null;
        if (interrupted) return emit({ type: "turn-ended", reason: "interrupted" });
        if (message["subtype"] === "success" && message["is_error"] !== true && !failedAuth) {
          return emit({ type: "turn-ended", reason: "complete" });
        }
        return emit({ type: "turn-failed", failure: resultFailure(message, failedAuth) });
      }
    };

    const start = async () => {
      const { executable, env } = await options.locate();
      if (ended) return;
      if (executable === null) {
        return fail({ code: "unavailable", message: "Claude Code is not installed." });
      }
      // The relay's key goes in the CLI's environment, which its MCP servers
      // inherit: never on a command line or in a file.
      const spawned = startProcess(executable, claudeSessionArguments(session), {
        env: { ...env, ...QUIET_ENV, ...session.tools?.server.env },
        cwd: session.workingDirectory,
      });
      child = spawned;
      tail = stderrTail(spawned.stderr);
      readJsonLines(spawned.stdout, onMessage, (reason) =>
        fail({ code: "protocol", message: `Claude Code sent an unreadable line (${reason}).` }),
      );
      spawned.on("error", () =>
        fail({ code: "crashed", message: "Claude Code could not be started." }),
      );
      spawned.on("exit", (code, signal) => {
        if (closing || ended) return;
        log("assistants.claude-exited", { code, signal, stderr: tail().length });
        fail(
          unsupported(tail())
            ? {
                code: "unavailable",
                message: "This version of Claude Code does not take Sondine's options.",
              }
            : { code: "crashed", message: "Claude Code stopped." },
        );
      });
      for (const text of queued.splice(0)) write(userMessage(text));
    };

    void start().catch((error: unknown) => {
      log("assistants.claude-start-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      fail({ code: "crashed", message: "Claude Code could not be started." });
    });

    return {
      send(text) {
        if (ended) throw new Error("This session has ended.");
        if (turnRunning) throw new Error("A turn is already running.");
        turnRunning = true;
        if (child === null) queued.push(text);
        else write(userMessage(text));
      },
      interrupt() {
        if (!turnRunning || ended) return;
        if (child === null) {
          // Not started yet: the message never left.
          queued.length = 0;
          turnRunning = false;
          emit({ type: "turn-ended", reason: "interrupted" });
          return;
        }
        interruptRequested = true;
        write({
          type: "control_request",
          request_id: randomUUID(),
          request: { subtype: "interrupt" },
        });
        // A CLI that does not stop is ended: the turn counts as stopped.
        interruptTimer = setTimeout(() => {
          if (!turnRunning || ended) return;
          turnRunning = false;
          emit({ type: "turn-ended", reason: "interrupted" });
          fail({ code: "crashed", message: "Claude did not stop in time, so Sondine ended it." });
        }, INTERRUPT_GRACE_MS);
      },
      async close() {
        closing = true;
        ended = true;
        turnRunning = false;
        if (interruptTimer !== null) clearTimeout(interruptTimer);
        if (child !== null) await endProcess(child);
      },
      running: () => turnRunning,
    };
  };

  return { id: "claude", detect, open };
}

function resultFailure(message: Record<string, unknown>, failedAuth: boolean): AssistantFailure {
  const status = field.number(message, "api_error_status");
  const reason = field.string(message, "terminal_reason") ?? "";
  const text = field.string(message, "result") ?? "";
  if (failedAuth || status === 401 || /not logged in|please run \/login|authenticat/iu.test(text)) {
    return {
      code: "signed-out",
      message: "Claude Code is signed out. Run `claude` in a terminal to sign in.",
    };
  }
  if (status === 429 || /usage limit|rate limit|limit reached/iu.test(text)) {
    return { code: "usage-limit", message: "Your Claude plan's limit is reached for now." };
  }
  if (
    reason === "prompt_too_long" ||
    reason === "blocking_limit" ||
    /prompt is too long/iu.test(text)
  ) {
    return {
      code: "context-full",
      message: "This discussion is too long for the model. Start a new one.",
    };
  }
  return { code: "unavailable", message: "Claude did not answer. Try again in a moment." };
}
