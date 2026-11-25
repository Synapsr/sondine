import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { afterEach, describe, expect, it } from "vitest";
import { importRecording } from "./audio-import";
import { connectionPragmas, openDatabase, transaction } from "./database";
import {
  bundledMigrationsFolder,
  MigrationError,
  migrationsTable,
  readMigrations,
} from "./migrate";
import { enqueueAnalysisJob } from "./jobs";
import { publishAnalysis } from "./publish";
import * as schema from "./schema";
import { searchSegments } from "./search";
import { seedEpisode, segment, startRun, tempDatabase, type TempDatabase } from "./test-helpers";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const drizzleTables = Object.values(schema).filter((value) => is(value, SQLiteTable));

let temp: TempDatabase | undefined;
const scratchDirs: string[] = [];
afterEach(() => {
  temp?.cleanup();
  temp = undefined;
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function schemaOf(db: TempDatabase["db"]): unknown {
  return db.client
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
    .all();
}

/** Every row of every table but the search index and the runner's, sorted. */
function rowsOf(db: TempDatabase["db"]): Record<string, string[]> {
  return Object.fromEntries(
    db.client
      .prepare(
        `SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
           AND name NOT LIKE 'segments_fts%' AND name <> ? ORDER BY name`,
      )
      .all(migrationsTable)
      .map((row) => String(row["name"]))
      .map((table) => [
        table,
        db.client
          .prepare(`SELECT * FROM "${table}"`)
          .all()
          .map((row) => JSON.stringify(row))
          .toSorted(),
      ]),
  );
}

function schemaDump(t: TempDatabase): string {
  return JSON.stringify(
    t.db.client
      .prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
      .all(),
  );
}

describe("migrations", () => {
  it("apply on an empty database and create every table", () => {
    temp = tempDatabase();
    const names = readMigrations(bundledMigrationsFolder).map((migration) => migration.name);
    expect(temp.db.migrations.applied).toEqual(names);
    expect(temp.db.migrations.current).toEqual(names);

    const tables = new Set(
      temp.db.client
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
        .all()
        .map((row) => row["name"]),
    );
    for (const table of drizzleTables) expect(tables).toContain(getTableConfig(table).name);
    expect(tables).toContain("segments_fts");
    expect(tables).toContain(migrationsTable);
  });

  it("create the columns the Drizzle schema declares", () => {
    temp = tempDatabase();
    for (const table of drizzleTables) {
      const config = getTableConfig(table);
      const columns = temp.db.client
        .prepare(`SELECT name, "notnull" FROM pragma_table_info(?) ORDER BY cid`)
        .all(config.name)
        .map((row) => `${String(row["name"])}:${String(row["notnull"])}`);
      // SQLite reports a primary key as nullable unless NOT NULL is spelled
      // out (drizzle-kit never does); settings_key_check covers the TEXT key.
      const declared = config.columns.map(
        (column) => `${column.name}:${column.notNull && !column.primary ? 1 : 0}`,
      );
      expect(columns.toSorted(), config.name).toEqual(declared.toSorted());
    }
  });

  it("are idempotent", () => {
    temp = tempDatabase();
    const before = schemaDump(temp);
    const again = temp.reopen();
    expect(again.migrations.applied).toEqual([]);
    expect(again.migrations.current).toEqual(temp.db.migrations.current);
    expect(schemaDump(temp)).toBe(before);
  });

  it("match the Drizzle schema (drizzle-kit sees no pending change)", () => {
    const output = execFileSync(
      join(packageRoot, "node_modules/.bin/drizzle-kit"),
      ["generate", "--explain", "--output", "json"],
      { cwd: packageRoot, encoding: "utf8" },
    );
    expect(JSON.parse(output.trim().split("\n").at(-1) ?? "{}")).toMatchObject({
      status: "no_changes",
    });
  }, 30_000);

  it("enable FTS5 secure-delete on segments_fts", () => {
    temp = tempDatabase();
    const row = temp.db.client
      .prepare("SELECT v FROM segments_fts_config WHERE k = 'secure-delete'")
      .get();
    expect(row?.["v"]).toBe(1);
  });

  it("refuse a migration edited after it was applied", () => {
    const folder = copyMigrations();
    temp = tempDatabase({ migrationsFolder: folder });
    const [first] = readMigrations(folder);
    if (first === undefined) throw new Error("no migrations");
    appendFileSync(join(folder, first.name, "migration.sql"), "\n-- edited\n");
    expect(() => temp?.reopen({ migrationsFolder: folder })).toThrow(MigrationError);
  });

  it("refuse a database migrated by a newer build", () => {
    temp = tempDatabase();
    temp.db.client
      .prepare(`INSERT INTO ${migrationsTable} (name, hash, applied_at_ms) VALUES (?, ?, ?)`)
      .run("29991231000000_future", "x", 0);
    expect(() => temp?.reopen()).toThrow(/unknown to this build/);
  });

  it("turn existing episode regions into whole-region slices", () => {
    const folder = copyMigrations();
    const slices = readMigrations(folder).find((m) => m.name.endsWith("_episode_region_slices"));
    if (slices === undefined) throw new Error("no slice migration");
    const parked = join(folder, "..", slices.name);
    renameSync(join(folder, slices.name), parked);
    temp = tempDatabase({ migrationsFolder: folder });
    temp.db.client.exec(`
      INSERT INTO track_runs (id, uid, track_key, source_kind, started_wall_ms, updated_at_ms)
        VALUES (1, 'run-1', 'input:mic', 'input', 0, 0);
      INSERT INTO speech_regions (id, track_run_id, sample_start, wall_start_ms, vad_version)
        VALUES (7, 1, 160000, 10000, 'v');
      INSERT INTO episodes (id, started_at_ms, grouping_version, classifier_version, created_at_ms, updated_at_ms)
        VALUES (3, 10000, 'g1', 'c1', 0, 0);
      INSERT INTO episode_regions (episode_id, speech_region_id, grouping_version) VALUES (3, 7, 'g1');
    `);
    renameSync(parked, join(folder, slices.name));
    const upgraded = temp.reopen({ migrationsFolder: folder });
    expect(upgraded.migrations.applied).toEqual([slices.name]);
    expect(
      upgraded.client
        .prepare("SELECT episode_id, slice_sample_start, slice_sample_end FROM episode_regions")
        .all(),
    ).toEqual([{ episode_id: 3, slice_sample_start: 160000, slice_sample_end: null }]);
  });

  it("rebuild episodes for dictations, keeping their ids, what points at them and search", () => {
    const folder = copyMigrations();
    const rebuild = readMigrations(folder).find((m) => m.name.endsWith("_listens_and_dictation"));
    if (rebuild === undefined) throw new Error("no dictation migration");
    const parked = join(folder, "..", rebuild.name);
    renameSync(join(folder, rebuild.name), parked);
    temp = tempDatabase({ migrationsFolder: folder });
    seedEpisode(temp.db, [[0, 5]]);
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 40]]);
    const runId = startRun(temp.db, episodeId, "asr");
    publishAnalysis(temp.db, {
      episodeId,
      stage: "asr",
      runId,
      inputGeneration: 1,
      segments: [segment(trackRunId, 10, 18, "On décale la réunion à jeudi.")],
      turns: [],
    });
    enqueueAnalysisJob(temp.db, { episodeId, inputGeneration: 1, priority: 30, nowMs: 0 });
    const before = temp.db.client.prepare("SELECT * FROM episodes ORDER BY id").all();
    renameSync(parked, join(folder, rebuild.name));
    const upgraded = temp.reopen({ migrationsFolder: folder });
    expect(upgraded.migrations.applied).toEqual([rebuild.name]);
    // Replayed alone, the rebuild knows only its own columns, not those later
    // migrations add (`page_key`): those it has keep every value.
    const after = upgraded.client.prepare("SELECT * FROM episodes ORDER BY id").all();
    expect(
      before.map((row, at) =>
        Object.fromEntries(Object.keys(after[at] ?? {}).map((key) => [key, row[key]])),
      ),
    ).toEqual(after);
    expect(upgraded.client.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      upgraded.client
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'episodes'")
        .all()
        .map((row) => row["name"])
        .toSorted(),
    ).toEqual(["episodes_size_started_idx", "episodes_started_idx"]);
    expect(searchSegments(upgraded, "réunion").map((hit) => hit.episodeId)).toEqual([episodeId]);
    upgraded.client
      .prepare("UPDATE episodes SET context = 'dictation' WHERE id = ?")
      .run(episodeId);
    expect(() =>
      upgraded.client.prepare("UPDATE episodes SET context = 'dictée' WHERE id = ?").run(episodeId),
    ).toThrow(/CHECK/);
  });

  it("add phone_recordings over a snapshot, keep every row, and restore onto either build", () => {
    const folder = copyMigrations("_phone_recordings");
    const phone = readMigrations(folder).find((m) => m.name.endsWith("_phone_recordings"));
    if (phone === undefined) throw new Error("no phone recordings migration");
    const parked = join(folder, "..", phone.name);
    renameSync(join(folder, phone.name), parked);
    temp = tempDatabase({ migrationsFolder: folder });
    // The build before: a Mac conversation with its transcript, and an imported file.
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 40]]);
    const runId = startRun(temp.db, episodeId, "asr");
    publishAnalysis(temp.db, {
      episodeId,
      stage: "asr",
      runId,
      inputGeneration: 1,
      segments: [segment(trackRunId, 10, 18, "On décale la réunion à jeudi.")],
      turns: [],
    });
    importRecording(temp.db, {
      uid: "import-1",
      fileName: "notes.m4a",
      sampleRate: 16_000,
      sampleCount: 32_000,
      startedWallMs: 0,
      archiveRelPath: "archive/imports/import-1/0001.pcm",
      spoolRelPath: "spool/imports/import-1/0001.pcm",
      chunks: [{ sampleStart: 0, sampleCount: 32_000, byteOffset: 0, crc32: 7 }],
      nowMs: 1,
    });
    const before = rowsOf(temp.db);
    // The snapshot a backup holds, taken before the update.
    const snapshot = join(temp.dir, "snapshot.db");
    temp.db.client.exec(`VACUUM INTO '${snapshot}'`);

    renameSync(parked, join(folder, phone.name));
    const upgraded = temp.reopen({ migrationsFolder: folder });
    expect(upgraded.migrations.applied).toEqual([phone.name]);
    const after = rowsOf(upgraded);
    expect(after["phone_recordings"]).toEqual([]);
    const { phone_recordings: _added, ...kept } = after;
    expect(kept).toEqual(before);
    expect(upgraded.client.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(searchSegments(upgraded, "réunion").map((hit) => hit.episodeId)).toEqual([episodeId]);
    // A stored row needs its run and hash; a tombstone holds neither.
    expect(() =>
      upgraded.client
        .prepare(
          `INSERT INTO phone_recordings (recording_id, device_id, state, received_at_ms)
           VALUES ('r', 'd', 'stored', 0)`,
        )
        .run(),
    ).toThrow(/CHECK/);
    expect(() =>
      upgraded.client
        .prepare(
          `INSERT INTO phone_recordings (recording_id, device_id, state, sha256, received_at_ms, deleted_at_ms)
           VALUES ('r', 'd', 'deleted', 'aa', 0, 1)`,
        )
        .run(),
    ).toThrow(/CHECK/);

    // Restored from the snapshot: the build before opens it as it was, and
    // this build migrates it again to the same schema.
    const restoredDir = mkdtempSync(join(tmpdir(), "sondine-restore-"));
    scratchDirs.push(restoredDir);
    const restored = join(restoredDir, "sondine.db");
    cpSync(snapshot, restored);
    const older = readMigrations(folder).filter((m) => m.name !== phone.name);
    const olderFolder = join(restoredDir, "older");
    for (const migration of older) {
      cpSync(join(folder, migration.name), join(olderFolder, migration.name), { recursive: true });
    }
    const asBefore = openDatabase(restored, { migrationsFolder: olderFolder });
    expect(asBefore.migrations.applied).toEqual([]);
    expect(rowsOf(asBefore)).toEqual(before);
    asBefore.close();
    const again = openDatabase(restored, { migrationsFolder: folder });
    expect(again.migrations.applied).toEqual([phone.name]);
    expect(schemaOf(again)).toEqual(schemaOf(upgraded));
    expect(rowsOf(again)).toEqual(after);
    again.close();
  });

  it("add phone devices, operations and uploads over a snapshot, and restore onto either build", () => {
    const folder = copyMigrations("_phone_sync");
    const sync = readMigrations(folder).find((m) => m.name.endsWith("_phone_sync"));
    if (sync === undefined) throw new Error("no phone sync migration");
    const parked = join(folder, "..", sync.name);
    renameSync(join(folder, sync.name), parked);
    temp = tempDatabase({ migrationsFolder: folder });
    // The build before: a phone recording received by AirDrop, and one deleted.
    importRecording(temp.db, {
      uid: "phone-1",
      fileName: "a.m4a",
      sampleRate: 16_000,
      sampleCount: 32_000,
      startedWallMs: 0,
      archiveRelPath: "archive/imports/phone-1/0001.pcm",
      spoolRelPath: "spool/imports/phone-1/0001.pcm",
      chunks: [{ sampleStart: 0, sampleCount: 32_000, byteOffset: 0, crc32: 7 }],
      nowMs: 1,
      phone: {
        recordingId: "7f9c2b1e-4d3a-4c8e-9b6f-1a2b3c4d5e6f",
        deviceId: "c3d4e5f6-0718-4293-a4b5-c6d7e8f90a1b",
        sha256: "a".repeat(64),
        timeUncertain: false,
      },
    });
    temp.db.client
      .prepare(
        `INSERT INTO phone_recordings (recording_id, device_id, state, received_at_ms, deleted_at_ms)
         VALUES ('8a0d3c2f-5e4b-4d9f-8c70-2b3c4d5e6f70', 'c3d4e5f6-0718-4293-a4b5-c6d7e8f90a1b', 'deleted', 2, 3)`,
      )
      .run();
    const before = rowsOf(temp.db);
    const snapshot = join(temp.dir, "snapshot.db");
    temp.db.client.exec(`VACUUM INTO '${snapshot}'`);

    renameSync(parked, join(folder, sync.name));
    const upgraded = temp.reopen({ migrationsFolder: folder });
    expect(upgraded.migrations.applied).toEqual([sync.name]);
    const after = rowsOf(upgraded);
    const {
      phone_devices: devices,
      phone_operations: operations,
      phone_uploads: uploads,
      ...kept
    } = after;
    expect([devices, operations, uploads]).toEqual([[], [], []]);
    expect(kept).toEqual(before);
    expect(upgraded.client.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    // A credential is a 32-byte hash; an operation needs its phone.
    expect(() =>
      upgraded.client
        .prepare(
          `INSERT INTO phone_devices (device_id, name, credential_hash, paired_at_ms)
           VALUES ('d', 'iPhone', x'00', 0)`,
        )
        .run(),
    ).toThrow(/CHECK/);
    expect(() =>
      upgraded.client
        .prepare(
          `INSERT INTO phone_operations (device_id, operation_id, kind, recording_id, done_at_ms)
           VALUES ('nobody', 'o', 'delete', 'r', 0)`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);

    const restoredDir = mkdtempSync(join(tmpdir(), "sondine-restore-"));
    scratchDirs.push(restoredDir);
    const restored = join(restoredDir, "sondine.db");
    cpSync(snapshot, restored);
    const olderFolder = join(restoredDir, "older");
    for (const migration of readMigrations(folder).filter((m) => m.name !== sync.name)) {
      cpSync(join(folder, migration.name), join(olderFolder, migration.name), { recursive: true });
    }
    const asBefore = openDatabase(restored, { migrationsFolder: olderFolder });
    expect(asBefore.migrations.applied).toEqual([]);
    expect(rowsOf(asBefore)).toEqual(before);
    asBefore.close();
    const again = openDatabase(restored, { migrationsFolder: folder });
    expect(again.migrations.applied).toEqual([sync.name]);
    expect(schemaOf(again)).toEqual(schemaOf(upgraded));
    expect(rowsOf(again)).toEqual(after);
    again.close();
  });

  it("add a phone recording's name and the outbox's names and notes over a snapshot, and restore", () => {
    const folder = copyMigrations("_phone_results");
    const results = readMigrations(folder).find((m) => m.name.endsWith("_phone_results"));
    if (results === undefined) throw new Error("no phone results migration");
    const parked = join(folder, "..", results.name);
    renameSync(join(folder, results.name), parked);
    temp = tempDatabase({ migrationsFolder: folder });
    // The build before: a phone recording held, one deleted, a phone and its deletion.
    importRecording(temp.db, {
      uid: "phone-1",
      fileName: "a.m4a",
      sampleRate: 16_000,
      sampleCount: 32_000,
      startedWallMs: 0,
      archiveRelPath: "archive/imports/phone-1/0001.pcm",
      spoolRelPath: "spool/imports/phone-1/0001.pcm",
      chunks: [{ sampleStart: 0, sampleCount: 32_000, byteOffset: 0, crc32: 7 }],
      nowMs: 1,
      phone: {
        recordingId: "7f9c2b1e-4d3a-4c8e-9b6f-1a2b3c4d5e6f",
        deviceId: "c3d4e5f6-0718-4293-a4b5-c6d7e8f90a1b",
        sha256: "a".repeat(64),
        timeUncertain: false,
      },
    });
    temp.db.client.exec(
      `INSERT INTO phone_recordings (recording_id, device_id, state, received_at_ms, deleted_at_ms)
         VALUES ('8a0d3c2f-5e4b-4d9f-8c70-2b3c4d5e6f70', 'c3d4e5f6-0718-4293-a4b5-c6d7e8f90a1b', 'deleted', 2, 3);
       INSERT INTO phone_devices (device_id, name, credential_hash, paired_at_ms)
         VALUES ('c3d4e5f6-0718-4293-a4b5-c6d7e8f90a1b', 'iPhone', zeroblob(32), 4);
       INSERT INTO phone_operations (device_id, operation_id, kind, recording_id, done_at_ms)
         VALUES ('c3d4e5f6-0718-4293-a4b5-c6d7e8f90a1b', 'o', 'delete', '8a0d3c2f-5e4b-4d9f-8c70-2b3c4d5e6f70', 5);`,
    );
    const before = rowsOf(temp.db);
    const snapshot = join(temp.dir, "snapshot.db");
    temp.db.client.exec(`VACUUM INTO '${snapshot}'`);

    renameSync(parked, join(folder, results.name));
    const upgraded = temp.reopen({ migrationsFolder: folder });
    expect(upgraded.migrations.applied).toEqual([results.name]);
    const after = rowsOf(upgraded);
    // Every row kept; a phone recording gains an empty name.
    const { phone_recordings: recordings, ...kept } = after;
    const { phone_recordings: recordingsBefore, ...keptBefore } = before;
    expect(kept).toEqual(keptBefore);
    expect(recordings).toHaveLength(recordingsBefore?.length ?? -1);
    expect(
      upgraded.client
        .prepare(
          "SELECT recording_id, state, name, name_typed_at_ms FROM phone_recordings ORDER BY 1",
        )
        .all(),
    ).toEqual([
      {
        recording_id: "7f9c2b1e-4d3a-4c8e-9b6f-1a2b3c4d5e6f",
        state: "stored",
        name: null,
        name_typed_at_ms: null,
      },
      {
        recording_id: "8a0d3c2f-5e4b-4d9f-8c70-2b3c4d5e6f70",
        state: "deleted",
        name: null,
        name_typed_at_ms: null,
      },
    ]);
    expect(upgraded.client.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    // A tombstone keeps no name; an operation is a deletion, a name or a note.
    expect(() =>
      upgraded.client
        .prepare(
          "UPDATE phone_recordings SET name = 'x' WHERE recording_id = '8a0d3c2f-5e4b-4d9f-8c70-2b3c4d5e6f70'",
        )
        .run(),
    ).toThrow(/CHECK/);
    upgraded.client
      .prepare(
        `INSERT INTO phone_operations (device_id, operation_id, kind, recording_id, done_at_ms)
         VALUES ('c3d4e5f6-0718-4293-a4b5-c6d7e8f90a1b', 'n', 'note', 'r', 6)`,
      )
      .run();
    expect(() =>
      upgraded.client
        .prepare(
          `INSERT INTO phone_operations (device_id, operation_id, kind, recording_id, done_at_ms)
           VALUES ('c3d4e5f6-0718-4293-a4b5-c6d7e8f90a1b', 'p', 'play', 'r', 6)`,
        )
        .run(),
    ).toThrow(/CHECK/);
    upgraded.client.prepare("DELETE FROM phone_operations WHERE operation_id = 'n'").run();

    const restoredDir = mkdtempSync(join(tmpdir(), "sondine-restore-"));
    scratchDirs.push(restoredDir);
    const restored = join(restoredDir, "sondine.db");
    cpSync(snapshot, restored);
    const olderFolder = join(restoredDir, "older");
    for (const migration of readMigrations(folder).filter((m) => m.name !== results.name)) {
      cpSync(join(folder, migration.name), join(olderFolder, migration.name), { recursive: true });
    }
    const asBefore = openDatabase(restored, { migrationsFolder: olderFolder });
    expect(asBefore.migrations.applied).toEqual([]);
    expect(rowsOf(asBefore)).toEqual(before);
    asBefore.close();
    const again = openDatabase(restored, { migrationsFolder: folder });
    expect(again.migrations.applied).toEqual([results.name]);
    expect(schemaOf(again)).toEqual(schemaOf(upgraded));
    expect(rowsOf(again)).toEqual(rowsOf(upgraded));
    again.close();
  });

  it("add same_moment_links over a snapshot, keep every row, and restore onto either build", () => {
    const folder = copyMigrations("_same_moment_links");
    const links = readMigrations(folder).find((m) => m.name.endsWith("_same_moment_links"));
    if (links === undefined) throw new Error("no same-moment migration");
    const parked = join(folder, "..", links.name);
    renameSync(join(folder, links.name), parked);
    temp = tempDatabase({ migrationsFolder: folder });
    // The build before: a Mac conversation and the phone's recording of it.
    const mac = seedEpisode(temp.db, [[10, 70]]);
    const phone = importRecording(temp.db, {
      uid: "phone-1",
      fileName: "a.m4a",
      sampleRate: 16_000,
      sampleCount: 32_000,
      startedWallMs: 0,
      archiveRelPath: "archive/imports/phone-1/0001.pcm",
      spoolRelPath: "spool/imports/phone-1/0001.pcm",
      chunks: [{ sampleStart: 0, sampleCount: 32_000, byteOffset: 0, crc32: 7 }],
      nowMs: 1,
      phone: {
        recordingId: "7f9c2b1e-4d3a-4c8e-9b6f-1a2b3c4d5e6f",
        deviceId: "c3d4e5f6-0718-4293-a4b5-c6d7e8f90a1b",
        sha256: "a".repeat(64),
        timeUncertain: false,
      },
    });
    const before = rowsOf(temp.db);
    const snapshot = join(temp.dir, "snapshot.db");
    temp.db.client.exec(`VACUUM INTO '${snapshot}'`);

    renameSync(parked, join(folder, links.name));
    const upgraded = temp.reopen({ migrationsFolder: folder });
    expect(upgraded.migrations.applied).toEqual([links.name]);
    const after = rowsOf(upgraded);
    const { same_moment_links: added, ...kept } = after;
    expect(added).toEqual([]);
    expect(kept).toEqual(before);
    expect(upgraded.client.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const insert = (linked: 0 | 1, source: string | null) =>
      upgraded.client
        .prepare(
          `INSERT INTO same_moment_links (phone_episode_id, mac_episode_id, phone_generation,
             mac_generation, method, linked, offset_ms, drift_ppm, anchor_ms, score,
             shared_from_ms, shared_to_ms, journal_source, checked_at_ms)
           VALUES (?, ?, 1, 1, 'envelope-xcorr/1', ?, 0, 0, 0, 0.8, 0, 1, ?, 0)`,
        )
        .run(phone.episodeId, mac.episodeId, linked, source);
    // A link holds its offset, shared time and source; a comparison without one holds none.
    expect(() => insert(1, null)).toThrow(/CHECK/);
    expect(() => insert(0, "mac")).toThrow(/CHECK/);
    insert(1, "mac");
    upgraded.client.prepare("DELETE FROM episodes WHERE id = ?").run(mac.episodeId);
    expect(upgraded.client.prepare("SELECT count(*) AS n FROM same_moment_links").get()).toEqual({
      n: 0,
    });

    const restoredDir = mkdtempSync(join(tmpdir(), "sondine-restore-"));
    scratchDirs.push(restoredDir);
    const restored = join(restoredDir, "sondine.db");
    cpSync(snapshot, restored);
    const olderFolder = join(restoredDir, "older");
    for (const migration of readMigrations(folder).filter((m) => m.name !== links.name)) {
      cpSync(join(folder, migration.name), join(olderFolder, migration.name), { recursive: true });
    }
    const asBefore = openDatabase(restored, { migrationsFolder: olderFolder });
    expect(asBefore.migrations.applied).toEqual([]);
    expect(rowsOf(asBefore)).toEqual(before);
    asBefore.close();
    const again = openDatabase(restored, { migrationsFolder: folder });
    expect(again.migrations.applied).toEqual([links.name]);
    expect(schemaOf(again)).toEqual(schemaOf(upgraded));
    expect(rowsOf(again)).toEqual(after);
    again.close();
  });

  it("add a phone's last path over a snapshot, keep its operations, and restore onto either build", () => {
    const folder = copyMigrations("_phone_last_via");
    const lastVia = readMigrations(folder).find((m) => m.name.endsWith("_phone_last_via"));
    if (lastVia === undefined) throw new Error("no phone last-via migration");
    const parked = join(folder, "..", lastVia.name);
    renameSync(join(folder, lastVia.name), parked);
    temp = tempDatabase({ migrationsFolder: folder });
    // The build before: two phones, one revoked, and an operation of each (the table is rebuilt
    // under them: its cascade must not run).
    temp.db.client.exec(
      `INSERT INTO phone_devices (device_id, name, credential_hash, paired_at_ms, last_contact_at_ms, reads)
         VALUES ('c3d4e5f6-0718-4293-a4b5-c6d7e8f90a1b', 'iPhone', zeroblob(32), 4, 9, 3);
       INSERT INTO phone_devices (device_id, name, credential_hash, paired_at_ms, revoked_at_ms)
         VALUES ('d4e5f607-1829-43a4-b5c6-d7e8f90a1b2c', 'Ancien', randomblob(32), 1, 2);
       INSERT INTO phone_operations (device_id, operation_id, kind, recording_id, done_at_ms)
         VALUES ('c3d4e5f6-0718-4293-a4b5-c6d7e8f90a1b', 'o', 'delete', 'r', 5),
                ('d4e5f607-1829-43a4-b5c6-d7e8f90a1b2c', 'p', 'note', 'r', 6);`,
    );
    const before = rowsOf(temp.db);
    const snapshot = join(temp.dir, "snapshot.db");
    temp.db.client.exec(`VACUUM INTO '${snapshot}'`);

    renameSync(parked, join(folder, lastVia.name));
    const upgraded = temp.reopen({ migrationsFolder: folder });
    expect(upgraded.migrations.applied).toEqual([lastVia.name]);
    const after = rowsOf(upgraded);
    // Every row kept, the operations included; a phone gains no path until its next request.
    const { phone_devices: devices, ...kept } = after;
    const { phone_devices: devicesBefore, ...keptBefore } = before;
    expect(kept).toEqual(keptBefore);
    expect(devices).toHaveLength(devicesBefore?.length ?? -1);
    expect(
      upgraded.client
        .prepare(
          "SELECT device_id, last_contact_at_ms, last_via, reads FROM phone_devices ORDER BY 1",
        )
        .all(),
    ).toEqual([
      {
        device_id: "c3d4e5f6-0718-4293-a4b5-c6d7e8f90a1b",
        last_contact_at_ms: 9,
        last_via: null,
        reads: 3,
      },
      {
        device_id: "d4e5f607-1829-43a4-b5c6-d7e8f90a1b2c",
        last_contact_at_ms: null,
        last_via: null,
        reads: 0,
      },
    ]);
    expect(upgraded.client.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    // A path is the relay's: at home, through Tailscale, or loopback.
    const setVia = (via: string) =>
      upgraded.client
        .prepare(
          "UPDATE phone_devices SET last_via = ? WHERE device_id = 'c3d4e5f6-0718-4293-a4b5-c6d7e8f90a1b'",
        )
        .run(via);
    setVia("tailnet");
    expect(() => setVia("wan")).toThrow(/CHECK/);
    setVia("lan");
    upgraded.client.prepare("UPDATE phone_devices SET last_via = NULL").run();

    const restoredDir = mkdtempSync(join(tmpdir(), "sondine-restore-"));
    scratchDirs.push(restoredDir);
    const restored = join(restoredDir, "sondine.db");
    cpSync(snapshot, restored);
    const olderFolder = join(restoredDir, "older");
    for (const migration of readMigrations(folder).filter((m) => m.name !== lastVia.name)) {
      cpSync(join(folder, migration.name), join(olderFolder, migration.name), { recursive: true });
    }
    const asBefore = openDatabase(restored, { migrationsFolder: olderFolder });
    expect(asBefore.migrations.applied).toEqual([]);
    expect(rowsOf(asBefore)).toEqual(before);
    asBefore.close();
    const again = openDatabase(restored, { migrationsFolder: folder });
    expect(again.migrations.applied).toEqual([lastVia.name]);
    expect(schemaOf(again)).toEqual(schemaOf(upgraded));
    expect(rowsOf(again)).toEqual(rowsOf(upgraded));
    again.close();
  });

  it("add self_echoes over a snapshot, keep every row, and restore onto either build", () => {
    const folder = copyMigrations("_self_echoes");
    const echoes = readMigrations(folder).find((m) => m.name.endsWith("_self_echoes"));
    if (echoes === undefined) throw new Error("no self-echo migration");
    const parked = join(folder, "..", echoes.name);
    renameSync(join(folder, echoes.name), parked);
    temp = tempDatabase({ migrationsFolder: folder });
    // The build before: a conversation and a playback on the speakers.
    const mac = seedEpisode(temp.db, [[10, 70]]);
    temp.db.client
      .prepare(
        `INSERT INTO self_playbacks (started_wall_ms, ended_wall_ms, route, updated_at_ms)
         VALUES (0, 1, 'speakers', 1)`,
      )
      .run();
    const before = rowsOf(temp.db);
    const snapshot = join(temp.dir, "snapshot.db");
    temp.db.client.exec(`VACUUM INTO '${snapshot}'`);

    renameSync(parked, join(folder, echoes.name));
    const upgraded = temp.reopen({ migrationsFolder: folder });
    expect(upgraded.migrations.applied).toEqual([echoes.name]);
    const after = rowsOf(upgraded);
    const { self_echoes: added, ...kept } = after;
    expect(added).toEqual([]);
    expect(kept).toEqual(before);
    expect(upgraded.client.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const insert = (verdict: string, spans: string) =>
      upgraded.client
        .prepare(
          `INSERT INTO self_echoes (speech_region_id, method, verdict, voiced_ms, covered_ms,
             echo_ms, near_end_ms, lag_ms, correlation, spans, judged_at_ms)
           VALUES (?, 'envelope-echo/1', ?, 1, 1, 1, 0, 120, 0.8, ?, 0)`,
        )
        .run(mac.regionIds[0] ?? 0, verdict, spans);
    expect(() => insert("near-end", "[]")).toThrow(/CHECK/);
    expect(() => insert("echo", "{}")).toThrow(/CHECK/);
    insert("echo", "[]");
    upgraded.client.prepare("DELETE FROM episode_regions").run();
    upgraded.client.prepare("DELETE FROM speech_regions").run();
    expect(upgraded.client.prepare("SELECT count(*) AS n FROM self_echoes").get()).toEqual({
      n: 0,
    });

    const restoredDir = mkdtempSync(join(tmpdir(), "sondine-restore-"));
    scratchDirs.push(restoredDir);
    const restored = join(restoredDir, "sondine.db");
    cpSync(snapshot, restored);
    const olderFolder = join(restoredDir, "older");
    for (const migration of readMigrations(folder).filter((m) => m.name !== echoes.name)) {
      cpSync(join(folder, migration.name), join(olderFolder, migration.name), { recursive: true });
    }
    const asBefore = openDatabase(restored, { migrationsFolder: olderFolder });
    expect(asBefore.migrations.applied).toEqual([]);
    expect(rowsOf(asBefore)).toEqual(before);
    asBefore.close();
    const again = openDatabase(restored, { migrationsFolder: folder });
    expect(again.migrations.applied).toEqual([echoes.name]);
    expect(schemaOf(again)).toEqual(schemaOf(upgraded));
    expect(rowsOf(again)).toEqual(after);
    again.close();
  });

  it("roll back a failing migration and keep foreign keys on", () => {
    const folder = copyMigrations();
    temp = tempDatabase({ migrationsFolder: folder });
    const broken = join(folder, "29990101000000_broken");
    mkdirSync(broken);
    writeFileSync(
      join(broken, "migration.sql"),
      "CREATE TABLE `half_done` (`id` integer PRIMARY KEY);\n--> statement-breakpoint\nINSERT INTO `missing_table` VALUES (1);\n",
    );
    expect(() => temp?.reopen({ migrationsFolder: folder })).toThrow(
      /29990101000000_broken failed/,
    );
    const tables = temp.db.client
      .prepare("SELECT name FROM sqlite_schema WHERE name = 'half_done'")
      .all();
    expect(tables).toEqual([]);
    expect(
      temp.db.client.prepare(`SELECT count(*) AS n FROM ${migrationsTable}`).get()?.["n"],
    ).toBe(readMigrations(bundledMigrationsFolder).length);
    expect(temp.db.client.prepare("PRAGMA foreign_keys").get()?.["foreign_keys"]).toBe(1);
  });
});

describe("openDatabase", () => {
  it("rejects an async transaction callback and rolls it back", () => {
    temp = tempDatabase();
    const db = temp.db;
    expect(() =>
      transaction(db, async () => {
        db.client.exec("INSERT INTO settings (key, value, updated_at_ms) VALUES ('k', '1', 0)");
      }),
    ).toThrow(/synchronous/);
    expect(db.client.isTransaction).toBe(false);
    expect(db.client.prepare("SELECT count(*) AS n FROM settings").get()?.["n"]).toBe(0);
  });

  it("applies the connection pragmas", () => {
    temp = tempDatabase();
    const read = (name: string) => {
      const row = temp?.db.client.prepare(`PRAGMA ${name}`).get();
      return row === undefined ? undefined : Object.values(row)[0];
    };
    const expected: Record<(typeof connectionPragmas)[number][0], unknown> = {
      journal_mode: "wal",
      synchronous: 1,
      foreign_keys: 1,
      busy_timeout: 2000,
      secure_delete: 1,
      wal_autocheckpoint: 1000,
      journal_size_limit: 67108864,
      temp_store: 2,
      cache_size: -8192,
    };
    for (const [name, value] of Object.entries(expected)) expect(read(name), name).toBe(value);
  });

  it("enforces foreign keys and CHECK enums", () => {
    temp = tempDatabase();
    const client = temp.db.client;
    expect(() =>
      client
        .prepare(
          "INSERT INTO spool_files (track_run_id, seq, rel_path, sample_start, created_wall_ms) VALUES (999, 0, 'x', 0, 0)",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      client
        .prepare(
          "INSERT INTO episodes (state, started_at_ms, grouping_version, classifier_version, created_at_ms, updated_at_ms) VALUES ('archived', 0, 'g', 'c', 0, 0)",
        )
        .run(),
    ).toThrow(/CHECK constraint failed: episodes_state_check/);
    expect(() =>
      client
        .prepare(
          "INSERT INTO deleted_ranges (scope, wall_start_ms, wall_end_ms, origin, created_at_ms) VALUES ('track_run', 0, 10, 'app', 0)",
        )
        .run(),
    ).toThrow(/deleted_ranges_shape_check/);
  });
});

/**
 * A copy of the bundled migrations; with `upTo`, only those up to the one
 * whose name ends with it, so a test of one migration never runs the ones
 * written after it.
 */
function copyMigrations(upTo?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sondine-migrations-"));
  scratchDirs.push(dir);
  const folder = join(dir, "drizzle");
  cpSync(bundledMigrationsFolder, folder, { recursive: true });
  if (upTo !== undefined) {
    const last = readMigrations(folder).find((m) => m.name.endsWith(upTo));
    if (last === undefined) throw new Error(`no migration ${upTo}`);
    for (const later of readMigrations(folder).filter((m) => m.name > last.name)) {
      rmSync(join(folder, later.name), { recursive: true });
    }
  }
  return folder;
}
