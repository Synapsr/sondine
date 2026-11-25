import type { Database } from "./database";
import { str } from "./rows";

// The journal's settings (ADR 028): whether Sondine writes it, in which
// language its next lines are written (the window's), and who writes them:
// this Mac, this Mac read again by the user's Claude, or their Claude.

export type JournalLanguageSetting = "fr" | "en";

export const JOURNAL_WRITERS = ["device", "device-checked", "claude"] as const;
export type JournalWriter = (typeof JOURNAL_WRITERS)[number];

export interface JournalSettingsRow {
  readonly enabled: boolean;
  readonly language: JournalLanguageSetting;
  readonly writer: JournalWriter;
}

const KEY = "journal.settings";
const DEFAULTS: JournalSettingsRow = { enabled: true, language: "fr", writer: "device" };

export function journalSettings(db: Database): JournalSettingsRow {
  const row = db.statement("SELECT value FROM settings WHERE key = ?").get(KEY);
  if (row === undefined) return DEFAULTS;
  const value: unknown = JSON.parse(str(row, "value"));
  if (typeof value !== "object" || value === null) return DEFAULTS;
  const enabled = "enabled" in value ? value.enabled : undefined;
  const language = "language" in value ? value.language : undefined;
  const writer = "writer" in value ? value.writer : undefined;
  return {
    enabled: enabled !== false,
    language: language === "en" ? "en" : "fr",
    writer: JOURNAL_WRITERS.find((candidate) => candidate === writer) ?? "device",
  };
}

export function setJournalSettings(
  db: Database,
  change: Partial<JournalSettingsRow>,
  nowMs: number,
): JournalSettingsRow {
  const next = { ...journalSettings(db), ...change };
  db.statement(
    `INSERT INTO settings (key, value, updated_at_ms) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms`,
  ).run(KEY, JSON.stringify(next), nowMs);
  return next;
}
