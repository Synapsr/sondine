import { transaction, type Database } from "./database";
import { speechPostRollMs, speechPreRollMs } from "./delete-episode";
import { findDeletedRanges, msToSamples } from "./deleted-ranges";
import { int, intOrNull, oneOfValues, str, strOrNull, type Row } from "./rows";
import {
  audioStates,
  spoolFileStates,
  trackRunStates,
  type AudioState,
  type SpoolFileState,
  type TrackRunState,
} from "./schema/enums";

// Spool retention (ADR 016): a closed spool file past its retention keeps the
// chunks its speech regions select, and those a range the user keeps reaches
// (`kept_audio`: « Garder les 2 dernières minutes » keeps silence too),
// archived whole, bytes and CRC unchanged, and loses the rest. These helpers
// hold the database side of the protocol; core does the file work and decides
// when a file may go.

export interface RetentionRolls {
  readonly preRollMs: number;
  readonly postRollMs: number;
}

/** The roll kept around each speech region (architecture §3). */
export const speechRolls: RetentionRolls = {
  preRollMs: speechPreRollMs,
  postRollMs: speechPostRollMs,
};

export interface RetentionSpoolFile {
  readonly id: number;
  readonly trackRunId: number;
  readonly runUid: string;
  readonly runState: TrackRunState;
  readonly runSampleEnd: number | null;
  readonly sampleRate: number;
  readonly seq: number;
  /** Relative to the data directory: `spool/<track dir>/<run id>/NNNN.pcm`. */
  readonly relPath: string;
  readonly sampleStart: number;
  readonly committedBytes: number;
  readonly state: SpoolFileState;
  readonly createdWallMs: number;
  readonly closedWallMs: number | null;
}

export interface RetentionChunk {
  readonly id: number;
  readonly spoolFileId: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly sampleStart: number;
  readonly sampleCount: number;
  readonly crc32: number;
  readonly audioState: AudioState;
  readonly archiveRelPath: string | null;
  readonly archiveByteOffset: number | null;
}

export interface ArchivePlan {
  readonly file: RetentionSpoolFile;
  /** Every chunk of the file, in byte order. */
  readonly chunks: readonly RetentionChunk[];
  /**
   * Chunks whose audio is kept: they intersect a closed speech region widened
   * by the rolls (clamped to the run), or a range the user keeps. Present or
   * archived, in byte order.
   */
  readonly selected: readonly RetentionChunk[];
  /** Chunks the regions select whose audio is already gone (`expired`). */
  readonly lost: number;
  /** Open speech regions that could still select a chunk of this file. */
  readonly openRegions: number;
  /** Sample span [start, end) of the file's chunks; null when it has none. */
  readonly span: { readonly start: number; readonly end: number } | null;
}

/** A retention step found the database in a state the protocol forbids; nothing was written. */
export class RetentionStateError extends Error {
  override readonly name = "RetentionStateError";
}

const fileColumns = `f.id, f.track_run_id, f.seq, f.rel_path, f.sample_start, f.committed_bytes,
  f.state, f.created_wall_ms, f.closed_wall_ms,
  t.uid AS run_uid, t.state AS run_state, t.sample_end AS run_sample_end, t.sample_rate`;

const chunkColumns = `id, spool_file_id, byte_offset, byte_length, sample_start, sample_count, crc32,
  audio_state, archive_rel_path, archive_byte_offset`;

function toFile(row: Row): RetentionSpoolFile {
  return {
    id: int(row, "id"),
    trackRunId: int(row, "track_run_id"),
    runUid: str(row, "run_uid"),
    runState: oneOfValues(row, "run_state", trackRunStates),
    runSampleEnd: intOrNull(row, "run_sample_end"),
    sampleRate: int(row, "sample_rate"),
    seq: int(row, "seq"),
    relPath: str(row, "rel_path"),
    sampleStart: int(row, "sample_start"),
    committedBytes: int(row, "committed_bytes"),
    state: oneOfValues(row, "state", spoolFileStates),
    createdWallMs: int(row, "created_wall_ms"),
    closedWallMs: intOrNull(row, "closed_wall_ms"),
  };
}

