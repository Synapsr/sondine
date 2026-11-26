import { transaction, type Database } from "./database";
import { intersectsDeletedRange } from "./deleted-ranges";
import { currentRunId, type SegmentInput } from "./publish";
import { int, intOrNull, str, strOrNull, type Row } from "./rows";
import { searchTextOf } from "./search-text";

// Corrections of the transcript's text (M2; ADR 006). A correction is a
// `transcript_edit` assertion anchored to the segment's capture samples, so a
// reanalysis keeps it; the segment holds the corrected text in `text` (what
// search, exports and agents read) and the engine's in `original_text`, and
// points to its assertion (`edit_id`). Restoring puts the engine's text back
// and deletes the assertion: no corrected text stays behind. A deletion of the
// recording deletes the assertion with it (delete-episode.ts).
//
// When a new transcript replaces the old one, each correction replaces the
// words of the new segments of its track run that fall inside its anchor
// (by their timings; without timings, a segment at least half inside): the
// words around it stay as the engine wrote them, in their own segments, and
// pieces cut differently by the engine merge into one corrected segment.
// Where two voices overlap on one track, the correction goes to the segment
// whose text is closest to what it corrected. A correction that matches
// nothing, or would span a deleted stretch, stays for the next transcript.

export type EditOutcome = "ok" | "stale" | "missing";

export interface SegmentEditInput {
  readonly episodeId: number;
  readonly runId: number;
  readonly segmentId: number;
  readonly nowMs: number;
}

interface EditedSegment {
  readonly id: number;
  readonly trackRunId: number;
  readonly sampleStart: number;
  readonly sampleEnd: number;
  readonly text: string;
  readonly searchText: string;
  readonly originalText: string | null;
  readonly editId: number | null;
  readonly lang: string | null;
}

/** The segment, when it belongs to the episode's current transcript `runId`. */
function findSegment(db: Database, input: SegmentEditInput): EditedSegment | EditOutcome {
  if (currentRunId(db, input.episodeId, "asr") !== input.runId) return "stale";
  const row = db
    .statement(
      `SELECT id, track_run_id, sample_start, sample_end, text, search_text, original_text, edit_id, lang
       FROM segments WHERE id = ? AND run_id = ? AND episode_id = ?`,
    )
    .get(input.segmentId, input.runId, input.episodeId);
  if (row === undefined) return "missing";
  return {
    id: int(row, "id"),
    trackRunId: int(row, "track_run_id"),
    sampleStart: int(row, "sample_start"),
    sampleEnd: int(row, "sample_end"),
    text: str(row, "text"),
    searchText: str(row, "search_text"),
    originalText: strOrNull(row, "original_text"),
    editId: intOrNull(row, "edit_id"),
    lang: strOrNull(row, "lang"),
  };
}

/** Rewrites a segment's text and its full-text entry (external content: by hand). */
function rewrite(
  db: Database,
  segment: EditedSegment,
  next: {
    readonly text: string;
    readonly originalText: string | null;
    readonly editId: number | null;
  },
  input: SegmentEditInput,
): void {
  const searchText = searchTextOf(next.text, segment.lang);
  db.statement(
    "INSERT INTO segments_fts (segments_fts, rowid, search_text) VALUES ('delete', ?, ?)",
  ).run(segment.id, segment.searchText);
  db.statement(
    "UPDATE segments SET text = ?, search_text = ?, original_text = ?, edit_id = ? WHERE id = ?",
  ).run(next.text, searchText, next.originalText, next.editId, segment.id);
  db.statement("INSERT INTO segments_fts (rowid, search_text) VALUES (?, ?)").run(
    segment.id,
    searchText,
  );
  // Today and its first words read again.
  db.statement("UPDATE episodes SET updated_at_ms = ? WHERE id = ?").run(
    input.nowMs,
    input.episodeId,
  );
}

const deleteEdit = (db: Database, editId: number | null) => {
  if (editId !== null) db.statement("DELETE FROM user_assertions WHERE id = ?").run(editId);
};

