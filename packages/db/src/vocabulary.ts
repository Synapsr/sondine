import { createHash } from "node:crypto";
import {
  applyVocabulary,
  buildVocabulary,
  nameWords,
  namesWrittenIn,
  respell,
  tagKey,
  VOCABULARY_CHECK_VERSION,
  VOCABULARY_VERSION,
  vocabularyCandidates,
  type Vocabulary,
  type VocabularyCheckItem,
} from "@sondine/core";
import { transaction, type Database } from "./database";
import { int, intOrNull, str, strOrNull } from "./rows";
import { respellSegment, type ProjectedSegment } from "./transcript-edits";

// Personal vocabulary (M4, ADR 046; core's vocabulary.ts): what the user's
// corrections taught, read live, so a deleted correction teaches nothing,
// and the user's names: their Vocabulary list and their People.
// - At publish, applied after their corrections are projected, to segments
//   without one, with the engine's text kept as the original (« Rétablir
//   l'original », which then records a correction keeping what was heard, so
//   it holds).
// - After publish, a name that only looks like one of theirs is read by the
//   journal's model (`vocabulary_passes`, `vocabulary_checks`), on the
//   recent transcripts only.

/** Corrections looked at: the most recent ones. */
const RECENT = 1_000;

/** Words in the list, at most. */
export const VOCABULARY_WORDS_MAX = 500;

/** A pass the model failed is tried again this many times, 10 minutes apart. */
export const VOCABULARY_MAX_ATTEMPTS = 3;
const RETRY_MS = 10 * 60_000;

/** Transcripts the model reads: those of the last 7 days. */
export const VOCABULARY_CHECK_DAYS = 7;

export interface VocabularyEntry {
  readonly id: number;
  readonly word: string;
  readonly note: string | null;
}

export interface VocabularyList {
  /** The user's words, alphabetical. */
  readonly words: readonly VocabularyEntry[];
  /** Their People's names, alphabetical: in the vocabulary without being in the list. */
  readonly people: readonly string[];
}

const byName = (a: string, b: string) => a.localeCompare(b, "fr", { sensitivity: "base" });

export function listVocabulary(db: Database): VocabularyList {
  const words = db
    .statement("SELECT id, word, note FROM vocabulary_words")
    .all()
    .map((row) => ({ id: int(row, "id"), word: str(row, "word"), note: strOrNull(row, "note") }))
    .sort((a, b) => byName(a.word, b.word));
  const listed = new Set(words.map((entry) => tagKey(entry.word)));
  const people = db
    .statement("SELECT name FROM people")
    .all()
    .map((row) => str(row, "name").trim())
    .filter((name) => !listed.has(tagKey(name)))
    .sort(byName);
  return { words, people: [...new Set(people)] };
}

export type VocabularyChange = { readonly id: number } | "exists" | "missing" | "full";

const cleanNote = (note: string | null | undefined) => {
  const trimmed = note?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
};

