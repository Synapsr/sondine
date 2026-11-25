import { createHash } from "node:crypto";
import { contextStatesIn, restoreContextStates, type ContextItemState } from "./context-items";
import { transaction, type Database } from "./database";
import {
  cancelJobs,
  lineageOf,
  loadTranscript,
  PublishFailed,
  republish,
  retireLive,
} from "./episode-boundaries";
import {
  bumpInputGeneration,
  currentRunId,
  retireRun,
  type SegmentInput,
  type TurnInput,
} from "./publish";
import { int, intOrNull, num, str, strOrNull, type Row } from "./rows";
import { showSegmentText } from "./transcript-edits";
import { settleVoiceRead } from "./voices";

// ⌘Z and ⇧⌘Z (M2): the user's edits undone and redone exactly. Around each
// edit, core captures what it may change: the user's assertions over the
// episode's audio (names, « Non », corrections, types), the people they name,
// and for a split or a merge the episodes themselves (rows, member slices,
// « ne pas identifier », transcripts). Undoing restores the capture from
// before, redoing the one from after, each only while the state is still the
// one the other capture saw (its print), checked in the transaction: anything
// changed since, by Sondine or the user, refuses instead of guessing. Ids come
// back as they were, so older captures stay valid. Transcripts come back as
// derived runs of their lineage, current when they were, corrections
// projected again from their restored assertions; a correction made in place
// comes back as the sentence showed it.
//
// Captures hold transcript text: they live in core's memory only, and core
// forgets them on every deletion.

/**
 * What an edit may change: `assertions` (names, « Non », a person's name),
 * `people` (every assertion naming the scope's people, wherever it is, and
 * their rows: merging two people), `text` (and what the transcripts'
 * sentences show: a correction), `kind` (and the episodes' type columns),
 * `structure` (and the episodes whole: a split or a merge).
 */
export type UndoLevel = "assertions" | "people" | "text" | "kind" | "structure";

export interface UndoScope {
  readonly level: UndoLevel;
  readonly episodeIds: readonly number[];
  readonly personIds: readonly number[];
}

/** A stretch of capture: track run, first sample, end sample. */
export type UndoAnchor = readonly [trackRunId: number, start: number, end: number];

interface AssertionState {
  readonly id: number;
  readonly kind: string;
  readonly trackRunId: number;
  readonly sampleStart: number;
  readonly sampleEnd: number;
  readonly payload: string;
  readonly origin: string;
  readonly createdAtMs: number;
  readonly revokedAtMs: number | null;
  readonly personId: number | null;
}

/** What one sentence of a current transcript shows (ids are not kept: a transcript published again has new ones). */
interface SegmentState {
  readonly trackRunId: number;
  readonly sampleStart: number;
  readonly sampleEnd: number;
  /** The engine's text: with the bounds, which sentence it is. */
  readonly engine: string;
  readonly text: string;
  readonly originalText: string | null;
  readonly editId: number | null;
}

interface PersonState {
  readonly name: string;
  readonly isSelf: number;
  readonly createdAtMs: number;
}

interface KindState {
  readonly size: string | null;
  readonly context: string | null;
  readonly sizeState: string;
  readonly kindInputs: string;
}

interface RowState extends KindState {
  readonly state: string;
  readonly analysisState: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number | null;
  readonly voicedMs: number;
  readonly primaryAppId: number | null;
  readonly label: string | null;
  readonly groupingVersion: string;
  readonly groupingKey: string | null;
  readonly pageKey: string | null;
  readonly classifierVersion: string;
  readonly createdAtMs: number;
}

interface MemberState {
  readonly regionId: number;
  readonly groupingVersion: string;
  readonly start: number;
  readonly end: number | null;
}

interface TranscriptState {
  readonly current: boolean;
  readonly segments: readonly SegmentInput[];
  readonly turns: readonly TurnInput[];
}

/** The run a transcript came from, to publish it again (not part of the print). */
interface RunSource {
  readonly lineage: number;
  readonly engine: Row;
}

interface EpisodeState {
  readonly kind: KindState | null;
  readonly row: RowState | null;
  readonly members: readonly MemberState[] | null;
  /** « ne pas identifier »: 1 or 0 for this episode, null without a rule. */
  readonly rule: number | null;
  readonly transcript: TranscriptState | null;
}

