import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_TOOLS,
  ChatFailure,
  ChatToolUse,
  ServiceFailure,
  type ChatChoice,
  ChatFocus,
  type ChatDiscussion,
  type ChatDiscussionSummary,
  type ChatMessage,
  type ChatProvider,
  type ChatProviderId,
  type ChatStatus,
  type ChatView,
} from "@sondine/api";
import {
  addChatMessage,
  chatChoice,
  chatDiscussion,
  chatDiscussionsReading,
  chatMessages,
  createChatDiscussion,
  deleteChatDiscussion,
  finishChatMessage,
  listChatDiscussions,
  recordChatReads,
  setChatChoice,
  setChatDiscussionLimited,
  setChatDiscussionChoice,
  setChatEnabled,
  settleInterruptedChatMessages,
  staleChatDiscussions,
  type Database,
  type StoredChatDiscussion,
  type StoredChatMessage,
} from "@sondine/db";
import type {
  AssistantEvent,
  AssistantProvider,
  AssistantSession,
  AssistantStatus,
} from "@sondine/engines";
import * as z from "zod";
import { log } from "../log";
import type { ChatCall, ChatKey, ChatKeysService } from "./chat-keys";
import { replay, withFocus } from "./chat-instructions";

// Discussions with an agent (ADR 027). Off by default; while on, a provider
// process runs only for a discussion Téo writes in, or briefly to say who is
// signed in and which models exist. Discussions are kept in the database
// across launches, with what each agent read (episodes at their input
// generation, people, items of context); a deletion erases exactly the
// discussions that read something since deleted or changed. Core holds in
// memory only the live part: a provider session per discussion Téo writes
// in, with a key of its own that lets the agent read Sondine through the MCP
// edge and nothing else, and the answer streaming. A session idle for ten
// minutes ends; the next message starts another one, told what was said.

/** A provider session idle this long is ended. */
export const IDLE_SESSION_MS = 10 * 60_000;
/** The providers' answer about sign-in and models is reused this long. */
export const PROVIDERS_FRESH_MS = 5 * 60_000;
/** Views sent to a window at most this often while an answer streams. */
const VIEW_INTERVAL_MS = 60;
/** Discussion titles: Téo's first message, cut here. */
const TITLE_CHARS = 80;
/** Provider sessions alive at once; the least recently used idle one ends for a new one. */
export const MAX_LIVE_SESSIONS = 4;
/** How long a new session waits for the MCP socket to listen. */
const LISTEN_TIMEOUT_MS = 5_000;

export interface ChatServiceOptions {
  readonly db: Database;
  readonly keys: ChatKeysService;
  readonly providers: readonly AssistantProvider[];
  /** The relay a provider starts to read Sondine (`sondine-mcp`); null when this build has none. */
  readonly relay: { readonly command: string; readonly args: readonly string[] } | null;
  /** A private folder outside the app group container: each session's empty working folder. */
  readonly workDirectory: string;
  readonly instructions: (nowMs: number) => string;
  /** Forget where the CLIs are, so a refresh finds one installed meanwhile. */
  readonly relocate?: () => void;
  readonly now?: () => number;
  readonly idleSessionMs?: number;
}

/** The answer streaming into a stored message. */
interface Answer {
  readonly messageId: number;
  text: string;
  tools: ChatToolUse[];
}

/** The live part of a discussion Téo writes in; the rest is in the database. */
interface Live {
  readonly id: number;
  /** The live provider session, its choice and its key. */
  session: { handle: AssistantSession; choice: ChatChoice; key: ChatKey | null } | null;
  answer: Answer | null;
  idle: NodeJS.Timeout | null;
  /** A session is starting (waiting for the socket); Stop meanwhile cancels the message. */
  starting: { stopped: boolean } | null;
  /** When the session was last used, for the cap. */
  usedAtMs: number;
}

/** A provider as the window shows it. */
export const providerOf = (status: AssistantStatus): ChatProvider => ({
  id: status.provider,
  state: status.state,
  executable: status.executable,
  version: status.version,
  home: status.home,
  account: status.account,
  models: status.models.map((model) => ({ ...model, efforts: [...model.efforts] })),
  problem: status.problem,
});

