import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bundledMigrationsFolder,
  closeSpeechRegion,
  closeSpoolFile,
  openDatabase,
  openSpeechRegion,
  planArchive,
  readMigrations,
  recordArchive,
  recordSpoolCommit,
  recordSpoolFile,
  restoredNote,
  upsertTrackRun,
  type OpenedDatabase,
} from "@sondine/db";
import { afterEach, describe, expect, it } from "vitest";
import { DATA_LAYOUT } from "../../shared/data-layout";
import { applyStagedRestore, RestoreSwapError } from "../../main/restore-swap";
import {
  BackupStale,
  cleanInterruptedExport,
  PARTIAL_RECORD,
  writeExport,
  zeroOutside,
} from "./backup-export";
import { RestoreRefused, stageRestore } from "./backup-restore";
import { WrongPassphrase } from "./backup-crypto";

// Invented data only (AGENTS.md): a run whose one spool file was archived
// around a speech region, a second file still in the spool, a person, a
// context file, the phone identity's files, settings. Exported, staged into
// a fresh data directory, swapped in, and read back.

const t0 = Date.UTC(2026, 10, 20, 9);
const BLOCK = 8_000;
const BLOCKS = 20;
const PASSPHRASE = "correct horse battery staple";
const migrations = readMigrations(bundledMigrationsFolder);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `sondine-${label}-`));
  dirs.push(dir);
  return dir;
}

/** Invented, recognisable bytes: never zero, so a zeroed range shows. */
const pattern = (length: number, seed: number) =>
  Buffer.from(Array.from({ length }, (_, index) => 1 + ((index * 7 + seed) % 250)));

interface Seeded {
  readonly db: OpenedDatabase;
  readonly archiveRelPath: string;
  readonly archiveBytes: Buffer;
  readonly archivedRange: readonly [number, number];
  readonly contextSha: string;
}

