import type { Database } from "./database";
import { str } from "./rows";

// Whether a call is said when it starts (ADR 036): on by default, with the apps
// whose calls the user asked never to be notified again (« Pas pour <app> »),
// the latest first.

const ENABLED_KEY = "callOffers.enabled";
const MUTED_KEY = "callOffers.mutedApps";
const MUTED_MAX = 200;

const UPSERT = `INSERT INTO settings (key, value, updated_at_ms) VALUES (?, ?, ?)
  ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms`;

export interface MutedCallApp {
  readonly bundleId: string;
  readonly name: string;
}

function read(db: Database, key: string): unknown {
  const row = db.statement("SELECT value FROM settings WHERE key = ?").get(key);
  if (row === undefined) return undefined;
  try {
    return JSON.parse(str(row, "value"));
  } catch {
    return undefined;
  }
}

export function callOffersEnabled(db: Database): boolean {
  return read(db, ENABLED_KEY) !== false;
}

export function setCallOffersEnabled(db: Database, on: boolean, nowMs: number): void {
  db.statement(UPSERT).run(ENABLED_KEY, JSON.stringify(on), nowMs);
}

export function mutedCallApps(db: Database): MutedCallApp[] {
  const value = read(db, MUTED_KEY);
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown): MutedCallApp[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const bundleId: unknown = Reflect.get(entry, "bundleId");
    const name: unknown = Reflect.get(entry, "name");
    return typeof bundleId === "string" && typeof name === "string" ? [{ bundleId, name }] : [];
  });
}

function saveMuted(db: Database, apps: readonly MutedCallApp[], nowMs: number): void {
  db.statement(UPSERT).run(MUTED_KEY, JSON.stringify(apps.slice(0, MUTED_MAX)), nowMs);
}

/** « Pas pour cette app »: first in the list, once. */
export function muteCallApp(db: Database, app: MutedCallApp, nowMs: number): void {
  saveMuted(
    db,
    [app, ...mutedCallApps(db).filter((entry) => entry.bundleId !== app.bundleId)],
    nowMs,
  );
}

/** « Prévenir à nouveau ». */
export function unmuteCallApp(db: Database, bundleId: string, nowMs: number): void {
  saveMuted(
    db,
    mutedCallApps(db).filter((entry) => entry.bundleId !== bundleId),
    nowMs,
  );
}
