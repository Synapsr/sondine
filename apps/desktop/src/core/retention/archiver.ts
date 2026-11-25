import { readdirSync, rmdirSync, statSync, unlinkSync, type Dirent } from "node:fs";
import { dirname, join } from "node:path";
import {
  archiveRefs,
  commitAudioExpiry,
  expireLostArchive,
  expireSpoolFile,
  hasLaterSpoolFile,
  isArchiveReferenced,
  markArchiveScrubbed,
  planArchive,
  recordArchive,
  reopenExpiredSpoolFile,
  RetentionStateError,
  speechRolls,
  spoolFileChunks,
  spoolFileStateOf,
  unarchiveSpoolFile,
  unscrubbedChunks,
  type ArchivePlan,
  type AudioExpiry,
  type Database,
  type RetentionChunk,
  type RetentionRolls,
} from "@sondine/db";
import {
  isMissing,
  readBlocks,
  withFile,
  writeFileDurably,
  zeroRanges,
  type BlockRead,
  type DurableWriteStep,
} from "../audio/pcm-io";
import type { WaitReason } from "./guards";
import { absolute, archiveRelPathOf, spoolRelPathOf, type RetentionLayout } from "./layout";

// The archive and eviction of one spool file (ADR 016, crash protocol):
//   1. read each selected chunk from the spool and check its CRC;
//   2. write NNNN.pcm.tmp, fsync, rename, fsync the directory;
//   3. point the chunks at the archive (synchronous=FULL transaction);
//   4. expire the other chunks and the file (synchronous=FULL), unlink the PCM.
// A crash between any two steps leaves either an orphan archive (deleted at
// startup), archived chunks whose spool bytes still exist, or an expired file
// whose PCM is still there (unlinked at startup). The manifest stays.

/** Protocol steps, for crash tests. */
export type ArchiveStep = "read" | DurableWriteStep | "committed" | "expired" | "unlinked";

export type FileOutcome =
  | {
      readonly kind: "evicted";
      readonly archivedChunks: number;
      /** Bytes the archive gained (a rewrite counts only what it added). */
      readonly archivedBytes: number;
      readonly expiredChunks: number;
      readonly freedBytes: number;
    }
  | { readonly kind: "waiting"; readonly reason: WaitReason };

const waiting = (reason: WaitReason): FileOutcome => ({ kind: "waiting", reason });

/**
 * Archives a closed spool file's selected chunks and evicts the rest. The
 * caller has checked the guards; this re-checks the database invariants in
 * each transaction and never expires an unarchived selected chunk.
 */
