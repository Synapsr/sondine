import { transaction, type Database } from "./database";
import { hasDeletedRanges, intersectsDeletedRange } from "./deleted-ranges";
import { int, oneOfValues, str } from "./rows";
import { analysisRunStatuses, type AnalysisStage, type AnalysisState } from "./schema/enums";
import { searchTextOf } from "./search-text";
import { projectTranscriptEdits, type ProjectedSegment } from "./transcript-edits";
import { spellAsTaught } from "./vocabulary";
import { packWords, type WordTiming } from "./words";

/** One transcript segment. Samples index the track run; times are wall ms. */
export interface SegmentInput {
  readonly trackRunId: number;
  readonly sampleStart: number;
  readonly sampleEnd: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly speakerLabel?: string | null;
  readonly lang?: string | null;
  readonly confidence?: number | null;
  readonly words?: readonly WordTiming[] | null;
}

export interface TurnInput {
  readonly trackRunId: number;
  readonly sampleStart: number;
  readonly sampleEnd: number;
  readonly startMs: number;
  readonly endMs: number;
  /** Engine-local speaker label, e.g. "S1". */
  readonly speakerLabel: string;
  readonly confidence?: number | null;
}

export interface PublishAnalysisInput {
  readonly episodeId: number;
  readonly stage: AnalysisStage;
  readonly runId: number;
  /** The episode input generation the run was computed from. */
  readonly inputGeneration: number;
  readonly segments: readonly SegmentInput[];
  readonly turns: readonly TurnInput[];
  /** Written to the episode in the same transaction when given. */
  readonly analysisState?: AnalysisState;
  readonly nowMs?: number;
}

export type PublishRejection =
  | "episode_missing"
  | "run_missing"
  | "run_mismatch"
  | "run_not_publishable"
  | "already_published"
  | "stale_generation"
  | "deleted_range"
  | "final_exists";

export type PublishResult =
  | {
      readonly published: true;
      readonly supersededRunIds: readonly number[];
      readonly segmentCount: number;
      readonly turnCount: number;
      readonly speakerCount: number;
    }
  | { readonly published: false; readonly reason: PublishRejection };

/** Stages whose segments carry searchable text. */
export const textStages: readonly AnalysisStage[] = ["asr", "asr_live"];

export class PublishInputError extends TypeError {
  override readonly name = "PublishInputError";
}

/**
 * Compare-and-publish: in one transaction, checks that the episode still
 * exists at `inputGeneration`, that the run belongs to it, and that no output
 * intersects a deleted range; then swaps the episode's current run for
 * `stage`, replacing the superseded run's segments, turns, speakers, and
 * full-text rows. A refused run is marked `discarded` (except for identity
 * mismatches, which leave the run untouched).
 */