const titleOf = (text: string) => {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= TITLE_CHARS ? flat : `${flat.slice(0, TITLE_CHARS - 1)}…`;
};

const sameChoice = (a: ChatChoice, b: ChatChoice) =>
  a.provider === b.provider && a.model === b.model && a.effort === b.effort;

const StoredTools = z.array(ChatToolUse).catch([]);

/** A stored message as the window gets it; what does not parse is dropped, not trusted. */
function messageOf(stored: StoredChatMessage): ChatMessage {
  const failure = ChatFailure.safeParse(stored.failure);
  return {
    id: stored.id,
    role: stored.role,
    text: stored.text,
    atMs: stored.atMs,
    tools: StoredTools.parse(stored.tools),
    streaming: stored.streaming,
    stopped: stored.stopped,
    failure: stored.failure === null ? null : failure.success ? failure.data : null,
  };
}

/** The fields of a tool's arguments a discussion shows (`query`, ids, a day). */
function toolUseOf(callId: string, tool: string, input: unknown): ChatToolUse {
  const args = (typeof input === "object" && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  const id = (key: string) =>
    typeof args[key] === "number" && Number.isInteger(args[key]) && (args[key] as number) > 0
      ? (args[key] as number)
      : null;
  return {
    id: callId,
    tool,
    state: "running",
    query: tool === "search_transcripts" && typeof args["text"] === "string" ? args["text"] : null,
    episodeId: id("episodeId"),
    personId: id("personId"),
    itemId: id("itemId"),
    day: typeof args["day"] === "string" ? args["day"] : null,
    results: null,
  };
}

export function makeChatService(options: ChatServiceOptions) {
  const { db, keys } = options;
  const now = options.now ?? Date.now;
  const idleMs = options.idleSessionMs ?? IDLE_SESSION_MS;
  const byId = new Map(options.providers.map((provider) => [provider.id, provider]));
  const live = new Map<number, Live>();
  let revision = 0;
  let erased = 0;
  let detected: { atMs: number; providers: ChatProvider[] } | null = null;
  let detecting: Promise<ChatProvider[]> | null = null;
  /** Sessions starting: they count against the cap before they exist. */
  let opening = 0;
  const listeners = new Set<() => void>();

  // Answers a stopped core left streaming end as stopped.
  const interrupted = settleInterruptedChatMessages(db);
  if (interrupted > 0) log.info("chat.interrupted-answers", { messages: interrupted });

  const changed = () => {
    revision += 1;
    for (const listener of listeners) listener();
  };

  const status = (providers: ChatProvider[] | null): ChatStatus => {
    const choice = chatChoice(db);
    return {
      enabled: keys.enabled(),
      providers,
      choice:
        choice !== null && byId.has(choice.provider as ChatProviderId)
          ? { ...choice, provider: choice.provider as ChatProviderId }
          : null,
      canRead: options.relay !== null,
    };
  };

  const detect = (): Promise<ChatProvider[]> => {
    detecting ??= Promise.all(options.providers.map((provider) => provider.detect()))
      .then((statuses) => {
        const providers = statuses.map(providerOf);
        detected = { atMs: now(), providers };
        log.info("chat.providers", {
          states: providers.map((p) => `${p.id}:${p.state}`).join(","),
        });
        return providers;
      })
      .finally(() => {
        detecting = null;
      });
    return detecting;
  };

  const providers = async (refresh: boolean): Promise<ChatProvider[]> => {
    if (refresh) {
      options.relocate?.();
      return await detect();
    }
    if (detected !== null && now() - detected.atMs < PROVIDERS_FRESH_MS) return detected.providers;
    return await detect();
  };

  const liveOf = (discussionId: number): Live => {
    let entry = live.get(discussionId);
    if (entry === undefined) {
      entry = {
        id: discussionId,
        session: null,
        answer: null,
        idle: null,
        starting: null,
        usedAtMs: now(),
      };
      live.set(discussionId, entry);
    }
    return entry;
  };

  const closeSession = (session: Live["session"]) => {
    if (session === null) return;
    session.key?.revoke();
    void session.handle.close().catch(() => {});
  };

  const endSession = (entry: Live) => {
    if (entry.idle !== null) clearTimeout(entry.idle);
    entry.idle = null;
    const session = entry.session;
    entry.session = null;
    closeSession(session);
  };

  /** Ends the answer streaming, stores it as it is, with how it ended. */
  const settle = (
    entry: Live,
    end: { readonly stopped?: boolean; readonly failure?: ChatFailure },
  ) => {
    const answer = entry.answer;
    if (answer === null) return;
    entry.answer = null;
    // A read still running when the answer ended did not finish.
    const tools = answer.tools.map((tool) =>
      tool.state === "running" ? { ...tool, state: "failed" as const } : tool,
    );
    finishChatMessage(db, answer.messageId, {
      text: answer.text,
      tools,
      stopped: end.stopped === true,
      failure: end.failure ?? null,
    });
  };

  /** Forgets a discussion's live part; with `drop`, its rows too. */
  const forget = (discussionId: number, drop: boolean) => {
    const entry = live.get(discussionId);
    if (entry !== undefined) {
      if (entry.starting !== null) entry.starting.stopped = true;
      endSession(entry);
      if (!drop) settle(entry, { stopped: true });
      live.delete(discussionId);
    }
    if (drop) deleteChatDiscussion(db, discussionId);
  };

  const idleLater = (entry: Live) => {
    if (entry.idle !== null) clearTimeout(entry.idle);
    entry.idle = setTimeout(() => endSession(entry), idleMs);
    entry.idle.unref?.();
  };

  const onEvent = (entry: Live, event: AssistantEvent) => {
    if (live.get(entry.id) !== entry) return;
    const answer = entry.answer;
    switch (event.type) {
      case "text":
        if (answer !== null) answer.text += event.delta;
        break;
      case "tool-started":
        answer?.tools.push(toolUseOf(event.callId, event.tool, event.input));
        break;
      case "tool-ended":
        if (answer !== null) {
          answer.tools = answer.tools.map((tool) =>
            tool.id === event.callId && tool.state === "running"
              ? { ...tool, state: event.ok ? "done" : "failed" }
              : tool,
          );
        }
        break;
      case "turn-ended":
        settle(entry, { stopped: event.reason === "interrupted" });
        idleLater(entry);
        break;
      case "turn-failed":
        settle(entry, { failure: event.failure });
        idleLater(entry);
        break;
      case "failed":
        log.warn("chat.session-failed", { code: event.failure.code });
        // An answer already settled (an interrupt that ended the process) keeps its state.
        settle(entry, { failure: event.failure });
        endSession(entry);
        break;
    }
    changed();
  };

  /** The edge's report of a call: what came back, and what of Sondine it carried. */
  const onCall = (entry: Live, call: ChatCall) => {
    if (live.get(entry.id) !== entry) return;
    // Whatever the agent received counts, an answer refused for its size included
    // (it still gave times and counts); the edge sends no reads for what it withheld.
    if (call.reads.episodes.length + call.reads.people.length + call.reads.items.length > 0) {
      recordChatReads(db, entry.id, call.reads);
    }
    const answer = entry.answer;
    if (answer !== null) {
      const index = answer.tools.findIndex(
        (tool) => tool.tool === call.tool && tool.results === null && tool.state !== "failed",
      );
      const tool = index === -1 ? undefined : answer.tools[index];
      if (tool !== undefined) {
        answer.tools[index] = {
          ...tool,
          results: call.detail.results ?? null,
          day: tool.day ?? call.detail.day ?? null,
          episodeId: tool.episodeId ?? call.detail.episodeId ?? null,
          state: call.outcome === "ok" ? tool.state : "failed",
        };
      }
    }
    changed();
  };

  /** Makes room for one more provider session: the least recently used idle one ends. */
  const makeRoom = () => {
    const alive = [...live.values()].filter((entry) => entry.session !== null);
    if (alive.length + opening < MAX_LIVE_SESSIONS) return;
    const idle = alive
      .filter((entry) => entry.answer === null)
      .toSorted((a, b) => a.usedAtMs - b.usedAtMs)[0];
    if (idle === undefined) {
      throw new ServiceFailure(
        "invalid-input",
        `${MAX_LIVE_SESSIONS} discussions are already answering; wait for one to finish.`,
      );
    }
    endSession(idle);
  };

  /**
   * Starts a provider session for a discussion. Its key and folder are
   * released on any failure, and nothing starts when Stop came meanwhile
   * (the result is then false).
   */
  const openSession = async (entry: Live, choice: ChatChoice): Promise<boolean> => {
    const provider = byId.get(choice.provider);
    if (provider === undefined) throw new ServiceFailure("invalid-input", "Unknown provider.");
    const starting = { stopped: false };
    entry.starting = starting;
    // Counted from here: no await separates this from `makeRoom`'s check.
    opening += 1;
    let key: ChatKey | null = null;
    let workingDirectory: string | null = null;
    try {
      key =
        options.relay === null
          ? null
          : keys.create(
              (call) => onCall(entry, call),
              // Read at every call (ADR 037): « Limiter » applies to the answer under way.
              () => limitOf(entry.id),
            );
      // The relay connects as soon as the CLI starts: the socket must listen first.
      if (key !== null && !(await keys.whenListening(LISTEN_TIMEOUT_MS))) {
        throw new ServiceFailure(
          "invalid-input",
          "Sondine could not open its socket for the agent.",
        );
      }
      if (starting.stopped || live.get(entry.id) !== entry) {
        key?.revoke();
        return false;
      }
      const directory = join(options.workDirectory, `d${entry.id}-${now()}`);
      workingDirectory = directory;
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const handle = provider.open(
        {
          model: choice.model,
          effort: choice.effort,
          instructions: options.instructions(now()),
          workingDirectory: directory,
          tools:
            options.relay === null || key === null
              ? null
              : {
                  server: {
                    name: "sondine",
                    command: options.relay.command,
                    args: options.relay.args,
                    env: { SONDINE_TOKEN: key.token },
                  },
                  names: AGENT_TOOLS,
                },
        },
        (event) => onEvent(entry, event),
      );
      const close = handle.close;
      entry.session = {
        choice,
        key,
        handle: {
          ...handle,
          close: async () => {
            await close();
            rmSync(directory, { recursive: true, force: true });
          },
        },
      };
      log.info("chat.session-opened", { discussion: entry.id, provider: choice.provider });
      return true;
    } catch (error) {
      key?.revoke();
      if (workingDirectory !== null) rmSync(workingDirectory, { recursive: true, force: true });
      throw error;
    } finally {
      opening -= 1;
      if (entry.starting === starting) entry.starting = null;
    }
  };

  /** Erases discussions (their sessions end, their rows go); says so in the list. */
  const erase = (discussionIds: readonly number[], reason: string) => {
    if (discussionIds.length === 0) return;
    for (const discussionId of discussionIds) forget(discussionId, true);
    erased += discussionIds.length;
    log.info("chat.erased", { discussions: discussionIds.length, reason });
    changed();
  };

  // A deletion core did not see through (it stopped first) is caught up now.
  erase(staleChatDiscussions(db), "start");

  const existing = (discussionId: number): StoredChatDiscussion => {
    const stored = chatDiscussion(db, discussionId);
    if (stored === null) {
      throw new ServiceFailure("not-found", `No discussion ${discussionId}.`);
    }
    return stored;
  };

  /** The focus a discussion started on; null for everything or a shape this core does not know. */
  const focusOf = (stored: StoredChatDiscussion | null): ChatFocus | null => {
    const parsed = ChatFocus.safeParse(stored?.focus);
    return parsed.success ? parsed.data : null;
  };
  /** What a discussion's tools may read now: its focus while « Limiter » is on, else everything. */
  const limitOf = (discussionId: number): ChatFocus | null => {
    const stored = chatDiscussion(db, discussionId);
    return stored?.limited === true ? focusOf(stored) : null;
  };

  const summaryOf = (stored: StoredChatDiscussion): ChatDiscussionSummary => ({
    id: stored.id,
    title: stored.title,
    provider: (byId.has(stored.provider as ChatProviderId)
      ? stored.provider
      : "claude") as ChatProviderId,
    model: stored.model,
    startedAtMs: stored.startedAtMs,
    updatedAtMs: stored.updatedAtMs,
    running: live.get(stored.id)?.answer != null,
    focus: focusOf(stored),
    limited: stored.limited && focusOf(stored) !== null,
  });

  const view = (discussionId: number | null): ChatView => {
    const list = listChatDiscussions(db).map(summaryOf);
    const stored = discussionId === null ? null : chatDiscussion(db, discussionId);
    let discussion: ChatDiscussion | null = null;
    if (stored !== null) {
      const answer = live.get(stored.id)?.answer ?? null;
      discussion = {
        ...summaryOf(stored),
        effort: stored.effort,
        messages: chatMessages(db, stored.id).map((message) => {
          const shown = messageOf(message);
          // The answer streaming lives in memory until it ends.
          return answer !== null && answer.messageId === message.id
            ? { ...shown, text: answer.text, tools: [...answer.tools], streaming: true }
            : shown;
        }),
      };
    }
    return { revision, discussions: list, discussion, erased };
  };

  return {
    async status(input: { refresh?: boolean | undefined } | undefined): Promise<ChatStatus> {
      if (!keys.enabled()) return status(null);
      return status(await providers(input?.refresh === true));
    },

    async setEnabled(enabled: boolean): Promise<ChatStatus> {
      setChatEnabled(db, enabled, now());
      keys.setEnabled(enabled);
      if (!enabled) {
        // Off ends every session at once; the discussions stay on this Mac.
        for (const discussionId of live.keys()) forget(discussionId, false);
        detected = null;
        changed();
        return status(null);
      }
      changed();
      return status(await providers(true));
    },

    async send(input: {
      discussionId: number | null;
      text: string;
      choice: ChatChoice;
      focus?: ChatFocus | null | undefined;
      limited?: boolean | undefined;
    }): Promise<{ discussionId: number }> {
      if (!keys.enabled()) throw new ServiceFailure("invalid-input", "Discussions are off.");
      const known = await providers(false);
      const provider = known.find((candidate) => candidate.id === input.choice.provider);
      if (provider === undefined || provider.state !== "ready") {
        throw new ServiceFailure(
          "invalid-input",
          provider?.problem ?? "This provider is not ready.",
        );
      }
      const model = provider.models.find((candidate) => candidate.id === input.choice.model);
      if (model === undefined) {
        throw new ServiceFailure("invalid-input", "This model is not offered any more.");
      }
      const effort =
        input.choice.effort !== null && model.efforts.includes(input.choice.effort)
          ? input.choice.effort
          : model.defaultEffort;
      const choice: ChatChoice = { ...input.choice, effort };
      if (input.discussionId !== null) existing(input.discussionId);
      const current = input.discussionId === null ? undefined : live.get(input.discussionId);
      if (current?.answer != null || current?.starting != null) {
        throw new ServiceFailure("invalid-input", "The agent is still answering.");
      }
      const needsSession =
        current === undefined ||
        current.session === null ||
        !sameChoice(current.session.choice, choice);
      // Refused before anything changes when every session is answering.
      if (needsSession) makeRoom();
      const atMs = now();
      const discussionId =
        input.discussionId ??
        createChatDiscussion(db, {
          title: titleOf(input.text),
          provider: choice.provider,
          model: choice.model,
          effort: choice.effort,
          nowMs: atMs,
          focus: input.focus ?? null,
          limited: input.limited === true && input.focus != null,
        });
      setChatDiscussionChoice(db, discussionId, choice, atMs);
      setChatChoice(db, choice, atMs);
      const earlier = chatMessages(db, discussionId).map(({ role, text }) => ({ role, text }));
      const entry = liveOf(discussionId);
      if (entry.idle !== null) clearTimeout(entry.idle);
      entry.idle = null;
      entry.usedAtMs = atMs;
      addChatMessage(db, { discussionId, role: "user", text: input.text, atMs, streaming: false });
      const messageId = addChatMessage(db, {
        discussionId,
        role: "agent",
        text: "",
        atMs,
        streaming: true,
      });
      entry.answer = { messageId, text: "", tools: [] };
      changed();
      if (needsSession) {
        // The previous session (another model) ends once the new one holds
        // its key, so the socket never stops listening in between.
        const previous = entry.session;
        entry.session = null;
        let started: boolean;
        try {
          started = await openSession(entry, choice);
        } catch (error) {
          settle(entry, {
            failure: {
              code: "unavailable",
              message:
                error instanceof ServiceFailure ? error.message : "The agent could not be started.",
            },
          });
          changed();
          return { discussionId };
        } finally {
          closeSession(previous);
        }
        // Stopped, deleted, or discussions turned off, while the socket opened.
        if (!started || live.get(discussionId) !== entry) {
          endSession(entry);
          settle(entry, { stopped: true });
          changed();
          return { discussionId };
        }
      }
      try {
        // The discussion's own focus, stored when it started.
        const text = withFocus(input.text, focusOf(chatDiscussion(db, discussionId)));
        entry.session!.handle.send(needsSession ? replay(earlier, text) : text);
      } catch {
        settle(entry, {
          failure: { code: "crashed", message: "The agent could not take this message." },
        });
        endSession(entry);
        changed();
      }
      return { discussionId };
    },

    async stop(discussionId: number): Promise<Record<string, never>> {
      existing(discussionId);
      const entry = live.get(discussionId);
      if (entry === undefined) return {};
      if (entry.starting !== null) {
        // The message has not left: it never will.
        entry.starting.stopped = true;
        settle(entry, { stopped: true });
        changed();
        return {};
      }
      entry.session?.handle.interrupt();
      return {};
    },

    /** « Limiter » (ADR 037): stored, and read by the discussion's key at its next call. */
    setLimited(discussionId: number, limited: boolean): void {
      existing(discussionId);
      if (limited && focusOf(chatDiscussion(db, discussionId)) === null) {
        throw new ServiceFailure("invalid-input", "This discussion has no focus to limit to.");
      }
      setChatDiscussionLimited(db, discussionId, limited);
      changed();
    },

    async remove(discussionId: number): Promise<Record<string, never>> {
      existing(discussionId);
      forget(discussionId, true);
      changed();
      return {};
    },

    async *watch(discussionId: number | null, signal?: AbortSignal): AsyncGenerator<ChatView> {
      let dirty = true;
      let wake: (() => void) | null = null;
      const listener = () => {
        dirty = true;
        wake?.();
      };
      listeners.add(listener);
      const aborted = () => wake?.();
      signal?.addEventListener("abort", aborted);
      try {
        while (signal?.aborted !== true) {
          if (dirty) {
            dirty = false;
            yield view(discussionId);
            await new Promise((resolve) => setTimeout(resolve, VIEW_INTERVAL_MS));
            continue;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
        }
      } finally {
        listeners.delete(listener);
        signal?.removeEventListener("abort", aborted);
      }
    },

    /**
     * Something was deleted: the discussions that read something since
     * deleted or changed are erased, their sessions ended. Their words may
     * quote what is gone.
     */
    deleted(): void {
      erase(staleChatDiscussions(db), "deletion");
    },

    /**
     * A person was deleted, or merged into another: discussions that read
     * any of their episodes may hold the name that went (a journal names
     * voices without ids), so they go too.
     */
    peopleRemoved(episodeIds: readonly number[]): void {
      const reading = chatDiscussionsReading(db, episodeIds);
      const stale = staleChatDiscussions(db);
      erase([...new Set([...reading, ...stale])], "person");
    },

    async close(): Promise<void> {
      const closing = [...live.values()].map(async (entry) => {
        if (entry.starting !== null) entry.starting.stopped = true;
        if (entry.idle !== null) clearTimeout(entry.idle);
        settle(entry, { stopped: true });
        const session = entry.session;
        entry.session = null;
        session?.key?.revoke();
        await session?.handle.close().catch(() => {});
      });
      live.clear();
      await Promise.all(closing);
    },

    /** An agent is answering, or a session starts. */
    answering: () =>
      [...live.values()].some((entry) => entry.answer !== null || entry.starting !== null),

    /** For tests and diagnostics: the discussions with a live provider session. */
    liveSessions: () => [...live.values()].filter((entry) => entry.session !== null).length,
  };
}

export type ChatService = ReturnType<typeof makeChatService>;

/** The private working folder of the CLIs: emptied at start (old sessions' files, dead keys). */
export function prepareWorkDirectory(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}
