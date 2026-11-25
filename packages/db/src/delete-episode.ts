import {
  contextHomesIn,
  deleteEpisodeContext,
  dropPinnedContext,
  linkedTranscripts,
  settleContext,
} from "./context-items";
import { deleteEpisodeTags, settleTags, tagHomesIn } from "./recording-tags";
import { checkpointTruncate, transaction, type CheckpointResult, type Database } from "./database";
import { msToSamples, samplesToMs } from "./deleted-ranges";
import { cutForegroundSpans } from "./foreground";
import { tombstonePhoneRecordings } from "./phone-recordings";
import { int, intOrNull, str, strOrNull } from "./rows";
import type { AssertionOrigin } from "./schema/enums";

/** Audio kept around each speech region (architecture §3). */
export const speechPreRollMs = 1500;
export const speechPostRollMs = 800;

export interface DeleteEpisodeOptions {
  readonly origin: AssertionOrigin;
  readonly nowMs?: number;
  /** Truncate the WAL after the delete commits. Defaults to true. */
  readonly checkpoint?: boolean;
}

/** Audio blocks the caller must scrub from disk (spool bytes, archive files). */
export interface DeletedChunk {
  readonly chunkId: number;
  readonly spoolRelPath: string;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly archiveRelPath: string | null;
  /** Where the chunk's bytes start in its archive file; null when it has none. */
  readonly archiveByteOffset: number | null;
}

export type DeleteEpisodeResult =
  | { readonly deleted: false }
  | {
      readonly deleted: true;
      readonly tombstoneIds: readonly number[];
      readonly chunks: readonly DeletedChunk[];
      readonly segmentCount: number;
      /** Context items deleted with it; their files go once nothing holds them. */
      readonly contextCount: number;
      readonly checkpoint: CheckpointResult | null;
    };

/**
 * Deletes an episode and everything derived from its audio in one
 * transaction: tombstones over each region (with pre- and post-roll) so no
 * import or late job can bring it back, chunk states, overlapping assertions,
 * the apps in front then, the context added to it (ADR 024), full-text rows
 * (secure-delete), segments, analysis, and the regions; a phone recording's
 * row becomes a tombstone (ADR 032). Then truncates the
 * WAL. Removing the audio and context files is left to the caller.
 *
 * Segments and speaker turns intersecting a tombstone are removed whatever
 * episode they belong to (another grouping version, a neighbour reaching into
 * the roll); `segmentCount` counts every segment removed.
 *
 * When a split or the length cap cut a region, the episode holds one slice of
 * it: the tombstone covers that slice, with roll only at the region's own
 * edges, and the region stays while another episode of the same grouping
 * version holds a slice of it.
 */
