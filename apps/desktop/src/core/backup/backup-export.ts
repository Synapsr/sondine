import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  backupArchiveFiles,
  backupContextFiles,
  backupCounts,
  databaseMigrations,
  openDatabase,
  prepareExportCopy,
  snapshotDatabase,
  type BackupArchiveFile,
  type Database,
} from "@sondine/db";
import { DATA_LAYOUT } from "../../shared/data-layout";
import { BackupWriter, FRAME_BYTES, type BackupSummary } from "./backup-format";
import { LAN_FILES, RENDERER_FILE } from "./backup-names";

// Writing a backup (ADR 048). The caller holds retention (no archive file
// moves meanwhile) and says whether nothing was deleted since the start:
// the database is copied with SQLite's backup, cleaned, then its files go
// one after another, each archive file with only the bytes of the chunks the
// copy still holds. The file is written beside its destination and renamed
// once complete.

/**
 * In the data folder, beside the work folder: the `.partial` files exports
 * were writing, outside the data folder. One stays listed until its file is
 * gone, so a disk unplugged during a crash is cleaned once it is back.
 */
export const PARTIAL_RECORD = "backup-partials.json";

function readPartials(dataDir: string): string[] {
  try {
    const value: unknown = JSON.parse(readFileSync(join(dataDir, PARTIAL_RECORD), "utf8"));
    return Array.isArray(value)
      ? value.filter(
          (item): item is string => typeof item === "string" && item.endsWith(".sondine.partial"),
        )
      : [];
  } catch {
    return [];
  }
}