function seed(dataDir: string): Seeded {
  const db = openDatabase(join(dataDir, DATA_LAYOUT.database));
  const trackRunId = upsertTrackRun(db, {
    uid: "11111111-2222-4333-8444-555555555555",
    trackKey: "input:InventedMic",
    sourceKind: "input",
    startedWallMs: t0,
    nowMs: t0,
  }).trackRunId;
  const file = (seq: number) => {
    const { spoolFileId } = recordSpoolFile(db, {
      trackRunId,
      seq,
      relPath: `spool/input-Invented/run/${String(seq).padStart(4, "0")}.pcm`,
      sampleStart: seq * BLOCK * BLOCKS,
      createdWallMs: t0 + seq * 10_000,
    });
    for (let block = 0; block < BLOCKS; block++) {
      recordSpoolCommit(db, {
        spoolFileId,
        byteOffset: block * BLOCK * 2,
        byteLength: BLOCK * 2,
        sampleStart: seq * BLOCK * BLOCKS + block * BLOCK,
        wallMs: t0 + seq * 10_000 + block * 500,
        crc32: 1_000 + block,
      });
    }
    return spoolFileId;
  };
  const archived = file(0);
  closeSpoolFile(db, { spoolFileId: archived, closedWallMs: t0 + 10_000 });
  openSpeechRegion(db, {
    trackRunId,
    sampleStart: 4 * 16_000,
    wallStartMs: t0 + 4_000,
    vadVersion: "v",
  });
  closeSpeechRegion(db, {
    trackRunId,
    sampleStart: 4 * 16_000,
    sampleEnd: 5 * 16_000,
    wallEndMs: t0 + 5_000,
    endReason: "silence",
  });
  const plan = planArchive(db, archived);
  if (plan === undefined) throw new Error("no plan");
  const archiveRelPath = "archive/input-Invented/run/0000.pcm";
  let offset = 0;
  const placements = plan.selected.map((chunk) => {
    const placement = { chunkId: chunk.id, crc32: chunk.crc32, archiveByteOffset: offset };
    offset += chunk.byteLength;
    return placement;
  });
  recordArchive(db, { spoolFileId: archived, archiveRelPath, placements });
  // The archive file is longer than its chunks: the tail stands for bytes a
  // scrub or an expiry left; they must never leave.
  const archiveBytes = pattern(offset + 4_096, 3);
  mkdirSync(join(dataDir, "archive/input-Invented/run"), { recursive: true });
  writeFileSync(join(dataDir, archiveRelPath), archiveBytes);
  // A second file, still in the spool: its audio is not archived yet.
  file(1);

  db.statement(
    "INSERT INTO people (name, is_self, created_at_ms, updated_at_ms) VALUES (?, 0, ?, ?)",
  ).run("Personne inventée", t0, t0);
  const contextBytes = Buffer.from("un fichier inventé");
  const contextSha = createHash("sha256").update(contextBytes).digest("hex");
  db.statement(
    `INSERT INTO context_items (kind, track_run_id, anchor_sample, title, file_sha256, file_bytes, media_type, origin, created_at_ms, updated_at_ms)
     VALUES ('file', ?, 0, 'inventé.txt', ?, ?, 'text/plain', 'app', ?, ?)`,
  ).run(trackRunId, contextSha, contextBytes.length, t0, t0);
  mkdirSync(join(dataDir, DATA_LAYOUT.contextDir), { recursive: true });
  writeFileSync(join(dataDir, DATA_LAYOUT.contextDir, contextSha), contextBytes);
  mkdirSync(join(dataDir, DATA_LAYOUT.lanDir), { recursive: true });
  writeFileSync(join(dataDir, DATA_LAYOUT.lanDir, "cert.pem"), "invented certificate");

  const put = db.statement("INSERT INTO settings (key, value, updated_at_ms) VALUES (?, ?, ?)");
  put.run("capture.paused", JSON.stringify({ microphone: false, systemAudio: false }), t0);
  put.run("updates.installing", JSON.stringify({ version: "9.9.9" }), t0);
  put.run("compute", JSON.stringify({ destination: "device", own: null, beta: null }), t0);
  return { db, archiveRelPath, archiveBytes, archivedRange: [0, offset], contextSha };
}

async function exportTo(seeded: Seeded, dataDir: string, path: string, passphrase: string | null) {
  return writeExport({
    db: seeded.db,
    dataDir,
    path,
    passphrase,
    includeAudio: true,
    prefs: { "sondine.locale": "fr" },
    appVersion: "0.11.0",
    macName: "Mac inventé",
    models: ["parakeet-invented"],
    nowMs: t0 + 60_000,
    stillCurrent: () => true,
    freeBytes: () => 1e12,
  });
}

