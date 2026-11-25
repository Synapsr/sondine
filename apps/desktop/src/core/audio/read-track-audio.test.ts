import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { msToSamples, openDatabase, speechRolls, type OpenedDatabase } from "@sondine/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { layoutOf, RATE, SpoolFixture, T0, type FixtureRun } from "../../../test/spool-fixture";
import { migrationsDir, tempDataDir, type TempDataDir } from "../../../test/support";
import { runRetentionPass, retentionPolicy } from "../retention/pass";
import { createTrackAudioReader } from "./read-track-audio";
import type { ReadTrackAudio } from "./track-audio";

const BLOCK = 4_000;
const PRE = msToSamples(speechRolls.preRollMs, RATE);
const POST = msToSamples(speechRolls.postRollMs, RATE);

describe("readTrackAudio", () => {
  let data: TempDataDir;
  let db: OpenedDatabase;
  let spool: SpoolFixture;
  let read: ReadTrackAudio;

  beforeEach(() => {
    data = tempDataDir();
    db = openDatabase(join(data.dir, "sondine.db"), { migrationsFolder: migrationsDir });
    spool = new SpoolFixture(db, data.dir, BLOCK);
    read = createTrackAudioReader(db, data.dir);
  });
  afterEach(() => {
    db.close();
    data.cleanup();
  });

  /** The captured samples with `zeroed` spans set to zero. */
  function expected(run: FixtureRun, from: number, to: number, zeroed: [number, number][] = []) {
    const samples = run.expected(from, to);
    for (const [start, end] of zeroed) samples.fill(0, start - from, end - from);
    return samples;
  }

  const evict = () =>
    runRetentionPass(db, layoutOf(data.dir), {
      nowMs: T0 + 3 * 24 * 60 * 60 * 1_000,
      reconciliation: () => ({ reconciled: true, liveRuns: new Set(), problemRuns: new Set() }),
      policy: { ...retentionPolicy, regionRecordHorizonMs: 5_000 },
    });

  it("returns exactly the range from the spool, with gaps and unrecorded samples zero-filled", () => {
    const run = spool.run();
    // Blocks 0-1, a gap (block 2), blocks 3-4; then nothing after sample 20 000.
    run.file("BBgBB");
    run.close();
    const from = 1_234;
    const to = 6 * BLOCK + 500;
    const audio = read({ trackRunId: run.id, sampleStart: from, sampleEnd: to });
    expect(audio.samples).toHaveLength(to - from);
    expect(audio.missing).toEqual([
      { sampleStart: 2 * BLOCK, sampleEnd: 3 * BLOCK, reason: "gap" },
      { sampleStart: 5 * BLOCK, sampleEnd: to, reason: "unrecorded" },
    ]);
    expect(audio.samples).toEqual(
      expected(run, from, to, [
        [2 * BLOCK, 3 * BLOCK],
        [5 * BLOCK, to],
      ]),
    );
    expect(read({ trackRunId: run.id, sampleStart: 7, sampleEnd: 7 })).toEqual({
      samples: new Int16Array(0),
      missing: [],
    });
    expect(() => read({ trackRunId: run.id, sampleStart: 9, sampleEnd: 3 })).toThrow(RangeError);
  });

  it("reads archived and present chunks across files, and reports expired and deleted ones", () => {
    const run = spool.run();
    const first = run.file("B".repeat(40));
    const second = run.file("B".repeat(40));
    run.close();
    const region = [first.endSample - 3 * RATE, first.endSample - 2 * RATE] as const;
    run.region(...region);
    // The first file is evicted (its region archived); the second keeps its spool
    // until the pass reaches it, so we stop the pass after one file.
    const report = runRetentionPass(db, layoutOf(data.dir), {
      nowMs: T0 + 3 * 24 * 60 * 60 * 1_000,
      reconciliation: () => ({ reconciled: true, liveRuns: new Set(), problemRuns: new Set() }),
      policy: { ...retentionPolicy, regionRecordHorizonMs: 5_000, maxFilesPerPass: 1 },
    });
    expect(report.evicted).toBe(1);
    // One chunk of the second file is deleted (whole-chunk deletion).
    const deletedFrom = second.startSample + 4 * BLOCK;
    db.statement("UPDATE chunks SET audio_state = 'deleted' WHERE id = ?").run(
      second.chunkIds[4] ?? -1,
    );

    const keptFrom = Math.floor((region[0] - PRE) / BLOCK) * BLOCK;
    const from = keptFrom - 2 * BLOCK;
    const to = second.startSample + 6 * BLOCK + 100;
    const audio = read({ trackRunId: run.id, sampleStart: from, sampleEnd: to });
    // Before the widened region the first file's audio expired; after it, too,
    // until the second file's spool; one deleted chunk inside it.
    const keptTo = Math.ceil((region[1] + POST) / BLOCK) * BLOCK;
    expect(audio.missing).toEqual([
      { sampleStart: from, sampleEnd: keptFrom, reason: "expired" },
      { sampleStart: keptTo, sampleEnd: first.endSample, reason: "expired" },
      { sampleStart: deletedFrom, sampleEnd: deletedFrom + BLOCK, reason: "deleted" },
    ]);
    expect(audio.samples).toEqual(
      expected(run, from, to, [
        [from, keptFrom],
        [keptTo, first.endSample],
        [deletedFrom, deletedFrom + BLOCK],
      ]),
    );
  });

  it("zero-fills a tombstone inside a chunk whatever its state says", () => {
    const run = spool.run();
    run.file("BBBB");
    run.close();
    db.statement(
      `INSERT INTO deleted_ranges (scope, track_run_id, sample_start, sample_end, wall_start_ms, wall_end_ms, origin, created_at_ms)
       VALUES ('track_run', ?, ?, ?, ?, ?, 'app', ?)`,
    ).run(run.id, 5_000, 6_000, T0, T0 + 1, T0);
    const audio = read({ trackRunId: run.id, sampleStart: 0, sampleEnd: 4 * BLOCK });
    expect(audio.missing).toEqual([{ sampleStart: 5_000, sampleEnd: 6_000, reason: "deleted" }]);
    expect(audio.samples).toEqual(expected(run, 0, 4 * BLOCK, [[5_000, 6_000]]));
  });

  it("reports corrupt bytes and missing files, and falls back to the spool for a damaged archive", () => {
    const run = spool.run();
    const file = run.file("B".repeat(40));
    run.close();
    run.region(2 * RATE, 3 * RATE);
    // A damaged spool block: CRC fails.
    const spoolBytes = readFileSync(file.pcm);
    spoolBytes[30 * BLOCK * 2] = (spoolBytes[30 * BLOCK * 2] ?? 0) ^ 0x01;
    writeFileSync(file.pcm, spoolBytes);
    expect(read({ trackRunId: run.id, sampleStart: 30 * BLOCK, sampleEnd: 31 * BLOCK })).toEqual({
      samples: new Int16Array(BLOCK),
      missing: [{ sampleStart: 30 * BLOCK, sampleEnd: 31 * BLOCK, reason: "corrupt" }],
    });

    // Archived chunks while the spool still holds them (a pass interrupted before eviction).
    db.statement(
      `UPDATE chunks SET audio_state = 'archived', archive_rel_path = ?, archive_byte_offset = byte_offset
       WHERE spool_file_id = ? AND sample_start < ?`,
    ).run(file.relPath.replace("spool/", "archive/"), file.id, 20 * BLOCK);
    // No archive file at all: the spool serves them.
    const range = { trackRunId: run.id, sampleStart: 0, sampleEnd: 20 * BLOCK };
    expect(read(range)).toEqual({ samples: expected(run, 0, 20 * BLOCK), missing: [] });
    // Once the spool file is gone too, they are corrupt.
    db.statement("UPDATE spool_files SET state = 'expired' WHERE id = ?").run(file.id);
    rmSync(file.pcm);
    expect(read(range).missing).toEqual([
      { sampleStart: 0, sampleEnd: 20 * BLOCK, reason: "corrupt" },
    ]);
  });

  it("reads 55 min of audio in whole-file reads", () => {
    // Ten-minute files of 2 s blocks, as the helper writes them.
    const big = new SpoolFixture(db, data.dir, 2 * RATE);
    const run = big.run();
    for (let file = 0; file < 6; file++) run.file("B".repeat(300));
    run.close();
    const sampleEnd = 55 * 60 * RATE;
    const started = performance.now();
    const audio = read({ trackRunId: run.id, sampleStart: 0, sampleEnd });
    const elapsedMs = performance.now() - started;
    expect(audio.missing).toEqual([]);
    expect(audio.samples).toHaveLength(sampleEnd);
    expect(audio.samples[sampleEnd - 1]).toBe(run.expected(sampleEnd - 1, sampleEnd)[0]);
    // A loose bound against an accidental per-sample or per-chunk syscall path.
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it("serves whole runs whose first file was evicted", () => {
    const run = spool.run();
    run.file("B".repeat(40));
    run.file("B".repeat(40));
    run.region(RATE, 2 * RATE);
    run.close();
    expect(evict()).toMatchObject({ evicted: 2 });
    const audio = read({ trackRunId: run.id, sampleStart: 0, sampleEnd: 80 * BLOCK });
    // The region [1 s, 2 s) keeps [0, 2.8 s): blocks 0 to 11.
    expect(audio.missing).toEqual([
      { sampleStart: 12 * BLOCK, sampleEnd: 80 * BLOCK, reason: "expired" },
    ]);
    expect(audio.samples).toEqual(expected(run, 0, 80 * BLOCK, [[12 * BLOCK, 80 * BLOCK]]));
  });
});
