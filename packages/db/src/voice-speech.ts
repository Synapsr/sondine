import type { Database } from "./database";
import { int, str } from "./rows";
import { unpackWords } from "./words";

// Where each voice of a transcript speaks: its segments. Nemotron's
// alignment spread one sentence's words over minutes in transcripts made
// before the engine repaired them (ADR 016, "Word times"); such a segment
// spans other voices' speech, so a name given to its voice took theirs. A
// segment longer than `SLACK_MS` plus `MAX_MS_PER_WORD` a word is left out,
// unless its voice has no other.

const MAX_MS_PER_WORD = 1_000;
const SLACK_MS = 2_000;

/** One segment of one voice, in samples of a track run and wall ms. */
export interface VoicedSegment {
  readonly label: string;
  readonly trackRunId: number;
  readonly sampleRate: number;
  readonly sampleStart: number;
  readonly sampleEnd: number;
  readonly startMs: number;
  readonly endMs: number;
}

/** A run's segments with a voice, in time order, without those whose times the alignment lost. */
export function voicedSegments(db: Database, runId: number): VoicedSegment[] {
  const rows = db
    .statement(
      `SELECT s.speaker_label, s.track_run_id, s.sample_start, s.sample_end, s.start_ms, s.end_ms,
              s.words, t.sample_rate
       FROM segments s JOIN track_runs t ON t.id = s.track_run_id
       WHERE s.run_id = ? AND s.speaker_label IS NOT NULL ORDER BY s.start_ms, s.id`,
    )
    .all(runId)
    .map((row) => {
      const words = row["words"];
      const segment: VoicedSegment = {
        label: str(row, "speaker_label"),
        trackRunId: int(row, "track_run_id"),
        sampleRate: int(row, "sample_rate"),
        sampleStart: int(row, "sample_start"),
        sampleEnd: int(row, "sample_end"),
        startMs: int(row, "start_ms"),
        endMs: int(row, "end_ms"),
      };
      // Without word times there is nothing to judge the span by.
      const timed =
        !(words instanceof Uint8Array) ||
        segment.endMs - segment.startMs <= SLACK_MS + MAX_MS_PER_WORD * unpackWords(words).length;
      return { segment, timed };
    });
  const withTimes = new Set(rows.filter((row) => row.timed).map((row) => row.segment.label));
  return rows
    .filter((row) => row.timed || !withTimes.has(row.segment.label))
    .map((row) => row.segment);
}