export interface UndoSnapshot {
  readonly scope: UndoScope;
  readonly window: readonly UndoAnchor[];
  /** Null: no such episode, or person. */
  readonly episodes: ReadonlyMap<number, EpisodeState | null>;
  readonly people: ReadonlyMap<number, PersonState | null>;
  readonly assertions: readonly AssertionState[];
  /** The context items anchored in the window (ADR 024), whatever the level. */
  readonly context: readonly ContextItemState[];
  /** At `text` level: the sentences of current transcripts over the window. */
  readonly segments: readonly SegmentState[];
  /**
   * At `people` level: the current transcripts over the window whose voices
   * linking merged. Linking joins voices once they read as one person, which
   * a merge can cause and undoing it cannot part again: undo then refuses.
   */
  readonly linked: readonly number[];
  readonly sources: ReadonlyMap<number, RunSource>;
  /** What the state was, compared before restoring over it. */
  readonly print: string;
}

/** Open slices reach this far: past any sample. */
const OPEN_END = Number.MAX_SAFE_INTEGER;

function slicesOf(db: Database, episodeIds: readonly number[]): UndoAnchor[] {
  const query = db.statement(
    `SELECT r.track_run_id, m.slice_sample_start AS start,
       coalesce(m.slice_sample_end, r.sample_end, ${OPEN_END}) AS end
     FROM episode_regions m JOIN speech_regions r ON r.id = m.speech_region_id
     WHERE m.episode_id = ?`,
  );
  return episodeIds.flatMap((id) =>
    query
      .all(id)
      .map((row): UndoAnchor => [int(row, "track_run_id"), int(row, "start"), int(row, "end")]),
  );
}

function assertionsIn(db: Database, window: readonly UndoAnchor[]): AssertionState[] {
  const query = db.statement(
    `SELECT * FROM user_assertions
     WHERE track_run_id = ? AND sample_start < ? AND max(sample_end, sample_start + 1) > ?`,
  );
  const found = new Map<number, AssertionState>();
  for (const [trackRunId, start, end] of window) {
    for (const row of query.all(trackRunId, end, start)) {
      found.set(int(row, "id"), {
        id: int(row, "id"),
        kind: str(row, "kind"),
        trackRunId: int(row, "track_run_id"),
        sampleStart: int(row, "sample_start"),
        sampleEnd: int(row, "sample_end"),
        payload: str(row, "payload"),
        origin: str(row, "origin"),
        createdAtMs: int(row, "created_at_ms"),
        revokedAtMs: intOrNull(row, "revoked_at_ms"),
        personId: intOrNull(row, "person_id"),
      });
    }
  }
  return [...found.values()].toSorted((a, b) => a.id - b.id);
}

/**
 * The episodes' slices, widened to every assertion that meets them: an edit
 * that cuts an anchor writes its parts again, all inside that anchor.
 */
export function undoWindow(db: Database, episodeIds: readonly number[]): UndoAnchor[] {
  const slices = slicesOf(db, episodeIds);
  return [
    ...slices,
    ...assertionsIn(db, slices).map((row): UndoAnchor => [
      row.trackRunId,
      row.sampleStart,
      Math.max(row.sampleEnd, row.sampleStart + 1),
    ]),
  ];
}

function kindOf(row: Row): KindState {
  return {
    size: strOrNull(row, "size"),
    context: strOrNull(row, "context"),
    sizeState: str(row, "size_state"),
    kindInputs: str(row, "kind_inputs"),
  };
}

function rowOf(row: Row): RowState {
  return {
    ...kindOf(row),
    state: str(row, "state"),
    analysisState: str(row, "analysis_state"),
    startedAtMs: int(row, "started_at_ms"),
    endedAtMs: intOrNull(row, "ended_at_ms"),
    voicedMs: int(row, "voiced_ms"),
    primaryAppId: intOrNull(row, "primary_app_id"),
    label: strOrNull(row, "label"),
    groupingVersion: str(row, "grouping_version"),
    groupingKey: strOrNull(row, "grouping_key"),
    pageKey: strOrNull(row, "page_key"),
    classifierVersion: str(row, "classifier_version"),
    createdAtMs: int(row, "created_at_ms"),
  };
}

