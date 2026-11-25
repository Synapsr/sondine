import { journalTextSimilarity } from "@sondine/core";
import { transaction, type Database } from "./database";
import { loadRunSpeakers, loadSelfSpeakers } from "./episode-sources";
import { journalEpisodeSql, loadJournalSource } from "./journal-input";
import { resolveSpeakers, type Person } from "./people";
import { int, intOrNull, oneOfValues, str, strOrNull, type Row } from "./rows";
import { knownVoices, readsAsPerson, shownSelf, voiceMatches, type KnownVoices } from "./voices";
import {
  journalItemKinds,
  journalMarkStatuses,
  type JournalItemKind,
  type JournalMarkStatus,
} from "./schema/enums";
import type { JournalRunMetrics } from "./schema/journal";

// The daily journal's store (ADR 028): its derived queue, its attempts and
// their publication, its reading with the user's marks applied.

/** Failed passes over one transcript with one configuration before the queue gives up on it. */
export const JOURNAL_MAX_FAILURES = 3;

/** A local day the user asked for, `[fromMs, toMs)`. */
export interface JournalRange {
  readonly fromMs: number;
  readonly toMs: number;
  /**
   * « Réécrire ce jour »: what was written before this time is written
   * again, by whoever writes the journal now.
   */
  readonly rewriteBeforeMs?: number;
}

/**
 * An episode to write: no current journal with this key written since
 * `:since` (0, or a day's rewrite), and fewer failures since then on its
 * transcript. The key is the prompt's version: who writes (this Mac or the
 * user's Claude) is the user's choice for what comes next, and never makes
 * a written journal old by itself.
 */
/**
 * A run's key is the prompt's version; one written before 2026-11-11 carries
 * it at the end of a longer key (`engine@1|model@1|journal-prompt/2`), and
 * is as current.
 */
const sameKey = `(r.config_key = :key OR r.config_key LIKE '%|' || :key)`;

const needsJournal = `${journalEpisodeSql}
  AND NOT EXISTS (SELECT 1 FROM journal_runs r
    WHERE r.episode_id = e.id AND r.status = 'published' AND r.stale = 0 AND ${sameKey}
      AND r.started_at_ms >= :since)
  AND (SELECT count(*) FROM journal_runs r
    JOIN episode_analysis ea ON ea.episode_id = e.id AND ea.stage = 'asr'
    WHERE r.episode_id = e.id AND r.status = 'failed' AND ${sameKey}
      AND r.asr_run_id = ea.run_id AND r.started_at_ms >= :since) < :maxFailures`;

/**
 * The next episode to write: in a day the user asked for first, then the
 * newest. Null when every eligible episode has a current journal or has
 * failed `JOURNAL_MAX_FAILURES` times on its transcript.
 */
export function nextJournalEpisode(
  db: Database,
  configKey: string,
  requested: readonly JournalRange[] = [],
): { readonly episodeId: number; readonly requested: boolean } | null {
  for (const range of requested) {
    const row = db
      .statement(
        `SELECT e.id FROM episodes e WHERE e.started_at_ms >= :from AND e.started_at_ms < :to
         AND ${needsJournal} ORDER BY e.started_at_ms DESC, e.id DESC LIMIT 1`,
      )
      .get({
        from: range.fromMs,
        to: range.toMs,
        key: configKey,
        since: range.rewriteBeforeMs ?? 0,
        maxFailures: JOURNAL_MAX_FAILURES,
      });
    if (row !== undefined) return { episodeId: int(row, "id"), requested: true };
  }
  const row = db
    .statement(
      `SELECT e.id FROM episodes e WHERE ${needsJournal}
       ORDER BY e.started_at_ms DESC, e.id DESC LIMIT 1`,
    )
    .get({ key: configKey, since: 0, maxFailures: JOURNAL_MAX_FAILURES });
  return row === undefined ? null : { episodeId: int(row, "id"), requested: false };
}

