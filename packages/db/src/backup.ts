import { backup, DatabaseSync } from "node:sqlite";
import type { Database } from "./database";
import { migrationsTable, type Migration } from "./migrate";
import { int, str } from "./rows";

// A whole backup of Sondine (ADR 048), the database's part: a consistent copy
// taken while the app runs, cleaned of what must not travel, the files it
// points to, and a summary to show before a restore. Restoring prepares the
// copy so the restored Mac starts paused, with nothing of the export's
// passing state.

/** What the restored database says of its restore, until the user closes the note. */
export const RESTORED_KEY = "backup.restored";

/** Settings that describe a moment of this Mac, not the user's choices: they never travel. */
export const TRANSIENT_SETTING_KEYS = [
  "capture.pause-deadline",
  "capture.pause-reminded",
  "capture.call-listen",
  "updates.installing",
  "updates.updated",
  "sondine.dev.small-mac",
  RESTORED_KEY,
] as const;

export interface BackupMigration {
  readonly name: string;
  readonly hash: string;
}

export interface BackupCounts {
  readonly episodes: number;
  readonly people: number;
  /** Speech whose audio the backup holds, in milliseconds. */
  readonly audioMs: number;
  readonly contextItems: number;
  readonly firstEpisodeAtMs: number | null;
  readonly lastEpisodeAtMs: number | null;
}

/** One archive file of the copy, with the byte ranges of its chunks the copy still holds. */
export interface BackupArchiveFile {
  readonly relPath: string;
  /** `[offset, end)` pairs, sorted and merged: every other byte leaves as zero. */
  readonly ranges: readonly (readonly [number, number])[];
}

/**
 * Copies the live database to `target` with SQLite's online backup: the copy
 * is consistent at the moment it ends, though core keeps writing.
 */
export async function snapshotDatabase(db: Database, target: string): Promise<void> {
  await backup(db.client, target);
}

/**
 * Cleans a fresh copy for the backup, in place: audio still in the spool (not
 * archived yet) leaves as expired, with its text; passing settings go. No
 * VACUUM: it held core's thread about 3 s for a 165 MB database, and
 * `secure_delete` (on in the live database and here) already zeroes what a
 * deletion frees, so free pages carry nothing.
 */
export function prepareExportCopy(path: string, options: { readonly includeAudio: boolean }): void {
  const client = new DatabaseSync(path);
  try {
    client.exec("PRAGMA secure_delete = ON");
    client.exec("BEGIN IMMEDIATE");
    try {
      const gone = options.includeAudio
        ? "audio_state = 'present'"
        : "audio_state IN ('present', 'archived')";
      client.exec(
        `UPDATE chunks SET audio_state = 'expired', archive_rel_path = NULL, archive_byte_offset = NULL WHERE ${gone}`,
      );
      client.exec("UPDATE spool_files SET state = 'expired' WHERE state IN ('open', 'closed')");
      const drop = client.prepare("DELETE FROM settings WHERE key = ?");
      for (const key of TRANSIENT_SETTING_KEYS) drop.run(key);
      client.exec("COMMIT");
    } catch (error) {
      if (client.isTransaction) client.exec("ROLLBACK");
      throw error;
    }
  } finally {
    client.close();
  }
}

/** The migrations a database has, by name and hash: a restore needs every one known. */
export function databaseMigrations(db: Database): BackupMigration[] {
  return db
    .statement(`SELECT name, hash FROM ${migrationsTable} ORDER BY name`)
    .all()
    .map((row) => ({ name: str(row, "name"), hash: str(row, "hash") }));
}

/**
 * Why this build cannot open a database with `stored` migrations, or null:
 * a newer one (a migration this build lacks) or a changed one.
 */
export function migrationRefusal(
  stored: readonly BackupMigration[],
  known: readonly Migration[],
): "newer" | "changed" | null {
  const local = new Map(known.map((migration) => [migration.name, migration.hash]));
  for (const migration of stored) {
    const hash = local.get(migration.name);
    if (hash === undefined) return "newer";
    if (hash !== migration.hash) return "changed";
  }
  return null;
}