export function deleteEpisode(
  db: Database,
  episodeId: number,
  options: DeleteEpisodeOptions,
): DeleteEpisodeResult {
  const nowMs = options.nowMs ?? Date.now();
  const result = transaction(db, () => {
    if (
      db.statement("SELECT 1 AS present FROM episodes WHERE id = ?").get(episodeId) === undefined
    ) {
      return undefined;
    }
    // Its context first, while its slices still say which items are its own.
    const linked = linkedTranscripts(db);
    const contextCount = deleteEpisodeContext(db, episodeId);
    deleteEpisodeTags(db, episodeId);
    const regions = db
      .statement(
        `SELECT r.id, r.track_run_id, r.sample_start, r.sample_end, r.wall_start_ms, r.wall_end_ms,
           t.sample_rate, e.slice_sample_start, e.slice_sample_end,
           EXISTS (SELECT 1 FROM episode_regions o
             WHERE o.speech_region_id = r.id AND o.grouping_version = e.grouping_version
               AND o.episode_id <> e.episode_id) AS shared
         FROM episode_regions e
         JOIN speech_regions r ON r.id = e.speech_region_id
         JOIN track_runs t ON t.id = r.track_run_id
         WHERE e.episode_id = ?`,
      )
      .all(episodeId);

    const insertTombstone = db.statement(
      `INSERT INTO deleted_ranges
         (scope, track_run_id, sample_start, sample_end, wall_start_ms, wall_end_ms, origin, created_at_ms)
       VALUES ('track_run', ?, ?, ?, ?, ?, ?, ?)`,
    );
    const markChunks = db.statement(
      `UPDATE chunks SET audio_state = 'deleted'
       WHERE track_run_id = ? AND sample_start < ? AND sample_start + sample_count > ?
         AND audio_state <> 'deleted'
       RETURNING id`,
    );
    const deleteAssertions = db.statement(
      `DELETE FROM user_assertions
       WHERE track_run_id = ? AND sample_start < ?
         AND (sample_end > ? OR (sample_end = sample_start AND sample_start >= ?))`,
    );
    // A zero-length segment is the point [t, t + 1), as in deleted-ranges.ts.
    const overlappingSegments = `track_run_id = ? AND sample_start < ?
       AND max(sample_end, sample_start + 1) > ?`;
    // A neighbour losing text shows as changed to readers that compare
    // `updated_at_ms` (the Today revision).
    const touchNeighbours = db.statement(
      `UPDATE episodes SET updated_at_ms = ?
       WHERE id <> ? AND id IN (SELECT episode_id FROM segments WHERE ${overlappingSegments})`,
    );
    const unindexSegments = db.statement(
      `INSERT INTO segments_fts (segments_fts, rowid, search_text)
       SELECT 'delete', id, search_text FROM segments WHERE ${overlappingSegments}`,
    );
    const deleteSegments = db.statement(`DELETE FROM segments WHERE ${overlappingSegments}`);
    // A correction leaves with the segment it corrected, wherever its anchor lies.
    const deleteEdits = db.statement(
      `DELETE FROM user_assertions WHERE id IN (
         SELECT edit_id FROM segments WHERE ${overlappingSegments} AND edit_id IS NOT NULL)`,
    );
    const deleteTurns = db.statement(
      "DELETE FROM speaker_turns WHERE track_run_id = ? AND sample_start < ? AND sample_end > ?",
    );

    const tombstoneIds: number[] = [];
    const chunkIds: number[] = [];
    const stones: { trackRunId: number; from: number; to: number }[] = [];
    let segmentCount = 0;
    for (const region of regions) {
      const rate = int(region, "sample_rate");
      const sampleStart = int(region, "sample_start");
      const wallStartMs = int(region, "wall_start_ms");
      const wallEndMs = intOrNull(region, "wall_end_ms") ?? nowMs;
      const sampleEnd =
        intOrNull(region, "sample_end") ?? sampleStart + msToSamples(wallEndMs - wallStartMs, rate);
      const sliceStart = int(region, "slice_sample_start");
      const sliceEnd = Math.max(intOrNull(region, "slice_sample_end") ?? sampleEnd, sliceStart + 1);
      // Roll only where the region itself starts or ends, never at a cut.
      const preRollMs = sliceStart <= sampleStart ? speechPreRollMs : 0;
      const postRollMs = sliceEnd >= sampleEnd ? speechPostRollMs : 0;
      const from = Math.max(0, sliceStart - msToSamples(preRollMs, rate));
      const to = sliceEnd + msToSamples(postRollMs, rate);
      const sliceWallStartMs = wallStartMs + samplesToMs(sliceStart - sampleStart, rate);
      const sliceWallEndMs = wallStartMs + samplesToMs(sliceEnd - sampleStart, rate);
      const trackRunId = int(region, "track_run_id");
      const tombstone = insertTombstone.run(
        trackRunId,
        from,
        to,
        sliceWallStartMs - preRollMs,
        Math.max(sliceWallEndMs, sliceWallStartMs + 1) + postRollMs,
        options.origin,
        nowMs,
      );
      tombstoneIds.push(Number(tombstone.lastInsertRowid));
      for (const row of markChunks.all(trackRunId, to, from)) chunkIds.push(int(row, "id"));
      deleteAssertions.run(trackRunId, to, from, from);
      cutForegroundSpans(db, trackRunId, from, to);
      // A neighbour's sentence the roll reaches goes, and what was pinned to it.
      dropPinnedContext(db, trackRunId, from, to);
      stones.push({ trackRunId, from, to });
      touchNeighbours.run(nowMs, episodeId, trackRunId, to, from);
      unindexSegments.run(trackRunId, to, from);
      deleteEdits.run(trackRunId, to, from);
      segmentCount += Number(deleteSegments.run(trackRunId, to, from).changes);
      deleteTurns.run(trackRunId, to, from);
    }

    // A neighbour's context anchored in the roll moves to its first audio left.
    const neighbours = contextHomesIn(db, stones);
    const neighbourTags = tagHomesIn(db, stones);
    db.statement(
      `INSERT INTO segments_fts (segments_fts, rowid, search_text)
       SELECT 'delete', id, search_text FROM segments WHERE episode_id = ?`,
    ).run(episodeId);
    db.statement(
      `DELETE FROM user_assertions WHERE id IN (
         SELECT edit_id FROM segments WHERE episode_id = ? AND edit_id IS NOT NULL)`,
    ).run(episodeId);
    segmentCount += Number(
      db.statement("DELETE FROM segments WHERE episode_id = ?").run(episodeId).changes,
    );
    db.statement(
      `UPDATE jobs SET state = 'cancelled', updated_at_ms = ?, finished_at_ms = ?
       WHERE episode_id = ? AND state IN ('queued', 'running')`,
    ).run(nowMs, nowMs, episodeId);
    // The page it heard goes too while it was heard: its address and title (ADR 023).
    db.statement(
      `DELETE FROM web_plays WHERE id IN (
         SELECT p.id FROM episodes e JOIN web_plays p ON p.page_key = e.page_key
         WHERE e.id = ? AND p.started_wall_ms <= coalesce(e.ended_at_ms, ?)
           AND coalesce(p.ended_wall_ms, ?) >= e.started_at_ms)`,
    ).run(episodeId, nowMs, nowMs);
    db.statement("DELETE FROM episodes WHERE id = ?").run(episodeId);
    const deleteRegion = db.statement("DELETE FROM speech_regions WHERE id = ?");
    for (const region of regions) {
      if (int(region, "shared") === 0) deleteRegion.run(int(region, "id"));
    }
    settleContext(db, neighbours, nowMs);
    settleTags(db, neighbourTags);
    // A phone recording leaves its id behind, so the same file never comes back (ADR 032).
    tombstonePhoneRecordings(
      db,
      [...new Set(regions.map((region) => int(region, "track_run_id")))],
      nowMs,
    );
    // An audio file's transcription goes with the item it was made of.
    const transcripts = deleteUnlinkedTranscripts(db, linked, { origin: options.origin, nowMs });

    return {
      tombstoneIds: [...tombstoneIds, ...transcripts.tombstoneIds],
      chunks: [...deletedChunks(db, chunkIds), ...transcripts.chunks],
      segmentCount: segmentCount + transcripts.segmentCount,
      contextCount,
    };
  });
  if (result === undefined) return { deleted: false };
  const checkpoint = options.checkpoint === false ? null : checkpointTruncate(db);
  return { deleted: true, ...result, checkpoint };
}