function captureEpisode(
  db: Database,
  episodeId: number,
  level: UndoLevel,
  sources: Map<number, RunSource>,
): EpisodeState | null {
  const row = db.statement("SELECT * FROM episodes WHERE id = ?").get(episodeId);
  if (row === undefined) return null;
  if (level === "assertions" || level === "people" || level === "text") {
    return { kind: null, row: null, members: null, rule: null, transcript: null };
  }
  if (level === "kind") {
    return { kind: kindOf(row), row: null, members: null, rule: null, transcript: null };
  }
  const members = db
    .statement(
      `SELECT speech_region_id, grouping_version, slice_sample_start, slice_sample_end
       FROM episode_regions WHERE episode_id = ? ORDER BY speech_region_id, slice_sample_start`,
    )
    .all(episodeId)
    .map((member) => ({
      regionId: int(member, "speech_region_id"),
      groupingVersion: str(member, "grouping_version"),
      start: int(member, "slice_sample_start"),
      end: intOrNull(member, "slice_sample_end"),
    }));
  const rule = db
    .statement("SELECT recognize FROM identity_rules WHERE scope = 'episode' AND episode_id = ?")
    .get(episodeId);
  const loaded = loadTranscript(db, episodeId);
  if (loaded !== null) {
    const engine = db.statement("SELECT * FROM analysis_runs WHERE id = ?").get(loaded.runId);
    if (engine !== undefined) {
      sources.set(episodeId, { lineage: lineageOf(db, loaded.runId), engine });
    }
  }
  return {
    kind: null,
    row: rowOf(row),
    members,
    rule: rule === undefined ? null : int(rule, "recognize"),
    transcript:
      loaded === null
        ? null
        : { current: loaded.current, segments: loaded.segments, turns: loaded.turns },
  };
}

/** Where every assertion naming these people lies, revoked ones too. */
function personAnchors(db: Database, personIds: readonly number[]): UndoAnchor[] {
  const query = db.statement(
    "SELECT track_run_id, sample_start, sample_end FROM user_assertions WHERE person_id = ?",
  );
  return personIds.flatMap((id) =>
    query
      .all(id)
      .map((row): UndoAnchor => [
        int(row, "track_run_id"),
        int(row, "sample_start"),
        Math.max(int(row, "sample_end"), int(row, "sample_start") + 1),
      ]),
  );
}

/**
 * What `scope` holds now; `window` defaults to its episodes' audio, widened,
 * and at `people` level to wherever its people are named.
 */
export function captureUndo(
  db: Database,
  scope: UndoScope,
  window: readonly UndoAnchor[] = [
    ...undoWindow(db, scope.episodeIds),
    ...(scope.level === "people" ? personAnchors(db, scope.personIds) : []),
  ],
): UndoSnapshot {
  const sources = new Map<number, RunSource>();
  const episodes = new Map(
    scope.episodeIds.map((id) => [id, captureEpisode(db, id, scope.level, sources)] as const),
  );
  const personRow = db.statement("SELECT name, is_self, created_at_ms FROM people WHERE id = ?");
  const people = new Map(
    scope.personIds.map((id) => {
      const row = personRow.get(id);
      const person: PersonState | null =
        row === undefined
          ? null
          : {
              name: str(row, "name"),
              isSelf: int(row, "is_self"),
              createdAtMs: int(row, "created_at_ms"),
            };
      return [id, person] as const;
    }),
  );
  const assertions = assertionsIn(db, window);
  const context = contextStatesIn(db, window);
  const segments = scope.level === "text" ? segmentsIn(db, window).map(({ state }) => state) : [];
  const linked = scope.level === "people" ? linkedIn(db, window) : [];
  const print = printOf(episodes, people, assertions, context, segments, linked);
  return { scope, window, episodes, people, assertions, context, segments, linked, sources, print };
}

