import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  checkpointTruncate,
  ensureSearchNormalizer,
  openDatabase,
  type OpenedDatabase,
} from "@sondine/db";
import { Context, Data, Effect, Layer } from "effect";
import { CoreConfig } from "./config";
import { log } from "./log";

export class DatabaseFailure extends Data.TaggedError("DatabaseFailure")<{
  readonly message: string;
}> {}

/** The single SQLite connection; core is its only writer (ADR 006). */
export class Database extends Context.Service<Database, OpenedDatabase>()(
  "sondine/core/Database",
) {}

export const databaseLayer = Layer.effect(
  Database,
  Effect.gen(function* () {
    const config = yield* CoreConfig;
    return yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          if (config.databasePath !== ":memory:") {
            mkdirSync(dirname(config.databasePath), { recursive: true, mode: 0o700 });
          }
          const db = openDatabase(config.databasePath, { migrationsFolder: config.migrationsDir });
          log.info("db.open", {
            applied: db.migrations.applied.length,
            current: db.migrations.current.length,
          });
          // The index follows the search normalizer (ADR 016); a no-op unless it changed.
          const search = ensureSearchNormalizer(db);
          if (search.reindexed > 0) log.info("search.reindexed", { ...search });
          return db;
        },
        catch: (error) =>
          new DatabaseFailure({ message: error instanceof Error ? error.message : String(error) }),
      }),
      (db) =>
        Effect.sync(() => {
          if (db.path !== ":memory:") checkpointTruncate(db);
          db.close();
          log.info("db.closed");
        }),
    );
  }),
);
