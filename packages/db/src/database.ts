import { DatabaseSync, type StatementSync } from "node:sqlite";
import { drizzle, type NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import { dropJournalTriggers, ensureJournalTriggers } from "./journal-triggers";
import { bundledMigrationsFolder, migrate, readMigrations, type MigrationReport } from "./migrate";
import { int } from "./rows";

export type Orm = NodeSQLiteDatabase & { $client: DatabaseSync };

export interface Database {
  readonly path: string;
  readonly client: DatabaseSync;
  readonly orm: Orm;
  /** Prepares `sql` once per connection and reuses the statement. */
  statement(sql: string): StatementSync;
  close(): void;
}

export interface OpenDatabaseOptions {
  /** Folder of drizzle-kit migrations; defaults to this package's `drizzle/`. */
  readonly migrationsFolder?: string;
  /** Apply pending migrations after opening. Defaults to true. */
  readonly migrate?: boolean;
}

export interface OpenedDatabase extends Database {
  readonly migrations: MigrationReport;
}

/** Applied in order on every connection; journal_mode must come first. */
export const connectionPragmas = [
  ["journal_mode", "WAL"],
  ["synchronous", "NORMAL"],
  ["foreign_keys", "ON"],
  ["busy_timeout", "2000"],
  ["secure_delete", "ON"],
  ["wal_autocheckpoint", "1000"],
  ["journal_size_limit", "67108864"],
  ["temp_store", "MEMORY"],
  ["cache_size", "-8192"],
] as const;

export class DatabaseOpenError extends Error {
  override readonly name = "DatabaseOpenError";
}

export function openDatabase(path: string, options: OpenDatabaseOptions = {}): OpenedDatabase {
  const client = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  try {
    for (const [name, value] of connectionPragmas) client.exec(`PRAGMA ${name} = ${value}`);
    const mode = client.prepare("PRAGMA journal_mode").get()?.["journal_mode"];
    if (path !== ":memory:" && mode !== "wal") {
      throw new DatabaseOpenError(`journal_mode is ${String(mode)}, expected wal`);
    }
    const db = wrap(path, client);
    // A trigger reading another table would fail a migration that rebuilds
    // that table: they go first and come back after.
    if (options.migrate !== false) dropJournalTriggers(db);
    const migrations =
      options.migrate === false
        ? { applied: [], current: [] }
        : migrate(db, readMigrations(options.migrationsFolder ?? bundledMigrationsFolder));
    // After the migrations, which may have rebuilt a table and dropped its triggers.
    if (options.migrate !== false) ensureJournalTriggers(db);
    return { ...db, migrations };
  } catch (error) {
    client.close();
    throw error;
  }
}

function wrap(path: string, client: DatabaseSync): Database {
  const statements = new Map<string, StatementSync>();
  return {
    path,
    client,
    orm: drizzle({ client }),
    statement(sql) {
      let prepared = statements.get(sql);
      if (prepared === undefined) {
        prepared = client.prepare(sql);
        statements.set(sql, prepared);
      }
      return prepared;
    },
    close() {
      statements.clear();
      if (client.isOpen) client.close();
    },
  };
}

const savepointDepth = new WeakMap<DatabaseSync, number>();

/**
 * Runs `fn` in one write transaction (BEGIN IMMEDIATE), or in a savepoint
 * when a transaction is already open, so import functions compose into one
 * batch. `fn` must be synchronous: node:sqlite has no async transactions.
 */
export function transaction<T>(db: Database, fn: () => T): T {
  const client = db.client;
  if (client.isTransaction) {
    const depth = (savepointDepth.get(client) ?? 0) + 1;
    const name = `sondine_sp_${depth}`;
    savepointDepth.set(client, depth);
    client.exec(`SAVEPOINT ${name}`);
    try {
      const result = settle(fn());
      client.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      client.exec(`ROLLBACK TO ${name}`);
      client.exec(`RELEASE ${name}`);
      throw error;
    } finally {
      savepointDepth.set(client, depth - 1);
    }
  }
  client.exec("BEGIN IMMEDIATE");
  try {
    const result = settle(fn());
    client.exec("COMMIT");
    return result;
  } catch (error) {
    if (client.isTransaction) client.exec("ROLLBACK");
    throw error;
  }
}

function settle<T>(value: T): T {
  if (value instanceof Promise) {
    void value.catch(() => undefined);
    throw new TypeError("transaction() callbacks must be synchronous");
  }
  return value;
}

export interface CheckpointResult {
  readonly busy: number;
  readonly logFrames: number;
  readonly checkpointedFrames: number;
}

/**
 * Copies the WAL into the database and truncates it to zero bytes, so deleted
 * content no longer lingers in the -wal file. Retries while readers block it.
 */
export function checkpointTruncate(db: Database, attempts = 5): CheckpointResult {
  let last: CheckpointResult = { busy: 1, logFrames: -1, checkpointedFrames: -1 };
  for (let attempt = 0; attempt < attempts; attempt++) {
    const row = db.client.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() ?? {};
    last = {
      busy: int(row, "busy"),
      logFrames: int(row, "log"),
      checkpointedFrames: int(row, "checkpointed"),
    };
    if (last.busy === 0) return last;
  }
  return last;
}
