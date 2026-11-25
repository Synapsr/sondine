import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  closeSpeechRegion,
  closeSpoolFile,
  openSpeechRegion,
  recordGap,
  recordSpoolCommit,
  recordSpoolFile,
  samplesToMs,
  upsertTrackRun,
  type Database,
} from "@sondine/db";
import { encodeJsonLine, ManifestRecord, type ManifestRecordWire } from "@sondine/protocol";
import { crc32 } from "../src/core/audio/pcm-io";
import type { RetentionLayout } from "../src/core/retention/layout";
import { DATA_LAYOUT } from "../src/shared/data-layout";

// A spool on disk as the helper writes it (PCM files and their manifests),
// with the rows a live importer would have recorded. Samples are a known
// function of (run, index), so a test can check every sample it reads back.

export const RATE = 16_000;
export const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
const SESSION = "11111111-2222-4333-8444-555555555555";
const TRACK_KEY = "input:BuiltInMicrophoneDevice";
const TRACK_DIR = "input-BuiltInMicrophoneDevice";

/** The sample a fixture run holds at `index`. */
export function sampleAt(salt: number, index: number): number {
  return ((index * 37 + salt * 1_009) % 65_536) - 32_768;
}

export function layoutOf(dataDir: string): RetentionLayout {
  return { dataDir, spoolDir: DATA_LAYOUT.spoolDir, archiveDir: DATA_LAYOUT.archiveDir };
}

/** `B` is a committed block, `g` a block-long gap (no bytes, a gap record). */
export type FilePattern = string;

export interface FixtureFile {
  readonly id: number;
  readonly seq: number;
  readonly relPath: string;
  readonly manifest: string;
  readonly pcm: string;
  readonly startSample: number;
  readonly endSample: number;
  /** Chunk ids in byte order. */
  readonly chunkIds: number[];
}

let runs = 0;

export class SpoolFixture {
  constructor(
    readonly db: Database,
    readonly dataDir: string,
    /** Samples per committed block (the helper commits 2 s; tests use shorter blocks). */
    readonly blockSamples = 4_000,
  ) {}

  run(options: { readonly startedWallMs?: number } = {}): FixtureRun {
    runs += 1;
    const uid = `00000000-0000-4000-8000-${String(runs).padStart(12, "0")}`;
    const startedWallMs = options.startedWallMs ?? T0;
    const trackRunId = upsertTrackRun(this.db, {
      uid,
      trackKey: TRACK_KEY,
      sourceKind: "input",
      startedWallMs,
      nowMs: startedWallMs,
    }).trackRunId;
    return new FixtureRun(this, uid, trackRunId, runs, startedWallMs);
  }
}

export class FixtureRun {
  readonly files: FixtureFile[] = [];
  private nextSample = 0;

  constructor(
    readonly fixture: SpoolFixture,
    readonly uid: string,
    readonly id: number,
    readonly salt: number,
    readonly startedWallMs: number,
  ) {}

  get dir(): string {
    return join(this.fixture.dataDir, DATA_LAYOUT.spoolDir, TRACK_DIR, this.uid);
  }

  wallAt(sample: number): number {
    return this.startedWallMs + samplesToMs(sample, RATE);
  }

  /** The run's samples [from, to) as they were captured. */
  expected(from: number, to: number): Int16Array {
    return Int16Array.from({ length: to - from }, (_, offset) =>
      sampleAt(this.salt, from + offset),
    );
  }

