import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeEarlierSpoolFiles,
  openSpeechRegion,
  recordSpoolCommit,
  recordSpoolFile,
  upsertTrackRun,
} from "./capture-import";
import { closeRecoveredTrackRun, dropTruncatedChunks } from "./capture-recovery";
import { at, count, rate, t0, tempDatabase, type TempDatabase } from "./test-helpers";

let temp: TempDatabase;
beforeEach(() => {
  temp = tempDatabase();
});
afterEach(() => temp.cleanup());

function openRun(): number {
  return upsertTrackRun(temp.db, {
    uid: "recovered-run",
    trackKey: "system:other",
    sourceKind: "system",
    startedWallMs: t0,
    nowMs: t0,
  }).trackRunId;
}

function file(trackRunId: number, seq: number): number {
  return recordSpoolFile(temp.db, {
    trackRunId,
    seq,
    relPath: `spool/system-other/recovered-run/000${seq}.pcm`,
    sampleStart: at(seq * 600),
    createdWallMs: t0 + seq * 600_000,
  }).spoolFileId;
}

describe("closeRecoveredTrackRun", () => {
  it("ends the run at its last committed sample, with its files and open regions", () => {
    const db = temp.db;
    const run = openRun();
    const spoolFileId = file(run, 0);
    recordSpoolCommit(db, {
      spoolFileId,
      byteOffset: 0,
      byteLength: 4 * rate,
      sampleStart: 0,
      wallMs: t0,
      crc32: 1,
    });
    // One region has committed audio, the other started after the last commit.
    openSpeechRegion(db, {
      trackRunId: run,
      sampleStart: at(1),
      wallStartMs: t0 + 1_000,
      vadVersion: "v",
    });
    openSpeechRegion(db, {
      trackRunId: run,
      sampleStart: at(3),
      wallStartMs: t0 + 3_000,
      vadVersion: "v",
    });

    const result = closeRecoveredTrackRun(db, {
      trackRunId: run,
      sampleEnd: at(2),
      endedWallMs: t0 + 2_000,
      endReason: "helper_exit",
      nowMs: t0 + 9_000,
    });
    expect(result).toEqual({
      status: "updated",
      closedFiles: 1,
      closedRegions: 1,
      droppedRegions: 1,
    });
    expect(
      db.statement("SELECT state, end_reason, ended_wall_ms, sample_end FROM track_runs").get(),
    ).toEqual({
      state: "closed",
      end_reason: "helper_exit",
      ended_wall_ms: t0 + 2_000,
      sample_end: at(2),
    });
    expect(count(db, "spool_files", "state = 'closed'")).toBe(1);
    expect(
      db.statement("SELECT sample_start, sample_end, end_reason FROM speech_regions").all(),
    ).toEqual([{ sample_start: at(1), sample_end: at(2), end_reason: "recovery" }]);

    // A closed run is left alone.
    expect(
      closeRecoveredTrackRun(db, {
        trackRunId: run,
        sampleEnd: 0,
        endedWallMs: t0,
        endReason: "recovered",
      }).status,
    ).toBe("unchanged");
    expect(
      closeRecoveredTrackRun(db, {
        trackRunId: 999,
        sampleEnd: 0,
        endedWallMs: t0,
        endReason: "recovered",
      }).status,
    ).toBe("unknown");
  });

  it("never ends a run before it started", () => {
    const run = openRun();
    closeRecoveredTrackRun(temp.db, {
      trackRunId: run,
      sampleEnd: 0,
      endedWallMs: t0 - 5_000,
      endReason: "recovered",
    });
    expect(temp.db.statement("SELECT ended_wall_ms AS v FROM track_runs").get()?.["v"]).toBe(t0);
  });
});

describe("closeEarlierSpoolFiles", () => {
  it("closes the open files before a sequence and nothing else", () => {
    const db = temp.db;
    const run = openRun();
    for (const seq of [0, 1, 2]) file(run, seq);
    expect(
      closeEarlierSpoolFiles(db, { trackRunId: run, beforeSeq: 2, closedWallMs: t0 }).statuses,
    ).toEqual(["updated", "updated"]);
    expect(db.statement("SELECT seq, state FROM spool_files ORDER BY seq").all()).toEqual([
      { seq: 0, state: "closed" },
      { seq: 1, state: "closed" },
      { seq: 2, state: "open" },
    ]);
    expect(
      closeEarlierSpoolFiles(db, { trackRunId: run, beforeSeq: 2, closedWallMs: t0 }).statuses,
    ).toEqual([]);
  });
});

describe("dropTruncatedChunks", () => {
  it("drops the chunks recovery cut and shrinks their file", () => {
    const db = temp.db;
    const run = openRun();
    const spoolFileId = file(run, 0);
    for (const block of [0, 1, 2]) {
      recordSpoolCommit(db, {
        spoolFileId,
        byteOffset: block * 4 * rate,
        byteLength: 4 * rate,
        sampleStart: at(block * 2),
        wallMs: t0 + block * 2_000,
        crc32: block,
      });
    }
    expect(
      dropTruncatedChunks(db, { trackRunId: run, fromSample: at(2), toSample: at(9) }),
    ).toEqual({
      dropped: 2,
    });
    expect(count(db, "chunks")).toBe(1);
    expect(db.statement("SELECT committed_bytes AS v FROM spool_files").get()?.["v"]).toBe(
      4 * rate,
    );
    expect(
      dropTruncatedChunks(db, { trackRunId: run, fromSample: at(2), toSample: at(9) }),
    ).toEqual({
      dropped: 0,
    });
  });
});
