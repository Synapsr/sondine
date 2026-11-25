import { decideSize, kindInputsOf, SIZE_TABLE_VERSION, type EpisodeSize } from "@sondine/core";
import { transaction, type Database } from "./database";
import { applyKindOverride } from "./episode-kind";
import { isPhoneHeld, phoneHeldSql } from "./phone-recordings";
import {
  bumpInputGeneration,
  currentRunId,
  publishAnalysis,
  retireRun,
  type SegmentInput,
  type TurnInput,
} from "./publish";
import { int, intOrNull, num, str, strOrNull, type Row } from "./rows";
import { unpackWords } from "./words";

// Splitting and merging closed episodes (M2; ADR 007). A closed episode is
// never regrouped, so its boundaries are its rows: a split moves the members
// after the cut to a new episode (a region across the cut is sliced), a merge
// moves the later episode's members into the earlier one. Their transcript
// moves with them, so nothing waits hours for Nemotron: its segments and
// turns are published again as derived runs through compare-and-publish
// (speakers, ordinals, full-text rows and the user's corrections are rebuilt
// there; names follow, being anchored to capture samples). A derived run is
// certified for the new generation only when its source was current;
// otherwise the episode stays due for analysis and the moved text shows
// meanwhile. The capture (audio, tombstones, assertions) is never touched.
//
// Late regions arriving after a split are repaired into the episode they
// overlap most, as before: they arrive within minutes of the episode's end,
// before anyone splits it.

export type BoundaryRefusal =
  /** No such episode, or it is still open. */
  | "missing"
  /** The cut is not strictly inside the episode, or one side would hold no speech. */
  | "outside"
  /** Not neighbours, or their audio cannot be joined. */
  | "apart"
  /**
   * A phone recording or an imported file (track run kind `phone`): kept
   * whole (its 2 s audio blocks would be cut through, and a delete of one side
   * would take the other's edge).
   */
  | "kept-whole";

export type BoundaryOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: BoundaryRefusal };

export class Refused extends Error {
  readonly reason: BoundaryRefusal;
  constructor(reason: BoundaryRefusal) {
    super(reason);
    this.reason = reason;
  }
}

/** A derived transcript was refused at publish; the operation is undone. */
export class PublishFailed extends Error {}

/** One member slice with its region's clock. */
export interface Member {
  readonly regionId: number;
  readonly trackRunId: number;
  readonly appId: number | null;
  readonly groupingVersion: string;
  readonly regionStart: number;
  /** Past any sample while the region goes on (the user's end cut the slice, ADR 044). */
  readonly regionEnd: number;
  readonly wallStartMs: number;
  readonly sampleRate: number;
  readonly voicedSamples: number | null;
  readonly start: number;
  readonly end: number;
}

export function loadMembers(db: Database, episodeId: number): Member[] {
  return db
    .statement(
      `SELECT r.id, r.track_run_id, t.app_id, m.grouping_version, r.sample_start, r.sample_end,
         r.wall_start_ms, t.sample_rate, r.voiced_samples, m.slice_sample_start, m.slice_sample_end
       FROM episode_regions m
       JOIN speech_regions r ON r.id = m.speech_region_id
       JOIN track_runs t ON t.id = r.track_run_id
       WHERE m.episode_id = ?
       ORDER BY r.wall_start_ms, m.slice_sample_start`,
    )
    .all(episodeId)
    .map((row) => {
      const regionEnd = intOrNull(row, "sample_end");
      const end = intOrNull(row, "slice_sample_end") ?? regionEnd;
      // A closed episode's slices end; one that does not cannot be cut safely.
      if (end === null) throw new Refused("outside");
      return {
        regionId: int(row, "id"),
        trackRunId: int(row, "track_run_id"),
        appId: intOrNull(row, "app_id"),
        groupingVersion: str(row, "grouping_version"),
        regionStart: int(row, "sample_start"),
        regionEnd: regionEnd ?? Number.MAX_SAFE_INTEGER,
        wallStartMs: int(row, "wall_start_ms"),
        sampleRate: int(row, "sample_rate"),
        voicedSamples: intOrNull(row, "voiced_samples"),
        start: int(row, "slice_sample_start"),
        end,
      };
    });
}

