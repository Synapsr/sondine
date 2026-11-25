import { agentsEnabled } from "@sondine/db";
import { Context, Effect, Layer } from "effect";
import { Database } from "../database";

// What agent access needs to know beside the database (ADR 011): whether the
// user's switch is on, which agents are connected right now, and the content
// generation. The generation moves the moment anything is deleted (an
// episode, a range, a person) or names stop being read; an agent's answer
// read before that move is never sent.

export interface AgentAccessService {
  readonly enabled: () => boolean;
  /** The user flipped the switch (already stored); the host opens or closes its socket. */
  readonly setEnabled: (enabled: boolean) => void;
  readonly onEnabledChange: (listener: (enabled: boolean) => void) => () => void;
  /** Whether the host listens right now. */
  readonly listening: () => boolean;
  readonly setListening: (listening: boolean) => void;
  readonly contentGeneration: () => number;
  /** Called synchronously, in the same turn as the deletion's commit. */
  readonly contentChanged: () => void;
  /** A live session of an agent; `close` ends it. Returns its unregistration. */
  readonly registerSession: (agentId: number, close: () => void) => () => void;
  /** Ends every session of one agent, or of all of them. */
  readonly closeSessions: (agentId?: number) => void;
  readonly connectedAgents: () => ReadonlySet<number>;
}

export class AgentAccess extends Context.Service<AgentAccess, AgentAccessService>()(
  "sondine/core/AgentAccess",
) {}

export function makeAgentAccess(initiallyEnabled: boolean): AgentAccessService {
  let enabled = initiallyEnabled;
  let listening = false;
  let generation = 0;
  const listeners = new Set<(enabled: boolean) => void>();
  const sessions = new Map<symbol, { readonly agentId: number; readonly close: () => void }>();
  return {
    enabled: () => enabled,
    setEnabled(next) {
      if (next === enabled) return;
      enabled = next;
      for (const listener of listeners) listener(next);
    },
    onEnabledChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    listening: () => listening,
    setListening(next) {
      listening = next;
    },
    contentGeneration: () => generation,
    contentChanged() {
      generation += 1;
    },
    registerSession(agentId, close) {
      const key = Symbol("session");
      sessions.set(key, { agentId, close });
      return () => sessions.delete(key);
    },
    closeSessions(agentId) {
      // Deleting while iterating a Map is safe: closing also unregisters.
      for (const [key, session] of sessions) {
        if (agentId !== undefined && session.agentId !== agentId) continue;
        sessions.delete(key);
        session.close();
      }
    },
    connectedAgents: () => new Set([...sessions.values()].map((session) => session.agentId)),
  };
}

export const agentAccessLayer = Layer.effect(
  AgentAccess,
  Effect.gen(function* () {
    const db = yield* Database;
    return AgentAccess.of(makeAgentAccess(agentsEnabled(db)));
  }),
);