export function publishAnalysis(db: Database, input: PublishAnalysisInput): PublishResult {
  if (input.segments.length > 0 && !textStages.includes(input.stage)) {
    throw new PublishInputError(`Stage ${input.stage} cannot publish segments`);
  }
  const nowMs = input.nowMs ?? Date.now();
  return transaction(db, () => {
    const episode = db
      .statement("SELECT input_generation FROM episodes WHERE id = ?")
      .get(input.episodeId);
    if (episode === undefined) return reject("episode_missing");

    const run = db
      .statement(
        "SELECT episode_id, stage, status, input_generation FROM analysis_runs WHERE id = ?",
      )
      .get(input.runId);
    if (run === undefined) return reject("run_missing");
    if (int(run, "episode_id") !== input.episodeId || str(run, "stage") !== input.stage) {
      return reject("run_mismatch");
    }
    const status = oneOfValues(run, "status", analysisRunStatuses);
    if (status === "published") return reject("already_published");
    if (status !== "running" && status !== "succeeded") return reject("run_not_publishable");

    const discard = (reason: PublishRejection): PublishResult => {
      db.statement(
        "UPDATE analysis_runs SET status = 'discarded', finished_at_ms = coalesce(finished_at_ms, ?) WHERE id = ?",
      ).run(nowMs, input.runId);
      return reject(reason);
    };
    if (
      int(episode, "input_generation") !== input.inputGeneration ||
      int(run, "input_generation") !== input.inputGeneration
    ) {
      return discard("stale_generation");
    }
    if (input.stage === "asr_live" && currentRunId(db, input.episodeId, "asr") !== undefined) {
      return discard("final_exists");
    }
    if (outputsIntersectDeletedRanges(db, [...input.segments, ...input.turns])) {
      return discard("deleted_range");
    }

    const superseded = [input.stage, ...(input.stage === "asr" ? ["asr_live" as const] : [])]
      .map((stage) => currentRunId(db, input.episodeId, stage))
      .filter((runId) => runId !== undefined);
    for (const runId of superseded) retireRun(db, runId);

    const speakerIds = insertSpeakers(db, input);
    // The user's corrections outlive the transcript they were made on, and
    // the names they taught are spelled their way, in near-live text too.
    const segments =
      input.stage === "asr"
        ? spellAsTaught(db, input.episodeId, projectTranscriptEdits(db, input.segments))
        : input.stage === "asr_live"
          ? spellAsTaught(db, input.episodeId, input.segments)
          : input.segments;
    insertSegments(db, input, segments, speakerIds);
    insertTurns(db, input, speakerIds);

    db.statement(
      `INSERT INTO episode_analysis (episode_id, stage, run_id, input_generation, published_at_ms)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(input.episodeId, input.stage, input.runId, input.inputGeneration, nowMs);
    db.statement(
      `UPDATE analysis_runs
       SET status = 'published', published_at_ms = ?, finished_at_ms = coalesce(finished_at_ms, ?)
       WHERE id = ?`,
    ).run(nowMs, nowMs, input.runId);
    db.statement(
      "UPDATE episodes SET analysis_state = coalesce(?, analysis_state), updated_at_ms = ? WHERE id = ?",
    ).run(input.analysisState ?? null, nowMs, input.episodeId);

    return {
      published: true,
      supersededRunIds: superseded,
      segmentCount: segments.length,
      turnCount: input.turns.length,
      speakerCount: speakerIds.size,
    };
  });
}

const reject = (reason: PublishRejection): PublishResult => ({ published: false, reason });

export function currentRunId(
  db: Database,
  episodeId: number,
  stage: AnalysisStage,
): number | undefined {
  const row = db
    .statement("SELECT run_id FROM episode_analysis WHERE episode_id = ? AND stage = ?")
    .get(episodeId, stage);
  return row === undefined ? undefined : int(row, "run_id");
}

/** Removes a run's outputs (index entries first) and marks it superseded. */
export function retireRun(db: Database, runId: number): void {
  db.statement(
    `INSERT INTO segments_fts (segments_fts, rowid, search_text)
     SELECT 'delete', id, search_text FROM segments WHERE run_id = ?`,
  ).run(runId);
  db.statement("DELETE FROM segments WHERE run_id = ?").run(runId);
  db.statement("DELETE FROM speaker_turns WHERE run_id = ?").run(runId);
  db.statement("DELETE FROM episode_speakers WHERE run_id = ?").run(runId);
  // A replaced transcript's voices are biometric data with no use left.
  db.statement("DELETE FROM speaker_embeddings WHERE run_id = ?").run(runId);
  db.statement("DELETE FROM voice_passes WHERE run_id = ?").run(runId);
  db.statement("DELETE FROM voice_links WHERE run_id = ?").run(runId);
  db.statement("DELETE FROM episode_analysis WHERE run_id = ?").run(runId);
  db.statement("UPDATE analysis_runs SET status = 'superseded' WHERE id = ?").run(runId);
}

interface Span {
  readonly trackRunId: number;
  readonly sampleStart: number;
  readonly sampleEnd: number;
  readonly startMs: number;
  readonly endMs: number;
}

function outputsIntersectDeletedRanges(db: Database, spans: readonly Span[]): boolean {
  if (spans.length === 0 || !hasDeletedRanges(db)) return false;
  const envelopes = new Map<number, Span>();
  for (const span of spans) {
    const envelope = envelopes.get(span.trackRunId);
    envelopes.set(
      span.trackRunId,
      envelope === undefined
        ? span
        : {
            trackRunId: span.trackRunId,
            sampleStart: Math.min(envelope.sampleStart, span.sampleStart),
            sampleEnd: Math.max(envelope.sampleEnd, span.sampleEnd),
            startMs: Math.min(envelope.startMs, span.startMs),
            endMs: Math.max(envelope.endMs, span.endMs),
          },
    );
  }
  const hits = (span: Span): boolean =>
    intersectsDeletedRange(db, {
      trackRunId: span.trackRunId,
      sampleStart: span.sampleStart,
      sampleEnd: span.sampleEnd,
      wallStartMs: span.startMs,
      wallEndMs: span.endMs,
    });
  const suspect = new Set([...envelopes.values()].filter(hits).map((span) => span.trackRunId));
  return spans.some((span) => suspect.has(span.trackRunId) && hits(span));
}

/** One episode speaker per distinct label, ordered by first appearance. */
function insertSpeakers(db: Database, input: PublishAnalysisInput): Map<string, number> {
  const speakers = new Map<string, { firstMs: number; voicedMs: number }>();
  const add = (label: string, startMs: number, durationMs: number): void => {
    const speaker = speakers.get(label);
    if (speaker === undefined) speakers.set(label, { firstMs: startMs, voicedMs: durationMs });
    else {
      speaker.firstMs = Math.min(speaker.firstMs, startMs);
      speaker.voicedMs += durationMs;
    }
  };
  for (const turn of input.turns) add(turn.speakerLabel, turn.startMs, turn.endMs - turn.startMs);
  const fromTurns = speakers.size > 0;
  for (const segment of input.segments) {
    if (segment.speakerLabel === undefined || segment.speakerLabel === null) continue;
    if (fromTurns && speakers.has(segment.speakerLabel)) continue;
    add(segment.speakerLabel, segment.startMs, segment.endMs - segment.startMs);
  }

  const insert = db.statement(
    `INSERT INTO episode_speakers (episode_id, run_id, label, ordinal, voiced_ms) VALUES (?, ?, ?, ?, ?)`,
  );
  const ids = new Map<string, number>();
  const ordered = [...speakers.entries()].toSorted(
    ([labelA, a], [labelB, b]) => a.firstMs - b.firstMs || (labelA < labelB ? -1 : 1),
  );
  for (const [index, [label, speaker]] of ordered.entries()) {
    const result = insert.run(input.episodeId, input.runId, label, index + 1, speaker.voicedMs);
    ids.set(label, Number(result.lastInsertRowid));
  }
  return ids;
}

function insertSegments(
  db: Database,
  input: PublishAnalysisInput,
  segments: readonly ProjectedSegment[],
  speakerIds: Map<string, number>,
): void {
  const insert = db.statement(
    `INSERT INTO segments (run_id, episode_id, track_run_id, seq, sample_start, sample_end, start_ms,
       end_ms, speaker_label, episode_speaker_id, text, search_text, lang, confidence, words,
       original_text, edit_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const index = db.statement("INSERT INTO segments_fts (rowid, search_text) VALUES (?, ?)");
  for (const [seq, segment] of segments.entries()) {
    const label = segment.speakerLabel ?? null;
    const searchText = searchTextOf(segment.text, segment.lang);
    const result = insert.run(
      input.runId,
      input.episodeId,
      segment.trackRunId,
      seq,
      segment.sampleStart,
      segment.sampleEnd,
      segment.startMs,
      segment.endMs,
      label,
      label === null ? null : (speakerIds.get(label) ?? null),
      segment.text,
      searchText,
      segment.lang ?? null,
      segment.confidence ?? null,
      segment.words === undefined || segment.words === null ? null : packWords(segment.words),
      segment.originalText ?? null,
      segment.editId ?? null,
    );
    index.run(result.lastInsertRowid, searchText);
  }
}

function insertTurns(
  db: Database,
  input: PublishAnalysisInput,
  speakerIds: Map<string, number>,
): void {
  const insert = db.statement(
    `INSERT INTO speaker_turns (run_id, episode_id, track_run_id, sample_start, sample_end, start_ms,
       end_ms, speaker_label, episode_speaker_id, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const turn of input.turns) {
    insert.run(
      input.runId,
      input.episodeId,
      turn.trackRunId,
      turn.sampleStart,
      turn.sampleEnd,
      turn.startMs,
      turn.endMs,
      turn.speakerLabel,
      speakerIds.get(turn.speakerLabel) ?? null,
      turn.confidence ?? null,
    );
  }
}

/** Marks a new input generation, so runs computed from older input are discarded. */
export function bumpInputGeneration(db: Database, episodeId: number, nowMs = Date.now()): number {
  const row = db
    .statement(
      `UPDATE episodes SET input_generation = input_generation + 1, updated_at_ms = ?
       WHERE id = ? RETURNING input_generation`,
    )
    .get(nowMs, episodeId);
  if (row === undefined) throw new PublishInputError(`Unknown episode ${episodeId}`);
  return int(row, "input_generation");
}