/** Episodes of `[fromMs, toMs)` still to write, and those that failed for good. */
export function journalPending(
  db: Database,
  configKey: string,
  range: JournalRange,
): { readonly pending: number; readonly failed: number } {
  const row = db
    .statement(
      `SELECT
         (SELECT count(*) FROM episodes e WHERE e.started_at_ms >= :from AND e.started_at_ms < :to
            AND ${needsJournal}) AS pending,
         (SELECT count(*) FROM episodes e WHERE e.started_at_ms >= :from AND e.started_at_ms < :to
            AND ${journalEpisodeSql}
            AND NOT EXISTS (SELECT 1 FROM journal_runs r WHERE r.episode_id = e.id
              AND r.status = 'published' AND ${sameKey} AND r.started_at_ms >= :since)
            AND (SELECT count(*) FROM journal_runs r
              JOIN episode_analysis ea ON ea.episode_id = e.id AND ea.stage = 'asr'
              WHERE r.episode_id = e.id AND r.status = 'failed' AND ${sameKey}
                AND r.asr_run_id = ea.run_id AND r.started_at_ms >= :since) >= :maxFailures) AS failed`,
    )
    .get({
      from: range.fromMs,
      to: range.toMs,
      key: configKey,
      since: range.rewriteBeforeMs ?? 0,
      maxFailures: JOURNAL_MAX_FAILURES,
    });
  return {
    pending: row === undefined ? 0 : int(row, "pending"),
    failed: row === undefined ? 0 : int(row, "failed"),
  };
}

export interface StartJournalRunInput {
  readonly episodeId: number;
  readonly asrRunId: number;
  readonly inputHash: string;
  readonly configKey: string;
  readonly engineId: string;
  readonly modelSha256: string | null;
  readonly speakerRefs: Readonly<Record<string, string>>;
  readonly nowMs: number;
}

/** A durable attempt, written before the model runs: a crash leaves it to `recoverJournalRuns`. */
export function startJournalRun(db: Database, input: StartJournalRunInput): number {
  const result = db
    .statement(
      `INSERT INTO journal_runs (episode_id, asr_run_id, input_hash, config_key, engine_id,
         model_sha256, status, speaker_refs, started_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
    )
    .run(
      input.episodeId,
      input.asrRunId,
      input.inputHash,
      input.configKey,
      input.engineId,
      input.modelSha256,
      JSON.stringify(input.speakerRefs),
      input.nowMs,
    );
  return Number(result.lastInsertRowid);
}

/** A failed attempt counts toward `JOURNAL_MAX_FAILURES`; a cancelled one does not. */
export function finishJournalRun(
  db: Database,
  runId: number,
  outcome: {
    readonly status: "failed" | "cancelled";
    readonly errorCode: string;
    readonly metrics: JournalRunMetrics;
    readonly nowMs: number;
  },
): void {
  db.statement(
    `UPDATE journal_runs SET status = ?, error_code = ?, metrics = ?, finished_at_ms = ?
     WHERE id = ? AND status = 'running'`,
  ).run(outcome.status, outcome.errorCode, JSON.stringify(outcome.metrics), outcome.nowMs, runId);
}

/** At start: attempts a stopped core left running are abandoned, never counted as failures. */
export function recoverJournalRuns(db: Database, nowMs: number): number {
  return Number(
    db
      .statement(
        `UPDATE journal_runs SET status = 'abandoned', finished_at_ms = ? WHERE status = 'running'`,
      )
      .run(nowMs).changes,
  );
}

export interface JournalItemInput {
  readonly kind: JournalItemKind;
  readonly text: string;
  readonly whoRef: string | null;
  readonly toRef: string | null;
  readonly due: string | null;
  readonly dueText: string | null;
  readonly segmentIds: readonly number[];
}

export type JournalPublishResult =
  | { readonly published: true; readonly items: number }
  | {
      readonly published: false;
      readonly reason: "run_missing" | "stale_input" | "bad_citation";
    };

/**
 * Publishes an attempt in one transaction, only while what it read still
 * holds: its row is there and running (a deleted sentence deleted it), and
 * the episode's input hashes the same now. Every citation must name a
 * sentence of that transcript. Older runs of the episode go, their items
 * with them.
 */
export function publishJournalRun(
  db: Database,
  input: {
    readonly runId: number;
    readonly items: readonly JournalItemInput[];
    readonly metrics: JournalRunMetrics;
    readonly timeZone: string;
    readonly nowMs: number;
  },
): JournalPublishResult {
  return transaction(db, (): JournalPublishResult => {
    const run = db
      .statement(
        `SELECT episode_id, asr_run_id, input_hash FROM journal_runs
         WHERE id = ? AND status = 'running'`,
      )
      .get(input.runId);
    if (run === undefined) return { published: false, reason: "run_missing" };
    const episodeId = int(run, "episode_id");
    const source = loadJournalSource(db, episodeId, input.timeZone, input.nowMs);
    if (
      source === null ||
      source.asrRunId !== int(run, "asr_run_id") ||
      source.inputHash !== str(run, "input_hash")
    ) {
      return { published: false, reason: "stale_input" };
    }
    const startOf = new Map(source.input.lines.map((line) => [line.segmentId, line.startMs]));
    if (
      input.items.some(
        (item) => item.segmentIds.length === 0 || item.segmentIds.some((id) => !startOf.has(id)),
      )
    ) {
      return { published: false, reason: "bad_citation" };
    }
    db.statement("DELETE FROM journal_runs WHERE episode_id = ? AND id <> ?").run(
      episodeId,
      input.runId,
    );
    const insertItem = db.statement(
      `INSERT INTO journal_items (run_id, episode_id, kind, seq, text, who_ref, to_ref, due,
         due_text, start_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertCitation = db.statement(
      "INSERT INTO journal_citations (item_id, ord, segment_id) VALUES (?, ?, ?)",
    );
    for (const [seq, item] of input.items.entries()) {
      const startMs = Math.min(...item.segmentIds.map((id) => startOf.get(id) ?? Infinity));
      const itemId = Number(
        insertItem.run(
          input.runId,
          episodeId,
          item.kind,
          seq,
          item.text,
          item.whoRef,
          item.toRef,
          item.due,
          item.dueText,
          startMs,
        ).lastInsertRowid,
      );
      for (const [ord, segmentId] of item.segmentIds.entries()) {
        insertCitation.run(itemId, ord, segmentId);
      }
    }
    db.statement(
      `UPDATE journal_runs SET status = 'published', metrics = ?, finished_at_ms = ? WHERE id = ?`,
    ).run(JSON.stringify(input.metrics), input.nowMs, input.runId);
    return { published: true, items: input.items.length };
  });
}