/** Current transcripts with speech over the window whose voices linking merged. */
function linkedIn(db: Database, window: readonly UndoAnchor[]): number[] {
  const query = db.statement(
    `SELECT DISTINCT s.run_id FROM segments s
     JOIN episode_analysis a ON a.run_id = s.run_id AND a.stage = 'asr'
     JOIN voice_links l ON l.run_id = s.run_id AND l.merged > 0
     WHERE s.track_run_id = ? AND s.sample_start < ? AND max(s.sample_end, s.sample_start + 1) > ?`,
  );
  const runs = new Set<number>();
  for (const [trackRunId, start, end] of window) {
    for (const row of query.all(trackRunId, end, start)) runs.add(int(row, "run_id"));
  }
  return [...runs].toSorted((a, b) => a - b);
}

const segmentKey = (state: SegmentState) =>
  JSON.stringify([state.trackRunId, state.sampleStart, state.sampleEnd, state.engine]);

/** The sentences of current transcripts over the window, in a stable order, with their ids. */
function segmentsIn(
  db: Database,
  window: readonly UndoAnchor[],
): { readonly id: number; readonly state: SegmentState }[] {
  const query = db.statement(
    `SELECT s.id, s.track_run_id, s.sample_start, s.sample_end, s.text, s.original_text, s.edit_id
     FROM segments s JOIN episode_analysis a ON a.run_id = s.run_id AND a.stage = 'asr'
     WHERE s.track_run_id = ? AND s.sample_start < ? AND max(s.sample_end, s.sample_start + 1) > ?`,
  );
  const found = new Map<number, SegmentState>();
  for (const [trackRunId, start, end] of window) {
    for (const row of query.all(trackRunId, end, start)) {
      const text = str(row, "text");
      const originalText = strOrNull(row, "original_text");
      found.set(int(row, "id"), {
        trackRunId: int(row, "track_run_id"),
        sampleStart: int(row, "sample_start"),
        sampleEnd: int(row, "sample_end"),
        engine: originalText ?? text,
        text,
        originalText,
        editId: intOrNull(row, "edit_id"),
      });
    }
  }
  return [...found]
    .map(([id, state]) => ({ id, state }))
    .toSorted(
      (a, b) =>
        segmentKey(a.state).localeCompare(segmentKey(b.state)) ||
        JSON.stringify(a.state).localeCompare(JSON.stringify(b.state)),
    );
}

function printOf(
  episodes: UndoSnapshot["episodes"],
  people: UndoSnapshot["people"],
  assertions: UndoSnapshot["assertions"],
  context: UndoSnapshot["context"],
  segments: UndoSnapshot["segments"],
  linked: UndoSnapshot["linked"],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        episodes: [...episodes].toSorted(([a], [b]) => a - b),
        people: [...people].toSorted(([a], [b]) => a - b),
        assertions,
        context,
        segments,
        linked,
      }),
    )
    .digest("base64url");
}

/**
 * The capture from before an edit, over the scope it ended with: what the
 * edit created (a split's new episode, a new person) did not exist yet.
 */
export function widenSnapshot(
  snapshot: UndoSnapshot,
  created: { readonly episodeIds: readonly number[]; readonly personIds: readonly number[] },
): UndoSnapshot {
  const episodes = new Map(snapshot.episodes);
  for (const id of created.episodeIds) if (!episodes.has(id)) episodes.set(id, null);
  const people = new Map(snapshot.people);
  for (const id of created.personIds) if (!people.has(id)) people.set(id, null);
  const scope: UndoScope = {
    level: snapshot.scope.level,
    episodeIds: [...episodes.keys()].toSorted((a, b) => a - b),
    personIds: [...people.keys()].toSorted((a, b) => a - b),
  };
  return {
    ...snapshot,
    scope,
    episodes,
    people,
    print: printOf(
      episodes,
      people,
      snapshot.assertions,
      snapshot.context,
      snapshot.segments,
      snapshot.linked,
    ),
  };
}

export type UndoRefusal =
  /** The state is no longer the one this edit left (or found). */
  | "changed"
  /** A transcript could not be published again (a deleted stretch, for example). */
  | "refused";