/** Wall ms of a sample, on its region's clock (as grouping places slices). */
export const wallAt = (member: Member, sample: number) =>
  member.wallStartMs + Math.round(((sample - member.regionStart) * 1000) / member.sampleRate);
export const sampleAt = (member: Member, ms: number) =>
  member.regionStart + Math.round(((ms - member.wallStartMs) * member.sampleRate) / 1000);

/** VAD speech in a slice: its share of the region's voiced samples. */
function voicedMs(member: Member): number {
  const length = member.end - member.start;
  const region = Math.max(1, member.regionEnd - member.regionStart);
  const voiced = member.voicedSamples === null ? length : (member.voicedSamples * length) / region;
  return (voiced * 1000) / member.sampleRate;
}

export interface Span {
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly voicedMs: number;
  readonly primaryAppId: number | null;
}

export function spanOf(members: readonly Member[]): Span {
  const byApp = new Map<number, number>();
  for (const member of members) {
    if (member.appId !== null) {
      byApp.set(member.appId, (byApp.get(member.appId) ?? 0) + (member.end - member.start));
    }
  }
  let primaryAppId: number | null = null;
  let most = -1;
  for (const [appId, samples] of byApp) {
    if (samples > most || (samples === most && primaryAppId !== null && appId < primaryAppId)) {
      primaryAppId = appId;
      most = samples;
    }
  }
  return {
    startedAtMs: Math.min(...members.map((member) => wallAt(member, member.start))),
    endedAtMs: Math.max(...members.map((member) => wallAt(member, member.end))),
    voicedMs: Math.round(members.reduce((sum, member) => sum + voicedMs(member), 0)),
    primaryAppId,
  };
}

/**
 * The members' span, without the speech deleted ranges took out of their
 * slices (a passage deleted inside one stays a hole that does not count).
 */
export function liveSpanOf(db: Database, members: readonly Member[]): Span {
  const span = spanOf(members);
  const track = db.statement(
    `SELECT sample_start, sample_end FROM deleted_ranges
     WHERE scope = 'track_run' AND track_run_id = ? AND sample_start < ? AND sample_end > ?`,
  );
  // `all` tombstones spare imported recordings (`findDeletedRanges`).
  const everywhere = db.statement(
    `SELECT wall_start_ms, wall_end_ms FROM deleted_ranges
     WHERE scope = 'all' AND wall_start_ms < ? AND wall_end_ms > ?
       AND NOT EXISTS (SELECT 1 FROM track_runs t WHERE t.id = ? AND t.source_kind = 'phone')`,
  );
  let erasedMs = 0;
  for (const member of members) {
    const clip = (from: number, to: number): [number, number] => [
      Math.max(member.start, from),
      Math.min(member.end, to),
    ];
    const cuts = [
      ...track
        .all(member.trackRunId, member.end, member.start)
        .map((row) => clip(int(row, "sample_start"), int(row, "sample_end"))),
      ...everywhere
        .all(wallAt(member, member.end), wallAt(member, member.start), member.trackRunId)
        .map((row) =>
          clip(
            sampleAt(member, int(row, "wall_start_ms")),
            sampleAt(member, int(row, "wall_end_ms")),
          ),
        ),
    ]
      .filter(([a, b]) => b > a)
      .toSorted((x, y) => x[0] - y[0]);
    let covered = 0;
    let reach = -Infinity;
    for (const [a, b] of cuts) {
      if (b <= reach) continue;
      covered += b - Math.max(a, reach);
      reach = b;
    }
    const region = Math.max(1, member.regionEnd - member.regionStart);
    const density = (member.voicedSamples ?? region) / region;
    erasedMs += (covered * density * 1000) / member.sampleRate;
  }
  return { ...span, voicedMs: Math.max(0, Math.round(span.voicedMs - erasedMs)) };
}