// Reading.

export interface JournalCitation {
  readonly segmentId: number;
  readonly episodeId: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly speakerLabel: string | null;
  readonly text: string;
}

export interface JournalMark {
  readonly id: number;
  readonly kind: JournalItemKind;
  readonly status: JournalMarkStatus;
  readonly text: string | null;
  readonly due: string | null;
  readonly dueEdited: boolean;
  readonly generatedText: string;
}

/** The voices of an item's transcript, by ref: a name when one is read, the user, an ordinal. */
export interface JournalVoice {
  /** The transcript's speaker label, as its sentences carry it. */
  readonly label: string;
  readonly name: string | null;
  readonly self: boolean;
  readonly ordinal: number | null;
  /**
   * Whom Sondine takes an unnamed voice for, at 80 % or more (ADR 030):
   * shown to confirm, never written into a line.
   */
  readonly guess: {
    readonly person: Person;
    readonly confidence: number;
    readonly recognized: boolean;
  } | null;
}

export interface StoredJournalItem {
  /** Null for a mark whose line the model no longer writes: the user's word stands alone. */
  readonly itemId: number | null;
  readonly markId: number | null;
  readonly episodeId: number;
  readonly kind: JournalItemKind;
  /** The model's text, or the user's; voices as `{P2}`. */
  readonly text: string;
  readonly edited: boolean;
  readonly status: JournalMarkStatus;
  readonly whoRef: string | null;
  readonly toRef: string | null;
  readonly due: string | null;
  readonly dueText: string | null;
  readonly startMs: number;
  readonly stale: boolean;
  readonly citations: readonly JournalCitation[];
  readonly voices: Readonly<Record<string, JournalVoice>>;
}

interface ItemRow {
  readonly itemId: number;
  readonly episodeId: number;
  readonly asrRunId: number;
  readonly kind: JournalItemKind;
  readonly text: string;
  readonly whoRef: string | null;
  readonly toRef: string | null;
  readonly due: string | null;
  readonly dueText: string | null;
  readonly startMs: number;
  readonly stale: boolean;
  readonly speakerRefs: Readonly<Record<string, string>>;
}

const itemColumns = `i.id, i.episode_id, r.asr_run_id, i.kind, i.text, i.who_ref, i.to_ref, i.due,
  i.due_text, i.start_ms, r.stale, r.speaker_refs`;

