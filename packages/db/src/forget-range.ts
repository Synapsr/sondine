import { checkpointTruncate, transaction, type CheckpointResult, type Database } from "./database";
import { deleteEpisode, deletedChunks, type DeletedChunk } from "./delete-episode";
import { forgetForegroundBetween } from "./foreground";
import { phoneHeldSql, phoneRecordingSql } from "./phone-recordings";
import { int, intOrNull } from "./rows";
import type { AssertionOrigin } from "./schema/enums";
import { deletePlaysBetween } from "./web-plays";

// « Forget the last N minutes » (plan.md, Later 2): everything heard in a wall
// range goes, audio and text. An episode the range touches goes whole, its
// earlier part included: the confirmation lists them first. An `all`
// tombstone over the range catches the rest (audio outside any episode,
// regions not grouped yet, the region open at the end), so no import, regroup
// or late job brings any of it back.

export interface RangeEpisode {
  readonly id: number;
  readonly startedAtMs: number;
  /** Null while it is open. */
  readonly endedAtMs: number | null;
}

/** Episodes a forget over `[fromWallMs, toWallMs)` deletes: every one it overlaps. */
export function episodesInRange(
  db: Database,
  fromWallMs: number,
  toWallMs: number,
): RangeEpisode[] {
  return db
    .statement(
      // What the Mac heard then: a phone recording or an imported file is no
      // part of it, told by its track run's kind (ADR 032), not its context.
      `SELECT e.id, e.started_at_ms, e.ended_at_ms FROM episodes e
       WHERE e.started_at_ms < ? AND coalesce(e.ended_at_ms, ?) > ?
         AND NOT ${phoneHeldSql("e")}
       ORDER BY e.started_at_ms, e.id`,
    )
    .all(toWallMs, toWallMs, fromWallMs)
    .map((row) => ({
      id: int(row, "id"),
      startedAtMs: int(row, "started_at_ms"),
      endedAtMs: intOrNull(row, "ended_at_ms"),
    }));
}

/**
 * Phone recordings over `[fromWallMs, toWallMs)`: a forget leaves them alone,
 * and its confirmation names them and says they stay (ADR 032).
 */
export function phoneRecordingsInRange(
  db: Database,
  fromWallMs: number,
  toWallMs: number,
): RangeEpisode[] {
  return db
    .statement(
      `SELECT e.id, e.started_at_ms, e.ended_at_ms FROM episodes e
       WHERE e.started_at_ms < ? AND coalesce(e.ended_at_ms, ?) > ?
         AND ${phoneRecordingSql("e")}
       ORDER BY e.started_at_ms, e.id`,
    )
    .all(toWallMs, toWallMs, fromWallMs)
    .map((row) => ({
      id: int(row, "id"),
      startedAtMs: int(row, "started_at_ms"),
      endedAtMs: intOrNull(row, "ended_at_ms"),
    }));
}

export interface ForgetRangeOptions {
  readonly fromWallMs: number;
  readonly toWallMs: number;
  readonly origin: AssertionOrigin;
  readonly nowMs?: number;
  /** Truncate the WAL after the delete commits. Defaults to true. */
  readonly checkpoint?: boolean;
}

export interface ForgetRangeResult {
  readonly episodeIds: readonly number[];
  /** Audio blocks the caller must scrub from disk. */
  readonly chunks: readonly DeletedChunk[];
  readonly checkpoint: CheckpointResult | null;
}

/** One transaction; removing the audio bytes is left to the caller, as for `deleteEpisode`. */
export function forgetRange(db: Database, options: ForgetRangeOptions): ForgetRangeResult {
  const { fromWallMs, toWallMs } = options;
  if (!(fromWallMs < toWallMs)) {
    throw new RangeError(`Empty range [${fromWallMs}, ${toWallMs})`);
  }
  const nowMs = options.nowMs ?? Date.now();
  const result = transaction(db, () => {
    const episodeIds: number[] = [];
    const chunks: DeletedChunk[] = [];
    for (const episode of episodesInRange(db, fromWallMs, toWallMs)) {
      const removed = deleteEpisode(db, episode.id, {
        origin: options.origin,
        nowMs,
        checkpoint: false,
      });
      if (!removed.deleted) continue;
      episodeIds.push(episode.id);
      chunks.push(...removed.chunks);
    }
    db.statement(
      `INSERT INTO deleted_ranges (scope, wall_start_ms, wall_end_ms, origin, created_at_ms)
       VALUES ('all', ?, ?, ?, ?)`,
    ).run(fromWallMs, toWallMs, options.origin, nowMs);
    // The pages that played meanwhile: their addresses and titles (ADR 023).
    deletePlaysBetween(db, fromWallMs, toWallMs, nowMs);
    // Every block heard in the range, speech or not: its bytes go too.
    const marked = db
      .statement(
        `UPDATE chunks SET audio_state = 'deleted'
         WHERE audio_state IN ('present', 'archived') AND id IN (
           SELECT c.id FROM chunks c JOIN track_runs t ON t.id = c.track_run_id
           WHERE t.source_kind != 'phone'
             AND c.wall_ms < ? AND c.wall_ms + (c.sample_count * 1000.0 / t.sample_rate) > ?)
         RETURNING id`,
      )
      .all(toWallMs, fromWallMs)
      .map((row) => int(row, "id"));
    chunks.push(...deletedChunks(db, marked));
    // The apps in front then, whole where they cross an edge.
    forgetForegroundBetween(db, fromWallMs, toWallMs);
    // Regions no episode held yet: those inside the range go; one that
    // crosses an edge keeps its outside part (readers skip the tombstone).
    db.statement(
      `DELETE FROM speech_regions
       WHERE wall_start_ms >= ? AND wall_end_ms IS NOT NULL AND wall_end_ms <= ?
         AND id NOT IN (SELECT speech_region_id FROM episode_regions)
         AND track_run_id NOT IN (SELECT id FROM track_runs WHERE source_kind = 'phone')`,
    ).run(fromWallMs, toWallMs);
    return { episodeIds, chunks };
  });
  const checkpoint = options.checkpoint === false ? null : checkpointTruncate(db);
  return { ...result, checkpoint };
}
