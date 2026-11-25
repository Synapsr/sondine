import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeSpeechRegion,
  openDatabase,
  openSpeechRegion,
  recordCallActive,
  recordListenActive,
  recordSpanEnded,
  recordEpoch,
  recordSpoolCommit,
  recordSpoolFile,
  upsertApp,
  upsertTrackRun,
  type Database,
  type OpenedDatabase,
  type TrackSourceKind,
} from "@sondine/db";
import { migrationsDir } from "./support";

// Capture rows on a synthetic timeline, written through the real import
// functions: times are seconds after a boot, so continuous time and wall time
// stay consistent the way the helper reports them.

export const RATE = 16_000;
export const CHUNK_SECONDS = 2;

export interface TempDb {
  readonly db: OpenedDatabase;
  readonly path: string;
  reopen(): OpenedDatabase;
  cleanup(): void;
}

export function tempDb(): TempDb {
  const dir = mkdtempSync(join(tmpdir(), "sondine-core-"));
  const path = join(dir, "sondine.db");
  const opened = [openDatabase(path, { migrationsFolder: migrationsDir })];
  const first = opened[0];
  if (first === undefined) throw new Error("unreachable");
  return {
    db: first,
    path,
    reopen() {
      const db = openDatabase(path, { migrationsFolder: migrationsDir });
      opened.push(db);
      return db;
    },
    cleanup() {
      for (const db of opened) db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let uid = 0;

export interface Run {
  readonly trackRunId: number;
  readonly trackKey: string;
  readonly sourceKind: TrackSourceKind;
  /** Seconds after boot of the run's sample 0. */
  readonly startSec: number;
  readonly spoolFileId: number;
}

/** A boot whose continuous clock read zero at `bootWallMs`. */
export class Boot {
  constructor(
    readonly db: Database,
    readonly bootWallMs: number,
  ) {}

  wallMs(sec: number): number {
    return this.bootWallMs + Math.round(sec * 1000);
  }

  continuousUs(sec: number): number {
    return Math.round(sec * 1_000_000);
  }

  run(options: {
    readonly trackKey?: string;
    readonly sourceKind?: TrackSourceKind;
    readonly bundleId?: string;
    readonly startSec: number;
  }): Run {
    uid += 1;
    const sourceKind = options.sourceKind ?? "input";
    const trackKey = options.trackKey ?? "input:BuiltInMicrophoneDevice";
    const { trackRunId } = upsertTrackRun(this.db, {
      uid: `00000000-0000-4000-8000-${String(uid).padStart(12, "0")}`,
      trackKey,
      sourceKind,
      ...(options.bundleId === undefined
        ? {}
        : { app: { bundleId: options.bundleId, seenAtMs: this.wallMs(options.startSec) } }),
      startedWallMs: this.wallMs(options.startSec),
      nowMs: this.wallMs(options.startSec),
    });
    recordEpoch(this.db, {
      trackRunId,
      seq: 1,
      reason: "run_start",
      sampleStart: 0,
      timebaseNumer: 125,
      timebaseDenom: 3,
      anchorHostTicks: BigInt(this.continuousUs(options.startSec)) * 24n,
      anchorContinuousUs: this.continuousUs(options.startSec),
      anchorWallMs: this.wallMs(options.startSec),
    });
    const { spoolFileId } = recordSpoolFile(this.db, {
      trackRunId,
      seq: 0,
      relPath: `spool/${trackKey.replace(":", "-")}/${trackRunId}/0000.pcm`,
      sampleStart: 0,
      createdWallMs: this.wallMs(options.startSec),
    });
    return { trackRunId, trackKey, sourceKind, startSec: options.startSec, spoolFileId };
  }

  sample(run: Run, sec: number): number {
    return Math.round((sec - run.startSec) * RATE);
  }

  /** Commits 2 s chunks covering `[fromSec, toSec)` of the run (relative to boot). */
  chunks(run: Run, fromSec: number, toSec: number): void {
    for (let sec = fromSec; sec < toSec; sec += CHUNK_SECONDS) {
      const sampleStart = this.sample(run, sec);
      const sampleCount = CHUNK_SECONDS * RATE;
      recordSpoolCommit(this.db, {
        spoolFileId: run.spoolFileId,
        byteOffset: sampleStart * 2,
        byteLength: sampleCount * 2,
        sampleStart,
        continuousUs: this.continuousUs(sec),
        wallMs: this.wallMs(sec),
        crc32: 0,
      });
    }
  }

  /**
   * A speech region; `endSec` null leaves it open. `clocks: false` stands for
   * a region recovered from a manifest, which has no continuous times;
   * `attributedTo` for a `system:other` region the attribution named an app for.
   */
  region(
    run: Run,
    startSec: number,
    endSec: number | null,
    options: {
      readonly clocks?: boolean;
      readonly attributedTo?: string;
      /** The voice the helper heard, in seconds; the whole span when omitted. */
      readonly voicedSec?: number;
    } = {},
  ): number {
    const clocks = options.clocks ?? true;
    const attributedTo = options.attributedTo;
    const opened = openSpeechRegion(this.db, {
      trackRunId: run.trackRunId,
      sampleStart: this.sample(run, startSec),
      wallStartMs: this.wallMs(startSec),
      ...(clocks ? { continuousStartUs: this.continuousUs(startSec) } : {}),
      vadVersion: "test/1",
      attributedAppId:
        attributedTo === undefined
          ? null
          : upsertApp(this.db, { bundleId: attributedTo, seenAtMs: this.wallMs(startSec) }).appId,
    });
    if (opened.speechRegionId === null) throw new Error(`region refused: ${opened.status}`);
    if (endSec !== null) this.close(run, startSec, endSec, options);
    return opened.speechRegionId;
  }

  close(
    run: Run,
    startSec: number,
    endSec: number,
    options: { readonly clocks?: boolean; readonly voicedSec?: number } = {},
  ): void {
    closeSpeechRegion(this.db, {
      trackRunId: run.trackRunId,
      sampleStart: this.sample(run, startSec),
      sampleEnd: this.sample(run, endSec),
      wallEndMs: this.wallMs(endSec),
      ...((options.clocks ?? true) ? { continuousEndUs: this.continuousUs(endSec) } : {}),
      endReason: "silence",
      ...(options.voicedSec === undefined
        ? {}
        : { voicedSamples: Math.round(options.voicedSec * RATE) }),
    });
  }

  /** A call the helper reported from `fromSec`, ended at `toSec` (null: still active). */
  call(uid: string, bundleId: string, fromSec: number, toSec: number | null): void {
    const clock = (sec: number) => ({
      wallMs: this.wallMs(sec),
      continuousUs: this.continuousUs(sec),
    });
    recordCallActive(this.db, {
      uid,
      sessionId: "session-1",
      bundleId,
      via: "call_app",
      inputDeviceUid: "BuiltInMicrophoneDevice",
      at: clock(fromSec),
      nowMs: this.wallMs(fromSec),
    });
    if (toSec !== null) {
      recordSpanEnded(this.db, "calls", { uid, at: clock(toSec), nowMs: this.wallMs(toSec) });
    }
  }

  /** An app the helper reported listening from `fromSec` to `toSec` (null: still listening). */
  listen(uid: string, bundleId: string, fromSec: number, toSec: number | null): void {
    const clock = (sec: number) => ({
      wallMs: this.wallMs(sec),
      continuousUs: this.continuousUs(sec),
    });
    recordListenActive(this.db, {
      uid,
      sessionId: "session-1",
      bundleId,
      via: "app",
      at: clock(fromSec),
      nowMs: this.wallMs(fromSec),
    });
    if (toSec !== null) {
      recordSpanEnded(this.db, "listens", { uid, at: clock(toSec), nowMs: this.wallMs(toSec) });
    }
  }

  endRun(run: Run, endSec: number): void {
    upsertTrackRun(this.db, {
      uid: this.uidOf(run),
      trackKey: run.trackKey,
      sourceKind: run.sourceKind,
      startedWallMs: this.wallMs(run.startSec),
      state: "closed",
      endedWallMs: this.wallMs(endSec),
      endReason: "stopped",
      sampleEnd: this.sample(run, endSec),
      nowMs: this.wallMs(endSec),
    });
  }

  private uidOf(run: Run): string {
    const row = this.db.statement("SELECT uid FROM track_runs WHERE id = ?").get(run.trackRunId);
    const value = row?.["uid"];
    if (typeof value !== "string") throw new Error("unknown run");
    return value;
  }
}

export function rows(db: Database, sql: string, ...params: (number | string)[]) {
  return db.client.prepare(sql).all(...params);
}

export function scalar(db: Database, sql: string, ...params: (number | string)[]) {
  const [row] = rows(db, sql, ...params);
  return row === undefined ? undefined : Object.values(row)[0];
}