/** Corrects one segment's text; the engine's text stays for « Rétablir l'original ». */
export function editSegment(
  db: Database,
  input: SegmentEditInput & { readonly text: string },
): EditOutcome {
  return transaction(db, () => {
    const segment = findSegment(db, input);
    if (typeof segment === "string") return segment;
    const text = input.text.trim();
    const original = segment.originalText ?? segment.text;
    if (text === original) return restore(db, segment, input);
    if (text === segment.text) return "ok";
    deleteEdit(db, segment.editId);
    const row = db
      .statement(
        `INSERT INTO user_assertions (kind, track_run_id, sample_start, sample_end, payload, origin, created_at_ms)
         VALUES ('transcript_edit', ?, ?, ?, ?, 'app', ?) RETURNING id`,
      )
      .get(
        segment.trackRunId,
        segment.sampleStart,
        segment.sampleEnd,
        JSON.stringify({ text, original }),
        input.nowMs,
      );
    if (row === undefined) throw new Error("user_assertions insert returned no row");
    rewrite(db, segment, { text, originalText: original, editId: int(row, "id") }, input);
    return "ok";
  });
}

function restore(db: Database, segment: EditedSegment, input: SegmentEditInput): EditOutcome {
  if (segment.originalText === null) return "ok";
  if (segment.editId === null) {
    // A spelling the vocabulary chose (vocabulary.ts): keeping what was heard
    // is the user's word, recorded so a later publish does not spell it again.
    const row = db
      .statement(
        `INSERT INTO user_assertions (kind, track_run_id, sample_start, sample_end, payload, origin, created_at_ms)
         VALUES ('transcript_edit', ?, ?, ?, ?, 'app', ?) RETURNING id`,
      )
      .get(
        segment.trackRunId,
        segment.sampleStart,
        segment.sampleEnd,
        JSON.stringify({ text: segment.originalText, original: segment.originalText }),
        input.nowMs,
      );
    if (row === undefined) throw new Error("user_assertions insert returned no row");
    rewrite(
      db,
      segment,
      { text: segment.originalText, originalText: null, editId: int(row, "id") },
      input,
    );
    return "ok";
  }
  deleteEdit(db, segment.editId);
  rewrite(db, segment, { text: segment.originalText, originalText: null, editId: null }, input);
  return "ok";
}

/**
 * A segment of a current transcript spelled as the user's names ask, by
 * Sondine rather than by the user (ADR 046): the engine's text stays as the
 * original, so « Rétablir l'original » still works, and no correction is
 * recorded. False when the segment was corrected by the user, changed since
 * `expected` was read, or is gone.
 */
export function respellSegment(
  db: Database,
  input: {
    readonly segmentId: number;
    readonly expected: string;
    readonly text: string;
    readonly nowMs: number;
  },
): boolean {
  const row = db
    .statement(
      `SELECT id, episode_id, run_id, track_run_id, sample_start, sample_end, text, search_text,
         original_text, edit_id, lang FROM segments WHERE id = ?`,
    )
    .get(input.segmentId);
  if (row === undefined || intOrNull(row, "edit_id") !== null) return false;
  if (str(row, "text") !== input.expected || input.text === input.expected) return false;
  const episodeId = int(row, "episode_id");
  const runId = int(row, "run_id");
  if (currentRunId(db, episodeId, "asr") !== runId) return false;
  rewrite(
    db,
    {
      id: int(row, "id"),
      trackRunId: int(row, "track_run_id"),
      sampleStart: int(row, "sample_start"),
      sampleEnd: int(row, "sample_end"),
      text: str(row, "text"),
      searchText: str(row, "search_text"),
      originalText: strOrNull(row, "original_text"),
      editId: null,
      lang: strOrNull(row, "lang"),
    },
    {
      text: input.text,
      originalText: strOrNull(row, "original_text") ?? input.expected,
      editId: null,
    },
    { episodeId, runId, segmentId: input.segmentId, nowMs: input.nowMs },
  );
  return true;
}

/** Puts the engine's text back and forgets the correction. */
export function restoreSegment(db: Database, input: SegmentEditInput): EditOutcome {
  return transaction(db, () => {
    const segment = findSegment(db, input);
    return typeof segment === "string" ? segment : restore(db, segment, input);
  });
}

/**
 * Shows a segment of a current transcript as ⌘Z restores it (undo.ts): its
 * text, the engine's text when corrected, and the correction it points to.
 */
export function showSegmentText(
  db: Database,
  input: {
    readonly segmentId: number;
    readonly text: string;
    readonly originalText: string | null;
    readonly editId: number | null;
    readonly nowMs: number;
  },
): void {
  const row = db
    .statement(
      `SELECT id, episode_id, run_id, track_run_id, sample_start, sample_end, text, search_text,
         original_text, edit_id, lang FROM segments WHERE id = ?`,
    )
    .get(input.segmentId);
  if (row === undefined) throw new Error(`segment ${input.segmentId} vanished`);
  rewrite(
    db,
    {
      id: int(row, "id"),
      trackRunId: int(row, "track_run_id"),
      sampleStart: int(row, "sample_start"),
      sampleEnd: int(row, "sample_end"),
      text: str(row, "text"),
      searchText: str(row, "search_text"),
      originalText: strOrNull(row, "original_text"),
      editId: intOrNull(row, "edit_id"),
      lang: strOrNull(row, "lang"),
    },
    { text: input.text, originalText: input.originalText, editId: input.editId },
    {
      episodeId: int(row, "episode_id"),
      runId: int(row, "run_id"),
      segmentId: input.segmentId,
      nowMs: input.nowMs,
    },
  );
}

