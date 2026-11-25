import { frNorm, frNormId, type FrNormOptions, type NormLanguage } from "@sondine/core";
import { reindexContext } from "./context-items";
import { transaction, type Database } from "./database";
import { int, str } from "./rows";

/**
 * What `segments_fts` indexes: a segment's text through fr-norm with these
 * options (ADR 016). Changing them changes `searchNormalizerId`, and core
 * reindexes at startup.
 */
export const searchNormOptions = {
  fillers: "drop",
  numbers: "words",
  diacritics: "strip",
} as const satisfies Omit<FrNormOptions, "language">;

export const searchNormalizerId = frNormId(searchNormOptions);

const SETTING_KEY = "search.normalizer";

/** The normalization a segment is indexed with: French unless tagged English. */
export function searchLanguageOf(lang: string | null | undefined): NormLanguage {
  return lang?.toLowerCase().startsWith("en") === true ? "en" : "fr";
}

/** The indexed form of a segment's text, in its language (French unless tagged English). */
export function searchTextOf(text: string, lang?: string | null): string {
  return frNorm(text, { ...searchNormOptions, language: searchLanguageOf(lang) });
}

export interface SearchReindexReport {
  readonly normalizerId: string;
  /** Segments rewritten; 0 when the stored normalizer was already current. */
  readonly reindexed: number;
}

/**
 * Makes `segments.search_text` and the full-text index match the current
 * normalizer. Cheap when nothing changed: one settings read.
 */
export function ensureSearchNormalizer(db: Database, nowMs = Date.now()): SearchReindexReport {
  const stored = db.statement("SELECT value FROM settings WHERE key = ?").get(SETTING_KEY);
  if (stored !== undefined && JSON.parse(str(stored, "value")) === searchNormalizerId) {
    return { normalizerId: searchNormalizerId, reindexed: 0 };
  }
  return transaction(db, () => {
    const rows = db.statement("SELECT id, text, lang FROM segments").all();
    const update = db.statement("UPDATE segments SET search_text = ? WHERE id = ?");
    for (const row of rows) {
      const lang = row["lang"];
      update.run(
        searchTextOf(str(row, "text"), typeof lang === "string" ? lang : null),
        int(row, "id"),
      );
    }
    db.client.exec("INSERT INTO segments_fts (segments_fts) VALUES ('rebuild')");
    // Context is indexed with the same normalizer (ADR 024).
    reindexContext(db);
    db.statement(
      `INSERT INTO settings (key, value, updated_at_ms) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms`,
    ).run(SETTING_KEY, JSON.stringify(searchNormalizerId), nowMs);
    return { normalizerId: searchNormalizerId, reindexed: rows.length };
  });
}