/** The archive files the copy points to, with the bytes of each it still holds. */
export function backupArchiveFiles(db: Database): BackupArchiveFile[] {
  const rows = db
    .statement(
      `SELECT archive_rel_path AS path, archive_byte_offset AS offset, byte_length AS length
       FROM chunks WHERE audio_state = 'archived' AND archive_rel_path IS NOT NULL
       ORDER BY archive_rel_path, archive_byte_offset`,
    )
    .all();
  const files = new Map<string, [number, number][]>();
  for (const row of rows) {
    const path = str(row, "path");
    const start = int(row, "offset");
    const end = start + int(row, "length");
    const ranges = files.get(path) ?? [];
    const last = ranges.at(-1);
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
    files.set(path, ranges);
  }
  return [...files].map(([relPath, ranges]) => ({ relPath, ranges }));
}

/** The context files (ADR 024) the copy points to, by SHA-256. */
export function backupContextFiles(db: Database): string[] {
  return db
    .statement(
      "SELECT DISTINCT file_sha256 AS sha FROM context_items WHERE file_sha256 IS NOT NULL ORDER BY 1",
    )
    .all()
    .map((row) => str(row, "sha"));
}

export function backupCounts(db: Database): BackupCounts {
  const count = (sql: string) => int(db.statement(sql).get() ?? {}, "n");
  const range = db
    .statement("SELECT min(started_at_ms) AS first, max(started_at_ms) AS last FROM episodes")
    .get();
  const first = range?.["first"];
  const last = range?.["last"];
  return {
    episodes: count("SELECT count(*) AS n FROM episodes"),
    people: count("SELECT count(*) AS n FROM people"),
    audioMs: Math.round(
      count(
        "SELECT coalesce(sum(sample_count), 0) AS n FROM chunks WHERE audio_state = 'archived'",
      ) / 16,
    ),
    contextItems: count("SELECT count(*) AS n FROM context_items"),
    firstEpisodeAtMs: typeof first === "number" ? first : null,
    lastEpisodeAtMs: typeof last === "number" ? last : null,
  };
}

/** What the restored database keeps of its restore, for the note after it. */
export interface RestoredNote {
  readonly restoredAtMs: number;
  /** When the backup was made. */
  readonly createdAtMs: number;
  /** The model artifacts the backed-up Mac had installed: the note offers them. */
  readonly models: readonly string[];
  /** The window's own settings (language, appearance, shortcuts), for it to take back. */
  readonly prefs: Readonly<Record<string, string>>;
}

/**
 * Prepares a staged copy before it replaces the data (it has not been
 * migrated yet): listening starts paused, until the user resumes it, and
 * the note of the restore is written.
 */
export function prepareRestoredCopy(path: string, note: RestoredNote): void {
  const client = new DatabaseSync(path);
  try {
    client.exec("BEGIN IMMEDIATE");
    try {
      const drop = client.prepare("DELETE FROM settings WHERE key = ?");
      for (const key of TRANSIENT_SETTING_KEYS) drop.run(key);
      const put = client.prepare(
        `INSERT INTO settings (key, value, updated_at_ms) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms`,
      );
      put.run(
        "capture.paused",
        JSON.stringify({ microphone: true, systemAudio: true }),
        note.restoredAtMs,
      );
      put.run(RESTORED_KEY, JSON.stringify(note), note.restoredAtMs);
      client.exec("COMMIT");
    } catch (error) {
      if (client.isTransaction) client.exec("ROLLBACK");
      throw error;
    }
  } finally {
    client.close();
  }
}

/** The note of a restore, while the user has not closed it. */
export function restoredNote(db: Database): RestoredNote | null {
  const row = db.statement("SELECT value FROM settings WHERE key = ?").get(RESTORED_KEY);
  if (row === undefined) return null;
  try {
    const value: unknown = JSON.parse(str(row, "value"));
    if (typeof value !== "object" || value === null) return null;
    const { restoredAtMs, createdAtMs, models, prefs } = value as Record<string, unknown>;
    if (typeof restoredAtMs !== "number" || typeof createdAtMs !== "number") return null;
    const list = Array.isArray(models)
      ? models.filter((model): model is string => typeof model === "string")
      : [];
    const kept: Record<string, string> = {};
    if (typeof prefs === "object" && prefs !== null) {
      for (const [key, text] of Object.entries(prefs))
        if (typeof text === "string") kept[key] = text;
    }
    return { restoredAtMs, createdAtMs, models: list, prefs: kept };
  } catch {
    return null;
  }
}

export function dismissRestoredNote(db: Database): void {
  db.statement("DELETE FROM settings WHERE key = ?").run(RESTORED_KEY);
}