export type UndoRestore =
  | {
      readonly ok: true;
      /** Episodes the restore took away (merged back, or split off). */
      readonly removed: readonly number[];
      /** Episodes the restored state holds. */
      readonly kept: readonly number[];
      /** People the restore took away (merged again), and those it holds. */
      readonly removedPeople: readonly number[];
      readonly keptPeople: readonly number[];
      /** The restored state, captured again (its print is the target's). */
      readonly snapshot: UndoSnapshot;
    }
  | { readonly ok: false; readonly reason: UndoRefusal };

class Changed extends Error {}

/** A constraint the restore met (a slice or an id taken since): the state changed. */
const isConstraint = (error: unknown) =>
  error instanceof Error &&
  "errcode" in error &&
  typeof error.errcode === "number" &&
  (error.errcode & 0xff) === 19;

const sameAssertion = (a: AssertionState, b: AssertionState) =>
  JSON.stringify(a) === JSON.stringify(b);

/** The episodes, or people, a capture holds (not those it saw absent). */
const present = (states: ReadonlyMap<number, unknown>) =>
  [...states].flatMap(([id, state]) => (state === null ? [] : [id]));

/**
 * Puts `target`'s state back, provided the state now prints `expected` (the
 * capture made on the other side of the same edit).
 */
export function restoreUndo(
  db: Database,
  input: { readonly target: UndoSnapshot; readonly expected: string; readonly nowMs: number },
): UndoRestore {
  const { target, nowMs } = input;
  try {
    return transaction(db, (): UndoRestore => {
      const now = captureUndo(db, target.scope, target.window);
      if (now.print !== input.expected) throw new Changed();
      restorePeople(db, target, now, nowMs);
      // The user's voice read follows the user back (ADR 034).
      settleVoiceRead(db);
      restoreAssertions(db, target, now);
      restoreContextStates(db, target.context, now.context);
      if (target.scope.level === "structure") restoreStructure(db, target, now, nowMs);
      else if (target.scope.level === "kind") restoreKind(db, target, nowMs);
      else if (target.scope.level === "text") restoreSegments(db, target, nowMs);
      forgetCreatedPeople(db, target, now);
      const kept = present(target.episodes);
      const keptPeople = present(target.people);
      const snapshot = captureUndo(db, target.scope, target.window);
      if (snapshot.print !== target.print) throw new Changed();
      return {
        ok: true,
        removed: present(now.episodes).filter((id) => !kept.includes(id)),
        kept,
        removedPeople: present(now.people).filter((id) => !keptPeople.includes(id)),
        keptPeople,
        snapshot,
      };
    });
  } catch (error) {
    if (error instanceof Changed || isConstraint(error)) return { ok: false, reason: "changed" };
    if (error instanceof PublishFailed) return { ok: false, reason: "refused" };
    throw error;
  }
}

function restorePeople(db: Database, target: UndoSnapshot, now: UndoSnapshot, nowMs: number) {
  // One user at most: whoever stops being them lets go first (a merge undone
  // gives it back to the person merged away).
  const letGo = db.statement("UPDATE people SET is_self = 0 WHERE id = ?");
  for (const [id, current] of now.people) {
    if (current?.isSelf === 1 && target.people.get(id)?.isSelf !== 1) letGo.run(id);
  }
  for (const [id, person] of target.people) {
    const current = now.people.get(id) ?? null;
    if (person === null) continue;
    if (current === null) {
      db.statement(
        "INSERT INTO people (id, name, is_self, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?)",
      ).run(id, person.name, person.isSelf, person.createdAtMs, nowMs);
    } else if (current.name !== person.name || current.isSelf !== person.isSelf) {
      db.statement("UPDATE people SET name = ?, is_self = ?, updated_at_ms = ? WHERE id = ?").run(
        person.name,
        person.isSelf,
        nowMs,
        id,
      );
    }
  }
}

/**
 * A person the restored state does not have goes, unless something still
 * names them or holds their voice read (ADR 034: undoing a name never erases
 * a read made since).
 */
function forgetCreatedPeople(db: Database, target: UndoSnapshot, now: UndoSnapshot) {
  for (const [id, person] of target.people) {
    if (person !== null || now.people.get(id) === null) continue;
    db.statement(
      `DELETE FROM people WHERE id = ?
       AND NOT EXISTS (SELECT 1 FROM user_assertions WHERE person_id = ? AND revoked_at_ms IS NULL)
       AND NOT EXISTS (SELECT 1 FROM voice_reads WHERE person_id = ?)`,
    ).run(id, id, id);
  }
}