/** A segment about to be published, with the correction it carries. */
export interface ProjectedSegment extends SegmentInput {
  readonly originalText?: string | null;
  readonly editId?: number | null;
}

interface ActiveEdit {
  readonly id: number;
  readonly trackRunId: number;
  readonly sampleStart: number;
  readonly sampleEnd: number;
  readonly text: string;
  readonly original: string;
}

function editOf(row: Row): ActiveEdit | null {
  const payload = JSON.parse(str(row, "payload")) as { text?: unknown; original?: unknown };
  if (typeof payload.text !== "string" || payload.text === "") return null;
  return {
    id: int(row, "id"),
    trackRunId: int(row, "track_run_id"),
    sampleStart: int(row, "sample_start"),
    sampleEnd: Math.max(int(row, "sample_end"), int(row, "sample_start") + 1),
    text: payload.text,
    original: typeof payload.original === "string" ? payload.original : "",
  };
}

const span = (segment: SegmentInput) => Math.max(1, segment.sampleEnd - segment.sampleStart);
const overlap = (segment: SegmentInput, edit: ActiveEdit) =>
  Math.max(
    0,
    Math.min(Math.max(segment.sampleEnd, segment.sampleStart + 1), edit.sampleEnd) -
      Math.max(segment.sampleStart, edit.sampleStart),
  );

