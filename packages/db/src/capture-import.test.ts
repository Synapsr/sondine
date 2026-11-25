import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeSpeechRegion,
  closeSpoolFile,
  ImportConflictError,
  openSpeechRegion,
  recordEpoch,
  recordGap,
  recordSpoolCommit,
  recordSpoolFile,
  upsertTrackRun,
  type TrackRunInput,
} from "./capture-import";
import { transaction } from "./database";
import { chunks, deletedRanges, epochs, speechRegions, spoolFiles, trackRuns } from "./schema";
import { at, count, rate, t0, tempDatabase, type TempDatabase } from "./test-helpers";

let temp: TempDatabase;
beforeEach(() => {
  temp = tempDatabase();
});
afterEach(() => temp.cleanup());

const micRun: TrackRunInput = {
  uid: "6f1c2d1e-run",
  trackKey: "input:BuiltInMicrophoneDevice",
  sourceKind: "input",
  device: {
    uid: "BuiltInMicrophoneDevice",
    name: "MacBook Pro Microphone",
    transport: "built_in",
    hasInput: true,
    seenAtMs: t0,
  },
  startedWallMs: t0,
  nowMs: t0,
};

const blockBytes = 2 * rate * 2;

/** Replays a helper session: run, epoch, one spool file with 2 s commits, a region, a gap. */
function replaySession(): Record<string, string[]> {
  const db = temp.db;
  const statuses: Record<string, string[]> = {
    run: [],
    epoch: [],
    file: [],
    commit: [],
    region: [],
    gap: [],
  };
  const run = upsertTrackRun(db, micRun);
  statuses["run"]?.push(run.status);
  statuses["epoch"]?.push(
    recordEpoch(db, {
      trackRunId: run.trackRunId,
      seq: 0,
      reason: "run_start",
      sampleStart: 0,
      timebaseNumer: 125,
      timebaseDenom: 3,
      anchorHostTicks: 9_000_000_000n,
      anchorContinuousUs: 375_000_000,
      anchorWallMs: t0,
    }).status,
  );
  const file = recordSpoolFile(db, {
    trackRunId: run.trackRunId,
    seq: 0,
    relPath: "spool/input-builtin/6f1c2d1e-run/000000.pcm",
    sampleStart: 0,
    createdWallMs: t0,
  });
  statuses["file"]?.push(file.status);
  for (let block = 0; block < 5; block++) {
    statuses["commit"]?.push(
      recordSpoolCommit(db, {
        spoolFileId: file.spoolFileId,
        byteOffset: block * blockBytes,
        byteLength: blockBytes,
        sampleStart: at(block * 2),
        continuousUs: 375_000_000 + block * 2_000_000,
        wallMs: t0 + block * 2000,
        crc32: 0xdeadbeef - block,
      }).status,
    );
  }
  statuses["region"]?.push(
    openSpeechRegion(db, {
      trackRunId: run.trackRunId,
      sampleStart: at(3),
      wallStartMs: t0 + 3000,
      vadVersion: "silero-6.2",
    }).status,
    closeSpeechRegion(db, {
      trackRunId: run.trackRunId,
      sampleStart: at(3),
      sampleEnd: at(7),
      wallEndMs: t0 + 7000,
      endReason: "silence",
    }).status,
  );
  statuses["gap"]?.push(
    recordGap(db, {
      trackRunId: run.trackRunId,
      reason: "ring_overflow",
      wallStartMs: t0 + 8000,
      wallEndMs: t0 + 8100,
      lostBytes: 3200,
    }).status,
  );
  return statuses;
}

const tables = [
  "track_runs",
  "devices",
  "epochs",
  "spool_files",
  "chunks",
  "speech_regions",
  "gaps",
];
const counts = () => Object.fromEntries(tables.map((table) => [table, count(temp.db, table)]));

