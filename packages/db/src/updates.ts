import type { Database } from "./database";
import { str } from "./rows";

// Updates (ADR 045): the user's answer, when the check last asked (its rhythm
// holds across launches), what the last answer said, the version handed to
// main to install, the one Sondine refused, and the note of the last update.

const AUTOMATIC_KEY = "updates.automatic";
/** The daily check people turned on before 0.8.0: their yes was for the check alone. */
const EARLIER_CHECK_KEY = "updates.check";
const ASKED_KEY = "updates.askedAtMs";
const ANSWER_KEY = "updates.answer";
const INSTALLING_KEY = "updates.installing";
const REFUSED_KEY = "updates.refused";
const UPDATED_KEY = "updates.updated";

function read(db: Database, key: string): unknown {
  const row = db.statement("SELECT value FROM settings WHERE key = ?").get(key);
  return row === undefined ? undefined : JSON.parse(str(row, "value"));
}

function write(db: Database, key: string, value: unknown, nowMs: number): void {
  db.statement(
    `INSERT INTO settings (key, value, updated_at_ms) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms`,
  ).run(key, JSON.stringify(value), nowMs);
}

function remove(db: Database, key: string): void {
  db.statement("DELETE FROM settings WHERE key = ?").run(key);
}

function record(db: Database, key: string): Record<string, unknown> | null {
  const value = read(db, key);
  return typeof value === "object" && value !== null ? { ...value } : null;
}

/** « Mettre Sondine à jour automatiquement »: the user's answer, or null before one. */
export function automaticUpdates(db: Database): boolean | null {
  const value = read(db, AUTOMATIC_KEY);
  return typeof value === "boolean" ? value : null;
}

/** The answer also replaces the earlier yes to the check alone. */
export function setAutomaticUpdates(db: Database, automatic: boolean, nowMs: number): void {
  write(db, AUTOMATIC_KEY, automatic, nowMs);
  remove(db, EARLIER_CHECK_KEY);
}

/** A yes from before 0.8.0, to the check alone. */
export function earlierUpdateCheck(db: Database): boolean {
  return read(db, EARLIER_CHECK_KEY) === true;
}

/** When the check last asked; null before the first time. */
export function lastUpdateAsk(db: Database): number | null {
  const value = read(db, ASKED_KEY);
  return typeof value === "number" ? value : null;
}

export function recordUpdateAsk(db: Database, nowMs: number): void {
  write(db, ASKED_KEY, nowMs, nowMs);
}

export interface UpdateAnswer {
  /** The newest published version GitHub named. */
  readonly version: string;
  readonly answeredAtMs: number;
  /** The whole file, as core parses it; absent in an answer from before 0.8.0. */
  readonly feed: unknown;
}

export function lastUpdateAnswer(db: Database): UpdateAnswer | null {
  const value = record(db, ANSWER_KEY);
  if (value === null) return null;
  const { version, answeredAtMs, feed } = value;
  return typeof version === "string" && typeof answeredAtMs === "number"
    ? { version, answeredAtMs, feed }
    : null;
}

export function recordUpdateAnswer(db: Database, answer: UpdateAnswer): void {
  write(db, ANSWER_KEY, answer, answer.answeredAtMs);
}

export interface UpdateInstalling {
  readonly from: string;
  readonly to: string;
}

/** The version handed to main to install, until the next start says how it went. */
export function updateInstalling(db: Database): UpdateInstalling | null {
  const value = record(db, INSTALLING_KEY);
  return typeof value?.["from"] === "string" && typeof value["to"] === "string"
    ? { from: value["from"], to: value["to"] }
    : null;
}

export function recordUpdateInstalling(
  db: Database,
  installing: UpdateInstalling | null,
  nowMs: number,
): void {
  if (installing === null) remove(db, INSTALLING_KEY);
  else write(db, INSTALLING_KEY, installing, nowMs);
}

export interface UpdateRefused {
  readonly version: string;
  readonly sha256: string;
  readonly problem: string;
}

/** The archive Sondine refused, not downloaded again on its own. */
export function updateRefused(db: Database): UpdateRefused | null {
  const value = record(db, REFUSED_KEY);
  return typeof value?.["version"] === "string" &&
    typeof value["sha256"] === "string" &&
    typeof value["problem"] === "string"
    ? { version: value["version"], sha256: value["sha256"], problem: value["problem"] }
    : null;
}

export function recordUpdateRefused(
  db: Database,
  refused: UpdateRefused | null,
  nowMs: number,
): void {
  if (refused === null) remove(db, REFUSED_KEY);
  else write(db, REFUSED_KEY, refused, nowMs);
}

/** The version the last update brought, until the user closes its note. */
export function updatedNote(db: Database): string | null {
  const value = record(db, UPDATED_KEY);
  return typeof value?.["version"] === "string" ? value["version"] : null;
}

export function recordUpdatedNote(db: Database, version: string | null, nowMs: number): void {
  if (version === null) remove(db, UPDATED_KEY);
  else write(db, UPDATED_KEY, { version }, nowMs);
}

/** What capture is in the middle of, as the database knows it (ADR 045). */
export interface CaptureGoingOn {
  /** A call, or another app listening to the microphone (a dictation). */
  readonly call: boolean;
  readonly dictation: boolean;
  /** A recording still open. */
  readonly conversation: boolean;
  /** The window's player. */
  readonly playback: boolean;
}

export function captureGoingOn(db: Database, nowMs: number): CaptureGoingOn {
  const exists = (sql: string, ...values: number[]) =>
    db.statement(`SELECT EXISTS (${sql}) AS hit`).get(...values)?.["hit"] === 1;
  return {
    call: exists("SELECT 1 FROM calls WHERE end_reason IS NULL"),
    dictation: exists("SELECT 1 FROM listens WHERE end_reason IS NULL"),
    conversation: exists("SELECT 1 FROM episodes WHERE state = 'open'"),
    playback: exists("SELECT 1 FROM self_playbacks WHERE ended_wall_ms > ?", nowMs),
  };
}
