import type { Database } from "./database";
import { intersectsDeletedRange } from "./deleted-ranges";
import { wallMsAtSample } from "./episodes-store";
import { int } from "./rows";

/** A stretch of one track run, in run samples, half-open. */
export interface TrackStretch {
  readonly trackRunId: number;
  readonly sampleStart: number;
  readonly sampleEnd: number;
}

/** Chunks follow each other to the sample; this much is rounding, not a hole. */
const ROUNDING_MS = 50;

const roundingOf = (db: Database, trackRunId: number): number | null => {
  const run = db.statement("SELECT sample_rate FROM track_runs WHERE id = ?").get(trackRunId);
  return run === undefined ? null : Math.round((int(run, "sample_rate") * ROUNDING_MS) / 1000);
};

/** Whether Sondine captured all of a stretch, without a hole. */
export function stretchCaptured(db: Database, stretch: TrackStretch): boolean {
  const { trackRunId, sampleStart, sampleEnd } = stretch;
  const rounding = roundingOf(db, trackRunId);
  if (rounding === null || sampleStart < 0 || sampleEnd <= sampleStart) return false;
  let reach = sampleStart;
  for (const row of db
    .statement(
      `SELECT sample_start, sample_count FROM chunks
       WHERE track_run_id = ? AND sample_start < ? AND sample_start + sample_count > ?
       ORDER BY sample_start`,
    )
    .all(trackRunId, sampleEnd, sampleStart)) {
    if (int(row, "sample_start") > reach + rounding) return false;
    reach = Math.max(reach, int(row, "sample_start") + int(row, "sample_count"));
  }
  return reach >= sampleEnd - rounding;
}

/**
 * Whether a text known from elsewhere, said over the whole of `stretch`, may
 * stand for what the episode heard (ADR 020): Sondine captured all of it,
 * every speech in it is this episode's, and the user neither deleted nor
 * corrected anything there.
 */
export function ownsStretch(db: Database, episodeId: number, stretch: TrackStretch): boolean {
  const { trackRunId, sampleStart, sampleEnd } = stretch;
  const rounding = roundingOf(db, trackRunId);
  if (rounding === null) return false;
  if (!stretchCaptured(db, stretch)) return false;

  if (
    intersectsDeletedRange(db, {
      ...stretch,
      wallStartMs: wallMsAtSample(db, trackRunId, sampleStart),
      wallEndMs: wallMsAtSample(db, trackRunId, sampleEnd),
    })
  ) {
    return false;
  }
  const corrected = db
    .statement(
      `SELECT 1 FROM user_assertions
       WHERE kind = 'transcript_edit' AND revoked_at_ms IS NULL AND track_run_id = ?
         AND sample_start < ? AND sample_end > ? LIMIT 1`,
    )
    .get(trackRunId, sampleEnd, sampleStart);
  if (corrected !== undefined) return false;

  // Speech in the stretch that another episode has, or none: not this episode's to tell.
  const own = db
    .statement(
      `SELECT coalesce(er.slice_sample_start, r.sample_start) AS a,
         coalesce(er.slice_sample_end, r.sample_end) AS b
       FROM episode_regions er JOIN speech_regions r ON r.id = er.speech_region_id
       WHERE er.episode_id = ? AND r.track_run_id = ? ORDER BY a`,
    )
    .all(episodeId, trackRunId)
    .map((row) => [int(row, "a"), int(row, "b")] as const);
  return db
    .statement(
      `SELECT max(sample_start, ?) AS a, min(coalesce(sample_end, ?), ?) AS b FROM speech_regions
       WHERE track_run_id = ? AND sample_start < ? AND coalesce(sample_end, ?) > ?`,
    )
    .all(sampleStart, sampleEnd, sampleEnd, trackRunId, sampleEnd, sampleEnd, sampleStart)
    .every((row) => {
      const from = int(row, "a");
      const to = int(row, "b");
      const kept = own.reduce(
        (sum, [a, b]) => sum + Math.max(0, Math.min(to, b) - Math.max(from, a)),
        0,
      );
      return kept >= to - from - rounding;
    });
}
