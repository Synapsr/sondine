import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { trackAudioRows, type Database, type TrackAudioChunk } from "@sondine/db";
import { BYTES_PER_SAMPLE } from "@sondine/protocol";
import { isMissing, readBlocks, type BlockRead } from "./pcm-io";
import type {
  MissingReason,
  MissingSpan,
  ReadTrackAudio,
  TrackAudio,
  TrackAudioRange,
} from "./track-audio";

// Reads a run's samples back from the spool (`present` chunks) or the archive
// (`archived`), whole chunks at a time so every CRC is checked, with one read
// per run of contiguous chunks. Whatever cannot be read is zero-filled and
// listed with its reason. An archived chunk whose archive fails falls back to
// the spool while the spool file still holds it.

/** The reader for a data directory; spool and archive paths are relative to it. */
export function createTrackAudioReader(db: Database, dataDir: string): ReadTrackAudio {
  return (range) => readTrackAudio(db, dataDir, range);
}

interface Job {
  readonly chunk: TrackAudioChunk;
  readonly source: "spool" | "archive";
  /** Part of the chunk inside the range. */
  readonly from: number;
  readonly to: number;
  readonly read: BlockRead;
  /** Whole chunk inside the range: read straight into the output. */
  readonly direct: boolean;
}

export function readTrackAudio(db: Database, dataDir: string, range: TrackAudioRange): TrackAudio {
  const { trackRunId, sampleStart: start, sampleEnd: end } = range;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw new RangeError(`Invalid sample range [${start}, ${end})`);
  }
  const samples = new Int16Array(end - start);
  if (end === start) return { samples, missing: [] };
  const output = new Uint8Array(samples.buffer);
  const rows = trackAudioRows(db, trackRunId, start, end);
  const missing: MissingSpan[] = [];
  const miss = (sampleStart: number, sampleEnd: number, reason: MissingReason) => {
    if (sampleEnd > sampleStart) missing.push({ sampleStart, sampleEnd, reason });
  };

  const fromArchive: Job[] = [];
  const fromSpool: Job[] = [];
  let cursor = start;
  for (const chunk of rows.chunks) {
    const from = Math.max(chunk.sampleStart, cursor);
    const to = Math.min(chunk.sampleStart + chunk.sampleCount, end);
    if (to <= from) continue;
    holes(cursor, from, rows.gaps, miss);
    cursor = to;
    if (chunk.audioState === "expired" || chunk.audioState === "deleted") {
      miss(from, to, chunk.audioState);
    } else if (chunk.audioState === "archived") {
      fromArchive.push(job(chunk, from, to, start, output, "archive"));
    } else {
      fromSpool.push(job(chunk, from, to, start, output, "spool"));
    }
  }
  holes(cursor, end, rows.gaps, miss);

  const retry: Job[] = [];
  for (const failed of runJobs(dataDir, fromArchive, start, output)) {
    // The archive is missing or damaged; the spool may still hold the bytes.
    if (failed.chunk.spoolState === "open" || failed.chunk.spoolState === "closed") {
      retry.push(job(failed.chunk, failed.from, failed.to, start, output, "spool"));
    } else {
      miss(failed.from, failed.to, "corrupt");
    }
  }
  for (const failed of runJobs(dataDir, [...fromSpool, ...retry], start, output)) {
    miss(failed.from, failed.to, "corrupt");
  }

  // A tombstone always wins, whatever the chunk states say.
  let spans = missing;
  for (const tombstone of rows.deleted) {
    const from = Math.max(tombstone.sampleStart, start);
    const to = Math.min(tombstone.sampleEnd, end);
    if (to <= from) continue;
    output.fill(0, (from - start) * BYTES_PER_SAMPLE, (to - start) * BYTES_PER_SAMPLE);
    spans = [...subtract(spans, from, to), { sampleStart: from, sampleEnd: to, reason: "deleted" }];
  }
  return { samples, missing: merge(spans) };
}