describe("a backup's round trip", () => {
  it("brings everything back on a fresh data directory", async () => {
    const source = tempDir("source");
    const seeded = seed(source);
    const path = join(tempDir("out"), "Sondine.sondine");
    const { bytes } = await exportTo(seeded, source, path, PASSPHRASE);
    seeded.db.close();
    expect(bytes).toBeGreaterThan(seeded.archivedRange[1]);
    // Nothing of the work stays behind.
    expect(readdirSync(join(source, DATA_LAYOUT.backupWorkDir))).toEqual([]);
    expect(existsSync(`${path}.partial`)).toBe(false);

    const target = tempDir("target");
    await expect(
      stageRestore({
        path,
        passphrase: "not the passphrase",
        dataDir: target,
        migrations,
        nowMs: t0,
      }),
    ).rejects.toBeInstanceOf(WrongPassphrase);
    expect(existsSync(join(target, DATA_LAYOUT.restoreStagingDir))).toBe(false);

    const restoredAt = t0 + 86_400_000;
    const staged = await stageRestore({
      path,
      passphrase: PASSPHRASE,
      dataDir: target,
      migrations,
      nowMs: restoredAt,
      freeBytes: () => 1e12,
    });
    expect(staged.summary.counts.people).toBe(1);
    expect(applyStagedRestore(target)).toMatchObject({ kind: "swapped" });
    expect(existsSync(join(target, DATA_LAYOUT.restoreStagingDir))).toBe(false);

    const db = openDatabase(join(target, DATA_LAYOUT.database));
    try {
      const value = (key: string) =>
        db.statement("SELECT value FROM settings WHERE key = ?").get(key)?.["value"];
      // Listening comes back paused; a passing setting does not come back.
      expect(JSON.parse(String(value("capture.paused")))).toEqual({
        microphone: true,
        systemAudio: true,
      });
      expect(value("updates.installing")).toBeUndefined();
      expect(value("compute")).toBeDefined();
      expect(restoredNote(db)).toEqual({
        restoredAtMs: restoredAt,
        createdAtMs: t0 + 60_000,
        models: ["parakeet-invented"],
        prefs: { "sondine.locale": "fr" },
      });
      const states = db
        .statement("SELECT audio_state AS state, count(*) AS n FROM chunks GROUP BY 1 ORDER BY 1")
        .all();
      // The spool's audio, not archived yet, came back as expired; the rest as it was.
      expect(states).toEqual([
        { state: "archived", n: 7 },
        { state: "expired", n: 33 },
      ]);
    } finally {
      db.close();
    }
    const archive = readFileSync(join(target, seeded.archiveRelPath));
    const [, end] = seeded.archivedRange;
    expect(archive.length).toBe(seeded.archiveBytes.length);
    expect(archive.subarray(0, end).equals(seeded.archiveBytes.subarray(0, end))).toBe(true);
    expect(archive.subarray(end).every((byte) => byte === 0)).toBe(true);
    expect(readFileSync(join(target, DATA_LAYOUT.contextDir, seeded.contextSha), "utf8")).toBe(
      "un fichier inventé",
    );
    expect(readFileSync(join(target, DATA_LAYOUT.lanDir, "cert.pem"), "utf8")).toBe(
      "invented certificate",
    );
  });

  it("keeps the data it replaces aside", async () => {
    const source = tempDir("source");
    const seeded = seed(source);
    const path = join(tempDir("out"), "Sondine.sondine");
    await exportTo(seeded, source, path, null);
    seeded.db.close();

    const target = tempDir("target");
    const before = openDatabase(join(target, DATA_LAYOUT.database));
    before.close();
    mkdirSync(join(target, DATA_LAYOUT.spoolDir), { recursive: true });
    writeFileSync(join(target, DATA_LAYOUT.spoolDir, "old.jsonl"), "old");
    await stageRestore({
      path,
      passphrase: null,
      dataDir: target,
      migrations,
      nowMs: t0,
      freeBytes: () => 1e12,
    });
    const swap = applyStagedRestore(target);
    if (swap.kind !== "swapped") throw new Error("not swapped");
    const aside = join(target, DATA_LAYOUT.beforeRestoreDir, swap.stamp);
    expect(existsSync(join(aside, DATA_LAYOUT.database))).toBe(true);
    expect(readFileSync(join(aside, DATA_LAYOUT.spoolDir, "old.jsonl"), "utf8")).toBe("old");
    expect(existsSync(join(target, DATA_LAYOUT.spoolDir))).toBe(false);
  });

  it("finishes a swap a crash cut in the middle", async () => {
    const source = tempDir("source");
    const seeded = seed(source);
    const path = join(tempDir("out"), "Sondine.sondine");
    await exportTo(seeded, source, path, null);
    seeded.db.close();
    const target = tempDir("target");
    writeFileSync(join(target, DATA_LAYOUT.database), "old database");
    await stageRestore({
      path,
      passphrase: null,
      dataDir: target,
      migrations,
      nowMs: t0,
      freeBytes: () => 1e12,
    });
    // The crash: the old database was moved aside, the marker said « out », nothing moved in.
    const marker = JSON.parse(readFileSync(join(target, DATA_LAYOUT.restoreMarker), "utf8")) as {
      stamp: string;
      items: string[];
    };
    const aside = join(target, DATA_LAYOUT.beforeRestoreDir, marker.stamp);
    mkdirSync(aside, { recursive: true });
    renameSync(join(target, DATA_LAYOUT.database), join(aside, DATA_LAYOUT.database));
    writeFileSync(
      join(target, DATA_LAYOUT.restoreMarker),
      JSON.stringify({ ...marker, phase: "out" }),
    );
    expect(applyStagedRestore(target)).toMatchObject({ kind: "swapped" });
    expect(readFileSync(join(aside, DATA_LAYOUT.database), "utf8")).toBe("old database");
    const db = openDatabase(join(target, DATA_LAYOUT.database));
    expect(restoredNote(db)).not.toBeNull();
    db.close();
  });

  /** A staged restore over a data folder holding an « old database ». */
  async function stagedOver(): Promise<{ target: string; marker: Record<string, unknown> }> {
    const source = tempDir("source");
    const seeded = seed(source);
    const path = join(tempDir("out"), "Sondine.sondine");
    await exportTo(seeded, source, path, null);
    seeded.db.close();
    const target = tempDir("target");
    writeFileSync(join(target, DATA_LAYOUT.database), "old database");
    await stageRestore({
      path,
      passphrase: null,
      dataDir: target,
      migrations,
      nowMs: t0,
      freeBytes: () => 1e12,
    });
    const marker = JSON.parse(
      readFileSync(join(target, DATA_LAYOUT.restoreMarker), "utf8"),
    ) as Record<string, unknown>;
    return { target, marker };
  }

  it("stops, moving nothing more, when the data it would replace was not set aside", async () => {
    const { target, marker } = await stagedOver();
    // « in » while the old database is still in place: replacing it would lose it.
    writeFileSync(
      join(target, DATA_LAYOUT.restoreMarker),
      JSON.stringify({ ...marker, phase: "in" }),
    );
    expect(() => applyStagedRestore(target)).toThrow(RestoreSwapError);
    expect(readFileSync(join(target, DATA_LAYOUT.database), "utf8")).toBe("old database");
    expect(existsSync(join(target, DATA_LAYOUT.restoreStagingDir, DATA_LAYOUT.database))).toBe(
      true,
    );
  });

  it("never replaces what an earlier attempt set aside", async () => {
    const { target, marker } = await stagedOver();
    const aside = join(target, DATA_LAYOUT.beforeRestoreDir, String(marker["stamp"]));
    mkdirSync(aside, { recursive: true });
    writeFileSync(join(aside, DATA_LAYOUT.database), "set aside before");
    expect(() => applyStagedRestore(target)).toThrow(RestoreSwapError);
    expect(readFileSync(join(aside, DATA_LAYOUT.database), "utf8")).toBe("set aside before");
    expect(readFileSync(join(target, DATA_LAYOUT.database), "utf8")).toBe("old database");
  });

  it("keeps everything as it is when the marker is unreadable", async () => {
    const { target } = await stagedOver();
    writeFileSync(join(target, DATA_LAYOUT.restoreMarker), "{ not json");
    expect(() => applyStagedRestore(target)).toThrow(RestoreSwapError);
    expect(existsSync(join(target, DATA_LAYOUT.restoreStagingDir, DATA_LAYOUT.database))).toBe(
      true,
    );
    expect(readFileSync(join(target, DATA_LAYOUT.database), "utf8")).toBe("old database");
  });

  it("lets a late cancel win: no marker, no staging", async () => {
    const source = tempDir("source");
    const seeded = seed(source);
    const path = join(tempDir("out"), "Sondine.sondine");
    await exportTo(seeded, source, path, null);
    seeded.db.close();
    const target = tempDir("target");
    const abort = new AbortController();
    await expect(
      stageRestore({
        path,
        passphrase: null,
        dataDir: target,
        migrations,
        nowMs: t0,
        freeBytes: () => 1e12,
        signal: abort.signal,
        // Cancelled as the last frame is read.
        onProgress: (done, total) => (done === total ? abort.abort() : undefined),
      }),
    ).rejects.toThrow();
    expect(existsSync(join(target, DATA_LAYOUT.restoreStagingDir))).toBe(false);
  });

  it("refuses bytes appended after the last frame", async () => {
    const source = tempDir("source");
    const seeded = seed(source);
    const path = join(tempDir("out"), "Sondine.sondine");
    await exportTo(seeded, source, path, PASSPHRASE);
    seeded.db.close();
    appendFileSync(path, "trailing");
    await expect(
      stageRestore({
        path,
        passphrase: PASSPHRASE,
        dataDir: tempDir("target"),
        migrations,
        nowMs: t0,
        freeBytes: () => 1e12,
      }),
    ).rejects.toMatchObject({ reason: "damaged" });
  });

  it("removes at start the partial file of an export core did not finish", () => {
    const data = tempDir("data");
    const partial = join(tempDir("out"), "Sondine.sondine.partial");
    const away = join(data, "unplugged-disk", "Old.sondine.partial");
    writeFileSync(partial, "half a backup");
    mkdirSync(join(data, DATA_LAYOUT.backupWorkDir), { recursive: true });
    writeFileSync(join(data, PARTIAL_RECORD), JSON.stringify([partial, away]));
    cleanInterruptedExport(data);
    expect(existsSync(partial)).toBe(false);
    expect(existsSync(join(data, DATA_LAYOUT.backupWorkDir))).toBe(false);
    // A volume that is not there: its file stays listed, for the next start.
    expect(JSON.parse(readFileSync(join(data, PARTIAL_RECORD), "utf8"))).toEqual([away]);
    mkdirSync(join(data, "unplugged-disk"));
    writeFileSync(away, "half");
    cleanInterruptedExport(data);
    expect(existsSync(away)).toBe(false);
    expect(existsSync(join(data, PARTIAL_RECORD))).toBe(false);
  });

  it("keeps the staged data its marker does not list", async () => {
    const { target, marker } = await stagedOver();
    writeFileSync(
      join(target, DATA_LAYOUT.restoreMarker),
      JSON.stringify({ ...marker, items: [DATA_LAYOUT.database] }),
    );
    expect(() => applyStagedRestore(target)).toThrow(RestoreSwapError);
    expect(existsSync(join(target, DATA_LAYOUT.restoreStagingDir, DATA_LAYOUT.archiveDir))).toBe(
      true,
    );
    expect(readFileSync(join(target, DATA_LAYOUT.database), "utf8")).toBe("old database");
  });

  it("discards a staging no marker vouches for", () => {
    const target = tempDir("target");
    mkdirSync(join(target, DATA_LAYOUT.restoreStagingDir));
    writeFileSync(join(target, DATA_LAYOUT.restoreStagingDir, DATA_LAYOUT.database), "half");
    writeFileSync(join(target, DATA_LAYOUT.database), "current");
    expect(applyStagedRestore(target)).toEqual({ kind: "discarded" });
    expect(readFileSync(join(target, DATA_LAYOUT.database), "utf8")).toBe("current");
  });

  it("refuses a backup from a newer Sondine, before writing anything", async () => {
    const source = tempDir("source");
    const seeded = seed(source);
    const path = join(tempDir("out"), "Sondine.sondine");
    await exportTo(seeded, source, path, null);
    seeded.db.close();
    const target = tempDir("target");
    await expect(
      stageRestore({
        path,
        passphrase: null,
        dataDir: target,
        migrations: migrations.slice(0, -1),
        nowMs: t0,
        freeBytes: () => 1e12,
      }),
    ).rejects.toMatchObject({ reason: "newer" });
    expect(existsSync(join(target, DATA_LAYOUT.restoreStagingDir))).toBe(false);
  });

  it("refuses a restore without the room for it", async () => {
    const source = tempDir("source");
    const seeded = seed(source);
    const path = join(tempDir("out"), "Sondine.sondine");
    await exportTo(seeded, source, path, null);
    seeded.db.close();
    await expect(
      stageRestore({
        path,
        passphrase: null,
        dataDir: tempDir("target"),
        migrations,
        nowMs: t0,
        freeBytes: () => 10,
      }),
    ).rejects.toBeInstanceOf(RestoreRefused);
  });

  it("throws the backup away when something is deleted meanwhile", async () => {
    const source = tempDir("source");
    const seeded = seed(source);
    const path = join(tempDir("out"), "Sondine.sondine");
    let checks = 0;
    await expect(
      writeExport({
        db: seeded.db,
        dataDir: source,
        path,
        passphrase: null,
        includeAudio: true,
        prefs: {},
        appVersion: "0.11.0",
        macName: "Mac inventé",
        models: [],
        nowMs: t0,
        // A deletion lands once the copy is taken, while the files are written.
        stillCurrent: () => (checks += 1) < 3,
        freeBytes: () => 1e12,
      }),
    ).rejects.toBeInstanceOf(BackupStale);
    seeded.db.close();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.partial`)).toBe(false);
  });

  it("leaves the backup it would replace when a deletion comes at the end", async () => {
    const source = tempDir("source");
    const seeded = seed(source);
    const path = join(tempDir("out"), "Sondine.sondine");
    writeFileSync(path, "the previous backup");
    let checks = 0;
    let total = 0;
    // Count the checks of a complete export, then fail only the last one.
    await writeExport({
      db: seeded.db,
      dataDir: source,
      path: join(tempDir("out"), "count.sondine"),
      passphrase: null,
      includeAudio: true,
      prefs: {},
      appVersion: "0.11.0",
      macName: "Mac inventé",
      models: [],
      nowMs: t0,
      stillCurrent: () => (total += 1) > 0,
      freeBytes: () => 1e12,
    });
    await expect(
      writeExport({
        db: seeded.db,
        dataDir: source,
        path,
        passphrase: null,
        includeAudio: true,
        prefs: {},
        appVersion: "0.11.0",
        macName: "Mac inventé",
        models: [],
        nowMs: t0,
        stillCurrent: () => (checks += 1) < total,
        freeBytes: () => 1e12,
      }),
    ).rejects.toBeInstanceOf(BackupStale);
    seeded.db.close();
    expect(readFileSync(path, "utf8")).toBe("the previous backup");
  });

  it("refuses a volume without room, before writing", async () => {
    const source = tempDir("source");
    const seeded = seed(source);
    const path = join(tempDir("out"), "Sondine.sondine");
    await expect(
      writeExport({
        db: seeded.db,
        dataDir: source,
        path,
        passphrase: null,
        includeAudio: false,
        prefs: {},
        appVersion: "0.11.0",
        macName: "Mac inventé",
        models: [],
        nowMs: t0,
        stillCurrent: () => true,
        freeBytes: () => 1_000,
      }),
    ).rejects.toMatchObject({ name: "BackupNoSpace" });
    seeded.db.close();
    expect(existsSync(path)).toBe(false);
  });
});

describe("zeroOutside", () => {
  it("keeps only the bytes of the ranges, across buffer edges", () => {
    const buffer = Buffer.alloc(10, 9);
    zeroOutside(buffer, 100, [
      [95, 102],
      [105, 107],
      [109, 200],
    ]);
    expect([...buffer]).toEqual([9, 9, 0, 0, 0, 9, 9, 0, 0, 9]);
    const none = Buffer.alloc(4, 9);
    zeroOutside(none, 0, []);
    expect([...none]).toEqual([0, 0, 0, 0]);
  });
});