/** Adds a word to the list; the same word without case or accents is already there. */
export function addVocabularyWord(
  db: Database,
  input: { readonly word: string; readonly note?: string | null; readonly nowMs: number },
): VocabularyChange {
  return transaction(db, () => {
    const word = input.word.trim();
    const key = tagKey(word);
    if (db.statement("SELECT 1 FROM vocabulary_words WHERE key = ?").get(key) !== undefined) {
      return "exists";
    }
    const count = int(db.statement("SELECT count(*) AS n FROM vocabulary_words").get() ?? {}, "n");
    if (count >= VOCABULARY_WORDS_MAX) return "full";
    const row = db
      .statement(
        `INSERT INTO vocabulary_words (word, key, note, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(word, key, cleanNote(input.note), input.nowMs, input.nowMs);
    if (row === undefined) throw new Error("vocabulary_words insert returned no row");
    return { id: int(row, "id") };
  });
}

/** Changes a word of the list, its note, or both. */
export function updateVocabularyWord(
  db: Database,
  input: {
    readonly id: number;
    readonly word: string;
    readonly note?: string | null;
    readonly nowMs: number;
  },
): VocabularyChange {
  return transaction(db, () => {
    const word = input.word.trim();
    const key = tagKey(word);
    const other = db.statement("SELECT id FROM vocabulary_words WHERE key = ?").get(key);
    if (other !== undefined && int(other, "id") !== input.id) return "exists";
    const changed = db
      .statement(
        "UPDATE vocabulary_words SET word = ?, key = ?, note = ?, updated_at_ms = ? WHERE id = ?",
      )
      .run(word, key, cleanNote(input.note), input.nowMs, input.id);
    return Number(changed.changes) === 0 ? "missing" : { id: input.id };
  });
}

/** Takes a word off the list; what Sondine wrote with it stays, with the original. */
export function removeVocabularyWord(db: Database, id: number): boolean {
  return Number(db.statement("DELETE FROM vocabulary_words WHERE id = ?").run(id).changes) > 0;
}

interface VocabularyName {
  readonly name: string;
  readonly note: string | null;
  /** One of their People, rather than a word of their list. */
  readonly person: boolean;
}

/** The user's names, with the note of the list's words: the list first, then their People. */
export function vocabularyNames(db: Database): VocabularyName[] {
  const { words, people } = listVocabulary(db);
  return [
    ...words.map((entry) => ({ name: entry.word, note: entry.note, person: false })),
    ...people.map((name) => ({ name, note: null, person: true })),
  ];
}

/** The vocabulary as the user's corrections and names make it now. */
export function vocabularyOf(db: Database): Vocabulary {
  const corrections = db
    .statement(
      `SELECT payload FROM user_assertions WHERE kind = 'transcript_edit' AND revoked_at_ms IS NULL
       ORDER BY created_at_ms DESC, id DESC LIMIT ?`,
    )
    .all(RECENT)
    .flatMap((row) => {
      const payload: unknown = JSON.parse(str(row, "payload"));
      if (typeof payload !== "object" || payload === null) return [];
      const text = "text" in payload ? payload.text : undefined;
      const original = "original" in payload ? payload.original : undefined;
      return typeof text === "string" && typeof original === "string" ? [{ text, original }] : [];
    });
  return buildVocabulary({
    corrections,
    names: vocabularyNames(db).map((entry) => entry.name),
  });
}

/** What the engine wrote in a segment, before any correction or spelling: what a correction teaches from. */
export function segmentHeard(db: Database, segmentId: number): string | null {
  const row = db
    .statement("SELECT coalesce(original_text, text) AS heard FROM segments WHERE id = ?")
    .get(segmentId);
  return row === undefined ? null : str(row, "heard");
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
  if (vocabulary.corrections.size === 0 && vocabulary.names.size === 0) return [...segments];
  const written = namesWrittenIn(segments.map((segment) => segment.text));
  return segments.map((segment) => {
    if (segment.editId !== null && segment.editId !== undefined) return segment;
    const { segment: spelled, replaced } = applyVocabulary(segment, vocabulary, written);
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

/**
 * What makes a pass current: the names and taught spellings it read with,
 * whether the model was there to ask, and the versions of the rules and of
 * the request. A new name, a new correction or the model installed reads the
 * recent transcripts again (each word asked once).
 */
export function vocabularyNamesKey(db: Database, input: { readonly model: boolean }): string {
  const vocabulary = vocabularyOf(db);
  const words = [...vocabulary.names.values()].flat().sort();
  const taught = [...vocabulary.corrections.entries()]
    .map(([from, to]) => `${from}>${to}`)
    .toSorted();
  return createHash("sha256")
    .update(
      [
        VOCABULARY_VERSION,
        VOCABULARY_CHECK_VERSION,
        input.model ? "model" : "rule",
        ...words,
        "",
        ...taught,
      ].join("\n"),
    )
    .digest("hex")
    .slice(0, 16);
}

/**
 * An episode's current transcript spelled with the rule that needs no model,
 * as publish spells a new one: names that sound like the user's, and names
 * their corrections taught. Sentences the user corrected are theirs. Returns
 * the words rewritten.
 */
export function respellEpisode(
  db: Database,
  episodeId: number,
  vocabulary: Vocabulary,
  nowMs: number,
): number {
  return transaction(db, () => {
    const segments = db
      .statement(
        `SELECT s.id, s.text, s.edit_id FROM segments s
         JOIN episode_analysis a ON a.run_id = s.run_id AND a.stage = 'asr'
         WHERE s.episode_id = ? ORDER BY s.start_ms, s.seq`,
      )
      .all(episodeId)
      .map((row) => ({
        id: int(row, "id"),
        text: str(row, "text"),
        editId: intOrNull(row, "edit_id"),
      }));
    const written = namesWrittenIn(segments.map((segment) => segment.text));
    let replaced = 0;
    for (const segment of segments) {
      if (segment.editId !== null) continue;
      const spelled = applyVocabulary({ text: segment.text }, vocabulary, written);
      if (
        spelled.replaced > 0 &&
        respellSegment(db, {
          segmentId: segment.id,
          expected: segment.text,
          text: spelled.segment.text,
          nowMs,
        })
      ) {
        replaced += spelled.replaced;
      }
    }
    return replaced;
  });
}

/** The episodes whose transcript the model may read: closed, recent, not media or dictations. */
const ELIGIBLE_SQL = `
  FROM episodes e
  JOIN episode_analysis a ON a.episode_id = e.id AND a.stage = 'asr'
  LEFT JOIN vocabulary_passes p ON p.episode_id = e.id
  WHERE e.state = 'closed' AND e.context IN ('call', 'in_person', 'mixed', 'imported')
    AND e.started_at_ms >= :since
    AND (p.episode_id IS NULL OR p.run_id != a.run_id OR p.names_key != :key
      OR (p.status = 'failed' AND p.attempts < ${VOCABULARY_MAX_ATTEMPTS} AND p.finished_at_ms <= :retry))`;

/** The newest episode whose transcript was not read for the names `namesKey`; or this one, if it was not. */
export function nextVocabularyEpisode(
  db: Database,
  input: { readonly namesKey: string; readonly nowMs: number; readonly episodeId?: number },
): number | null {
  const row = db
    .statement(
      `SELECT e.id ${ELIGIBLE_SQL} ${input.episodeId === undefined ? "" : "AND e.id = :episode"}
       ORDER BY e.started_at_ms DESC, e.id DESC LIMIT 1`,
    )
    .get({
      since: input.nowMs - VOCABULARY_CHECK_DAYS * 86_400_000,
      key: input.namesKey,
      retry: input.nowMs - RETRY_MS,
      ...(input.episodeId === undefined ? {} : { episode: input.episodeId }),
    });
  return row === undefined ? null : int(row, "id");
}

/** Sentences shown before and after a word's own. */
const CONTEXT = 2;

/** A word to ask the model about, where it is. */
export interface VocabularyCheckTarget extends VocabularyCheckItem {
  readonly segmentId: number;
}

/**
 * The words of an episode's current transcript that look like one of the
 * user's names and were not asked about yet, each with its sentence and the
 * ones around it; and the run they were read from.
 */
export function loadVocabularyCheck(
  db: Database,
  episodeId: number,
  vocabulary: Vocabulary,
  notes: ReadonlyMap<string, Omit<VocabularyName, "name">>,
): { readonly runId: number; readonly targets: readonly VocabularyCheckTarget[] } | null {
  const run = db
    .statement("SELECT run_id FROM episode_analysis WHERE episode_id = ? AND stage = 'asr'")
    .get(episodeId);
  if (run === undefined) return null;
  const runId = int(run, "run_id");
  const segments = db
    .statement(
      `SELECT id, text, edit_id FROM segments WHERE run_id = ? AND episode_id = ?
       ORDER BY start_ms, seq`,
    )
    .all(runId, episodeId)
    .map((row) => ({
      id: int(row, "id"),
      text: str(row, "text"),
      editId: intOrNull(row, "edit_id"),
    }));
  const asked = new Set(
    db
      .statement(
        `SELECT c.segment_id, c.char_start, c.name FROM vocabulary_checks c
         JOIN segments s ON s.id = c.segment_id WHERE s.run_id = ? AND s.episode_id = ?`,
      )
      .all(runId, episodeId)
      .map((row) => `${int(row, "segment_id")}:${int(row, "char_start")}:${str(row, "name")}`),
  );
  const written = namesWrittenIn(segments.map((segment) => segment.text));
  const targets: VocabularyCheckTarget[] = [];
  for (const [index, segment] of segments.entries()) {
    // The user's own words are theirs.
    if (segment.editId !== null) continue;
    for (const candidate of vocabularyCandidates(segment.text, vocabulary, written)) {
      // Two close first names are most often two people: the model reads
      // only the words of the list (Téo's week: 2 of 12 People's wrong).
      const about = notes.get(candidate.name);
      if (about === undefined || about.person) continue;
      if (asked.has(`${segment.id}:${candidate.charStart}:${candidate.name}`)) continue;
      targets.push({
        segmentId: segment.id,
        name: candidate.name,
        note: about.note,
        word: candidate.word,
        before: segments.slice(Math.max(0, index - CONTEXT), index).map((other) => other.text),
        sentence: segment.text,
        charStart: candidate.charStart,
        charEnd: candidate.charEnd,
        after: segments.slice(index + 1, index + 1 + CONTEXT).map((other) => other.text),
      });
    }
  }
  return { runId, targets };
}

/** What the model is told of each name word: a list word's note goes to each of its words; the list first. */
export function vocabularyNotes(db: Database): Map<string, Omit<VocabularyName, "name">> {
  const notes = new Map<string, Omit<VocabularyName, "name">>();
  for (const entry of vocabularyNames(db)) {
    for (const word of nameWords([entry.name])) {
      if (!notes.has(word)) notes.set(word, { note: entry.note, person: entry.person });
    }
  }
  return notes;
}

/**
 * Ends a pass over one episode: stores the model's answers and spells each
 * word it said is the user's their way, in the sentence as it still is
 * (one the user corrected meanwhile, or that changed, is left). A failed pass
 * counts its attempt. Returns the words rewritten.
 */
export function finishVocabularyPass(
  db: Database,
  input: {
    readonly episodeId: number;
    readonly runId: number;
    readonly namesKey: string;
    readonly status: "done" | "failed";
    readonly answers: readonly {
      readonly target: VocabularyCheckTarget;
      readonly userWord: boolean;
    }[];
    readonly candidates: number;
    readonly nowMs: number;
  },
): number {
  return transaction(db, () => {
    const current = db
      .statement("SELECT run_id FROM episode_analysis WHERE episode_id = ? AND stage = 'asr'")
      .get(input.episodeId);
    // A new transcript since: the queue reads it again.
    if (current === undefined || int(current, "run_id") !== input.runId) return 0;
    let corrected = 0;
    const insert = db.statement(
      `INSERT OR IGNORE INTO vocabulary_checks (segment_id, char_start, name, verdict, config_key, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const [segmentId, answers] of Map.groupBy(
      input.answers,
      (answer) => answer.target.segmentId,
    )) {
      const row = db.statement("SELECT text FROM segments WHERE id = ?").get(segmentId);
      if (row === undefined) continue;
      const text = str(row, "text");
      const edits = answers
        .filter(
          ({ target, userWord }) =>
            userWord &&
            target.sentence === text &&
            text.slice(target.charStart, target.charEnd) === target.word,
        )
        .map(({ target }) => ({ start: target.charStart, end: target.charEnd, text: target.name }))
        .toSorted((a, b) => a.start - b.start);
      if (
        edits.length > 0 &&
        respellSegment(db, {
          segmentId,
          expected: text,
          text: respell({ text }, edits).text,
          nowMs: input.nowMs,
        })
      ) {
        corrected += edits.length;
      }
      for (const { target, userWord } of answers) {
        insert.run(
          segmentId,
          target.charStart,
          target.name,
          userWord ? "user_word" : "as_written",
          VOCABULARY_CHECK_VERSION,
          input.nowMs,
        );
      }
    }
    const previous = db
      .statement("SELECT run_id, names_key, attempts FROM vocabulary_passes WHERE episode_id = ?")
      .get(input.episodeId);
    const sameInput =
      previous !== undefined &&
      int(previous, "run_id") === input.runId &&
      str(previous, "names_key") === input.namesKey;
    const attempts =
      input.status === "failed" ? (sameInput ? int(previous, "attempts") : 0) + 1 : 0;
    db.statement(
      `INSERT INTO vocabulary_passes (episode_id, run_id, names_key, status, attempts, candidates, corrected, finished_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (episode_id) DO UPDATE SET run_id = excluded.run_id, names_key = excluded.names_key,
         status = excluded.status, attempts = excluded.attempts, candidates = excluded.candidates,
         corrected = excluded.corrected, finished_at_ms = excluded.finished_at_ms`,
    ).run(
      input.episodeId,
      input.runId,
      input.namesKey,
      input.status,
      attempts,
      input.candidates,
      corrected,
      input.nowMs,
    );
    return corrected;
  });
}