function toRetentionChunk(row: Row): RetentionChunk {
  return {
    id: int(row, "id"),
    spoolFileId: int(row, "spool_file_id"),
    byteOffset: int(row, "byte_offset"),
    byteLength: int(row, "byte_length"),
    sampleStart: int(row, "sample_start"),
    sampleCount: int(row, "sample_count"),
    crc32: int(row, "crc32"),
    audioState: oneOfValues(row, "audio_state", audioStates),
    archiveRelPath: strOrNull(row, "archive_rel_path"),
    archiveByteOffset: intOrNull(row, "archive_byte_offset"),
  };
}

function getRetentionSpoolFile(db: Database, spoolFileId: number): RetentionSpoolFile | undefined {
  const row = db
    .statement(
      `SELECT ${fileColumns} FROM spool_files f JOIN track_runs t ON t.id = f.track_run_id WHERE f.id = ?`,
    )
    .get(spoolFileId);
  return row === undefined ? undefined : toFile(row);
}

/** Closed spool files (not yet expired), oldest first: the candidates for retention. */
export function closedSpoolFiles(db: Database): RetentionSpoolFile[] {
  return db
    .statement(
      `SELECT ${fileColumns} FROM spool_files f JOIN track_runs t ON t.id = f.track_run_id
       WHERE f.state = 'closed' ORDER BY f.created_wall_ms, f.id`,
    )
    .all()
    .map(toFile);
}

/** Committed bytes of the spool files still on disk (open or closed). */
export function spoolBytes(db: Database): number {
  const value = db
    .statement(
      "SELECT coalesce(sum(committed_bytes), 0) AS bytes FROM spool_files WHERE state IN ('open', 'closed')",
    )
    .get()?.["bytes"];
  return typeof value === "number" ? value : 0;
}

/**
 * The chunks a spool file keeps and what could still change that choice.
 * Read-only; core calls it before archiving, and `expireSpoolFile` again
 * inside its transaction.
 */
export function planArchive(
  db: Database,
  spoolFileId: number,
  rolls: RetentionRolls = speechRolls,
): ArchivePlan | undefined {
  const file = getRetentionSpoolFile(db, spoolFileId);
  if (file === undefined) return undefined;
  const chunks = db
    .statement(`SELECT ${chunkColumns} FROM chunks WHERE spool_file_id = ? ORDER BY byte_offset`)
    .all(spoolFileId)
    .map(toRetentionChunk);
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const chunk of chunks) {
    start = Math.min(start, chunk.sampleStart);
    end = Math.max(end, chunk.sampleStart + chunk.sampleCount);
  }
  if (chunks.length === 0) {
    return { file, chunks, selected: [], lost: 0, openRegions: 0, span: null };
  }
  const pre = msToSamples(rolls.preRollMs, file.sampleRate);
  const post = msToSamples(rolls.postRollMs, file.sampleRate);
  // Regions whose widened span reaches [start, end); an open one reaches to the end of the run.
  const regions = db
    .statement(
      `SELECT sample_start, sample_end, state FROM speech_regions
       WHERE track_run_id = ? AND sample_start < ? AND (sample_end IS NULL OR sample_end > ?)
       ORDER BY sample_start`,
    )
    .all(file.trackRunId, end + pre, start - post);
  const runEnd = file.runSampleEnd ?? Number.POSITIVE_INFINITY;
  let openRegions = 0;
  const widened: { from: number; to: number }[] = [];
  for (const region of regions) {
    const sampleEnd = intOrNull(region, "sample_end");
    if (str(region, "state") !== "closed" || sampleEnd === null) {
      openRegions += 1;
      continue;
    }
    const from = Math.max(0, int(region, "sample_start") - pre);
    const to = Math.min(runEnd, sampleEnd + post);
    if (to > from) widened.push({ from, to });
  }
  for (const kept of db
    .statement(
      `SELECT sample_start, sample_end FROM kept_audio
       WHERE track_run_id = ? AND sample_start < ? AND sample_end > ?`,
    )
    .all(file.trackRunId, end, start)) {
    widened.push({ from: int(kept, "sample_start"), to: int(kept, "sample_end") });
  }
  const selected: RetentionChunk[] = [];
  let lost = 0;
  for (const chunk of chunks) {
    const chunkEnd = chunk.sampleStart + chunk.sampleCount;
    const kept = widened.some((span) => span.from < chunkEnd && span.to > chunk.sampleStart);
    if (!kept || chunk.audioState === "deleted") continue;
    if (chunk.audioState === "expired") lost += 1;
    else selected.push(chunk);
  }
  return { file, chunks, selected, lost, openRegions, span: { start, end } };
}