function itemRow(row: Row): ItemRow {
  const refs: unknown = JSON.parse(str(row, "speaker_refs"));
  const speakerRefs: Record<string, string> = {};
  if (typeof refs === "object" && refs !== null) {
    for (const [ref, label] of Object.entries(refs)) {
      if (typeof label === "string") speakerRefs[ref] = label;
    }
  }
  return {
    itemId: int(row, "id"),
    episodeId: int(row, "episode_id"),
    asrRunId: int(row, "asr_run_id"),
    kind: oneOfValues(row, "kind", journalItemKinds),
    text: str(row, "text"),
    whoRef: strOrNull(row, "who_ref"),
    toRef: strOrNull(row, "to_ref"),
    due: strOrNull(row, "due"),
    dueText: strOrNull(row, "due_text"),
    startMs: int(row, "start_ms"),
    stale: int(row, "stale") === 1,
    speakerRefs,
  };
}

function citationsOf(db: Database, itemId: number): JournalCitation[] {
  return db
    .statement(
      `SELECT s.id, s.episode_id, s.start_ms, s.end_ms, s.speaker_label, s.text
       FROM journal_citations c JOIN segments s ON s.id = c.segment_id
       WHERE c.item_id = ? ORDER BY c.ord`,
    )
    .all(itemId)
    .map((row) => ({
      segmentId: int(row, "id"),
      episodeId: int(row, "episode_id"),
      startMs: int(row, "start_ms"),
      endMs: int(row, "end_ms"),
      speakerLabel: strOrNull(row, "speaker_label"),
      text: str(row, "text"),
    }));
}

interface MarkSpan {
  readonly trackRunId: number;
  readonly sampleStart: number;
  readonly sampleEnd: number;
  readonly wallStartMs: number;
  readonly wallEndMs: number;
}

function marksBetween(
  db: Database,
  fromMs: number,
  toMs: number,
  kind: JournalItemKind | null,
): { mark: JournalMark; spans: MarkSpan[] }[] {
  const rows = db
    .statement(
      `SELECT DISTINCT m.id, m.kind, m.status, m.text, m.due, m.due_edited, m.generated_text
       FROM journal_marks m JOIN journal_mark_spans s ON s.mark_id = m.id
       WHERE s.wall_start_ms >= ? AND s.wall_start_ms < ? AND (? IS NULL OR m.kind = ?)`,
    )
    .all(fromMs, toMs, kind, kind);
  return rows.map((row) => ({
    mark: markOf(row),
    spans: db
      .statement(
        `SELECT track_run_id, sample_start, sample_end, wall_start_ms, wall_end_ms
         FROM journal_mark_spans WHERE mark_id = ? ORDER BY wall_start_ms`,
      )
      .all(int(row, "id"))
      .map((span) => ({
        trackRunId: int(span, "track_run_id"),
        sampleStart: int(span, "sample_start"),
        sampleEnd: int(span, "sample_end"),
        wallStartMs: int(span, "wall_start_ms"),
        wallEndMs: int(span, "wall_end_ms"),
      })),
  }));
}

function markOf(row: Row): JournalMark {
  return {
    id: int(row, "id"),
    kind: oneOfValues(row, "kind", journalItemKinds),
    status: oneOfValues(row, "status", journalMarkStatuses),
    text: strOrNull(row, "text"),
    due: strOrNull(row, "due"),
    dueEdited: int(row, "due_edited") === 1,
    generatedText: str(row, "generated_text"),
  };
}

/** The spans of an item's cited sentences, on their tracks. */
function itemSpans(db: Database, itemId: number): MarkSpan[] {
  return db
    .statement(
      `SELECT s.track_run_id, s.sample_start, s.sample_end, s.start_ms, s.end_ms
       FROM journal_citations c JOIN segments s ON s.id = c.segment_id
       WHERE c.item_id = ? ORDER BY c.ord`,
    )
    .all(itemId)
    .map((row) => ({
      trackRunId: int(row, "track_run_id"),
      sampleStart: int(row, "sample_start"),
      sampleEnd: int(row, "sample_end"),
      wallStartMs: int(row, "start_ms"),
      wallEndMs: int(row, "end_ms"),
    }));
}

const overlaps = (a: MarkSpan, b: MarkSpan) =>
  a.trackRunId === b.trackRunId &&
  a.sampleStart < Math.max(b.sampleEnd, b.sampleStart + 1) &&
  b.sampleStart < Math.max(a.sampleEnd, a.sampleStart + 1);

/**
 * The same audio in another recording of the same meeting (ADR 032): a mark
 * made on one recording's line goes to the line written from the other
 * when the source changes, so the user's word stays on one line.
 */
interface LinkedWindow {
  readonly runs: ReadonlySet<number>;
  readonly fromMs: number;
  readonly toMs: number;
}

