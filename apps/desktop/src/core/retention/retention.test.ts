import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  closeSpeechRegion,
  deleteEpisode,
  episodeRegions,
  episodes,
  msToSamples,
  openDatabase,
  openSpeechRegion,
  speechRolls,
  type OpenedDatabase,
} from "@sondine/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { layoutOf, RATE, SpoolFixture, T0, type FixtureRun } from "../../../test/spool-fixture";
import { migrationsDir, tempDataDir, type TempDataDir } from "../../../test/support";
import { readTrackAudio } from "../audio/read-track-audio";
import type { ReconciliationState } from "../capture/capture-importer";
import { recoverRetention, scrubChunks, type ArchiveStep } from "./archiver";
import { runRetentionPass, retentionPolicy, type RetentionPolicy } from "./pass";

// Retention never removes an unarchived speech chunk (ADR 016). Blocks are
// 0.25 s and files 10 s here, so the rolls (1.5 s and 0.8 s) span several blocks.

const BLOCK = 4_000;
const FILE = "B".repeat(40);
const DAY_LATER = T0 + 2 * 24 * 60 * 60 * 1_000;
const PRE = msToSamples(speechRolls.preRollMs, RATE);
const POST = msToSamples(speechRolls.postRollMs, RATE);
const policy: RetentionPolicy = { ...retentionPolicy, regionRecordHorizonMs: 5_000 };

const vouched = (...live: FixtureRun[]): ReconciliationState => ({
  reconciled: true,
  liveRuns: new Set(live.map((run) => run.uid)),
  problemRuns: new Set(),
});