/**
 * Runs `fn` in one write transaction with `synchronous=FULL`, so its commit
 * reaches the disk before the caller removes the audio it describes; restores
 * the connection's NORMAL afterwards.
 */
export function durableTransaction<T>(db: Database, fn: () => T): T {
  if (db.client.isTransaction) {
    throw new RetentionStateError("a durable transaction cannot run inside another transaction");
  }
  db.client.exec("PRAGMA synchronous = FULL");
  try {
    return transaction(db, fn);
  } finally {
    db.client.exec("PRAGMA synchronous = NORMAL");
  }
}

export interface ArchivePlacement {
  readonly chunkId: number;
  /** The CRC read back from the spool before writing the archive. */
  readonly crc32: number;
  readonly archiveByteOffset: number;
}

/**
 * Points chunks at their copy in a synced archive file. Every chunk must still
 * be `present` with the same CRC in that spool file; otherwise nothing is
 * written and `RetentionStateError` is thrown (the archive is then an orphan).
 */
export function recordArchive(
  db: Database,
  input: {
    readonly spoolFileId: number;
    readonly archiveRelPath: string;
    readonly placements: readonly ArchivePlacement[];
  },
): { readonly archived: number } {
  return durableTransaction(db, () => {
    const update = db.statement(
      `UPDATE chunks SET audio_state = 'archived', archive_rel_path = ?, archive_byte_offset = ?
       WHERE id = ? AND spool_file_id = ? AND audio_state = 'present' AND crc32 = ?`,
    );
    for (const placement of input.placements) {
      const changed = update.run(
        input.archiveRelPath,
        placement.archiveByteOffset,
        placement.chunkId,
        input.spoolFileId,
        placement.crc32,
      ).changes;
      if (Number(changed) !== 1) {
        throw new RetentionStateError(
          `chunk ${placement.chunkId} of spool file ${input.spoolFileId} changed while it was archived`,
        );
      }
    }
    return { archived: input.placements.length };
  });
}

/**
 * Points a spool file's archived chunks back at the spool, before its archive
 * is rewritten or after it was found damaged. Only while the spool file still
 * holds the bytes.
 */
export function unarchiveSpoolFile(db: Database, spoolFileId: number): { readonly chunks: number } {
  return durableTransaction(db, () => {
    const file = getRetentionSpoolFile(db, spoolFileId);
    if (file === undefined || (file.state !== "open" && file.state !== "closed")) {
      throw new RetentionStateError(`spool file ${spoolFileId} no longer holds its bytes`);
    }
    const changed = db
      .statement(
        `UPDATE chunks SET audio_state = 'present', archive_rel_path = NULL, archive_byte_offset = NULL
         WHERE spool_file_id = ? AND audio_state = 'archived'`,
      )
      .run(spoolFileId).changes;
    return { chunks: Number(changed) };
  });
}

/**
 * Undoes an eviction a crash interrupted after the database expired the file
 * but before its PCM was unlinked, when the archive turned out missing or
 * damaged: the spool bytes are still the good copy, so the file is closed
 * again and its archived and expired chunks are present again, ready for the
 * next pass to archive them anew. Deleted chunks stay deleted.
 */
export function reopenExpiredSpoolFile(
  db: Database,
  spoolFileId: number,
): { readonly chunks: number } {
  return durableTransaction(db, () => {
    const file = getRetentionSpoolFile(db, spoolFileId);
    if (file === undefined || file.state !== "expired") {
      throw new RetentionStateError(`spool file ${spoolFileId} is not expired`);
    }
    db.statement("UPDATE spool_files SET state = 'closed' WHERE id = ?").run(spoolFileId);
    const changed = db
      .statement(
        `UPDATE chunks SET audio_state = 'present', archive_rel_path = NULL, archive_byte_offset = NULL
         WHERE spool_file_id = ? AND audio_state IN ('archived', 'expired')`,
      )
      .run(spoolFileId).changes;
    return { chunks: Number(changed) };
  });
}