export function archiveAndEvict(
  db: Database,
  layout: RetentionLayout,
  initial: ArchivePlan,
  rolls: RetentionRolls = speechRolls,
  afterStep?: (step: ArchiveStep) => void,
): FileOutcome {
  const file = initial.file;
  const archiveRelPath = archiveRelPathOf(layout, file.relPath);
  if (archiveRelPath === null) return waiting("spool_unreadable");
  const archivePath = absolute(layout, archiveRelPath);

  let plan = initial;
  let rewritten = 0;
  const archived = plan.selected.filter((chunk) => chunk.audioState === "archived");
  const pending = plan.selected.some((chunk) => chunk.audioState === "present");
  // An earlier pass archived some chunks and stopped, or regions arrived since:
  // the archive is rewritten whole from the spool, which still holds every byte.
  if (archived.length > 0 && (pending || !archiveIntact(archivePath, archived))) {
    unarchiveSpoolFile(db, file.id);
    rewritten = archived.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const replanned = planArchive(db, file.id, rolls);
    if (replanned === undefined) return waiting("archive_conflict");
    plan = replanned;
  }

  const toArchive = plan.selected.filter((chunk) => chunk.audioState === "present");
  let archivedBytes = 0;
  if (toArchive.length > 0) {
    let offset = 0;
    const buffer = new Uint8Array(toArchive.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    const blocks: BlockRead[] = toArchive.map((chunk) => {
      const block = {
        position: chunk.byteOffset,
        length: chunk.byteLength,
        crc32: chunk.crc32,
        target: buffer,
        targetOffset: offset,
      };
      offset += chunk.byteLength;
      return block;
    });
    let intact: boolean[];
    try {
      intact = withFile(absolute(layout, file.relPath), "r", (fd) => readBlocks(fd, blocks));
    } catch (error) {
      if (isMissing(error)) return waiting("spool_unreadable");
      throw error;
    }
    if (intact.some((ok) => !ok)) return waiting("crc_mismatch");
    afterStep?.("read");
    writeFileDurably(archivePath, [buffer], afterStep);
    try {
      recordArchive(db, {
        spoolFileId: file.id,
        archiveRelPath,
        placements: toArchive.map((chunk, index) => ({
          chunkId: chunk.id,
          crc32: chunk.crc32,
          archiveByteOffset: blocks[index]?.targetOffset ?? -1,
        })),
      });
    } catch (error) {
      if (!(error instanceof RetentionStateError)) throw error;
      // No row points at the new archive (none of this file's chunks were archived).
      unlinkIfPresent(archivePath);
      return waiting("archive_conflict");
    }
    afterStep?.("committed");
    archivedBytes = buffer.length - rewritten;
  }

  let expiredChunks: number;
  try {
    expiredChunks = expireSpoolFile(db, file.id, rolls).expiredChunks;
  } catch (error) {
    if (!(error instanceof RetentionStateError)) throw error;
    return waiting("archive_conflict");
  }
  afterStep?.("expired");
  unlinkIfPresent(absolute(layout, file.relPath));
  afterStep?.("unlinked");
  return {
    kind: "evicted",
    archivedChunks: toArchive.length,
    archivedBytes,
    expiredChunks,
    freedBytes: file.committedBytes,
  };
}

/** Whether the archive holds every chunk intact (read back, CRC checked). */
function archiveIntact(archivePath: string, chunks: readonly RetentionChunk[]): boolean {
  if (chunks.length === 0) return true;
  // One buffer laid out like the archive, so contiguous chunks are one read.
  const base = Math.min(...chunks.map((chunk) => chunk.archiveByteOffset ?? -1));
  const end = Math.max(...chunks.map((chunk) => (chunk.archiveByteOffset ?? 0) + chunk.byteLength));
  if (base < 0) return false;
  const target = new Uint8Array(end - base);
  const blocks: BlockRead[] = chunks.map((chunk) => ({
    position: chunk.archiveByteOffset ?? -1,
    length: chunk.byteLength,
    crc32: chunk.crc32,
    target,
    targetOffset: (chunk.archiveByteOffset ?? 0) - base,
  }));
  try {
    return withFile(archivePath, "r", (fd) => readBlocks(fd, blocks)).every(Boolean);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function unlinkIfPresent(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

export interface RecoveryReport {
  /** Leftover `NNNN.pcm.tmp` files of interrupted archives. */
  readonly tmpRemoved: number;
  /** Archive files no chunk points to. */
  readonly orphansRemoved: number;
  /** Spool files already expired whose PCM was still there. */
  readonly spoolUnlinked: number;
  /** Spool files whose archive was missing or damaged while the spool still held the bytes. */
  readonly rearchive: number;
  /** Archived chunks whose archive is gone along with their spool bytes. */
  readonly lostChunks: number;
  /** Deleted chunks whose bytes were zeroed (again). */
  readonly rescrubbed: number;
  /** Deleted chunks still in a run's newest spool file: retention retries them. */
  readonly deferred: readonly ScrubbableChunk[];
  /** Bytes of audio the archive holds after recovery. */
  readonly archivedBytes: number;
}

/**
 * Startup recovery: finishes or undoes what a crash interrupted. Only reads
 * whole archives back for spool files that still hold their bytes (the only
 * ones a crash can leave half done); for evicted files it checks that each
 * archive is there and long enough, and reads check CRCs later.
 */
export function recoverRetention(db: Database, layout: RetentionLayout): RecoveryReport {
  let tmpRemoved = 0;
  let orphansRemoved = 0;
  const archiveRoot = join(layout.dataDir, layout.archiveDir);
  for (const trackDir of directories(archiveRoot)) {
    for (const runDir of directories(join(archiveRoot, trackDir))) {
      const path = join(archiveRoot, trackDir, runDir);
      for (const entry of listing(path)) {
        if (!entry.isFile()) continue;
        if (entry.name.endsWith(".tmp")) {
          if (unlinkIfPresent(join(path, entry.name))) tmpRemoved += 1;
          continue;
        }
        const archiveRelPath = `${layout.archiveDir}/${trackDir}/${runDir}/${entry.name}`;
        const spoolRelPath = spoolRelPathOf(layout, archiveRelPath);
        if (spoolRelPath === null) continue;
        if (isArchiveReferenced(db, spoolRelPath, archiveRelPath)) continue;
        if (unlinkIfPresent(join(path, entry.name))) orphansRemoved += 1;
      }
      removeIfEmpty(path);
    }
    removeIfEmpty(join(archiveRoot, trackDir));
  }

  let rearchive = 0;
  let lostChunks = 0;
  let archivedBytes = 0;
  for (const ref of archiveRefs(db)) {
    const archivePath = absolute(layout, ref.archiveRelPath);
    const chunks = spoolFileChunks(db, ref.spoolFileId, "archived");
    if (ref.spoolState === "open" || ref.spoolState === "closed") {
      if (archiveIntact(archivePath, chunks)) {
        archivedBytes += ref.archivedBytes;
      } else {
        unarchiveSpoolFile(db, ref.spoolFileId);
        rearchive += 1;
      }
      continue;
    }
    // A crash between expiring the file and unlinking its PCM leaves the spool
    // bytes on disk: check the archive by CRC, and if it is bad keep the spool
    // as the good copy (the next pass archives it anew) instead of unlinking it.
    const spoolPath = absolute(layout, ref.spoolRelPath);
    if (sizeOf(spoolPath) > 0) {
      if (archiveIntact(archivePath, chunks)) {
        archivedBytes += ref.archivedBytes;
      } else {
        reopenExpiredSpoolFile(db, ref.spoolFileId);
        unlinkIfPresent(archivePath);
        rearchive += 1;
      }
      continue;
    }
    const size = sizeOf(archivePath);
    const lost = chunks.filter((chunk) => (chunk.archiveByteOffset ?? 0) + chunk.byteLength > size);
    if (lost.length > 0) {
      lostChunks += expireLostArchive(
        db,
        lost.map((chunk) => chunk.id),
      ).chunks;
    }
    archivedBytes += ref.archivedBytes - lost.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  }

  let spoolUnlinked = 0;
  const spoolRoot = join(layout.dataDir, layout.spoolDir);
  for (const trackDir of directories(spoolRoot)) {
    for (const runDir of directories(join(spoolRoot, trackDir))) {
      for (const entry of listing(join(spoolRoot, trackDir, runDir))) {
        if (!entry.isFile() || !entry.name.endsWith(".pcm")) continue;
        const relPath = `${layout.spoolDir}/${trackDir}/${runDir}/${entry.name}`;
        if (spoolFileStateOf(db, relPath) !== "expired") continue;
        if (unlinkIfPresent(join(spoolRoot, trackDir, runDir, entry.name))) spoolUnlinked += 1;
      }
    }
  }

  const scrub = scrubChunks(db, layout, unscrubbedChunks(db));
  return {
    tmpRemoved,
    orphansRemoved,
    spoolUnlinked,
    rearchive,
    lostChunks,
    rescrubbed: scrub.zeroed,
    deferred: scrub.deferred,
    archivedBytes,
  };
}

/** A deleted chunk to scrub: `DeletedChunk` from `deleteEpisode`, or one recovery found. */
export interface ScrubbableChunk {
  readonly chunkId: number;
  readonly spoolRelPath: string;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly archiveRelPath: string | null;
  readonly archiveByteOffset: number | null;
}

export interface ScrubReport {
  readonly chunks: number;
  /** Chunks with at least one copy (spool or archive) overwritten. */
  readonly zeroed: number;
  /** Bytes zeroed in archives (audio the archive no longer holds). */
  readonly archiveBytes: number;
  /**
   * Chunks left in their run's newest spool file: the helper's recovery would
   * cut that file at a zeroed block. Retry them once the run has a later file
   * (each retention pass does); eviction removes them anyway.
   */
  readonly deferred: readonly ScrubbableChunk[];
}

/**
 * Overwrites deleted chunks' bytes with zeros in the spool and in the archive,
 * syncing each file, then records that their archive bytes are gone. Run it
 * right after `deleteEpisode`; startup recovery runs it again for any chunk a
 * crash left unscrubbed. A run's newest spool file is left alone (see
 * `ScrubReport.deferred`).
 */
export function scrubChunks(
  db: Database,
  layout: RetentionLayout,
  chunks: readonly ScrubbableChunk[],
): ScrubReport {
  const spool = new Map<string, { position: number; length: number }[]>();
  const archive = new Map<string, { position: number; length: number }[]>();
  const add = (map: typeof spool, relPath: string, range: { position: number; length: number }) => {
    const list = map.get(relPath);
    if (list === undefined) map.set(relPath, [range]);
    else list.push(range);
  };
  let archiveBytes = 0;
  const deferred: ScrubbableChunk[] = [];
  let zeroed = 0;
  const older = new Map<string, boolean>();
  for (const chunk of chunks) {
    let rewritable = older.get(chunk.spoolRelPath);
    if (rewritable === undefined) {
      rewritable = hasLaterSpoolFile(db, chunk.spoolRelPath);
      older.set(chunk.spoolRelPath, rewritable);
    }
    if (rewritable) {
      add(spool, chunk.spoolRelPath, { position: chunk.byteOffset, length: chunk.byteLength });
    } else {
      deferred.push(chunk);
    }
    const archived = chunk.archiveRelPath !== null && chunk.archiveByteOffset !== null;
    if (archived) {
      add(archive, chunk.archiveRelPath, {
        position: chunk.archiveByteOffset,
        length: chunk.byteLength,
      });
      archiveBytes += chunk.byteLength;
    }
    if (rewritable || archived) zeroed += 1;
  }
  for (const [relPath, ranges] of spool) zeroRanges(absolute(layout, relPath), ranges);
  for (const [relPath, ranges] of archive) zeroRanges(absolute(layout, relPath), ranges);
  markArchiveScrubbed(
    db,
    chunks.filter((chunk) => chunk.archiveRelPath !== null).map((chunk) => chunk.chunkId),
  );
  return { chunks: chunks.length, zeroed, archiveBytes, deferred };
}

function listing(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function directories(path: string): string[] {
  return listing(path)
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
}

/**
 * Lets archived audio go (ADR 015, ADR 029): zeroes each block's bytes in its
 * archive and syncs, then records the blocks `expired` and the episodes'
 * audio gone, then unlinks the archive files nothing points at any more. A
 * crash after the zeroing leaves blocks still `archived` but due: the next
 * pass takes them again.
 */
export function expireArchivedAudio(
  db: Database,
  layout: RetentionLayout,
  expiry: AudioExpiry,
  nowMs: number,
): { readonly chunks: number; readonly bytes: number; readonly filesRemoved: number } {
  const byFile = new Map<
    string,
    { spoolRelPath: string; ranges: { position: number; length: number }[] }
  >();
  let bytes = 0;
  for (const chunk of expiry.chunks) {
    const entry = byFile.get(chunk.archiveRelPath) ?? {
      spoolRelPath: chunk.spoolRelPath,
      ranges: [],
    };
    entry.ranges.push({ position: chunk.archiveByteOffset, length: chunk.byteLength });
    byFile.set(chunk.archiveRelPath, entry);
    bytes += chunk.byteLength;
  }
  for (const [relPath, { ranges }] of byFile) zeroRanges(absolute(layout, relPath), ranges);
  commitAudioExpiry(db, expiry, nowMs);
  let filesRemoved = 0;
  for (const [relPath, { spoolRelPath }] of byFile) {
    if (isArchiveReferenced(db, spoolRelPath, relPath)) continue;
    const path = absolute(layout, relPath);
    try {
      unlinkSync(path);
      filesRemoved += 1;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    removeIfEmpty(dirname(path));
  }
  return { chunks: expiry.chunks.length, bytes, filesRemoved };
}

function removeIfEmpty(path: string): void {
  try {
    rmdirSync(path);
  } catch {
    // Not empty, or already gone.
  }
}
