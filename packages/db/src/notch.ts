import type { Database } from "./database";
import { str } from "./rows";

// Call context beside the notch (ADR 025): whether resting the pointer on
// it opens it. On by default; off, it opens on a click and the pointer only
// shows the name.

const HOVER_KEY = "notch.openOnHover";

export function notchOpensOnHover(db: Database): boolean {
  const row = db.statement("SELECT value FROM settings WHERE key = ?").get(HOVER_KEY);
  return row === undefined || JSON.parse(str(row, "value")) !== false;
}

export function setNotchOpensOnHover(db: Database, on: boolean, nowMs: number): void {
  db.statement(
    `INSERT INTO settings (key, value, updated_at_ms) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms`,
  ).run(HOVER_KEY, JSON.stringify(on), nowMs);
}