/**
 * Ends a closed spool file's retention: the chunks its regions do not select
 * become `expired`, then the file. Refuses (throws, writes nothing) while a
 * selected chunk is not archived or an open region still reaches the file.
 * The caller unlinks the PCM only after this returns.
 */
export function expireSpoolFile(
  db: Database,
  spoolFileId: number,
  rolls: RetentionRolls = speechRolls,
): { readonly expiredChunks: number } {
  return durableTransaction(db, () => {
    const plan = planArchive(db, spoolFileId, rolls);
    if (plan === undefined) throw new RetentionStateError(`unknown spool file ${spoolFileId}`);
    if (plan.file.state !== "closed") {
      throw new RetentionStateError(`spool file ${spoolFileId} is ${plan.file.state}`);
    }
    if (plan.openRegions > 0) {
      throw new RetentionStateError(`spool file ${spoolFileId} is reached by an open region`);
    }
    const unarchived = plan.selected.filter((chunk) => chunk.audioState !== "archived");
    if (unarchived.length > 0) {
      throw new RetentionStateError(
        `spool file ${spoolFileId} has ${unarchived.length} selected chunks not archived`,
      );
    }
    const expired = db
      .statement(
        "UPDATE chunks SET audio_state = 'expired' WHERE spool_file_id = ? AND audio_state = 'present'",
      )
      .run(spoolFileId).changes;
    db.statement("UPDATE spool_files SET state = 'expired' WHERE id = ? AND state = 'closed'").run(
      spoolFileId,
    );
    return { expiredChunks: Number(expired) };
  });
}

/** Archived chunks whose archive is gone and whose spool bytes are gone too: their audio is lost. */
export function expireLostArchive(
  db: Database,
  chunkIds: readonly number[],
): { readonly chunks: number } {
  return transaction(db, () => {
    const update = db.statement(
      `UPDATE chunks SET audio_state = 'expired', archive_rel_path = NULL, archive_byte_offset = NULL
       WHERE id = ? AND audio_state = 'archived'`,
    );
    let changed = 0;
    for (const id of chunkIds) changed += Number(update.run(id).changes);
    return { chunks: changed };
  });
}

export interface ArchiveRef {
  readonly spoolFileId: number;
  readonly spoolRelPath: string;
  readonly spoolState: SpoolFileState;
  readonly archiveRelPath: string;
  /** Bytes the archive must hold at least (end of its last archived chunk). */
  readonly archiveEnd: number;
  readonly archivedBytes: number;
}

/**
 * Every archive file that `archived` chunks point to, with the size it must
 * have. Scans the chunks table: startup recovery only.
 */
export function archiveRefs(db: Database): ArchiveRef[] {
  return db
    .statement(
      `SELECT f.id, f.rel_path, f.state, c.archive_rel_path,
         max(c.archive_byte_offset + c.byte_length) AS archive_end, sum(c.byte_length) AS bytes
       FROM chunks c JOIN spool_files f ON f.id = c.spool_file_id
       WHERE c.audio_state = 'archived'
       GROUP BY f.id, c.archive_rel_path ORDER BY f.id`,
    )
    .all()
    .map((row) => ({
      spoolFileId: int(row, "id"),
      spoolRelPath: str(row, "rel_path"),
      spoolState: oneOfValues(row, "state", spoolFileStates),
      archiveRelPath: str(row, "archive_rel_path"),
      archiveEnd: int(row, "archive_end"),
      archivedBytes: int(row, "bytes"),
    }));
}

/** Chunks of a spool file in one audio state, in byte order. */
export function spoolFileChunks(
  db: Database,
  spoolFileId: number,
  state: AudioState,
): RetentionChunk[] {
  return db
    .statement(
      `SELECT ${chunkColumns} FROM chunks WHERE spool_file_id = ? AND audio_state = ? ORDER BY byte_offset`,
    )
    .all(spoolFileId, state)
    .map(toRetentionChunk);
}