describe("spool retention", () => {
  let data: TempDataDir;
  let db: OpenedDatabase;
  let spool: SpoolFixture;

  beforeEach(() => {
    data = tempDataDir();
    db = openDatabase(join(data.dir, "sondine.db"), { migrationsFolder: migrationsDir });
    spool = new SpoolFixture(db, data.dir, BLOCK);
  });
  afterEach(() => {
    db.close();
    data.cleanup();
  });

  const layout = () => layoutOf(data.dir);
  const pass = (
    reconciliation: ReconciliationState,
    options: {
      nowMs?: number;
      policy?: RetentionPolicy;
      afterStep?: (step: ArchiveStep) => void;
    } = {},
  ) =>
    runRetentionPass(db, layout(), {
      nowMs: options.nowMs ?? DAY_LATER,
      reconciliation: () => reconciliation,
      policy: options.policy ?? policy,
      ...(options.afterStep === undefined ? {} : { afterStep: options.afterStep }),
    });

  const states = (fileId: number) =>
    db
      .statement(
        "SELECT audio_state AS state FROM chunks WHERE spool_file_id = ? ORDER BY byte_offset",
      )
      .all(fileId)
      .map((row) => row["state"]);
  const fileState = (fileId: number) =>
    db.statement("SELECT state FROM spool_files WHERE id = ?").get(fileId)?.["state"];

  /** Reads [from, to) back and checks every sample against what was captured. */
  function expectIntact(run: FixtureRun, from: number, to: number) {
    const audio = readTrackAudio(db, data.dir, {
      trackRunId: run.id,
      sampleStart: from,
      sampleEnd: to,
    });
    expect(audio.missing).toEqual([]);
    expect(
      Buffer.from(audio.samples.buffer).equals(Buffer.from(run.expected(from, to).buffer)),
    ).toBe(true);
  }

  /** Every chunk intersecting a widened region is archived, the others expired. */
  function expectSelection(run: FixtureRun, regions: readonly (readonly [number, number])[]) {
    const rows = db
      .statement(
        "SELECT sample_start AS s, sample_count AS n, audio_state AS state FROM chunks WHERE track_run_id = ?",
      )
      .all(run.id) as { s: number; n: number; state: string }[];
    for (const row of rows) {
      const kept = regions.some(
        ([start, end]) => start - PRE < row.s + row.n && end + POST > row.s,
      );
      expect([row.s, row.state]).toEqual([row.s, kept ? "archived" : "expired"]);
    }
  }

  /** A closed episode over the region of `run` that starts at `start`. */
  function episodeFor(run: FixtureRun, start: number): number {
    const region = db
      .statement("SELECT id FROM speech_regions WHERE track_run_id = ? AND sample_start = ?")
      .get(run.id, start)?.["id"];
    const episode = db.orm
      .insert(episodes)
      .values({
        state: "closed",
        startedAtMs: run.wallAt(start),
        endedAtMs: run.wallAt(start + RATE),
        groupingVersion: "g1",
        classifierVersion: "c1",
        createdAtMs: T0,
        updatedAtMs: T0,
      })
      .returning({ id: episodes.id })
      .get();
    db.orm
      .insert(episodeRegions)
      .values({
        episodeId: episode.id,
        speechRegionId: Number(region),
        groupingVersion: "g1",
        sliceSampleStart: start,
      })
      .run();
    return episode.id;
  }

  const archiveFiles = (): string[] => {
    const root = join(data.dir, "archive");
    if (!existsSync(root)) return [];
    return readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name));
  };

  it("archives the chunks around speech, regions crossing files included, and expires the rest", () => {
    const run = spool.run();
    const first = run.file(FILE);
    const second = run.file(FILE);
    const crossing = [first.endSample - 16_000, second.startSample + 16_000] as const;
    const inside = [2 * RATE, 3 * RATE] as const;
    run.region(...inside);
    run.region(...crossing);
    run.close();

    const report = pass(vouched());
    expect(report).toMatchObject({ due: 2, evicted: 2, waiting: 0, failed: 0, spoolBytes: 0 });
    expectSelection(run, [inside, crossing]);
    expect([fileState(first.id), fileState(second.id)]).toEqual(["expired", "expired"]);
    expect(existsSync(first.pcm) || existsSync(second.pcm)).toBe(false);
    // Manifests stay: envelopes and gaps.
    expect(existsSync(first.manifest) && existsSync(second.manifest)).toBe(true);
    expect(archiveFiles()).toHaveLength(2);

    // The widened regions read back exactly; outside them the audio is gone.
    expectIntact(run, inside[0] - PRE, inside[1] + POST);
    expectIntact(run, crossing[0] - PRE, crossing[1] + POST);
    const gone = readTrackAudio(db, data.dir, {
      trackRunId: run.id,
      sampleStart: 5 * RATE,
      sampleEnd: 6 * RATE,
    });
    expect(gone.missing).toEqual([
      { sampleStart: 5 * RATE, sampleEnd: 6 * RATE, reason: "expired" },
    ]);

    // A second pass has nothing left to do.
    expect(pass(vouched())).toMatchObject({ due: 0, evicted: 0 });
  });

  it("keeps a file whose manifest holds a region the database never imported", () => {
    const run = spool.run();
    const first = run.file(FILE);
    const second = run.file(FILE);
    // Missed events: one region inside the first file, one crossing into the second.
    run.region(2 * RATE, 3 * RATE, { imported: false });
    run.region(second.startSample - RATE, second.startSample + RATE, { imported: false });
    run.close();

    expect(pass(vouched())).toMatchObject({
      evicted: 0,
      waiting: 2,
      reasons: { unimported_region: 2 },
      firstProblem: { code: "retention.unimported_region" },
    });
    expect(states(first.id).every((state) => state === "present")).toBe(true);
    expect(existsSync(first.pcm) && existsSync(second.pcm)).toBe(true);

    // Once reconciliation imports them, the speech is archived and the rest goes.
    for (const [start, end] of [
      [2 * RATE, 3 * RATE],
      [second.startSample - RATE, second.startSample + RATE],
    ] as const) {
      openSpeechRegion(db, {
        trackRunId: run.id,
        sampleStart: start,
        wallStartMs: run.wallAt(start),
        vadVersion: "test",
      });
      closeSpeechRegion(db, {
        trackRunId: run.id,
        sampleStart: start,
        sampleEnd: end,
        wallEndMs: run.wallAt(end),
        endReason: "silence",
      });
    }
    expect(pass(vouched())).toMatchObject({ evicted: 2, waiting: 0 });
    expectIntact(run, 2 * RATE - PRE, 3 * RATE + POST);
    expectIntact(run, second.startSample - RATE - PRE, second.startSample + RATE + POST);
  });

  it("keeps a file whose manifest holds a commit the database lacks", () => {
    const run = spool.run();
    const file = run.file(FILE);
    run.region(2 * RATE, 3 * RATE);
    run.close();
    db.statement("DELETE FROM chunks WHERE id = ?").run(file.chunkIds[30] ?? -1);
    expect(pass(vouched())).toMatchObject({ evicted: 0, reasons: { unimported_commit: 1 } });
    expect(existsSync(file.pcm)).toBe(true);
  });

  it("protects files reached by an open region, and open runs the reconciliation does not vouch for", () => {
    const run = spool.run();
    const first = run.file(FILE);
    const second = run.file(FILE);
    const third = run.file(FILE);
    run.file("BBBBBBBB", { closed: false });
    // Open in the database, 1 s into the third file: its pre-roll reaches the second.
    run.region(third.startSample + RATE, third.startSample + RATE, { open: true });

    expect(pass({ ...vouched(), reconciled: false })).toMatchObject({
      evicted: 0,
      reasons: { not_reconciled: 3 },
    });
    expect(pass(vouched())).toMatchObject({ evicted: 0, reasons: { run_not_live: 3 } });
    expect(pass({ ...vouched(run), problemRuns: new Set([run.uid]) })).toMatchObject({
      evicted: 0,
      reasons: { run_problem: 3 },
    });

    const report = pass(vouched(run));
    expect(report).toMatchObject({ evicted: 1, waiting: 2, reasons: { open_region: 2 } });
    expect([fileState(first.id), fileState(second.id), fileState(third.id)]).toEqual([
      "expired",
      "closed",
      "closed",
    ]);
    expect(existsSync(second.pcm) && existsSync(third.pcm)).toBe(true);
  });

  it("waits for an open run to commit past a file before trusting its manifests", () => {
    const run = spool.run();
    const first = run.file(FILE);
    // The run's newest file has 1 s so far: a region reaching the first file may still close.
    run.file("BBBB", { closed: false });
    expect(pass(vouched(run))).toMatchObject({ evicted: 0, reasons: { awaiting_manifests: 1 } });
    expect(existsSync(first.pcm)).toBe(true);
  });

  it("keeps a file whose selected chunk fails its CRC", () => {
    const run = spool.run();
    const file = run.file(FILE);
    run.region(2 * RATE, 3 * RATE);
    run.close();
    // Corrupt one byte of a chunk the region selects (block 10 = 2.5 s).
    const bytes = readFileSync(file.pcm);
    bytes[10 * BLOCK * 2 + 7] = (bytes[10 * BLOCK * 2 + 7] ?? 0) ^ 0xff;
    writeFileSync(file.pcm, bytes);

    expect(pass(vouched())).toMatchObject({ evicted: 0, reasons: { crc_mismatch: 1 } });
    expect(states(file.id).every((state) => state === "present")).toBe(true);
    expect(archiveFiles()).toEqual([]);
    const audio = readTrackAudio(db, data.dir, {
      trackRunId: run.id,
      sampleStart: 10 * BLOCK,
      sampleEnd: 11 * BLOCK,
    });
    expect(audio.missing).toEqual([
      { sampleStart: 10 * BLOCK, sampleEnd: 11 * BLOCK, reason: "corrupt" },
    ]);
    expect(audio.samples.every((sample) => sample === 0)).toBe(true);
  });

  it("evicts the oldest files past the cap, and bounds the work of a pass", () => {
    const run = spool.run({ startedWallMs: DAY_LATER - 60_000 });
    const files = [run.file(FILE), run.file(FILE), run.file(FILE)];
    run.close();
    const fileBytes = 40 * BLOCK * 2;
    // Recent files, but the spool holds three and may hold 1.5.
    const capped = { ...policy, capBytes: fileBytes * 1.5, maxFilesPerPass: 1 };
    expect(pass(vouched(), { policy: capped })).toMatchObject({ due: 2, evicted: 1, deferred: 1 });
    expect(pass(vouched(), { policy: capped })).toMatchObject({ due: 1, evicted: 1 });
    expect(files.map((file) => fileState(file.id))).toEqual(["expired", "expired", "closed"]);
    expect(pass(vouched(), { policy: capped })).toMatchObject({ due: 0, spoolBytes: fileBytes });
  });

  const steps: ArchiveStep[] = [
    "read",
    "tmp-written",
    "tmp-synced",
    "renamed",
    "dir-synced",
    "committed",
    "expired",
    "unlinked",
  ];
  it.each(steps)("recovers from a crash after %s without losing a selected chunk", (step) => {
    const run = spool.run();
    const first = run.file(FILE);
    const second = run.file(FILE);
    const regions = [
      [2 * RATE, 3 * RATE],
      [first.endSample - 16_000, second.startSample + 16_000],
    ] as const;
    for (const region of regions) run.region(...region);
    run.close();

    const crash = new Error("crash");
    const report = pass(vouched(), {
      afterStep: (at) => {
        if (at === step) throw crash;
      },
    });
    expect(report.failed).toBe(2);

    // Restart: a new connection, startup recovery, then the next pass.
    db.close();
    db = openDatabase(join(data.dir, "sondine.db"), { migrationsFolder: migrationsDir });
    recoverRetention(db, layout());
    for (const [start, end] of regions) expectIntact(run, start - PRE, end + POST);
    expect(archiveFiles().filter((path) => path.endsWith(".tmp"))).toEqual([]);

    expect(pass(vouched())).toMatchObject({ failed: 0, waiting: 0 });
    expect([fileState(first.id), fileState(second.id)]).toEqual(["expired", "expired"]);
    expect(existsSync(first.pcm) || existsSync(second.pcm)).toBe(false);
    expectSelection(run, regions);
    for (const [start, end] of regions) expectIntact(run, start - PRE, end + POST);
    // Exactly one archive per evicted file, each referenced.
    expect(archiveFiles().toSorted()).toEqual(
      [first, second]
        .map((file) => join(data.dir, file.relPath.replace("spool/", "archive/")))
        .toSorted(),
    );
  });

  it("deletes archives no chunk points to and leftovers of interrupted writes", () => {
    const run = spool.run();
    const file = run.file(FILE);
    run.region(2 * RATE, 3 * RATE);
    run.close();
    expect(pass(vouched())).toMatchObject({ evicted: 1 });
    const kept = join(data.dir, file.relPath.replace("spool/", "archive/"));
    const runDir = join(kept, "..");
    const orphan = join(runDir, "0007.pcm");
    const stray = join(data.dir, "archive", "input-Gone", "00000000-0000-4000-8000-999999999999");
    mkdirSync(stray, { recursive: true });
    writeFileSync(orphan, Buffer.alloc(64));
    writeFileSync(`${kept}.tmp`, Buffer.alloc(64));
    writeFileSync(join(stray, "0000.pcm"), Buffer.alloc(64));

    expect(recoverRetention(db, layout())).toMatchObject({ tmpRemoved: 1, orphansRemoved: 2 });
    expect(archiveFiles()).toEqual([kept]);
    expect(existsSync(stray)).toBe(false);
    expectIntact(run, 2 * RATE - PRE, 3 * RATE + POST);
  });

  it("re-archives from the spool, or expires and reports, when an archive is damaged or gone", () => {
    const run = spool.run();
    const first = run.file(FILE);
    const second = run.file(FILE);
    run.region(2 * RATE, 3 * RATE);
    run.region(second.startSample + 2 * RATE, second.startSample + 3 * RATE);
    run.close();
    // The first file stops after its archive commit; the second goes all the way.
    let crashed = false;
    pass(vouched(), {
      afterStep: (step) => {
        if (step !== "committed" || crashed) return;
        crashed = true;
        throw new Error("crash");
      },
    });
    expect(fileState(first.id)).toBe("closed");
    expect(fileState(second.id)).toBe("expired");
    const firstArchive = join(data.dir, first.relPath.replace("spool/", "archive/"));
    const secondArchive = join(data.dir, second.relPath.replace("spool/", "archive/"));
    // Damage the first archive (its spool still holds the bytes) and lose the second.
    const bytes = readFileSync(firstArchive);
    bytes[100] = (bytes[100] ?? 0) ^ 0xff;
    writeFileSync(firstArchive, bytes);
    writeFileSync(secondArchive, Buffer.alloc(16));

    const archivedInSecond = states(second.id).filter((state) => state === "archived").length;
    expect(archivedInSecond).toBeGreaterThan(0);
    const recovery = recoverRetention(db, layout());
    expect(recovery).toMatchObject({ rearchive: 1, lostChunks: archivedInSecond });
    expect(states(first.id).includes("archived")).toBe(false);
    expect(states(second.id).includes("archived")).toBe(false);
    const lost = readTrackAudio(db, data.dir, {
      trackRunId: run.id,
      sampleStart: second.startSample + 2 * RATE,
      sampleEnd: second.startSample + 3 * RATE,
    });
    expect(lost.missing).toEqual([
      {
        sampleStart: second.startSample + 2 * RATE,
        sampleEnd: second.startSample + 3 * RATE,
        reason: "expired",
      },
    ]);

    expect(pass(vouched())).toMatchObject({ evicted: 1, failed: 0 });
    expectIntact(run, 2 * RATE - PRE, 3 * RATE + POST);
  });

  it.each(["damaged", "missing"] as const)(
    "keeps the spool of a file expired just before a crash when its archive is %s",
    (damage) => {
      const run = spool.run();
      const file = run.file(FILE);
      run.region(2 * RATE, 3 * RATE);
      run.close();
      // The database expired the file, then the crash came before the unlink.
      pass(vouched(), {
        afterStep: (step) => {
          if (step === "expired") throw new Error("crash");
        },
      });
      expect(fileState(file.id)).toBe("expired");
      expect(existsSync(file.pcm)).toBe(true);
      const archive = join(data.dir, file.relPath.replace("spool/", "archive/"));
      if (damage === "damaged") {
        // Same length, so only a CRC check can tell.
        const bytes = readFileSync(archive);
        bytes[100] = (bytes[100] ?? 0) ^ 0xff;
        writeFileSync(archive, bytes);
      } else {
        rmSync(archive);
      }

      expect(recoverRetention(db, layout())).toMatchObject({
        rearchive: 1,
        lostChunks: 0,
        spoolUnlinked: 0,
      });
      expect(fileState(file.id)).toBe("closed");
      expect(existsSync(file.pcm)).toBe(true);
      expectIntact(run, 2 * RATE - PRE, 3 * RATE + POST);

      expect(pass(vouched())).toMatchObject({ evicted: 1, failed: 0 });
      expect(existsSync(file.pcm)).toBe(false);
      expectIntact(run, 2 * RATE - PRE, 3 * RATE + POST);
    },
  );

  it("zeroes a deleted episode's archived bytes, and again after a crash before the scrub", () => {
    const run = spool.run();
    const file = run.file(FILE);
    run.region(2 * RATE, 3 * RATE);
    run.region(6 * RATE, 7 * RATE);
    run.close();
    expect(pass(vouched())).toMatchObject({ evicted: 1 });
    const archivePath = join(data.dir, file.relPath.replace("spool/", "archive/"));

    const archived = () =>
      db
        .statement(
          "SELECT archive_byte_offset AS offset, byte_length AS length FROM chunks WHERE track_run_id = ? AND audio_state = 'deleted'",
        )
        .all(run.id) as { offset: number | null; length: number }[];

    const deleted = deleteEpisode(db, episodeFor(run, 2 * RATE), { origin: "app" });
    if (!deleted.deleted) throw new Error("episode not deleted");
    const targets = deleted.chunks.filter((chunk) => chunk.archiveRelPath !== null);
    expect(targets.length).toBeGreaterThan(0);
    const before = readFileSync(archivePath);
    scrubChunks(db, layout(), deleted.chunks);
    const after = readFileSync(archivePath);
    for (const chunk of targets) {
      const offset = chunk.archiveByteOffset ?? -1;
      expect(before.subarray(offset, offset + chunk.byteLength).some((byte) => byte !== 0)).toBe(
        true,
      );
      expect(after.subarray(offset, offset + chunk.byteLength).every((byte) => byte === 0)).toBe(
        true,
      );
    }
    expect(archived().every((chunk) => chunk.offset === null)).toBe(true);
    // The other region's audio is untouched; the deleted one reads as deleted.
    expectIntact(run, 6 * RATE - PRE, 7 * RATE + POST);
    expect(
      readTrackAudio(db, data.dir, {
        trackRunId: run.id,
        sampleStart: 2 * RATE,
        sampleEnd: 3 * RATE,
      }).missing,
    ).toEqual([{ sampleStart: 2 * RATE, sampleEnd: 3 * RATE, reason: "deleted" }]);

    // Core dies between the delete and the scrub: recovery scrubs.
    const second = deleteEpisode(db, episodeFor(run, 6 * RATE), { origin: "app" });
    if (!second.deleted) throw new Error("episode not deleted");
    const pending = second.chunks.filter((chunk) => chunk.archiveRelPath !== null);
    expect(recoverRetention(db, layout()).rescrubbed).toBe(pending.length);
    const scrubbed = readFileSync(archivePath);
    for (const chunk of pending) {
      const offset = chunk.archiveByteOffset ?? -1;
      expect(scrubbed.subarray(offset, offset + chunk.byteLength).every((byte) => byte === 0)).toBe(
        true,
      );
    }
    // Nothing points at the archive any more: the next startup removes it.
    expect(recoverRetention(db, layout())).toMatchObject({ orphansRemoved: 1, rescrubbed: 0 });
    expect(existsSync(archivePath)).toBe(false);
  });

  it("zeroes deleted spool bytes except in a run's newest file, which the helper re-checks", () => {
    const run = spool.run();
    const first = run.file(FILE);
    const second = run.file(FILE);
    run.region(2 * RATE, 3 * RATE);
    run.region(second.startSample + 2 * RATE, second.startSample + 3 * RATE);
    run.close();
    const original = [readFileSync(first.pcm), readFileSync(second.pcm)];
    const removed = [
      deleteEpisode(db, episodeFor(run, 2 * RATE), { origin: "app" }),
      deleteEpisode(db, episodeFor(run, second.startSample + 2 * RATE), { origin: "app" }),
    ].flatMap((result) => (result.deleted ? result.chunks : []));
    const inSecond = removed.filter((chunk) => chunk.spoolRelPath === second.relPath).length;
    expect(inSecond).toBeGreaterThan(0);

    expect(scrubChunks(db, layout(), removed).deferred).toHaveLength(inSecond);
    const firstBytes = readFileSync(first.pcm);
    for (const chunk of removed.filter((c) => c.spoolRelPath === first.relPath)) {
      const bytes = firstBytes.subarray(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
      expect(bytes.every((byte) => byte === 0)).toBe(true);
    }
    // The newest file keeps every byte (its CRCs stay valid for the helper).
    expect(readFileSync(second.pcm).equals(original[1] ?? Buffer.alloc(0))).toBe(true);
    // Retention evicts both files; the deleted audio is in neither archive.
    expect(pass(vouched())).toMatchObject({ evicted: 2, archivedChunks: 0 });
    expect(existsSync(second.pcm)).toBe(false);
    expect(archiveFiles()).toEqual([]);
  });
});
