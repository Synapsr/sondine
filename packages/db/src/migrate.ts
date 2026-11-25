import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "./database";
import { int, str } from "./rows";

/** The drizzle-kit output folder shipped with this package. */
export const bundledMigrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

export const migrationsTable = "schema_migrations";

export interface Migration {
  readonly name: string;
  readonly hash: string;
  readonly statements: readonly string[];
}

export interface MigrationReport {
  /** Migrations applied by this call, in order. */
  readonly applied: readonly string[];
  /** Every migration recorded in the database after this call. */
  readonly current: readonly string[];
}

export class MigrationError extends Error {
  override readonly name = "MigrationError";
}

const folderName = /^\d{14}_[a-z0-9_]+$/;
const breakpoint = "--> statement-breakpoint";

/** Reads `<folder>/<timestamp>_<name>/migration.sql` files in name order. */
export function readMigrations(folder: string): Migration[] {
  const names = readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(folder, entry.name, "migration.sql")))
    .map((entry) => entry.name)
    .toSorted();
  return names.map((name) => {
    if (!folderName.test(name))
      throw new MigrationError(`Unexpected migration folder name: ${name}`);
    const source = readFileSync(join(folder, name, "migration.sql"), "utf8");
    return {
      name,
      hash: createHash("sha256").update(source).digest("hex"),
      statements: source
        .split(breakpoint)
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0),
    };
  });
}

/**
 * Applies pending migrations in name order, each in its own transaction, and
 * records them in `schema_migrations`. Running it again applies nothing.
 *
 * Foreign keys are switched off around the batch (the pragma is ignored inside
 * a transaction) because drizzle-kit rebuilds SQLite tables to alter them;
 * `foreign_key_check` runs before each commit instead.
 */
export function migrate(db: Database, migrations: readonly Migration[]): MigrationReport {
  const client = db.client;
  if (client.isTransaction) throw new MigrationError("migrate() cannot run inside a transaction");

  const local = new Map<string, Migration>();
  for (const migration of migrations) {
    if (local.has(migration.name))
      throw new MigrationError(`Duplicate migration ${migration.name}`);
    local.set(migration.name, migration);
  }

  client.exec(
    `CREATE TABLE IF NOT EXISTS ${migrationsTable} (
      name TEXT PRIMARY KEY NOT NULL,
      hash TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL
    ) STRICT`,
  );
  const recorded = client
    .prepare(`SELECT name, hash FROM ${migrationsTable} ORDER BY name`)
    .all()
    .map((row) => ({ name: str(row, "name"), hash: str(row, "hash") }));
  for (const row of recorded) {
    const migration = local.get(row.name);
    if (migration === undefined) {
      throw new MigrationError(`Database has migration ${row.name}, unknown to this build`);
    }
    if (migration.hash !== row.hash) {
      throw new MigrationError(`Migration ${row.name} changed after it was applied`);
    }
  }

  const done = new Set(recorded.map((row) => row.name));
  const pending = [...local.values()]
    .filter((migration) => !done.has(migration.name))
    .toSorted(byName);
  if (pending.length === 0) return { applied: [], current: recorded.map((row) => row.name) };

  const foreignKeysWereOn =
    int(client.prepare("PRAGMA foreign_keys").get() ?? {}, "foreign_keys") === 1;
  client.exec("PRAGMA foreign_keys = OFF");
  const applied: string[] = [];
  try {
    const record = client.prepare(
      `INSERT INTO ${migrationsTable} (name, hash, applied_at_ms) VALUES (?, ?, ?)`,
    );
    for (const migration of pending) {
      client.exec("BEGIN IMMEDIATE");
      try {
        for (const statement of migration.statements) client.exec(statement);
        const violation = client.prepare("PRAGMA foreign_key_check").get();
        if (violation !== undefined) {
          throw new MigrationError(
            `Migration ${migration.name} leaves a foreign key violation in ${String(violation["table"])}`,
          );
        }
        record.run(migration.name, migration.hash, Date.now());
        client.exec("COMMIT");
        applied.push(migration.name);
      } catch (error) {
        if (client.isTransaction) client.exec("ROLLBACK");
        if (error instanceof MigrationError) throw error;
        throw new MigrationError(`Migration ${migration.name} failed`, { cause: error });
      }
    }
  } finally {
    if (foreignKeysWereOn) client.exec("PRAGMA foreign_keys = ON");
  }
  return { applied, current: [...done, ...applied].toSorted() };
}

const byName = (a: Migration, b: Migration): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
