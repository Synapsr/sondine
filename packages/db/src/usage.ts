import { transaction, type Database } from "./database";
import { str } from "./rows";

// The anonymous statistics' rows (ADR 042): the user's answer, and, only
// while it is a yes to the question asked now, what was counted and the
// reports waiting. Deleted text leaves the file too (`secure_delete`).

const CONSENT_KEY = "usage.consent";
const STATE_KEY = "usage.state";

export interface UsageConsentRow {
  readonly answer: "yes" | "no";
  /** The version of the question answered. */
  readonly version: number;
  readonly atMs: number;
}

function read(db: Database, key: string): unknown {
  const row = db.statement("SELECT value FROM settings WHERE key = ?").get(key);
  if (row === undefined) return null;
  try {
    return JSON.parse(str(row, "value"));
  } catch {
    return null;
  }
}

function write(db: Database, key: string, value: unknown, nowMs: number): void {
  db.statement(
    `INSERT INTO settings (key, value, updated_at_ms) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms`,
  ).run(key, JSON.stringify(value), nowMs);
}

export function usageConsent(db: Database): UsageConsentRow | null {
  const value = read(db, CONSENT_KEY);
  if (typeof value !== "object" || value === null) return null;
  const { answer, version, atMs } = value as Record<string, unknown>;
  return (answer === "yes" || answer === "no") &&
    typeof version === "number" &&
    typeof atMs === "number"
    ? { answer, version, atMs }
    : null;
}

/** Writes the answer and deletes everything counted under the one before. */
export function setUsageConsent(db: Database, consent: UsageConsentRow): void {
  transaction(db, () => {
    write(db, CONSENT_KEY, consent, consent.atMs);
    deleteUsageState(db);
  });
}

export function usageState(db: Database): unknown {
  return read(db, STATE_KEY);
}

export function saveUsageState(db: Database, state: unknown, nowMs: number): void {
  write(db, STATE_KEY, state, nowMs);
}

/** Whether there was anything to delete. */
export function deleteUsageState(db: Database): boolean {
  return db.statement("DELETE FROM settings WHERE key = ?").run(STATE_KEY).changes > 0;
}

/** The first run as `onboarding` keeps it: how far it went, and when it began. */
export function onboardingReached(
  db: Database,
): { readonly step: string; readonly startedAtMs: number } | null {
  const value = read(db, "onboarding");
  if (typeof value !== "object" || value === null) return null;
  const { step, startedAtMs, completedAtMs } = value as Record<string, unknown>;
  if (typeof step !== "string" || typeof startedAtMs !== "number") return null;
  return { step: typeof completedAtMs === "number" ? "done" : step, startedAtMs };
}