export function writeMembers(db: Database, episodeId: number, members: readonly Member[]): void {
  db.statement("DELETE FROM episode_regions WHERE episode_id = ?").run(episodeId);
  const insert = db.statement(
    `INSERT INTO episode_regions (episode_id, speech_region_id, grouping_version, slice_sample_start, slice_sample_end)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const member of members) {
    insert.run(
      episodeId,
      member.regionId,
      member.groupingVersion,
      member.start,
      // A slice that runs to its region's end is stored open-ended, as grouping does.
      member.end === member.regionEnd ? null : member.end,
    );
  }
}

/** A run's outputs as publish inputs: the engine's text (corrections are re-applied), words unpacked. */
export interface Transcript {
  readonly runId: number;
  /** The run's analysis was current for its episode's audio. */
  readonly current: boolean;
  readonly segments: readonly SegmentInput[];
  readonly turns: readonly TurnInput[];
  /** Corrected segments: their assertion and side, to clip anchors across a cut. */
  readonly edits: readonly { readonly editId: number; readonly segment: SegmentInput }[];
}

export function loadTranscript(
  db: Database,
  episodeId: number,
  stage: "asr" | "asr_live" = "asr",
): Transcript | null {
  const runId = currentRunId(db, episodeId, stage);
  if (runId === undefined) return null;
  const current =
    db
      .statement(
        `SELECT 1 AS current FROM episode_analysis a JOIN episodes e ON e.id = a.episode_id
         WHERE a.run_id = ? AND a.input_generation = e.input_generation`,
      )
      .get(runId) !== undefined;
  const edits: { editId: number; segment: SegmentInput }[] = [];
  const segments = db
    .statement(
      `SELECT track_run_id, sample_start, sample_end, start_ms, end_ms, speaker_label, text,
         original_text, edit_id, lang, confidence, words
       FROM segments WHERE run_id = ? ORDER BY seq`,
    )
    .all(runId)
    .map((row) => {
      const words = row["words"];
      const segment: SegmentInput = {
        trackRunId: int(row, "track_run_id"),
        sampleStart: int(row, "sample_start"),
        sampleEnd: int(row, "sample_end"),
        startMs: int(row, "start_ms"),
        endMs: int(row, "end_ms"),
        text: strOrNull(row, "original_text") ?? str(row, "text"),
        speakerLabel: strOrNull(row, "speaker_label"),
        lang: strOrNull(row, "lang"),
        confidence: row["confidence"] === null ? null : num(row, "confidence"),
        words: words instanceof Uint8Array ? unpackWords(words) : null,
      };
      const editId = intOrNull(row, "edit_id");
      if (editId !== null) edits.push({ editId, segment });
      return segment;
    });
  const turns = db
    .statement(
      `SELECT track_run_id, sample_start, sample_end, start_ms, end_ms, speaker_label, confidence
       FROM speaker_turns WHERE run_id = ? ORDER BY start_ms, id`,
    )
    .all(runId)
    .map((row) => ({
      trackRunId: int(row, "track_run_id"),
      sampleStart: int(row, "sample_start"),
      sampleEnd: int(row, "sample_end"),
      startMs: int(row, "start_ms"),
      endMs: int(row, "end_ms"),
      speakerLabel: str(row, "speaker_label"),
      confidence: row["confidence"] === null ? null : num(row, "confidence"),
    }));
  return { runId, current, segments, turns, edits };
}

/** The pieces of a segment before and after `atMs`, cut between its words (by their middle). */
function cutSegment(
  segment: SegmentInput,
  atMs: number,
): [SegmentInput | null, SegmentInput | null] {
  if (segment.endMs <= atMs) return [segment, null];
  if (segment.startMs >= atMs) return [null, segment];
  const words = segment.words ?? [];
  const middle = (segment.startMs + segment.endMs) / 2;
  // Untimed (or corrected) text cannot be cut: it goes where most of it lies.
  if (words.length === 0) return middle < atMs ? [segment, null] : [null, segment];
  const before = words.filter((word) => segment.startMs + (word.startMs + word.endMs) / 2 < atMs);
  if (before.length === 0) return [null, segment];
  if (before.length === words.length) return [segment, null];
  const durationMs = Math.max(1, segment.endMs - segment.startMs);
  const perMs = (segment.sampleEnd - segment.sampleStart) / durationMs;
  const piece = (from: number, to: number): SegmentInput | null => {
    const head = words[from];
    const tail = words[to - 1];
    if (head === undefined || tail === undefined) return null;
    const startMs = from === 0 ? 0 : head.startMs;
    const endMs = to === words.length ? durationMs : tail.endMs;
    const charStart = from === 0 ? 0 : head.charStart;
    const charEnd = to === words.length ? segment.text.length : tail.charEnd;
    const raw = segment.text.slice(charStart, charEnd);
    const text = raw.trim();
    if (text === "") return null;
    const lead = raw.search(/\S/u);
    return {
      ...segment,
      sampleStart: segment.sampleStart + Math.round(startMs * perMs),
      sampleEnd: Math.min(segment.sampleEnd, segment.sampleStart + Math.round(endMs * perMs)),
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
  return [piece(0, before.length), piece(before.length, words.length)];
}

/** A turn's parts before and after `atMs`; empty parts are dropped. */
function cutTurn(turn: TurnInput, atMs: number): [TurnInput | null, TurnInput | null] {
  if (turn.endMs <= atMs) return [turn, null];
  if (turn.startMs >= atMs) return [null, turn];
  const perMs = (turn.sampleEnd - turn.sampleStart) / Math.max(1, turn.endMs - turn.startMs);
  const cut = turn.sampleStart + Math.round((atMs - turn.startMs) * perMs);
  return [
    { ...turn, endMs: atMs, sampleEnd: cut },
    { ...turn, startMs: atMs, sampleStart: cut },
  ];
}

/** The derived runs' common ancestor: speakers of one lineage are the same voices. */
export function lineageOf(db: Database, runId: number): number {
  const row = db.statement("SELECT engine_config FROM analysis_runs WHERE id = ?").get(runId);
  if (row === undefined) return runId;
  const config = JSON.parse(str(row, "engine_config")) as { derivedFrom?: unknown };
  return typeof config.derivedFrom === "number" ? config.derivedFrom : runId;
}

/** A run for `episodeId` copying `source`'s engine, marked as derived from its lineage. */
export function deriveRun(
  db: Database,
  source: number,
  episodeId: number,
  generation: number,
  operation: string,
  nowMs: number,
): number {
  const lineage = lineageOf(db, source);
  const row = db
    .statement(
      `INSERT INTO analysis_runs (episode_id, stage, status, engine_id, engine_version, engine_runtime,
         adapter_class, model_sha256, engine_config, input_hash, input_generation, coverage, metrics,
         started_at_ms, finished_at_ms)
       SELECT ?, stage, 'succeeded', engine_id, engine_version, engine_runtime, adapter_class,
         model_sha256, json_set(engine_config, '$.derivedFrom', ?, '$.operation', ?),
         input_hash || ':' || ?, ?, coverage, metrics, ?, ?
       FROM analysis_runs WHERE id = ? RETURNING id`,
    )
    .get(
      episodeId,
      lineage,
      operation,
      `${operation}-${episodeId}-${nowMs}`,
      generation,
      nowMs,
      nowMs,
      source,
    );
  if (row === undefined) throw new Error(`analysis run ${source} vanished`);
  return int(row, "id");
}

/**
 * Publishes a derived transcript; any refusal undoes the whole operation. A
 * live one (`asr_live`) stays provisional: the episode's analysis state is
 * left as it is.
 */
export function republish(
  db: Database,
  episodeId: number,
  runId: number,
  generation: number,
  segments: readonly SegmentInput[],
  turns: readonly TurnInput[],
  nowMs: number,
  stage: "asr" | "asr_live" = "asr",
): { speakers: number; turns: number } {
  const result = publishAnalysis(db, {
    episodeId,
    stage,
    runId,
    inputGeneration: generation,
    segments,
    turns,
    ...(stage === "asr" ? { analysisState: "complete" as const } : {}),
    nowMs,
  });
  if (!result.published) throw new PublishFailed(result.reason);
  return { speakers: result.speakerCount, turns: turns.length };
}

/** Writes a size decision for one part, from its own audio and, when transcribed, its speakers. */
export function redecide(
  db: Database,
  episodeId: number,
  span: Span,
  diarization: { readonly speakers: number; readonly turns: number } | null,
  previous: EpisodeSize | null,
  nowMs: number,
): void {
  const row = db.statement("SELECT context FROM episodes WHERE id = ?").get(episodeId);
  const context = row === undefined ? null : strOrNull(row, "context");
  const decision = decideSize({
    context:
      context === "call" || context === "media" || context === "mixed" ? context : "in_person",
    voicedMs: span.voicedMs,
    elapsedMs: Math.max(0, span.endedAtMs - span.startedAtMs),
    episodeOpen: false,
    diarization,
    ...(previous === null ? {} : { previous }),
  });
  db.statement(
    `UPDATE episodes SET started_at_ms = ?, ended_at_ms = ?, voiced_ms = ?, primary_app_id = ?,
       size = ?, size_state = ?, kind_inputs = ?, classifier_version = ?, updated_at_ms = ?
     WHERE id = ?`,
  ).run(
    span.startedAtMs,
    span.endedAtMs,
    span.voicedMs,
    span.primaryAppId,
    decision.size,
    decision.provisional ? "provisional" : "final",
    JSON.stringify(kindInputsOf(decision)),
    SIZE_TABLE_VERSION,
    nowMs,
    episodeId,
  );
  applyKindOverride(db, episodeId, nowMs);
}

export const cancelJobs = (db: Database, episodeId: number, nowMs: number) =>
  db
    .statement(
      `UPDATE jobs SET state = 'cancelled', updated_at_ms = ?, finished_at_ms = ?
       WHERE episode_id = ? AND state IN ('queued', 'running')`,
    )
    .run(nowMs, nowMs, episodeId);

/** A provisional transcript has no place once the audio moves: final analysis replaces it. */
export function retireLive(db: Database, episodeId: number): void {
  const live = currentRunId(db, episodeId, "asr_live");
  if (live !== undefined) retireRun(db, live);
}

/** The user's "do not identify" on an episode, which its parts and merges keep. */
function episodeRule(db: Database, episodeId: number): boolean | null {
  const row = db
    .statement("SELECT recognize FROM identity_rules WHERE scope = 'episode' AND episode_id = ?")
    .get(episodeId);
  return row === undefined ? null : int(row, "recognize") === 1;
}

function setEpisodeRule(db: Database, episodeId: number, recognize: boolean, nowMs: number): void {
  db.statement(
    `INSERT INTO identity_rules (scope, episode_id, recognize, created_at_ms, updated_at_ms)
     VALUES ('episode', ?, ?, ?, ?)
     ON CONFLICT DO UPDATE SET recognize = excluded.recognize, updated_at_ms = excluded.updated_at_ms`,
  ).run(episodeId, recognize ? 1 : 0, nowMs, nowMs);
}

export const sizeOf = (db: Database, episodeId: number): EpisodeSize | null => {
  const row = db.statement("SELECT size FROM episodes WHERE id = ?").get(episodeId);
  const size = row === undefined ? null : strOrNull(row, "size");
  return size === "trace" || size === "moment" || size === "conversation" ? size : null;
};

function closedEpisode(db: Database, episodeId: number): Row {
  const row = db
    .statement("SELECT * FROM episodes WHERE id = ? AND state = 'closed'")
    .get(episodeId);
  if (row === undefined) throw new Refused("missing");
  if (isPhoneHeld(db, episodeId)) throw new Refused("kept-whole");
  return row;
}

function attempt<T>(db: Database, run: () => T): BoundaryOutcome<T> {
  try {
    return { ok: true, value: transaction(db, run) };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, reason: error.reason };
    throw error;
  }
}

/**
 * Splits a closed episode at `atMs` (wall clock): what starts from there
 * becomes a new episode, its transcript with it.
 */
export function splitEpisode(
  db: Database,
  input: { readonly episodeId: number; readonly atMs: number; readonly nowMs: number },
): BoundaryOutcome<{ readonly episodeId: number; readonly newEpisodeId: number }> {
  const { episodeId, atMs, nowMs } = input;
  return attempt(db, () => {
    const episode = closedEpisode(db, episodeId);
    const before: Member[] = [];
    const after: Member[] = [];
    for (const member of loadMembers(db, episodeId)) {
      if (wallAt(member, member.end) <= atMs) before.push(member);
      else if (wallAt(member, member.start) >= atMs) after.push(member);
      else {
        const cut = Math.min(member.end - 1, Math.max(member.start + 1, sampleAt(member, atMs)));
        before.push({ ...member, end: cut });
        after.push({ ...member, start: cut });
      }
    }
    const left = before.length === 0 ? null : spanOf(before);
    const right = after.length === 0 ? null : spanOf(after);
    if (left === null || right === null || left.voicedMs <= 0 || right.voicedMs <= 0) {
      throw new Refused("outside");
    }
    const transcript = loadTranscript(db, episodeId);

    const created = db
      .statement(
        `INSERT INTO episodes (state, context, size, size_state, analysis_state, input_generation,
           started_at_ms, ended_at_ms, voiced_ms, primary_app_id, grouping_version, page_key,
           classifier_version, kind_inputs, created_at_ms, updated_at_ms)
         VALUES ('closed', ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        strOrNull(episode, "context"),
        strOrNull(episode, "size"),
        str(episode, "size_state"),
        "pending",
        right.startedAtMs,
        right.endedAtMs,
        right.voicedMs,
        right.primaryAppId,
        str(episode, "grouping_version"),
        // Both halves heard the same page.
        strOrNull(episode, "page_key"),
        str(episode, "classifier_version"),
        str(episode, "kind_inputs"),
        nowMs,
        nowMs,
      );
    if (created === undefined) throw new Error("episodes insert returned no row");
    const newEpisodeId = int(created, "id");
    writeMembers(db, episodeId, before);
    writeMembers(db, newEpisodeId, after);
    const rule = episodeRule(db, episodeId);
    if (rule !== null) setEpisodeRule(db, newEpisodeId, rule, nowMs);
    cancelJobs(db, episodeId, nowMs);
    retireLive(db, episodeId);
    const generation = bumpInputGeneration(db, episodeId, nowMs);
    const previous = sizeOf(db, episodeId);

    let diarization: [
      { speakers: number; turns: number } | null,
      { speakers: number; turns: number } | null,
    ] = [null, null];
    if (transcript !== null) {
      const segments: [SegmentInput[], SegmentInput[]] = [[], []];
      for (const segment of transcript.segments) {
        const [head, tail] = cutSegment(segment, atMs);
        if (head !== null) segments[0].push(head);
        if (tail !== null) segments[1].push(tail);
      }
      const turns: [TurnInput[], TurnInput[]] = [[], []];
      for (const turn of transcript.turns) {
        const [head, tail] = cutTurn(turn, atMs);
        if (head !== null && head.endMs > head.startMs) turns[0].push(head);
        if (tail !== null && tail.endMs > tail.startMs) turns[1].push(tail);
      }
      clipEdits(db, transcript, atMs);
      const leftRun = deriveRun(db, transcript.runId, episodeId, generation, "split", nowMs);
      diarization[0] = republish(db, episodeId, leftRun, generation, segments[0], turns[0], nowMs);
      const rightRun = deriveRun(db, transcript.runId, newEpisodeId, 1, "split", nowMs);
      diarization[1] = republish(db, newEpisodeId, rightRun, 1, segments[1], turns[1], nowMs);
      if (!transcript.current) {
        // The moved text shows; both parts stay due for a complete analysis.
        bumpInputGeneration(db, episodeId, nowMs);
        bumpInputGeneration(db, newEpisodeId, nowMs);
        diarization = [null, null];
      }
    }
    redecide(db, episodeId, liveSpanOf(db, before), diarization[0], previous, nowMs);
    redecide(db, newEpisodeId, liveSpanOf(db, after), diarization[1], null, nowMs);
    return { episodeId, newEpisodeId };
  });
}