interface LoadedLink {
  readonly offsetMs: number;
  readonly sharedFromMs: number;
  readonly sharedToMs: number;
  readonly phoneRuns: ReadonlySet<number>;
  readonly macRuns: ReadonlySet<number>;
}

/** Two transcripts cut the same speech a little differently. */
const LINKED_TOLERANCE_MS = 500;
/** A link's clocks may be minutes apart: links are looked for this far around. */
const LINK_MARGIN_MS = 3_600_000;

function loadLinks(db: Database, fromMs: number, toMs: number): LoadedLink[] {
  const runsOf = (column: string) => `(SELECT json_group_array(DISTINCT r.track_run_id)
      FROM episode_regions er JOIN speech_regions r ON r.id = er.speech_region_id
      WHERE er.episode_id = l.${column})`;
  return db
    .statement(
      `SELECT l.offset_ms, l.shared_from_ms, l.shared_to_ms,
         ${runsOf("phone_episode_id")} AS phone_runs, ${runsOf("mac_episode_id")} AS mac_runs
       FROM same_moment_links l
       WHERE l.linked = 1 AND l.shared_from_ms < ? AND l.shared_to_ms > ?`,
    )
    .all(toMs + LINK_MARGIN_MS, fromMs - LINK_MARGIN_MS)
    .map((row) => ({
      offsetMs: int(row, "offset_ms"),
      sharedFromMs: int(row, "shared_from_ms"),
      sharedToMs: int(row, "shared_to_ms"),
      phoneRuns: runSet(str(row, "phone_runs")),
      macRuns: runSet(str(row, "mac_runs")),
    }));
}

function runSet(json: string): Set<number> {
  const parsed: unknown = JSON.parse(json);
  return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === "number") : []);
}

/** Where an item's audio lies in the recordings linked to it, on their clocks. */
function linkedWindows(links: readonly LoadedLink[], spans: readonly MarkSpan[]): LinkedWindow[] {
  const out: LinkedWindow[] = [];
  for (const link of links) {
    for (const span of spans) {
      // The shared time is on the Mac's clock; the offset is Mac − phone.
      if (link.phoneRuns.has(span.trackRunId)) {
        const fromMs = span.wallStartMs + link.offsetMs;
        const toMs = span.wallEndMs + link.offsetMs;
        if (fromMs < link.sharedToMs && toMs > link.sharedFromMs) {
          out.push({ runs: link.macRuns, fromMs, toMs });
        }
      } else if (
        link.macRuns.has(span.trackRunId) &&
        span.wallStartMs < link.sharedToMs &&
        span.wallEndMs > link.sharedFromMs
      ) {
        out.push({
          runs: link.phoneRuns,
          fromMs: span.wallStartMs - link.offsetMs,
          toMs: span.wallEndMs - link.offsetMs,
        });
      }
    }
  }
  return out;
}

const inWindow = (span: MarkSpan, window: LinkedWindow) =>
  window.runs.has(span.trackRunId) &&
  span.wallStartMs < window.toMs + LINKED_TOLERANCE_MS &&
  Math.max(span.wallEndMs, span.wallStartMs + 1) > window.fromMs - LINKED_TOLERANCE_MS;

/** A mark goes to the item of its kind it overlaps whose words are closest, if close enough. */
const MIN_MARK_SIMILARITY = 0.3;

/** Around a range, where marks of its conversations may lie (an episode is at most a few hours). */
const MARK_MARGIN_MS = 2 * 86_400_000;

/**
 * How well a mark fits an item it overlaps: its words' similarity, or, once
 * a deletion emptied the model's words it kept, 1 when the item is the only
 * one of its kind over the mark's audio (0 otherwise: never a guess).
 */
function markScore(mark: JournalMark, itemText: string, overlapping: number): number {
  if (mark.generatedText === "") return overlapping === 1 ? 1 : 0;
  return journalTextSimilarity(mark.generatedText, itemText);
}