  /**
   * Writes the next spool file: `pattern` blocks from the end of the previous
   * one, imported (chunks and gaps) unless `importCommits` is false, closed
   * unless `closed` is false.
   */
  file(
    pattern: FilePattern,
    options: {
      readonly closed?: boolean;
      readonly importCommits?: boolean;
      readonly createdWallMs?: number;
    } = {},
  ): FixtureFile {
    const { db, blockSamples } = this.fixture;
    const seq = this.files.length;
    const stem = String(seq).padStart(4, "0");
    const startSample = this.nextSample;
    const relPath = `${DATA_LAYOUT.spoolDir}/${TRACK_DIR}/${this.uid}/${stem}.pcm`;
    mkdirSync(this.dir, { recursive: true });
    const pcm = join(this.dir, `${stem}.pcm`);
    const manifest = join(this.dir, `${stem}.jsonl`);
    const createdWallMs = options.createdWallMs ?? this.wallAt(startSample);
    const spoolFileId = recordSpoolFile(db, {
      trackRunId: this.id,
      seq,
      relPath,
      sampleStart: startSample,
      createdWallMs,
    }).spoolFileId;
    const records: ManifestRecordWire[] = [header(this.uid, seq, startSample, createdWallMs)];
    const chunkIds: number[] = [];
    const bytes: Uint8Array[] = [];
    let offset = 0;
    let sample = startSample;
    let commit = 0;
    for (const kind of pattern) {
      if (kind === "g") {
        records.push({
          type: "gap",
          reason: "ring-overflow",
          fromSample: sample,
          toSample: sample + blockSamples,
        });
        if (options.importCommits !== false) {
          recordGap(db, {
            trackRunId: this.id,
            trackKey: TRACK_KEY,
            reason: "ring_overflow",
            wallStartMs: this.wallAt(sample),
            wallEndMs: this.wallAt(sample + blockSamples),
            sampleStart: sample,
            sampleEnd: sample + blockSamples,
          });
        }
        sample += blockSamples;
        continue;
      }
      const block = new Uint8Array(this.expected(sample, sample + blockSamples).buffer);
      const crc = crc32(block);
      bytes.push(block);
      offset += block.length;
      records.push({
        type: "commit",
        seq: commit,
        epoch: 1,
        committedOffset: offset,
        sampleIndex: sample,
        sampleCount: blockSamples,
        crc32: crc,
        at: clockAt(sample),
      });
      commit += 1;
      if (options.importCommits !== false) {
        const chunk = recordSpoolCommit(db, {
          spoolFileId,
          byteOffset: offset - block.length,
          byteLength: block.length,
          sampleStart: sample,
          wallMs: this.wallAt(sample),
          crc32: crc,
        });
        if (chunk.chunkId !== null) chunkIds.push(chunk.chunkId);
      }
      sample += blockSamples;
    }
    writeFileSync(pcm, Buffer.concat(bytes));
    writeFileSync(manifest, records.map(line).join(""));
    if (options.closed !== false) {
      closeSpoolFile(db, { spoolFileId, closedWallMs: this.wallAt(sample) });
    }
    this.nextSample = sample;
    const file = {
      id: spoolFileId,
      seq,
      relPath,
      manifest,
      pcm,
      startSample,
      endSample: sample,
      chunkIds,
    };
    this.files.push(file);
    return file;
  }

  /**
   * A speech region [start, end): recorded in the manifest of `recordIn`
   * (default: the file holding its last sample) and imported unless `imported`
   * is false; `open` leaves it open in the database and out of the manifests.
   */
  region(
    start: number,
    end: number,
    options: {
      readonly imported?: boolean;
      readonly open?: boolean;
      readonly recordIn?: number;
    } = {},
  ): void {
    const { db } = this.fixture;
    if (options.imported !== false) {
      openSpeechRegion(db, {
        trackRunId: this.id,
        sampleStart: start,
        wallStartMs: this.wallAt(start),
        vadVersion: "test",
      });
      if (options.open === true) return;
      closeSpeechRegion(db, {
        trackRunId: this.id,
        sampleStart: start,
        sampleEnd: end,
        wallEndMs: this.wallAt(end),
        endReason: "silence",
      });
    }
    if (options.open === true) return;
    const holder =
      options.recordIn === undefined
        ? this.files.findLast((file) => file.startSample < end)
        : this.files[options.recordIn];
    if (holder === undefined) throw new Error("no file to record the region in");
    appendFileSync(
      holder.manifest,
      line({
        type: "region",
        regionId: `22222222-0000-4000-8000-${String(start).padStart(12, "0")}`,
        startSample: start,
        endSample: end,
        closeReason: "silence",
        speechProbability: { mean: 0.8, max: 0.95 },
        level: { mean: -30, peak: -12 },
      }),
    );
  }

  close(): void {
    upsertTrackRun(this.fixture.db, {
      uid: this.uid,
      trackKey: TRACK_KEY,
      sourceKind: "input",
      startedWallMs: this.startedWallMs,
      state: "closed",
      endedWallMs: this.wallAt(this.nextSample),
      endReason: "stopped",
      sampleEnd: this.nextSample,
      nowMs: this.wallAt(this.nextSample),
    });
  }
}

function header(
  runId: string,
  seq: number,
  startSample: number,
  wallMs: number,
): ManifestRecordWire {
  return {
    type: "header",
    format: "sondine-spool",
    version: 1,
    sessionId: SESSION,
    trackKey: TRACK_KEY,
    runId,
    epoch: 1,
    file: `${String(seq).padStart(4, "0")}.pcm`,
    sequence: seq,
    startSample,
    rate: RATE,
    channels: 1,
    sampleFormat: "s16le",
    timebase: { numer: 125, denom: 3 },
    anchor: { ...clockAt(startSample), wallNs: `${wallMs}000000` },
    helperVersion: "0.1.0",
  };
}

// 16 kHz: one sample is 62.5 µs; host ticks at 24 MHz are 1.5 per µs.
function clockAt(sample: number) {
  return {
    hostTicks: String(1_000_000 + sample * 1_500),
    continuousNs: String(5_000_000_000 + sample * 62_500),
  };
}

function line(record: ManifestRecordWire): string {
  const encoded = encodeJsonLine(ManifestRecord, ManifestRecord.parse(record));
  if (!encoded.ok) throw new Error(encoded.error.message);
  return encoded.line;
}
