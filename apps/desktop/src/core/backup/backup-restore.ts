import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  databaseMigrations,
  migrationRefusal,
  openDatabase,
  prepareRestoredCopy,
  type Migration,
} from "@sondine/db";
import { DATA_LAYOUT } from "../../shared/data-layout";
import { RESTORED_ITEMS, restoreStamp, type RestoreMarker } from "../../shared/restore-marker";
import { openBackup, writeAll, type BackupSummary, type FileSink } from "./backup-format";
import { isRestorableName, RENDERER_FILE } from "./backup-names";
import { volumeFreeBytes } from "./backup-export";

// Staging a restore (ADR 048): the backup is unpacked into
// `restore-staging/`, each file checked against the manifest and the whole
// stream against its digest; then its database's migrations are checked
// against this build's, and the copy is prepared (listening paused, the
// restore's note). Only then the marker is written: main swaps the staging
// in at the next launch. Anything wrong leaves no staging behind.

export class RestoreRefused extends Error {
  override readonly name = "RestoreRefused";
  constructor(
    readonly reason: "newer" | "no-space",
    readonly neededBytes: number | null = null,
    readonly freeBytes: number | null = null,
  ) {
    super(`restore refused: ${reason}`);
  }
}

/** Room kept beyond the backup's files in the data directory's volume. */
const SPACE_MARGIN = 1.1;

export function restoreRoom(
  summary: BackupSummary,
  dataDir: string,
  freeBytes: (directory: string) => number = volumeFreeBytes,
): { readonly neededBytes: number; readonly freeBytes: number } {
  return { neededBytes: Math.ceil(summary.bytes * SPACE_MARGIN), freeBytes: freeBytes(dataDir) };
}

export interface StageInput {
  readonly path: string;
  readonly passphrase: string | null;
  readonly dataDir: string;
  /** This build's migrations. */
  readonly migrations: readonly Migration[];
  readonly nowMs: number;
  readonly signal?: AbortSignal;
  /** Bytes of the backup file read, of `total`. */
  readonly onProgress?: (done: number, total: number) => void;
  readonly freeBytes?: (directory: string) => number;
}

/** Stages the backup at `path`; throws `WrongPassphrase`, `BackupFormatError`, `RestoreRefused`, or an abort. */
export async function stageRestore(
  input: StageInput,
): Promise<{ readonly summary: BackupSummary }> {
  const staging = join(input.dataDir, DATA_LAYOUT.restoreStagingDir);
  rmSync(staging, { recursive: true, force: true });
  const backup = await openBackup(input.path, input.passphrase);
  const handles = new Set<Awaited<ReturnType<typeof open>>>();
  try {
    const summary = backup.summary;
    if (migrationRefusal(summary.migrations, input.migrations) !== null) {
      throw new RestoreRefused("newer");
    }
    const room = restoreRoom(summary, input.dataDir, input.freeBytes);
    if (room.freeBytes < room.neededBytes) {
      throw new RestoreRefused("no-space", room.neededBytes, room.freeBytes);
    }
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    let prefs: Record<string, string> = {};
    await backup.extract({
      accept: isRestorableName,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      onProgress: (done) => input.onProgress?.(done, backup.fileBytes),
      sink: async (name, size): Promise<FileSink> => {
        if (name === RENDERER_FILE) {
          const parts: Buffer[] = [];
          return {
            write: async (bytes) => void parts.push(Buffer.from(bytes)),
            end: async () => {
              if (size > 64 * 1024) return;
              prefs = parsePrefs(Buffer.concat(parts).toString("utf8"));
            },
          };
        }
        const target = join(staging, name);
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        const handle = await open(target, "wx", 0o600);
        handles.add(handle);
        return {
          write: (bytes) => writeAll(handle, bytes),
          end: async () => {
            await handle.sync();
            handles.delete(handle);
            await handle.close();
          },
        };
      },
    });

    // The database's own record decides, not the summary's copy of it.
    const database = join(staging, DATA_LAYOUT.database);
    const staged = openDatabase(database, { migrate: false });
    let refusal: ReturnType<typeof migrationRefusal>;
    try {
      refusal = migrationRefusal(databaseMigrations(staged), input.migrations);
    } finally {
      staged.close();
    }
    if (refusal !== null) throw new RestoreRefused("newer");
    prepareRestoredCopy(database, {
      restoredAtMs: input.nowMs,
      createdAtMs: summary.createdAtMs,
      models: summary.models,
      prefs,
    });
    // A cancel that came during the last checks still wins.
    input.signal?.throwIfAborted();
    markStaged(input.dataDir, restoreStamp(input.nowMs));
    return { summary };
  } catch (error) {
    for (const handle of handles) await handle.close().catch(() => undefined);
    rmSync(staging, { recursive: true, force: true });
    throw error;
  } finally {
    await backup.close();
  }
}

/** The last step: the staging is complete, main may swap it in. It lists what it holds. */
function markStaged(dataDir: string, stamp: string): void {
  const staging = join(dataDir, DATA_LAYOUT.restoreStagingDir);
  const items = RESTORED_ITEMS.filter((item) => existsSync(join(staging, item)));
  const path = join(dataDir, DATA_LAYOUT.restoreMarker);
  const marker: RestoreMarker = { stamp, phase: "staged", items };
  writeFileSync(`${path}.tmp`, JSON.stringify(marker), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

function parsePrefs(text: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}