function voicesOf(
  db: Database,
  episodeId: number,
  asrRunId: number,
  refs: Readonly<Record<string, string>>,
  cache: Map<number, Map<string, JournalVoice>>,
  known: () => KnownVoices,
): Record<string, JournalVoice> {
  let byLabel = cache.get(asrRunId);
  if (byLabel === undefined) {
    const people = resolveSpeakers(db, asrRunId);
    // Sondine's guesses for the others, read now like the transcript's (ADR 030).
    const matches = voiceMatches(db, asrRunId, known());
    // The sources' « Moi », unless the transcript shows that voice as someone else.
    const base = loadSelfSpeakers(db, [episodeId]).get(episodeId);
    const self =
      shownSelf(db, asrRunId, base, people, matches)?.label === base?.label
        ? (base?.label ?? null)
        : null;
    byLabel = new Map(
      loadRunSpeakers(db, asrRunId).map((speaker) => {
        const person = people.get(speaker.label);
        const isSelf = speaker.label === self || person?.isSelf === true;
        const match = person === undefined && !isSelf ? matches.get(speaker.label) : undefined;
        return [
          speaker.label,
          {
            label: speaker.label,
            name: person?.name ?? null,
            self: isSelf,
            ordinal: speaker.ordinal,
            guess:
              match === undefined
                ? null
                : {
                    person: match.person,
                    confidence: match.confidence,
                    recognized: readsAsPerson(match),
                  },
          },
        ];
      }),
    );
    cache.set(asrRunId, byLabel);
  }
  const out: Record<string, JournalVoice> = {};
  for (const [ref, label] of Object.entries(refs)) {
    out[ref] = byLabel.get(label) ?? { label, name: null, self: false, ordinal: null, guess: null };
  }
  return out;
}

/** Sentences of current transcripts over a mark's spans: an orphan mark's citations. */
function sentencesOver(db: Database, spans: readonly MarkSpan[]): JournalCitation[] {
  const out = new Map<number, JournalCitation>();
  for (const span of spans) {
    const rows = db
      .statement(
        `SELECT s.id, s.episode_id, s.start_ms, s.end_ms, s.speaker_label, s.text
         FROM segments s JOIN episode_analysis ea
           ON ea.run_id = s.run_id AND ea.episode_id = s.episode_id AND ea.stage = 'asr'
         WHERE s.track_run_id = ? AND s.sample_start < ? AND max(s.sample_end, s.sample_start + 1) > ?
         ORDER BY s.start_ms`,
      )
      .all(span.trackRunId, Math.max(span.sampleEnd, span.sampleStart + 1), span.sampleStart);
    for (const row of rows) {
      out.set(int(row, "id"), {
        segmentId: int(row, "id"),
        episodeId: int(row, "episode_id"),
        startMs: int(row, "start_ms"),
        endMs: int(row, "end_ms"),
        speakerLabel: strOrNull(row, "speaker_label"),
        text: str(row, "text"),
      });
    }
  }
  return [...out.values()];
}

/**
 * The journal's items of episodes that started within `[fromMs, toMs)`, or,
 * with `kind`, of that kind only, in time order, with the user's marks
 * applied: each mark goes to at most one item (its kind, an overlapping
 * citation, the closest words), and a mark whose line the model no longer
 * writes shows on its own with the sentences now over its audio.
 */