/**
 * A correction made over the cut stays on the side of its segment: its
 * anchor is clipped at the cut, so the other side's projection never takes it.
 */
function clipEdits(db: Database, transcript: Transcript, atMs: number): void {
  const update = db.statement(
    "UPDATE user_assertions SET sample_start = ?, sample_end = ? WHERE id = ?",
  );
  const anchor = db.statement("SELECT sample_start, sample_end FROM user_assertions WHERE id = ?");
  for (const { editId, segment } of transcript.edits) {
    const row = anchor.get(editId);
    if (row === undefined) continue;
    const start = int(row, "sample_start");
    const end = int(row, "sample_end");
    const perMs =
      (segment.sampleEnd - segment.sampleStart) / Math.max(1, segment.endMs - segment.startMs);
    const cut = segment.sampleStart + Math.round((atMs - segment.startMs) * perMs);
    if (cut <= start || cut >= end) continue;
    const before = (segment.startMs + segment.endMs) / 2 < atMs;
    if (before) update.run(start, cut, editId);
    else update.run(cut, end, editId);
  }
}

/**
 * The episodes just before and after one, among closed ones of its kind
 * (media with media, dictations with dictations); none for a phone recording
 * or an imported file (track run kind `phone`), which merge with nothing.
 */
export function episodeNeighbours(
  db: Database,
  episodeId: number,
): { previous: number | null; next: number | null } {
  const row = db
    .statement("SELECT started_at_ms, context FROM episodes WHERE id = ? AND state = 'closed'")
    .get(episodeId);
  if (row === undefined) return { previous: null, next: null };
  const startedAt = int(row, "started_at_ms");
  const context = strOrNull(row, "context");
  if (isPhoneHeld(db, episodeId)) return { previous: null, next: null };
  // Media with media, dictations with dictations, the rest together.
  const lane = context === "media" || context === "dictation" ? context : "";
  const kind = `e.state = 'closed' AND e.id <> ? AND NOT ${phoneHeldSql("e")}
    AND (CASE WHEN e.context IN ('media', 'dictation') THEN e.context ELSE '' END) = ?`;
  const previous = db
    .statement(
      `SELECT e.id FROM episodes e WHERE ${kind}
         AND (e.started_at_ms < ? OR (e.started_at_ms = ? AND e.id < ?))
       ORDER BY e.started_at_ms DESC, e.id DESC LIMIT 1`,
    )
    .get(episodeId, lane, startedAt, startedAt, episodeId);
  const next = db
    .statement(
      `SELECT e.id FROM episodes e WHERE ${kind}
         AND (e.started_at_ms > ? OR (e.started_at_ms = ? AND e.id > ?))
       ORDER BY e.started_at_ms, e.id LIMIT 1`,
    )
    .get(episodeId, lane, startedAt, startedAt, episodeId);
  return {
    previous: previous === undefined ? null : int(previous, "id"),
    next: next === undefined ? null : int(next, "id"),
  };
}

