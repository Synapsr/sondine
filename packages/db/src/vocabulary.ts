import { applyVocabulary, buildVocabulary, type Vocabulary } from "@sondine/core";
import type { Database } from "./database";
import { str } from "./rows";
import type { ProjectedSegment } from "./transcript-edits";

// Personal vocabulary at publish (M4; core's vocabulary.ts): what the user's
// corrections taught, read live, so a deleted correction teaches nothing.
// Applied after their corrections are projected, to segments without one,
// with the engine's text kept as the original (« Rétablir l'original », which
// then records a correction keeping what was heard, so it holds).

/** Corrections looked at: the most recent ones. */
const RECENT = 1_000;

function vocabularyOf(db: Database): Vocabulary {
  const corrections = db
    .statement(
      `SELECT payload FROM user_assertions WHERE kind = 'transcript_edit' AND revoked_at_ms IS NULL
       ORDER BY created_at_ms DESC, id DESC LIMIT ?`,
    )
    .all(RECENT)
    .flatMap((row) => {
      const payload = JSON.parse(str(row, "payload")) as { text?: unknown; original?: unknown };
      return typeof payload.text === "string" && typeof payload.original === "string"
        ? [{ text: payload.text, original: payload.original }]
        : [];
    });
  return buildVocabulary({ corrections });
}

/** A transcript's segments spelled as the user taught; never in media. */
export function spellAsTaught(
  db: Database,
  episodeId: number,
  segments: readonly ProjectedSegment[],
): ProjectedSegment[] {
  const episode = db.statement("SELECT context FROM episodes WHERE id = ?").get(episodeId);
  if (episode === undefined || episode["context"] === "media") return [...segments];
  const vocabulary = vocabularyOf(db);
  if (vocabulary.corrections.size === 0) return [...segments];
  return segments.map((segment) => {
    if (segment.editId !== null && segment.editId !== undefined) return segment;
    const { segment: spelled, replaced } = applyVocabulary(segment, vocabulary);
    // Word timings index the engine's text, kept as the original (as after a
    // correction in place), so a later split or republish cuts it right.
    return replaced === 0
      ? segment
      : {
          ...spelled,
          words: segment.words ?? null,
          originalText: segment.originalText ?? segment.text,
          editId: null,
        };
  });
}
