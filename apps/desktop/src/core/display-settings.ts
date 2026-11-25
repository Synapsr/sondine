import { DisplaySettings, type DisplayUpdateInput } from "@sondine/api";
import type { OpenedDatabase } from "@sondine/db";

// How the window shows things, kept across launches in the settings table
// (Téo, 2026-11-20): Today's commitments folded, and the day's filter menu
// (media, dictations), one choice for Today and the calendar's day. Null is
// « not chosen yet », so the window's default never stands in for a choice.

const SETTINGS_KEY = "display";

const NOT_CHOSEN: DisplaySettings = { commitmentsFolded: false, media: null, dictations: null };

/** Fields a later release adds read as not chosen on older rows. */
const Stored = DisplaySettings.partial();

export function readDisplaySettings(db: OpenedDatabase): DisplaySettings {
  const raw = db.statement("SELECT value FROM settings WHERE key = ?").get(SETTINGS_KEY)?.["value"];
  if (typeof raw !== "string") return NOT_CHOSEN;
  try {
    const parsed = Stored.safeParse(JSON.parse(raw));
    if (!parsed.success) return NOT_CHOSEN;
    return {
      commitmentsFolded: parsed.data.commitmentsFolded ?? NOT_CHOSEN.commitmentsFolded,
      media: parsed.data.media ?? null,
      dictations: parsed.data.dictations ?? null,
    };
  } catch {
    return NOT_CHOSEN;
  }
}

/** Changes only the fields given; returns the settings as stored. */
export function updateDisplaySettings(
  db: OpenedDatabase,
  input: DisplayUpdateInput,
  nowMs: number,
): DisplaySettings {
  const next: DisplaySettings = { ...readDisplaySettings(db) };
  if (input.commitmentsFolded !== undefined) next.commitmentsFolded = input.commitmentsFolded;
  if (input.media !== undefined) next.media = input.media;
  if (input.dictations !== undefined) next.dictations = input.dictations;
  db.statement(
    "INSERT INTO settings (key, value, updated_at_ms) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms",
  ).run(SETTINGS_KEY, JSON.stringify(next), nowMs);
  return next;
}