/** What deleting transcriptions took: their episodes, audio blocks to scrub, sentences and tombstones. */
export interface TranscriptsDeleted {
  readonly episodeIds: readonly number[];
  readonly tombstoneIds: readonly number[];
  readonly chunks: readonly DeletedChunk[];
  readonly segmentCount: number;
}

/**
 * Deletes the imported recordings « Transcrire » made (ADR 024) whose item a
 * deletion just took: `before` is `linkedTranscripts` from before it, and a
 * recording no item holds any more goes, as if the user deleted it. Run in
 * the transaction of whatever deletes items (a deletion, a grouping pass
 * settling them, the orphan sweep at start); « Retirer » (removing one item)
 * never calls it, so its transcription stays in « Importés ».
 */
export function deleteUnlinkedTranscripts(
  db: Database,
  before: ReadonlySet<number>,
  options: { readonly origin: AssertionOrigin; readonly nowMs: number },
): TranscriptsDeleted {
  const episodeIds: number[] = [];
  const tombstoneIds: number[] = [];
  const chunks: DeletedChunk[] = [];
  let segmentCount = 0;
  if (before.size === 0) return { episodeIds, tombstoneIds, chunks, segmentCount };
  const still = linkedTranscripts(db);
  const episodesOf = db.statement(
    `SELECT DISTINCT m.episode_id FROM episode_regions m
     JOIN speech_regions r ON r.id = m.speech_region_id WHERE r.track_run_id = ?`,
  );
  for (const trackRunId of before) {
    if (still.has(trackRunId)) continue;
    for (const row of episodesOf.all(trackRunId)) {
      const episodeId = int(row, "episode_id");
      const removed = deleteEpisode(db, episodeId, { ...options, checkpoint: false });
      if (!removed.deleted) continue;
      episodeIds.push(episodeId);
      tombstoneIds.push(...removed.tombstoneIds);
      chunks.push(...removed.chunks);
      segmentCount += removed.segmentCount;
    }
  }
  return { episodeIds, tombstoneIds, chunks, segmentCount };
}

/** Where the bytes of chunks just marked `deleted` are, for the scrubber. */
export function deletedChunks(db: Database, chunkIds: readonly number[]): DeletedChunk[] {
  const chunkRow = db.statement(
    `SELECT c.id, f.rel_path, c.byte_offset, c.byte_length, c.archive_rel_path,
       c.archive_byte_offset
     FROM chunks c JOIN spool_files f ON f.id = c.spool_file_id WHERE c.id = ?`,
  );
  return chunkIds.flatMap((id) => {
    const row = chunkRow.get(id);
    if (row === undefined) return [];
    return [
      {
        chunkId: int(row, "id"),
        spoolRelPath: str(row, "rel_path"),
        byteOffset: int(row, "byte_offset"),
        byteLength: int(row, "byte_length"),
        archiveRelPath: strOrNull(row, "archive_rel_path"),
        archiveByteOffset: intOrNull(row, "archive_byte_offset"),
      },
    ];
  });
}