describe("capture import", () => {
  it("is idempotent when a whole session is replayed", () => {
    const first = replaySession();
    expect(first).toEqual({
      run: ["inserted"],
      epoch: ["inserted"],
      file: ["inserted"],
      commit: ["inserted", "inserted", "inserted", "inserted", "inserted"],
      region: ["inserted", "updated"],
      gap: ["inserted"],
    });
    const before = counts();
    const second = transaction(temp.db, replaySession);
    expect(second).toEqual({
      run: ["unchanged"],
      epoch: ["duplicate"],
      file: ["duplicate"],
      commit: ["duplicate", "duplicate", "duplicate", "duplicate", "duplicate"],
      region: ["duplicate", "duplicate"],
      gap: ["duplicate"],
    });
    expect(counts()).toEqual(before);
    expect(before).toMatchObject({
      track_runs: 1,
      devices: 1,
      chunks: 5,
      speech_regions: 1,
      gaps: 1,
    });
    const file = temp.db.orm.select().from(spoolFiles).get();
    expect(file?.committedBytes).toBe(5 * blockBytes);
  });

  it("rejects a replay that contradicts the recorded commit", () => {
    replaySession();
    const file = temp.db.orm.select().from(spoolFiles).get();
    if (file === undefined) throw new Error("no spool file");
    expect(() =>
      recordSpoolCommit(temp.db, {
        spoolFileId: file.id,
        byteOffset: 0,
        byteLength: blockBytes,
        sampleStart: 0,
        wallMs: t0,
        crc32: 1,
      }),
    ).toThrow(ImportConflictError);
    expect(() => upsertTrackRun(temp.db, { ...micRun, trackKey: "input:Other" })).toThrow(
      ImportConflictError,
    );
  });

  it("keeps host ticks above 2^53 exact, on insert and on replay", () => {
    const ticks = 9_007_199_254_740_993n;
    const { trackRunId } = upsertTrackRun(temp.db, micRun);
    const epoch = {
      trackRunId,
      seq: 0,
      reason: "run_start",
      sampleStart: 0,
      timebaseNumer: 1,
      timebaseDenom: 1,
      anchorHostTicks: ticks,
      anchorContinuousUs: 375_000_000,
      anchorWallMs: t0,
    } as const;
    expect(recordEpoch(temp.db, epoch).status).toBe("inserted");
    expect(recordEpoch(temp.db, epoch).status).toBe("duplicate");
    expect(() => recordEpoch(temp.db, { ...epoch, anchorHostTicks: ticks + 1n })).toThrow(
      ImportConflictError,
    );
    expect(temp.db.orm.select().from(epochs).get()?.anchorHostTicks).toBe(ticks);

    const file = recordSpoolFile(temp.db, {
      trackRunId,
      seq: 0,
      relPath: "spool/input-builtin/6f1c2d1e-run/000000.pcm",
      sampleStart: 0,
      createdWallMs: t0,
    });
    const commit = {
      spoolFileId: file.spoolFileId,
      byteOffset: 0,
      byteLength: blockBytes,
      sampleStart: 0,
      hostTicks: ticks,
      wallMs: t0,
      crc32: 1,
    };
    expect(recordSpoolCommit(temp.db, commit).status).toBe("inserted");
    expect(recordSpoolCommit(temp.db, commit).status).toBe("duplicate");
    // Same bytes and CRC, another clock reading: not the same block.
    expect(() => recordSpoolCommit(temp.db, { ...commit, hostTicks: ticks + 1n })).toThrow(
      ImportConflictError,
    );
    expect(temp.db.orm.select().from(chunks).get()?.hostTicks).toBe(ticks);
    const stored = temp.db.client
      .prepare("select typeof(host_ticks) as type, cast(host_ticks as text) as value from chunks")
      .get();
    expect(stored).toEqual({ type: "integer", value: "9007199254740993" });
  });

  it("moves track runs forward only", () => {
    const { trackRunId } = upsertTrackRun(temp.db, micRun);
    const closed = {
      ...micRun,
      state: "closed" as const,
      endedWallMs: t0 + 60_000,
      endReason: "device_lost" as const,
      sampleEnd: at(60),
    };
    expect(upsertTrackRun(temp.db, closed).status).toBe("updated");
    expect(upsertTrackRun(temp.db, micRun).status).toBe("unchanged");
    expect(upsertTrackRun(temp.db, closed).status).toBe("unchanged");
    const row = temp.db.orm.select().from(trackRuns).where(eq(trackRuns.id, trackRunId)).get();
    expect(row).toMatchObject({
      state: "closed",
      endReason: "device_lost",
      endedWallMs: t0 + 60_000,
    });
  });

  it("closes spool files once", () => {
    const { trackRunId } = upsertTrackRun(temp.db, micRun);
    const { spoolFileId } = recordSpoolFile(temp.db, {
      trackRunId,
      seq: 0,
      relPath: "a.pcm",
      sampleStart: 0,
      createdWallMs: t0,
    });
    expect(closeSpoolFile(temp.db, { spoolFileId, closedWallMs: t0 + 600_000 }).status).toBe(
      "updated",
    );
    expect(closeSpoolFile(temp.db, { spoolFileId, closedWallMs: t0 + 600_000 }).status).toBe(
      "unchanged",
    );
    expect(closeSpoolFile(temp.db, { spoolFileId: 999, closedWallMs: t0 }).status).toBe("unknown");
  });

  it("rolls back a batch atomically when one event fails", () => {
    const { trackRunId } = upsertTrackRun(temp.db, micRun);
    expect(() =>
      transaction(temp.db, () => {
        openSpeechRegion(temp.db, {
          trackRunId,
          sampleStart: at(1),
          wallStartMs: t0 + 1000,
          vadVersion: "v",
        });
        recordSpoolCommit(temp.db, {
          spoolFileId: 404,
          byteOffset: 0,
          byteLength: 2,
          sampleStart: 0,
          wallMs: t0,
          crc32: 0,
        });
      }),
    ).toThrow(ImportConflictError);
    expect(count(temp.db, "speech_regions")).toBe(0);
  });

  it("keeps a failed inner event from undoing the rest of the batch when caught", () => {
    const { trackRunId } = upsertTrackRun(temp.db, micRun);
    transaction(temp.db, () => {
      openSpeechRegion(temp.db, {
        trackRunId,
        sampleStart: at(1),
        wallStartMs: t0 + 1000,
        vadVersion: "v",
      });
      expect(() =>
        recordSpoolCommit(temp.db, {
          spoolFileId: 404,
          byteOffset: 0,
          byteLength: 2,
          sampleStart: 0,
          wallMs: t0,
          crc32: 0,
        }),
      ).toThrow(ImportConflictError);
    });
    expect(count(temp.db, "speech_regions")).toBe(1);
  });
});