export function loadJournalItems(
  db: Database,
  range: JournalRange & { readonly kind?: JournalItemKind },
): StoredJournalItem[] {
  const kind = range.kind ?? null;
  const rows = db
    .statement(
      `SELECT ${itemColumns} FROM journal_items i
       JOIN journal_runs r ON r.id = i.run_id AND r.status = 'published'
       JOIN episodes e ON e.id = i.episode_id
       WHERE e.started_at_ms >= ? AND e.started_at_ms < ? AND (? IS NULL OR i.kind = ?)
         AND ${journalEpisodeSql}
       ORDER BY i.start_ms, i.episode_id, i.seq`,
    )
    .all(range.fromMs, range.toMs, kind, kind)
    .map(itemRow);
  // A conversation may cross midnight: its marks are looked for around the range,
  // and only those standing alone are kept to it.
  const marks = marksBetween(db, range.fromMs - MARK_MARGIN_MS, range.toMs + MARK_MARGIN_MS, kind);
  const spansOf = new Map(rows.map((row) => [row.itemId, itemSpans(db, row.itemId)]));
  const links = loadLinks(db, range.fromMs - MARK_MARGIN_MS, range.toMs + MARK_MARGIN_MS);
  const windowsOf = new Map(
    rows.map((row) => [row.itemId, linkedWindows(links, spansOf.get(row.itemId) ?? [])]),
  );
  // Every (mark, item) pair that may match, closest words first.
  const pairs: { markIndex: number; itemId: number; score: number }[] = [];
  for (const [markIndex, { mark, spans }] of marks.entries()) {
    const over = rows.filter((row) => {
      if (row.kind !== mark.kind) return false;
      const cited = spansOf.get(row.itemId) ?? [];
      const linked = windowsOf.get(row.itemId) ?? [];
      return spans.some(
        (span) =>
          cited.some((other) => overlaps(span, other)) ||
          linked.some((window) => inWindow(span, window)),
      );
    });
    for (const row of over) {
      const score = markScore(mark, row.text, over.length);
      if (score >= MIN_MARK_SIMILARITY) pairs.push({ markIndex, itemId: row.itemId, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const markOfItem = new Map<number, JournalMark>();
  const usedMarks = new Set<number>();
  for (const pair of pairs) {
    if (usedMarks.has(pair.markIndex) || markOfItem.has(pair.itemId)) continue;
    const entry = marks[pair.markIndex];
    if (entry === undefined) continue;
    usedMarks.add(pair.markIndex);
    markOfItem.set(pair.itemId, entry.mark);
  }
  const voices = new Map<number, Map<string, JournalVoice>>();
  let known: KnownVoices | null = null;
  const references = () => (known ??= knownVoices(db));
  const out: StoredJournalItem[] = rows.map((row) => {
    const mark = markOfItem.get(row.itemId) ?? null;
    return {
      itemId: row.itemId,
      markId: mark?.id ?? null,
      episodeId: row.episodeId,
      kind: row.kind,
      text: mark?.text ?? row.text,
      edited: mark?.text != null,
      status: mark?.status ?? "open",
      whoRef: row.whoRef,
      toRef: row.toRef,
      due: mark?.dueEdited === true ? mark.due : row.due,
      dueText: mark?.dueEdited === true ? null : row.dueText,
      startMs: row.startMs,
      stale: row.stale,
      citations: citationsOf(db, row.itemId),
      voices: voicesOf(db, row.episodeId, row.asrRunId, row.speakerRefs, voices, references),
    };
  });
  for (const [index, { mark, spans }] of marks.entries()) {
    // A line the user said was wrong, which the model no longer writes, has
    // nothing to show; one left without words has nothing to say.
    const words = mark.text ?? mark.generatedText;
    if (usedMarks.has(index) || mark.status === "dismissed" || words === "") continue;
    const citations = sentencesOver(db, spans);
    const first = citations[0];
    if (first === undefined || first.startMs < range.fromMs || first.startMs >= range.toMs)
      continue;
    out.push({
      itemId: null,
      markId: mark.id,
      episodeId: first.episodeId,
      kind: mark.kind,
      text: words,
      edited: mark.text !== null,
      status: mark.status,
      whoRef: null,
      toRef: null,
      due: mark.dueEdited ? mark.due : null,
      dueText: null,
      startMs: first.startMs,
      stale: false,
      citations,
      voices: {},
    });
  }
  return out.toSorted((a, b) => a.startMs - b.startMs || a.episodeId - b.episodeId);
}

export type JournalMarkChange =
  | { readonly status: JournalMarkStatus }
  | { readonly text: string | null }
  | { readonly due: string | null };

export type JournalMarkResult =
  | { readonly ok: true; readonly markId: number | null }
  | { readonly ok: false; readonly reason: "item_missing" | "mark_missing" };

/**
 * The user's word on an item or a mark, in one transaction. A first word on
 * an item writes a mark over the audio its sentences cite, keeping the
 * model's text to recognize the line after regeneration. A mark back to the
 * model's line (open, its text and date) is deleted.
 */
export function setJournalMark(
  db: Database,
  target: { readonly itemId: number | null; readonly markId: number | null },
  change: JournalMarkChange,
  nowMs: number,
): JournalMarkResult {
  return transaction(db, (): JournalMarkResult => {
    const item =
      target.itemId === null
        ? undefined
        : db
            .statement(
              `SELECT i.kind, i.text, e.started_at_ms, e.ended_at_ms FROM journal_items i
               JOIN journal_runs r ON r.id = i.run_id AND r.status = 'published'
               JOIN episodes e ON e.id = i.episode_id WHERE i.id = ?`,
            )
            .get(target.itemId);
    const spans = target.itemId === null ? [] : itemSpans(db, target.itemId);
    if (target.itemId !== null && (item === undefined || spans.length === 0)) {
      return { ok: false, reason: "item_missing" };
    }
    /** The marks of this item's kind over its audio, the closest words first. */
    const marksOver = (kind: string, text: string): JournalMark[] => {
      const found = new Map<number, JournalMark>();
      for (const span of spans) {
        const rows = db
          .statement(
            `SELECT DISTINCT m.id, m.kind, m.status, m.text, m.due, m.due_edited, m.generated_text
             FROM journal_marks m JOIN journal_mark_spans s ON s.mark_id = m.id
             WHERE m.kind = ? AND s.track_run_id = ? AND s.sample_start < ?
               AND max(s.sample_end, s.sample_start + 1) > ?`,
          )
          .all(
            kind,
            span.trackRunId,
            Math.max(span.sampleEnd, span.sampleStart + 1),
            span.sampleStart,
          );
        for (const row of rows) found.set(int(row, "id"), markOf(row));
      }
      // The same words written from the other recording of the meeting (ADR 032).
      const walls = spans.flatMap((span) => [span.wallStartMs, span.wallEndMs]);
      const links = walls.length === 0 ? [] : loadLinks(db, Math.min(...walls), Math.max(...walls));
      for (const window of linkedWindows(links, spans)) {
        const rows = db
          .statement(
            `SELECT DISTINCT m.id, m.kind, m.status, m.text, m.due, m.due_edited, m.generated_text
             FROM journal_marks m JOIN journal_mark_spans s ON s.mark_id = m.id
             WHERE m.kind = ? AND s.track_run_id IN (SELECT value FROM json_each(?))
               AND s.wall_start_ms < ? AND max(s.wall_end_ms, s.wall_start_ms + 1) > ?`,
          )
          .all(
            kind,
            JSON.stringify([...window.runs]),
            window.toMs + LINKED_TOLERANCE_MS,
            window.fromMs - LINKED_TOLERANCE_MS,
          );
        for (const row of rows) found.set(int(row, "id"), markOf(row));
      }
      return [...found.values()].toSorted(
        (a, b) =>
          journalTextSimilarity(b.generatedText, text) -
          journalTextSimilarity(a.generatedText, text),
      );
    };
    let markId = target.markId;
    if (markId !== null) {
      const mark = db.statement("SELECT kind FROM journal_marks WHERE id = ?").get(markId);
      if (mark === undefined) return { ok: false, reason: "mark_missing" };
      // The window's line and its mark must still go together: a line
      // written again since may have taken the mark to another.
      if (
        item !== undefined &&
        !marksOver(str(item, "kind"), str(item, "text")).some((other) => other.id === markId)
      ) {
        return { ok: false, reason: "item_missing" };
      }
    } else {
      if (item === undefined) return { ok: false, reason: "item_missing" };
      // A second word on a line (another window, a quick second click) goes to its mark.
      const existing = marksOver(str(item, "kind"), str(item, "text")).find(
        (mark) =>
          mark.generatedText === "" ||
          journalTextSimilarity(mark.generatedText, str(item, "text")) >= MIN_MARK_SIMILARITY,
      );
      if (existing !== undefined) {
        markId = existing.id;
      } else {
        markId = Number(
          db
            .statement(
              `INSERT INTO journal_marks (kind, status, generated_text, source_start_ms,
                 source_end_ms, created_at_ms, updated_at_ms)
               VALUES (?, 'open', ?, ?, ?, ?, ?)`,
            )
            .run(
              str(item, "kind"),
              str(item, "text"),
              int(item, "started_at_ms"),
              intOrNull(item, "ended_at_ms") ?? nowMs,
              nowMs,
              nowMs,
            ).lastInsertRowid,
        );
        const insertSpan = db.statement(
          `INSERT OR IGNORE INTO journal_mark_spans (mark_id, track_run_id, sample_start,
             sample_end, wall_start_ms, wall_end_ms) VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const span of spans) {
          insertSpan.run(
            markId,
            span.trackRunId,
            span.sampleStart,
            span.sampleEnd,
            span.wallStartMs,
            span.wallEndMs,
          );
        }
      }
    }
    if ("status" in change) {
      db.statement("UPDATE journal_marks SET status = ?, updated_at_ms = ? WHERE id = ?").run(
        change.status,
        nowMs,
        markId,
      );
    } else if ("text" in change) {
      db.statement("UPDATE journal_marks SET text = ?, updated_at_ms = ? WHERE id = ?").run(
        change.text,
        nowMs,
        markId,
      );
    } else {
      db.statement(
        "UPDATE journal_marks SET due = ?, due_edited = 1, updated_at_ms = ? WHERE id = ?",
      ).run(change.due, nowMs, markId);
    }
    const deleted = db
      .statement(
        `DELETE FROM journal_marks WHERE id = ? AND status = 'open' AND text IS NULL
           AND due_edited = 0`,
      )
      .run(markId).changes;
    return { ok: true, markId: Number(deleted) > 0 ? null : markId };
  });
}