/** Makes the assertions over the window the target's. */
function restoreAssertions(db: Database, target: UndoSnapshot, now: UndoSnapshot): void {
  const wanted = new Map(target.assertions.map((row) => [row.id, row]));
  const changed = now.assertions.filter((row) => {
    const other = wanted.get(row.id);
    return other === undefined || !sameAssertion(row, other);
  });
  const remove = db.statement("DELETE FROM user_assertions WHERE id = ?");
  for (const row of changed) if (!wanted.has(row.id)) remove.run(row.id);
  const update = db.statement(
    `UPDATE user_assertions SET kind = ?, track_run_id = ?, sample_start = ?, sample_end = ?,
       payload = ?, origin = ?, created_at_ms = ?, revoked_at_ms = ?, person_id = ? WHERE id = ?`,
  );
  const insert = db.statement(
    `INSERT INTO user_assertions (kind, track_run_id, sample_start, sample_end, payload, origin,
       created_at_ms, revoked_at_ms, person_id, id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const exists = db.statement("SELECT 1 FROM user_assertions WHERE id = ?");
  const held = new Map(now.assertions.map((row) => [row.id, row]));
  for (const row of target.assertions) {
    const current = held.get(row.id);
    if (current !== undefined && sameAssertion(row, current)) continue;
    const values = [
      row.kind,
      row.trackRunId,
      row.sampleStart,
      row.sampleEnd,
      row.payload,
      row.origin,
      row.createdAtMs,
      row.revokedAtMs,
      row.personId,
      row.id,
    ] as const;
    // An id outside the window (moved since) is taken: the state changed.
    if (current === undefined && exists.get(row.id) !== undefined) throw new Changed();
    (current === undefined ? insert : update).run(...values);
  }
}

/**
 * Shows each sentence as the target saw it: paired with today's by its bounds
 * and engine text (two voices over each other stay apart), its text and
 * correction set back.
 */
function restoreSegments(db: Database, target: UndoSnapshot, nowMs: number) {
  const held = new Map<string, { id: number; state: SegmentState }[]>();
  for (const segment of segmentsIn(db, target.window)) {
    const key = segmentKey(segment.state);
    held.set(key, [...(held.get(key) ?? []), segment]);
  }
  for (const state of target.segments) {
    const candidates = held.get(segmentKey(state)) ?? [];
    // The same sentence, preferably already showing what it should.
    const index = Math.max(
      0,
      candidates.findIndex(
        (candidate) => JSON.stringify(candidate.state) === JSON.stringify(state),
      ),
    );
    const [match] = candidates.splice(index, 1);
    if (match === undefined) throw new Changed();
    if (JSON.stringify(match.state) === JSON.stringify(state)) continue;
    showSegmentText(db, {
      segmentId: match.id,
      text: state.text,
      originalText: state.originalText,
      editId: state.editId,
      nowMs,
    });
  }
}

function restoreKind(db: Database, target: UndoSnapshot, nowMs: number) {
  const update = db.statement(
    `UPDATE episodes SET size = ?, context = ?, size_state = ?, kind_inputs = ?, updated_at_ms = ?
     WHERE id = ?`,
  );
  for (const [id, state] of target.episodes) {
    if (state?.kind === undefined || state.kind === null) continue;
    const { size, context, sizeState, kindInputs } = state.kind;
    update.run(size, context, sizeState, kindInputs, nowMs, id);
  }
}

function insertRun(
  db: Database,
  episodeId: number,
  source: RunSource,
  generation: number,
  nowMs: number,
): number {
  const { engine } = source;
  const row = db
    .statement(
      `INSERT INTO analysis_runs (episode_id, stage, status, engine_id, engine_version, engine_runtime,
         adapter_class, model_sha256, engine_config, input_hash, input_generation, coverage, metrics,
         started_at_ms, finished_at_ms)
       VALUES (?, ?, 'succeeded', ?, ?, ?, ?, ?, json_set(?, '$.derivedFrom', ?, '$.operation', 'undo'),
         ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      episodeId,
      str(engine, "stage"),
      str(engine, "engine_id"),
      str(engine, "engine_version"),
      str(engine, "engine_runtime"),
      str(engine, "adapter_class"),
      strOrNull(engine, "model_sha256"),
      str(engine, "engine_config"),
      source.lineage,
      `${str(engine, "input_hash")}:undo-${episodeId}-${nowMs}`,
      generation,
      engine["coverage"] === null ? null : num(engine, "coverage"),
      str(engine, "metrics"),
      nowMs,
      nowMs,
    );
  if (row === undefined) throw new Error("analysis_runs insert returned no row");
  return int(row, "id");
}

function restoreStructure(db: Database, target: UndoSnapshot, now: UndoSnapshot, nowMs: number) {
  const ids = [...target.episodes.keys()];
  // Every episode of the scope gives up its transcript and members first:
  // a slice moves between them.
  for (const id of ids) {
    if (now.episodes.get(id) === null) continue;
    cancelJobs(db, id, nowMs);
    retireLive(db, id);
    const run = currentRunId(db, id, "asr");
    if (run !== undefined) retireRun(db, run);
    db.statement("DELETE FROM episode_regions WHERE episode_id = ?").run(id);
    db.statement("DELETE FROM identity_rules WHERE scope = 'episode' AND episode_id = ?").run(id);
    if (target.episodes.get(id) === null) db.statement("DELETE FROM episodes WHERE id = ?").run(id);
  }
  const setRow = db.statement(
    `UPDATE episodes SET state = ?, context = ?, size = ?, size_state = ?, analysis_state = ?,
       started_at_ms = ?, ended_at_ms = ?, voiced_ms = ?, primary_app_id = ?, label = ?,
       grouping_version = ?, grouping_key = ?, page_key = ?, classifier_version = ?, kind_inputs = ?,
       created_at_ms = ?, updated_at_ms = ? WHERE id = ?`,
  );
  for (const id of ids) {
    const state = target.episodes.get(id);
    const row = state?.row;
    if (state === null || state === undefined || row === null || row === undefined) continue;
    if (now.episodes.get(id) === null) {
      db.statement(
        `INSERT INTO episodes (id, state, started_at_ms, grouping_version, classifier_version,
           created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        row.state,
        row.startedAtMs,
        row.groupingVersion,
        row.classifierVersion,
        row.createdAtMs,
        nowMs,
      );
    }
    const values = [
      row.state,
      row.context,
      row.size,
      row.sizeState,
      row.analysisState,
      row.startedAtMs,
      row.endedAtMs,
      row.voicedMs,
      row.primaryAppId,
      row.label,
      row.groupingVersion,
      row.groupingKey,
      row.pageKey,
      row.classifierVersion,
      row.kindInputs,
      row.createdAtMs,
      nowMs,
      id,
    ] as const;
    setRow.run(...values);
    const member = db.statement(
      `INSERT INTO episode_regions (episode_id, speech_region_id, grouping_version, slice_sample_start, slice_sample_end)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const slice of state.members ?? []) {
      member.run(id, slice.regionId, slice.groupingVersion, slice.start, slice.end);
    }
    if (state.rule !== null) {
      db.statement(
        `INSERT INTO identity_rules (scope, episode_id, recognize, created_at_ms, updated_at_ms)
         VALUES ('episode', ?, ?, ?, ?)`,
      ).run(id, state.rule, nowMs, nowMs);
    }
    // Jobs in flight for the old audio set are refused at publish.
    const generation = bumpInputGeneration(db, id, nowMs);
    const source = target.sources.get(id);
    if (state.transcript !== null && source !== undefined) {
      const run = insertRun(db, id, source, generation, nowMs);
      republish(db, id, run, generation, state.transcript.segments, state.transcript.turns, nowMs);
      // Due for analysis again, as it was; its text shows meanwhile.
      if (!state.transcript.current) bumpInputGeneration(db, id, nowMs);
    }
    // Publishing marks the analysis; the row is put back as it was.
    setRow.run(...values);
  }
}