function tombstone(
  range: { scope: "all" } | { scope: "track_run"; trackRunId: number; from: number; to: number },
  fromMs: number,
  toMs: number,
) {
  temp.db.orm
    .insert(deletedRanges)
    .values({
      scope: range.scope,
      trackRunId: range.scope === "track_run" ? range.trackRunId : null,
      sampleStart: range.scope === "track_run" ? range.from : null,
      sampleEnd: range.scope === "track_run" ? range.to : null,
      wallStartMs: fromMs,
      wallEndMs: toMs,
      origin: "tray",
      createdAtMs: t0,
    })
    .run();
}

describe("capture import and deleted ranges", () => {
  it("skips commits inside a deleted range but still advances the committed size", () => {
    const { trackRunId } = upsertTrackRun(temp.db, micRun);
    const { spoolFileId } = recordSpoolFile(temp.db, {
      trackRunId,
      seq: 0,
      relPath: "a.pcm",
      sampleStart: 0,
      createdWallMs: t0,
    });
    tombstone({ scope: "all" }, t0 + 2000, t0 + 4000);
    const statuses = [0, 1, 2].map(
      (block) =>
        recordSpoolCommit(temp.db, {
          spoolFileId,
          byteOffset: block * blockBytes,
          byteLength: blockBytes,
          sampleStart: at(block * 2),
          wallMs: t0 + block * 2000,
          crc32: block,
        }).status,
    );
    expect(statuses).toEqual(["inserted", "skipped_deleted", "inserted"]);
    expect(
      temp.db.orm
        .select()
        .from(chunks)
        .all()
        .map((chunk) => chunk.byteOffset),
    ).toEqual([0, 2 * blockBytes]);
    expect(temp.db.orm.select().from(spoolFiles).get()?.committedBytes).toBe(3 * blockBytes);
  });

  it("applies track-run tombstones by sample range, only to that run", () => {
    const mic = upsertTrackRun(temp.db, micRun).trackRunId;
    const app = upsertTrackRun(temp.db, {
      uid: "app-run",
      trackKey: "app:us.zoom.xos",
      sourceKind: "app",
      app: { bundleId: "us.zoom.xos", name: "zoom.us", seenAtMs: t0 },
      startedWallMs: t0,
    }).trackRunId;
    tombstone(
      { scope: "track_run", trackRunId: mic, from: at(10), to: at(20) },
      t0 + 10_000,
      t0 + 20_000,
    );
    const open = (trackRunId: number, seconds: number) =>
      openSpeechRegion(temp.db, {
        trackRunId,
        sampleStart: at(seconds),
        wallStartMs: t0 + seconds * 1000,
        vadVersion: "v",
      }).status;
    expect([open(mic, 9), open(mic, 10), open(mic, 19.99), open(mic, 20), open(app, 15)]).toEqual([
      "inserted",
      "skipped_deleted",
      "skipped_deleted",
      "inserted",
      "inserted",
    ]);
  });

  it("keeps the voice the helper heard and refuses more than the span", () => {
    const { trackRunId } = upsertTrackRun(temp.db, micRun);
    const open = (sec: number) =>
      openSpeechRegion(temp.db, {
        trackRunId,
        sampleStart: at(sec),
        wallStartMs: t0 + sec * 1000,
        vadVersion: "v",
      });
    const close = (sec: number, voicedSamples?: number | null) =>
      closeSpeechRegion(temp.db, {
        trackRunId,
        sampleStart: at(sec),
        sampleEnd: at(sec + 2),
        wallEndMs: t0 + (sec + 2) * 1000,
        endReason: "silence",
        ...(voicedSamples === undefined ? {} : { voicedSamples }),
      });
    const voiced = (sec: number) =>
      temp.db.orm
        .select({ voicedSamples: speechRegions.voicedSamples })
        .from(speechRegions)
        .where(eq(speechRegions.sampleStart, at(sec)))
        .get()?.voicedSamples;

    open(1);
    expect(close(1, rate).status).toBe("updated");
    expect(voiced(1)).toBe(rate);

    // Closed by an older helper, which did not report it.
    open(5);
    expect(close(5).status).toBe("updated");
    expect(voiced(5)).toBeNull();

    open(9);
    expect(() => close(9, 2 * rate + 1)).toThrow(RangeError);
    expect(() => close(9, -1)).toThrow(RangeError);
    expect(voiced(9)).toBeNull();
  });

  it("gives a clamped region its share of the voice", () => {
    const { trackRunId } = upsertTrackRun(temp.db, micRun);
    openSpeechRegion(temp.db, {
      trackRunId,
      sampleStart: at(5),
      wallStartMs: t0 + 5000,
      vadVersion: "v",
    });
    tombstone({ scope: "all" }, t0 + 8000, t0 + 60_000);
    const closed = closeSpeechRegion(temp.db, {
      trackRunId,
      sampleStart: at(5),
      sampleEnd: at(12),
      wallEndMs: t0 + 12_000,
      endReason: "silence",
      voicedSamples: 7 * rate,
    });
    expect(closed.status).toBe("clamped");
    expect(temp.db.orm.select().from(speechRegions).get()).toMatchObject({
      sampleEnd: at(8),
      voicedSamples: 3 * rate,
    });
  });

  it("clamps a region whose close crosses a deleted range, or drops it", () => {
    const { trackRunId } = upsertTrackRun(temp.db, micRun);
    openSpeechRegion(temp.db, {
      trackRunId,
      sampleStart: at(5),
      wallStartMs: t0 + 5000,
      vadVersion: "v",
    });
    tombstone({ scope: "all" }, t0 + 8000, t0 + 60_000);
    const closed = closeSpeechRegion(temp.db, {
      trackRunId,
      sampleStart: at(5),
      sampleEnd: at(12),
      wallEndMs: t0 + 12_000,
      endReason: "silence",
    });
    expect(closed.status).toBe("clamped");
    const region = temp.db.orm.select().from(speechRegions).get();
    expect(region).toMatchObject({
      state: "closed",
      sampleEnd: at(8),
      wallEndMs: t0 + 8000,
      endReason: "deleted",
    });
    expect(
      closeSpeechRegion(temp.db, {
        trackRunId,
        sampleStart: at(5),
        sampleEnd: at(12),
        wallEndMs: t0 + 12_000,
        endReason: "silence",
      }).status,
    ).toBe("duplicate");

    openSpeechRegion(temp.db, {
      trackRunId,
      sampleStart: at(70),
      wallStartMs: t0 + 70_000,
      vadVersion: "v",
    });
    tombstone(
      { scope: "track_run", trackRunId, from: at(65), to: at(80) },
      t0 + 65_000,
      t0 + 80_000,
    );
    expect(
      closeSpeechRegion(temp.db, {
        trackRunId,
        sampleStart: at(70),
        sampleEnd: at(75),
        wallEndMs: t0 + 75_000,
        endReason: "silence",
      }).status,
    ).toBe("skipped_deleted");
    expect(count(temp.db, "speech_regions")).toBe(1);
    expect(
      closeSpeechRegion(temp.db, {
        trackRunId,
        sampleStart: at(70),
        sampleEnd: at(75),
        wallEndMs: t0 + 75_000,
        endReason: "silence",
      }).status,
    ).toBe("unknown");
  });

  it("skips gaps that intersect a deleted range", () => {
    tombstone({ scope: "all" }, t0, t0 + 1000);
    expect(
      recordGap(temp.db, {
        trackKey: "system:other",
        reason: "helper_exit",
        wallStartMs: t0 + 500,
        wallEndMs: t0 + 5000,
      }).status,
    ).toBe("skipped_deleted");
    expect(
      recordGap(temp.db, {
        trackKey: "system:other",
        reason: "helper_exit",
        wallStartMs: t0 + 1000,
        wallEndMs: t0 + 5000,
      }).status,
    ).toBe("inserted");
    expect(
      recordGap(temp.db, { reason: "core_exit", wallStartMs: t0 + 2000, wallEndMs: t0 + 2000 })
        .status,
    ).toBe("inserted");
    expect(
      recordGap(temp.db, { reason: "core_exit", wallStartMs: t0 + 2000, wallEndMs: t0 + 2000 })
        .status,
    ).toBe("duplicate");
  });
});