/** Whether any chunk of the spool file at `spoolRelPath` points at `archiveRelPath`. */
export function isArchiveReferenced(
  db: Database,
  spoolRelPath: string,
  archiveRelPath: string,
): boolean {
  return (
    db
      .statement(
        `SELECT 1 AS present FROM spool_files f JOIN chunks c ON c.spool_file_id = f.id
         WHERE f.rel_path = ? AND c.archive_rel_path = ? LIMIT 1`,
      )
      .get(spoolRelPath, archiveRelPath) !== undefined
  );
}

/** The state of the spool file at `relPath`, if the database knows it. */
export function spoolFileStateOf(db: Database, relPath: string): SpoolFileState | undefined {
  const row = db.statement("SELECT state FROM spool_files WHERE rel_path = ?").get(relPath);
  return row === undefined ? undefined : oneOfValues(row, "state", spoolFileStates);
}

/** A deleted chunk whose bytes may still be on disk. */
export interface UnscrubbedChunk {
  readonly chunkId: number;
  readonly spoolRelPath: string;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly archiveRelPath: string | null;
  readonly archiveByteOffset: number | null;
}

function toUnscrubbed(row: Row): UnscrubbedChunk {
  return {
    chunkId: int(row, "id"),
    spoolRelPath: str(row, "rel_path"),
    byteOffset: int(row, "byte_offset"),
    byteLength: int(row, "byte_length"),
    archiveRelPath: strOrNull(row, "archive_rel_path"),
    archiveByteOffset: intOrNull(row, "archive_byte_offset"),
  };
}

/**
 * Deleted chunks whose bytes a crash may have left on disk: those of spool
 * files still on disk, and those still pointing at an archive (a scrub clears
 * that pointer once the archive bytes are zeroed).
 */
export function unscrubbedChunks(db: Database): UnscrubbedChunk[] {
  const inSpool = db
    .statement(
      `SELECT c.id, f.rel_path, c.byte_offset, c.byte_length, c.archive_rel_path, c.archive_byte_offset
       FROM spool_files f JOIN chunks c ON c.spool_file_id = f.id
       WHERE f.state IN ('open', 'closed') AND c.audio_state = 'deleted'`,
    )
    .all()
    .map(toUnscrubbed);
  const seen = new Set(inSpool.map((chunk) => chunk.chunkId));
  const inArchive = db
    .statement(
      `SELECT c.id, f.rel_path, c.byte_offset, c.byte_length, c.archive_rel_path, c.archive_byte_offset
       FROM chunks c JOIN spool_files f ON f.id = c.spool_file_id
       WHERE c.audio_state = 'deleted' AND c.archive_rel_path IS NOT NULL`,
    )
    .all()
    .map(toUnscrubbed)
    .filter((chunk) => !seen.has(chunk.chunkId));
  return [...inSpool, ...inArchive];
}

/** Records that deleted chunks' archive bytes are zeroed: they no longer point at an archive. */
export function markArchiveScrubbed(
  db: Database,
  chunkIds: readonly number[],
): { readonly chunks: number } {
  return transaction(db, () => {
    const update = db.statement(
      `UPDATE chunks SET archive_rel_path = NULL, archive_byte_offset = NULL
       WHERE id = ? AND audio_state = 'deleted'`,
    );
    let changed = 0;
    for (const id of chunkIds) changed += Number(update.run(id).changes);
    return { chunks: changed };
  });
}

export interface TrackAudioChunk extends RetentionChunk {
  readonly spoolRelPath: string;
  readonly spoolState: SpoolFileState;
}

export interface SampleSpan {
  readonly sampleStart: number;
  readonly sampleEnd: number;
}

export interface TrackAudioRows {
  /** Chunks intersecting the range, by first sample. */
  readonly chunks: readonly TrackAudioChunk[];
  /** Recorded gaps intersecting the range; an open-ended gap runs to the end of the range. */
  readonly gaps: readonly SampleSpan[];
  /** `track_run` tombstones intersecting the range. */
  readonly deleted: readonly SampleSpan[];
}