/** One slice per region: a region cut between the two episodes is whole again. */
function joinMembers(first: readonly Member[], second: readonly Member[]): Member[] {
  const byRegion = new Map<number, Member>();
  for (const member of [...first, ...second].toSorted((a, b) => a.start - b.start)) {
    const held = byRegion.get(member.regionId);
    if (held === undefined) byRegion.set(member.regionId, member);
    // Only touching slices join: a gap belongs to an episode in between.
    else if (held.end === member.start) byRegion.set(member.regionId, { ...held, end: member.end });
    else throw new Refused("apart");
  }
  return [...byRegion.values()];
}

/**
 * Merges two neighbouring closed episodes into the earlier one, with both
 * transcripts; the later episode goes, its capture stays. `continues`: the
 * other one goes on from this one (an end undone, ADR 044), whatever was
 * heard between them.
 */
export function mergeEpisodes(
  db: Database,
  input: {
    readonly episodeId: number;
    readonly otherId: number;
    readonly continues?: boolean;
    readonly nowMs: number;
  },
): BoundaryOutcome<{ readonly episodeId: number }> {
  const { nowMs } = input;
  return attempt(db, () => {
    if (input.episodeId === input.otherId) throw new Refused("apart");
    closedEpisode(db, input.episodeId);
    closedEpisode(db, input.otherId);
    const neighbours = episodeNeighbours(db, input.episodeId);
    const after = input.continues === true || neighbours.next === input.otherId;
    if (!after && neighbours.previous !== input.otherId) throw new Refused("apart");
    const [firstId, secondId] = after
      ? [input.episodeId, input.otherId]
      : [input.otherId, input.episodeId];
    const members = joinMembers(loadMembers(db, firstId), loadMembers(db, secondId));
    const transcripts = [loadTranscript(db, firstId), loadTranscript(db, secondId)] as const;
    const [firstTranscript, secondTranscript] = transcripts;
    // Voices of one lineage (a split coming back together) keep their labels;
    // voices of independent transcripts are kept apart. Read before the later
    // episode's runs go.
    const sameLineage =
      firstTranscript !== null &&
      secondTranscript !== null &&
      lineageOf(db, firstTranscript.runId) === lineageOf(db, secondTranscript.runId);
    const previous = sizeOf(db, firstId);

    // The stricter "do not identify" of the two applies to the whole.
    const rules = [episodeRule(db, firstId), episodeRule(db, secondId)];
    if (rules.includes(false)) setEpisodeRule(db, firstId, false, nowMs);
    else if (rules.includes(true)) setEpisodeRule(db, firstId, true, nowMs);

    for (const id of [firstId, secondId]) {
      cancelJobs(db, id, nowMs);
      retireLive(db, id);
    }
    // The later episode's text leaves the index before its rows go (runs,
    // speakers and rules cascade; its jobs keep their history, unlinked).
    const secondRun = currentRunId(db, secondId, "asr");
    if (secondRun !== undefined) retireRun(db, secondRun);
    db.statement("DELETE FROM episodes WHERE id = ?").run(secondId);
    writeMembers(db, firstId, members);
    const generation = bumpInputGeneration(db, firstId, nowMs);

    let diarization: { speakers: number; turns: number } | null = null;
    const [source] = transcripts.filter((transcript) => transcript !== null);
    if (source !== undefined) {
      const rename = (label: string) => (sameLineage ? label : `${label}·${secondId}`);
      const later = (transcript: Transcript | null) =>
        transcript === null
          ? { segments: [], turns: [] }
          : {
              segments: transcript.segments.map((segment) =>
                segment.speakerLabel === null || segment.speakerLabel === undefined
                  ? segment
                  : { ...segment, speakerLabel: rename(segment.speakerLabel) },
              ),
              turns: transcript.turns.map((turn) => ({
                ...turn,
                speakerLabel: rename(turn.speakerLabel),
              })),
            };
      const moved = later(secondTranscript);
      const segments = [...(firstTranscript?.segments ?? []), ...moved.segments].toSorted(
        (a, b) => a.startMs - b.startMs || a.trackRunId - b.trackRunId,
      );
      const turns = [...(firstTranscript?.turns ?? []), ...moved.turns];
      const run = deriveRun(db, source.runId, firstId, generation, "merge", nowMs);
      diarization = republish(db, firstId, run, generation, segments, turns, nowMs);
      const complete = firstTranscript?.current === true && secondTranscript?.current === true;
      if (!complete) {
        // Part of the audio was never transcribed: it stays due for analysis.
        bumpInputGeneration(db, firstId, nowMs);
        diarization = null;
      }
    }
    redecide(db, firstId, liveSpanOf(db, members), diarization, previous, nowMs);
    return { episodeId: firstId };
  });
}