/** Shared words over all words, after fr-norm: how close two texts are. */
function closeness(a: string, b: string, lang: string | null | undefined): number {
  const words = (text: string) => new Set(searchTextOf(text, lang).split(/\s+/u).filter(Boolean));
  const left = words(a);
  const right = words(b);
  if (left.size === 0 && right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** A stretch of a segment, cut at word boundaries. */
interface Cut {
  readonly before: ProjectedSegment | null;
  readonly inside: ProjectedSegment;
  readonly after: ProjectedSegment | null;
}

/**
 * Cuts `segment` where its words leave the edit's anchor (a word belongs
 * where its middle is). Without word timings, the whole segment is inside
 * when at least half of it is, else nothing is.
 */
function cut(segment: SegmentInput, edit: ActiveEdit): Cut | null {
  const words = segment.words ?? [];
  if (words.length === 0) {
    return overlap(segment, edit) * 2 >= span(segment)
      ? { before: null, inside: segment, after: null }
      : null;
  }
  const durationMs = Math.max(1, segment.endMs - segment.startMs);
  const perMs = (segment.sampleEnd - segment.sampleStart) / durationMs;
  const sampleAt = (ms: number) =>
    Math.min(segment.sampleEnd, segment.sampleStart + Math.round(ms * perMs));
  const where = words.map((word) => {
    const middle = sampleAt((word.startMs + word.endMs) / 2);
    return middle < edit.sampleStart ? -1 : middle >= edit.sampleEnd ? 1 : 0;
  });
  const first = where.indexOf(0);
  const last = where.lastIndexOf(0);
  if (first === -1) return null;
  const piece = (from: number, to: number): ProjectedSegment | null => {
    const head = words[from];
    const tail = words[to - 1];
    if (from >= to || head === undefined || tail === undefined) return null;
    const startMs = from === 0 ? 0 : head.startMs;
    const endMs = to === words.length ? durationMs : tail.endMs;
    const charStart = from === 0 ? 0 : head.charStart;
    const charEnd = to === words.length ? segment.text.length : tail.charEnd;
    const text = segment.text.slice(charStart, charEnd).trim();
    if (text === "") return null;
    const lead = segment.text.slice(charStart, charEnd).search(/\S/u);
    return {
      ...segment,
      sampleStart: from === 0 ? segment.sampleStart : sampleAt(startMs),
      sampleEnd: to === words.length ? segment.sampleEnd : sampleAt(endMs),
      startMs: segment.startMs + startMs,
      endMs: segment.startMs + endMs,
      text,
      words: words.slice(from, to).map((word) => ({
        ...word,
        charStart: word.charStart - charStart - lead,
        charEnd: word.charEnd - charStart - lead,
        startMs: word.startMs - startMs,
        endMs: word.endMs - startMs,
      })),
    };
  };
  const inside = piece(first, last + 1);
  if (inside === null) return null;
  return { before: piece(0, first), inside, after: piece(last + 1, words.length) };
}

/**
 * The segments of a new transcript with the user's corrections applied (see
 * the module comment), in time order. Called by publish, in its transaction,
 * so a correction made while the transcript was computed is kept.
 */
export function projectTranscriptEdits(
  db: Database,
  segments: readonly SegmentInput[],
): ProjectedSegment[] {
  const trackRuns = [...new Set(segments.map((segment) => segment.trackRunId))];
  if (trackRuns.length === 0) return [...segments];
  const edits = db
    .statement(
      `SELECT id, track_run_id, sample_start, sample_end, payload FROM user_assertions
       WHERE kind = 'transcript_edit' AND revoked_at_ms IS NULL
         AND track_run_id IN (${trackRuns.map(() => "?").join(", ")})
       ORDER BY created_at_ms, id`,
    )
    .all(...trackRuns)
    .flatMap((row) => editOf(row) ?? []);
  let out: ProjectedSegment[] = [...segments];
  const corrected = new Set<ProjectedSegment>();
  for (const edit of edits) {
    const candidates = out
      .filter(
        (segment) =>
          segment.trackRunId === edit.trackRunId &&
          !corrected.has(segment) &&
          overlap(segment, edit) > 0,
      )
      .toSorted((a, b) => a.sampleStart - b.sampleStart);
    let reach = -Infinity;
    let concurrent = false;
    for (const candidate of candidates) {
      if (candidate.sampleStart < reach) concurrent = true;
      reach = Math.max(reach, candidate.sampleEnd);
    }
    // Two voices over each other: the correction belongs to the one it corrected.
    const chosen = concurrent
      ? [
          candidates.reduce((best, candidate) => {
            const gain =
              closeness(candidate.text, edit.original, candidate.lang) -
              closeness(best.text, edit.original, best.lang);
            return gain > 0 || (gain === 0 && overlap(candidate, edit) > overlap(best, edit))
              ? candidate
              : best;
          }),
        ]
      : candidates;
    const cuts = chosen.flatMap((segment) => {
      const parts = cut(segment, edit);
      return parts === null ? [] : [{ segment, parts }];
    });
    const [head] = cuts;
    if (head === undefined) continue;
    const insides = cuts.map(({ parts }) => parts.inside);
    const voice = insides.reduce((best, part) => (span(part) > span(best) ? part : best));
    // One whole segment keeps its engine words (they index `originalText`, as
    // after a correction in place); pieces joined have none of their own.
    const whole =
      cuts.length === 1 && head.parts.before === null && head.parts.after === null
        ? head.parts.inside
        : null;
    const merged: ProjectedSegment = {
      trackRunId: edit.trackRunId,
      sampleStart: Math.min(...insides.map((part) => part.sampleStart)),
      sampleEnd: Math.max(...insides.map((part) => part.sampleEnd)),
      startMs: Math.min(...insides.map((part) => part.startMs)),
      endMs: Math.max(...insides.map((part) => part.endMs)),
      text: edit.text,
      speakerLabel: voice.speakerLabel ?? null,
      lang: head.parts.inside.lang ?? null,
      confidence: whole?.confidence ?? null,
      words: whole?.words ?? null,
      originalText: insides.map((part) => part.text).join(" "),
      editId: edit.id,
    };
    // Never one segment over a deleted stretch the pieces stayed clear of.
    const crossesDeletion = intersectsDeletedRange(db, {
      trackRunId: merged.trackRunId,
      sampleStart: merged.sampleStart,
      sampleEnd: merged.sampleEnd,
      wallStartMs: merged.startMs,
      wallEndMs: Math.max(merged.endMs, merged.startMs + 1),
    });
    if (crossesDeletion) continue;
    const replaced = new Set(cuts.map(({ segment }) => segment));
    const kept = cuts.flatMap(({ parts }) =>
      [parts.before, parts.after].filter((part): part is ProjectedSegment => part !== null),
    );
    out = [...out.filter((segment) => !replaced.has(segment)), ...kept, merged];
    corrected.add(merged);
  }
  return out.toSorted(
    (a, b) => a.startMs - b.startMs || a.trackRunId - b.trackRunId || a.sampleStart - b.sampleStart,
  );
}
