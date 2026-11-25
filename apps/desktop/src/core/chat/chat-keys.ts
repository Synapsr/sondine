import { createHash, randomBytes } from "node:crypto";
import type { ChatFocus } from "@sondine/api";
import type { AgentCallDetail, ChatReads } from "@sondine/db";
import { chatEnabled } from "@sondine/db";
import { Context, Effect, Layer } from "effect";
import { Database } from "../database";

// The keys of Sondine's own discussions (ADR 027). A discussion's agent
// reads Sondine through the same MCP edge as outside agents (ADR 011), with
// a key that lives in core's memory only: made when its session starts,
// dropped when it ends. The agent host listens while agent access is on or
// a key exists, and tells the two kinds apart by the key's prefix.

/** `sdc_` and 32 random bytes, base64url. */
export const CHAT_TOKEN_PATTERN = /^sdc_[A-Za-z0-9_-]{43}$/;

/** What the edge reports of a discussion's tool call. */
export interface ChatCall {
  readonly tool: string;
  readonly outcome: "ok" | "error" | "refused";
  readonly detail: AgentCallDetail;
  /** What the answer carried of Sondine's content, by id. */
  readonly reads: ChatReads;
}

export interface ChatKey {
  readonly token: string;
  /** Ends the key: its session closes and the host may stop listening. */
  readonly revoke: () => void;
}

export interface ChatKeysService {
  readonly enabled: () => boolean;
  /** The user flipped the switch (already stored); turning it off revokes every key. */
  readonly setEnabled: (enabled: boolean) => void;
  /** `limit` reads the discussion's limit now (ADR 037); null reads everything. */
  readonly create: (onCall: (call: ChatCall) => void, limit?: () => ChatFocus | null) => ChatKey;
  /** The key's call sink and limit, or null when it is unknown or revoked. */
  readonly lookup: (hash: Buffer) => KeyEntry | null;
  readonly count: () => number;
  /** The live MCP session of a key; at most one. Returns its unregistration, or null when one exists. */
  readonly registerSession: (id: symbol, close: () => void) => (() => void) | null;
  readonly onChange: (listener: () => void) => () => void;
  /** The host says whether it listens; a relay started before it would find no socket. */
  readonly setListening: (listening: boolean) => void;
  /** Resolves once the host listens, false after `timeoutMs`. */
  readonly whenListening: (timeoutMs: number) => Promise<boolean>;
}

export interface KeyEntry {
  readonly id: symbol;
  readonly onCall: (call: ChatCall) => void;
  readonly limit: () => ChatFocus | null;
}

export class ChatKeys extends Context.Service<ChatKeys, ChatKeysService>()(
  "sondine/core/ChatKeys",
) {}

const hashOf = (token: string): string => createHash("sha256").update(token).digest("hex");

export function makeChatKeys(initiallyEnabled: boolean): ChatKeysService {
  let enabled = initiallyEnabled;
  const keys = new Map<string, KeyEntry>();
  const sessions = new Map<symbol, () => void>();
  const listeners = new Set<() => void>();
  let listening = false;
  const waiting = new Set<(listening: boolean) => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  const drop = (hash: string) => {
    const key = keys.get(hash);
    if (key === undefined) return;
    keys.delete(hash);
    const close = sessions.get(key.id);
    sessions.delete(key.id);
    close?.();
    changed();
  };
  return {
    enabled: () => enabled,
    setEnabled(next) {
      if (next === enabled) return;
      enabled = next;
      if (!next) for (const hash of keys.keys()) drop(hash);
      changed();
    },
    create(onCall, limit = () => null) {
      if (!enabled) throw new Error("Discussions are off.");
      const token = `sdc_${randomBytes(32).toString("base64url")}`;
      const hash = hashOf(token);
      keys.set(hash, { id: Symbol("chat-key"), onCall, limit });
      changed();
      return { token, revoke: () => drop(hash) };
    },
    lookup(hash) {
      if (!enabled) return null;
      return keys.get(hash.toString("hex")) ?? null;
    },
    count: () => keys.size,
    registerSession(id, close) {
      if (sessions.has(id)) return null;
      sessions.set(id, close);
      return () => {
        if (sessions.get(id) === close) sessions.delete(id);
      };
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setListening(next) {
      listening = next;
      if (!next) return;
      for (const resolve of waiting) resolve(true);
    },
    whenListening(timeoutMs) {
      if (listening) return Promise.resolve(true);
      return new Promise((resolve) => {
        const done = (value: boolean) => {
          clearTimeout(timer);
          waiting.delete(done);
          resolve(value);
        };
        const timer = setTimeout(() => done(false), timeoutMs);
        waiting.add(done);
      });
    },
  };
}

export const chatKeysLayer = Layer.effect(
  ChatKeys,
  Effect.gen(function* () {
    const db = yield* Database;
    return ChatKeys.of(makeChatKeys(chatEnabled(db)));
  }),
);