/** What reading [sampleStart, sampleEnd) of a run needs from the database (indexed lookups). */
export function trackAudioRows(
  db: Database,
  trackRunId: number,
  sampleStart: number,
  sampleEnd: number,
): TrackAudioRows {
  const chunks = db
    .statement(
      `SELECT c.id, c.spool_file_id, c.byte_offset, c.byte_length, c.sample_start, c.sample_count,
         c.crc32, c.audio_state, c.archive_rel_path, c.archive_byte_offset,
         f.rel_path AS spool_rel_path, f.state AS spool_state
       FROM chunks c JOIN spool_files f ON f.id = c.spool_file_id
       WHERE c.track_run_id = :run AND c.sample_start < :end
         AND c.sample_start >= coalesce(
           (SELECT max(sample_start) FROM chunks WHERE track_run_id = :run AND sample_start <= :start),
           :start)
       ORDER BY c.sample_start, c.id`,
    )
    .all({ run: trackRunId, start: sampleStart, end: sampleEnd })
    .map((row) => ({
      ...toRetentionChunk(row),
      spoolRelPath: str(row, "spool_rel_path"),
      spoolState: oneOfValues(row, "spool_state", spoolFileStates),
    }))
    .filter((chunk) => chunk.sampleStart + chunk.sampleCount > sampleStart);
  const gaps = db
    .statement(
      `SELECT sample_start, coalesce(sample_end, :end) AS sample_end FROM gaps
       WHERE track_run_id = :run AND sample_start IS NOT NULL AND sample_start < :end
         AND coalesce(sample_end, :end) > :start
       ORDER BY sample_start`,
    )
    .all({ run: trackRunId, start: sampleStart, end: sampleEnd })
    .map(toSpan);
  const deleted = db
    .statement(
      `SELECT sample_start, sample_end FROM deleted_ranges
       WHERE scope = 'track_run' AND track_run_id = :run
         AND sample_start < :end AND sample_end > :start
       ORDER BY sample_start`,
    )
    .all({ run: trackRunId, start: sampleStart, end: sampleEnd })
    .map(toSpan);
  return { chunks, gaps, deleted };
}

function toSpan(row: Row): SampleSpan {
  return { sampleStart: int(row, "sample_start"), sampleEnd: int(row, "sample_end") };
}

/**
 * What the database holds for the region a manifest records at `sampleStart`:
 * `deleted` when no row exists because a tombstone covers its start (the
 * import refused or removed it), `missing` when its events were never imported.
 */
export function regionImportState(
  db: Database,
  trackRunId: number,
  sampleStart: number,
): "closed" | "open" | "deleted" | "missing" {
  const state = db
    .statement("SELECT state FROM speech_regions WHERE track_run_id = ? AND sample_start = ?")
    .get(trackRunId, sampleStart)?.["state"];
  if (state === "closed" || state === "open") return state;
  const deleted = db
    .statement(
      `SELECT 1 AS present FROM deleted_ranges
       WHERE scope = 'track_run' AND track_run_id = ? AND sample_start <= ? AND sample_end > ? LIMIT 1`,
    )
    .get(trackRunId, sampleStart, sampleStart);
  return deleted === undefined ? "missing" : "deleted";
}

/**
 * Whether a manifest commit without a chunk row was left out on purpose: a
 * tombstone covers it (the import refuses it), or a recovery cut its bytes.
 */
export function commitLeftOut(
  db: Database,
  input: {
    readonly trackRunId: number;
    readonly sampleStart: number;
    readonly sampleEnd: number;
    readonly wallStartMs: number;
    readonly wallEndMs: number;
  },
): boolean {
  if (findDeletedRanges(db, input).length > 0) return true;
  return (
    db
      .statement(
        `SELECT 1 AS present FROM gaps
         WHERE track_run_id = ? AND reason = 'recovery_truncated'
           AND sample_start <= ? AND sample_end > ? LIMIT 1`,
      )
      .get(input.trackRunId, input.sampleStart, input.sampleStart) !== undefined
  );
}

/**
 * Whether the run of the spool file at `relPath` has a later spool file: the
 * helper's crash recovery checks the CRCs of each run's newest file and cuts
 * it at the first mismatch, so only older files may have bytes overwritten.
 */
export function hasLaterSpoolFile(db: Database, relPath: string): boolean {
  return (
    db
      .statement(
        `SELECT 1 AS present FROM spool_files f
         JOIN spool_files later ON later.track_run_id = f.track_run_id AND later.seq > f.seq
         WHERE f.rel_path = ? LIMIT 1`,
      )
      .get(relPath) !== undefined
  );
}