function job(
  chunk: TrackAudioChunk,
  from: number,
  to: number,
  start: number,
  output: Uint8Array,
  source: Job["source"],
): Job {
  const direct = from === chunk.sampleStart && to === chunk.sampleStart + chunk.sampleCount;
  const position = source === "archive" ? (chunk.archiveByteOffset ?? -1) : chunk.byteOffset;
  return {
    chunk,
    from,
    to,
    direct,
    source,
    read: {
      position,
      length: chunk.byteLength,
      crc32: chunk.crc32,
      target: direct ? output : new Uint8Array(chunk.byteLength),
      targetOffset: direct ? (from - start) * BYTES_PER_SAMPLE : 0,
    },
  };
}

/** Runs the jobs file by file; returns the ones that failed (their output stays zero). */
function runJobs(dataDir: string, jobs: readonly Job[], start: number, output: Uint8Array): Job[] {
  const byFile = new Map<string, Job[]>();
  const failed: Job[] = [];
  for (const entry of jobs) {
    const path = entry.source === "archive" ? entry.chunk.archiveRelPath : entry.chunk.spoolRelPath;
    if (path === null || entry.read.position < 0) {
      failed.push(entry);
      continue;
    }
    const list = byFile.get(path);
    if (list === undefined) byFile.set(path, [entry]);
    else list.push(entry);
  }
  for (const [relPath, list] of byFile) {
    let fd: number;
    try {
      fd = openSync(join(dataDir, relPath), "r");
    } catch (error) {
      if (!isMissing(error)) throw error;
      failed.push(...list);
      continue;
    }
    let ok: boolean[];
    try {
      ok = readBlocks(
        fd,
        list.map((entry) => entry.read),
      );
    } finally {
      closeSync(fd);
    }
    list.forEach((entry, index) => {
      if (ok[index] !== true) {
        failed.push(entry);
        return;
      }
      if (entry.direct) return;
      const skip = (entry.from - entry.chunk.sampleStart) * BYTES_PER_SAMPLE;
      const length = (entry.to - entry.from) * BYTES_PER_SAMPLE;
      output.set(
        entry.read.target.subarray(skip, skip + length),
        (entry.from - start) * BYTES_PER_SAMPLE,
      );
    });
  }
  return failed;
}

/** Samples no chunk holds: a recorded gap, or nothing at all. */
function holes(
  from: number,
  to: number,
  gaps: readonly { readonly sampleStart: number; readonly sampleEnd: number }[],
  miss: (start: number, end: number, reason: MissingReason) => void,
): void {
  let cursor = from;
  for (const gap of gaps) {
    if (gap.sampleEnd <= cursor || gap.sampleStart >= to) continue;
    const gapStart = Math.max(gap.sampleStart, cursor);
    miss(cursor, gapStart, "unrecorded");
    const gapEnd = Math.min(gap.sampleEnd, to);
    miss(gapStart, gapEnd, "gap");
    cursor = Math.max(cursor, gapEnd);
  }
  miss(cursor, to, "unrecorded");
}

function subtract(spans: readonly MissingSpan[], from: number, to: number): MissingSpan[] {
  return spans.flatMap((span) => {
    if (span.sampleEnd <= from || span.sampleStart >= to) return [span];
    const parts: MissingSpan[] = [];
    if (span.sampleStart < from) parts.push({ ...span, sampleEnd: from });
    if (span.sampleEnd > to) parts.push({ ...span, sampleStart: to });
    return parts;
  });
}

/** In order, with touching spans of the same reason joined. */
function merge(spans: readonly MissingSpan[]): MissingSpan[] {
  const merged: MissingSpan[] = [];
  for (const span of spans.toSorted((a, b) => a.sampleStart - b.sampleStart)) {
    const last = merged.at(-1);
    if (last !== undefined && last.reason === span.reason && last.sampleEnd === span.sampleStart) {
      merged[merged.length - 1] = { ...last, sampleEnd: span.sampleEnd };
    } else {
      merged.push(span);
    }
  }
  return merged;
}