function writePartials(dataDir: string, partials: readonly string[]): void {
  const path = join(dataDir, PARTIAL_RECORD);
  if (partials.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  writeFileSync(`${path}.tmp`, JSON.stringify([...new Set(partials)]), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

/**
 * At core's start: removes the `.partial` files exports left when core died
 * (those on a volume that is not there stay listed), then the work folder
 * (the database's copy).
 */
export function cleanInterruptedExport(dataDir: string): void {
  const left = readPartials(dataDir).filter((partial) => {
    // Only a file this code names: `<…>.sondine.partial`.
    if (!existsSync(dirname(partial))) return true;
    rmSync(partial, { force: true });
    return existsSync(partial);
  });
  writePartials(dataDir, left);
  rmSync(join(dataDir, DATA_LAYOUT.backupWorkDir), { recursive: true, force: true });
}

export class BackupStale extends Error {
  override readonly name = "BackupStale";
}

export class BackupNoSpace extends Error {
  override readonly name = "BackupNoSpace";
  constructor(
    readonly neededBytes: number,
    readonly freeBytes: number,
  ) {
    super("not enough free space for the backup");
  }
}

/** Room kept beyond the backup's size on its volume. */
const SPACE_MARGIN = 1.1;

export interface ExportInput {
  readonly db: Database;
  readonly dataDir: string;
  /** Where the user chose to save it. */
  readonly path: string;
  readonly passphrase: string | null;
  readonly includeAudio: boolean;
  /** The window's own settings, as `renderer.json`. */
  readonly prefs: Readonly<Record<string, string>>;
  readonly appVersion: string;
  readonly macName: string;
  readonly models: readonly string[];
  readonly nowMs: number;
  readonly signal?: AbortSignal;
  /** False once something was deleted since the export began: it stops as stale. */
  readonly stillCurrent: () => boolean;
  /** Plaintext bytes written, of about `total`. */
  readonly onProgress?: (done: number, total: number) => void;
  /** The free bytes on `path`'s volume; tests pass their own. */
  readonly freeBytes?: (directory: string) => number;
}

interface Entry {
  readonly name: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly read: () => AsyncIterable<Buffer> | Iterable<Buffer>;
}

export function volumeFreeBytes(directory: string): number {
  const volume = statfsSync(directory);
  return Number(volume.bavail) * Number(volume.bsize);
}

/** A file's bytes, `FRAME_BYTES` at a time; outside `ranges` (when given) they leave as zero. */
async function* fileBytes(
  path: string,
  size: number,
  ranges: BackupArchiveFile["ranges"] | null,
): AsyncGenerator<Buffer> {
  const handle = await open(path, "r").catch((error: unknown) => {
    throw (error as NodeJS.ErrnoException).code === "ENOENT"
      ? new BackupStale(`a file went away while it was copied`)
      : error;
  });
  try {
    let offset = 0;
    while (offset < size) {
      const length = Math.min(FRAME_BYTES, size - offset);
      const buffer = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const { bytesRead } = await handle.read(buffer, read, length - read, offset + read);
        if (bytesRead === 0) throw new BackupStale("a file shrank while it was copied");
        read += bytesRead;
      }
      if (ranges !== null) zeroOutside(buffer, offset, ranges);
      yield buffer;
      offset += length;
    }
  } finally {
    await handle.close();
  }
}

/** Zeroes the bytes of `buffer` (at `offset` in its file) that no range covers. */
export function zeroOutside(
  buffer: Buffer,
  offset: number,
  ranges: BackupArchiveFile["ranges"],
): void {
  let cursor = offset;
  const end = offset + buffer.length;
  for (const [start, stop] of ranges) {
    if (stop <= cursor) continue;
    if (start >= end) break;
    if (start > cursor) buffer.fill(0, cursor - offset, start - offset);
    cursor = Math.max(cursor, stop);
    if (cursor >= end) return;
  }
  if (cursor < end) buffer.fill(0, cursor - offset, buffer.length);
}

function fileEntry(name: string, path: string, ranges: BackupArchiveFile["ranges"] | null): Entry {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new BackupStale(`${name} went away while the backup was prepared`);
  }
  return {
    name,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    read: () => fileBytes(path, stats.size, ranges),
  };
}

/** Writes the backup; returns its size. Throws `BackupStale`, `BackupNoSpace`, or an abort. */
export async function writeExport(input: ExportInput): Promise<{ readonly bytes: number }> {
  const workDir = join(input.dataDir, DATA_LAYOUT.backupWorkDir);
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  const copyPath = join(workDir, `${randomUUID()}.db`);
  const partial = `${input.path}.partial`;
  let writer: BackupWriter | null = null;
  try {
    await snapshotDatabase(input.db, copyPath);
    if (!input.stillCurrent()) throw new BackupStale("something was deleted");
    prepareExportCopy(copyPath, { includeAudio: input.includeAudio });

    const copy = openDatabase(copyPath, { migrate: false });
    let archive: BackupArchiveFile[];
    let context: string[];
    let summaryParts: Pick<BackupSummary, "counts" | "migrations">;
    try {
      archive = backupArchiveFiles(copy);
      context = backupContextFiles(copy);
      summaryParts = { counts: backupCounts(copy), migrations: databaseMigrations(copy) };
    } finally {
      copy.close();
    }
    // The copy reopened in WAL: its files go back to one.
    for (const suffix of ["-wal", "-shm"]) rmSync(`${copyPath}${suffix}`, { force: true });

    const entries: Entry[] = [fileEntry(DATA_LAYOUT.database, copyPath, null)];
    for (const file of archive) {
      entries.push(fileEntry(file.relPath, join(input.dataDir, file.relPath), file.ranges));
    }
    const previews = join(input.dataDir, DATA_LAYOUT.contextPreviewDir);
    const previewNames = existsSync(previews) ? readdirSync(previews) : [];
    for (const sha of context) {
      const name = `${DATA_LAYOUT.contextDir}/${sha}`;
      entries.push(fileEntry(name, join(input.dataDir, name), null));
      for (const preview of previewNames) {
        if (preview === `${sha}.jpg` || preview === `${sha}.png`) {
          const previewName = `${DATA_LAYOUT.contextPreviewDir}/${preview}`;
          entries.push(fileEntry(previewName, join(input.dataDir, previewName), null));
        }
      }
    }
    for (const lan of LAN_FILES) {
      const name = `${DATA_LAYOUT.lanDir}/${lan}`;
      const path = join(input.dataDir, name);
      if (existsSync(path)) entries.push(fileEntry(name, path, null));
    }
    const prefs = Buffer.from(JSON.stringify(input.prefs), "utf8");
    entries.push({
      name: RENDERER_FILE,
      size: prefs.length,
      mtimeMs: input.nowMs,
      read: () => [prefs],
    });

    const bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    // Each file's 512-byte header and padding, the frames' 21 bytes per MiB: a little over.
    const total = bytes + entries.length * 1024 + 4096;
    const free = (input.freeBytes ?? volumeFreeBytes)(dirname(input.path));
    const needed = Math.ceil(total * SPACE_MARGIN);
    if (free < needed) throw new BackupNoSpace(needed, free);

    await rm(partial, { force: true });
    // Should core die while it writes, its next start removes this file.
    writePartials(input.dataDir, [...readPartials(input.dataDir), partial]);
    writer = await BackupWriter.create({
      path: partial,
      passphrase: input.passphrase,
      summary: {
        appVersion: input.appVersion,
        createdAtMs: input.nowMs,
        macName: input.macName,
        includeAudio: input.includeAudio,
        models: [...input.models],
        bytes,
        ...summaryParts,
      },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      onProgress: (done) => {
        if (!input.stillCurrent()) throw new BackupStale("something was deleted");
        input.onProgress?.(done, total);
      },
    });
    for (const entry of entries) {
      if (!input.stillCurrent()) throw new BackupStale("something was deleted");
      await writer.addFile(entry.name, entry.size, entry.read(), entry.mtimeMs);
    }
    await writer.finish();
    input.signal?.throwIfAborted();
    // The last check and the rename run in one turn of core's thread: no
    // deletion lands between them, and a file the user is replacing goes
    // only for a backup that holds.
    if (!input.stillCurrent()) throw new BackupStale("something was deleted");
    renameSync(partial, input.path);
    writer = null;
    return { bytes: statSync(input.path).size };
  } catch (error) {
    await writer?.abort();
    await rm(partial, { force: true });
    throw error;
  } finally {
    writePartials(
      input.dataDir,
      readPartials(input.dataDir).filter((listed) => listed !== partial || existsSync(partial)),
    );
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      rmSync(`${copyPath}${suffix}`, { force: true });
    }
  }
}
