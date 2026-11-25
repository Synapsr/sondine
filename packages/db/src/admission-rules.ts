import type { Database } from "./database";
import { str } from "./rows";

// What automatic transcription waits for (ADR 016 admission), as the user
// set it in the "why it waits" panel: power, two minutes of idle, and memory
// at normal pressure are on by default; each can be turned off. Heat always
// counts.

export interface WaitFor {
  readonly power: boolean;
  readonly idle: boolean;
  /** Off: automatic jobs load at warn pressure, as a request does (never at critical). */
  readonly memory: boolean;
}

export const WAIT_FOR_ALL: WaitFor = { power: true, idle: true, memory: true };

const KEY = "analysis.waitFor";

export function waitFor(db: Database): WaitFor {
  const row = db.statement("SELECT value FROM settings WHERE key = ?").get(KEY);
  if (row === undefined) return WAIT_FOR_ALL;
  const value: unknown = JSON.parse(str(row, "value"));
  const stored =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return {
    power: stored["power"] !== false,
    idle: stored["idle"] !== false,
    memory: stored["memory"] !== false,
  };
}

export function setWaitFor(
  db: Database,
  condition: keyof WaitFor,
  wait: boolean,
  nowMs: number,
): WaitFor {
  const next = { ...waitFor(db), [condition]: wait };
  db.statement(
    `INSERT INTO settings (key, value, updated_at_ms) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms`,
  ).run(KEY, JSON.stringify(next), nowMs);
  return next;
}
