import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ImportPickResult } from "@sondine/api";
import type { ImportedChunk, PhoneArrival } from "@sondine/db";
import { parsePhoneRecordingHeader, type PhoneRecordingHeader } from "@sondine/protocol";
import { crc32 } from "../audio/pcm-io";
import {
  convertToWav,
  DecodeError,
  IMPORT_SAMPLE_RATE,
  MAX_IMPORT_SECONDS,
  monoBlocks,
  readWavLayout,
} from "./decode";

// One imported audio file, made ready to publish (ADR 021): checked, then
// decoded in a private staging folder of the data directory, its 16 kHz mono
// PCM written to the archive under a `.tmp` name and synced, in 2 s blocks
// with their CRC. Publishing renames it and writes its rows in one
// transaction (`importRecording`), under retention's lock; anything that
// fails takes its files along. A crash leaves only the staging folder, which
// the next start empties, and a `.tmp` (or an archive file no row names),
// which retention's startup recovery removes.
//
// A file the iPhone app recorded carries its header in the comment tag
// (ADR 032), which `afinfo -i` prints: read first, with the file's SHA-256,
// so a duplicate or a refused id costs no decoding. It then starts at the
// header's time when that is plausible.

export type ImportProblem = "unreadable" | "too-long" | "empty" | "disk-full";

export class ImportFailure extends Error {
  override readonly name = "ImportFailure";
  constructor(
    readonly problem: ImportProblem,
    message: string,
  ) {
    super(message);
  }
}

export interface ImportPaths {
  /** Absolute data directory. */
  readonly dataDir: string;
  /** Spool and archive roots, relative to it. */
  readonly spoolDir: string;
  readonly archiveDir: string;
  /** Absolute private folder for decoding, emptied at each start. */
  readonly stagingDir: string;
}

/** The archive and spool folder imported recordings use (`<root>/imports/<runId>/0001.pcm`). */
const TRACK_DIR = "imports";
/** Samples per archive block: 2 s, as the helper commits. */
const BLOCK_SAMPLES = 2 * IMPORT_SAMPLE_RATE;
/** Room left on the volume beyond what the import writes. */
const DISK_MARGIN_BYTES = 512 * 1024 ** 2;

export interface PreparedImport {
  readonly uid: string;
  readonly fileName: string;
  readonly sampleCount: number;
  readonly startedWallMs: number;
  /** A phone recording whose header's time was not plausible: it ends when it arrived. */
  readonly timeUncertain: boolean;
  readonly archiveRelPath: string;
  readonly spoolRelPath: string;
  readonly chunks: readonly ImportedChunk[];
  /** The archive file, still `.tmp`, and the name it takes once published. */
  readonly tmpPath: string;
  readonly finalPath: string;
}

/** What `afinfo` says of a file: its length and channels; null when it cannot tell. */
export function parseAfinfo(output: string): { seconds: number; channels: number } | null {
  const match = /([\d.]+) sec, format:\s+(\d+) ch/.exec(output);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  const seconds = Number.parseFloat(match[1]);
  const channels = Number.parseInt(match[2], 10);
  return Number.isFinite(seconds) && channels > 0 ? { seconds, channels } : null;
}

function afinfo(path: string, flag: "-b" | "-i"): Promise<string> {
  return new Promise((resolve) => {
    execFile("/usr/bin/afinfo", [flag, path], { timeout: 30_000, encoding: "utf8" }, (_e, stdout) =>
      resolve(stdout ?? ""),
    );
  });
}

/** The file's comment tag as `afinfo -i` prints it (`comments : "…"`); null when it has none. */
export function parseAfinfoComment(output: string): string | null {
  const match = /^\s*comments\s*: "(.*)"\s*$/m.exec(output);
  return match?.[1] ?? null;
}

/** What makes a file a phone recording: its header, and its bytes' SHA-256 (hex). */
export interface PhoneFile {
  readonly header: PhoneRecordingHeader;
  readonly sha256: string;
}

function sha256Of(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** The iPhone app's header in `path`; null for any other file. */
export async function readPhoneHeader(path: string): Promise<PhoneRecordingHeader | null> {
  return parsePhoneRecordingHeader(parseAfinfoComment(await afinfo(path, "-i")));
}

/** Reads the iPhone app's header from `path`; null for any other file. */
export async function readPhoneFile(path: string): Promise<PhoneFile | null> {
  const header = await readPhoneHeader(path);
  return header === null ? null : { header, sha256: await sha256Of(path) };
}

/** Whether `afinfo` can tell the file's length: a phone's file must say it before any decoding (ADR 008). */
export async function lengthReadable(path: string): Promise<boolean> {
  return parseAfinfo(await afinfo(path, "-b")) !== null;
}

/** What the window hears of a phone recording this Mac already knows; null to import it. */
export function answerForArrival(arrival: PhoneArrival): ImportPickResult | null {
  switch (arrival.kind) {
    case "new":
      return null;
    case "duplicate":
      return arrival.episodeId === null
        ? { outcome: "failed", problem: "internal" }
        : { outcome: "already", episodeId: arrival.episodeId };
    case "conflict":
    case "deleted":
      return { outcome: "failed", problem: arrival.kind };
  }
}

/** No phone recording is dated before this: the app did not exist. */
export const EARLIEST_PHONE_MS = Date.UTC(2025, 0, 1);
/** How far after its arrival a phone recording may end, for clocks a little apart. */
export const PHONE_CLOCK_TOLERANCE_MS = 5 * 60_000;

/**
 * When a phone recording started: its header's time, unless that is not
 * plausible (it would end after the Mac received it, beyond 5 minutes, or
 * start before 2025); then it ends when it arrived, and the time is uncertain.
 */
export function phoneStartOf(
  headerMs: number,
  durationMs: number,
  receivedMs: number,
): { readonly startedWallMs: number; readonly uncertain: boolean } {
  const plausible =
    headerMs >= EARLIEST_PHONE_MS && headerMs + durationMs <= receivedMs + PHONE_CLOCK_TOLERANCE_MS;
  return plausible
    ? { startedWallMs: headerMs, uncertain: false }
    : { startedWallMs: Math.floor(receivedMs) - durationMs, uncertain: true };
}

/**
 * When the recording started: its file's last change minus its length (most
 * recorders write the file as they record), unless that is impossible; then
 * it ends now.
 */
export function startOf(modifiedMs: number, durationMs: number, nowMs: number): number {
  // File times carry fractions of a millisecond; the database keeps whole ones.
  const start = Math.floor(modifiedMs) - durationMs;
  const plausible = start >= Date.UTC(2000, 0, 1) && modifiedMs <= nowMs;
  return plausible ? start : Math.floor(nowMs) - durationMs;
}

/** Empties the staging folder: what an interrupted import decoded. */
export function clearStaging(paths: ImportPaths): void {
  rmSync(paths.stagingDir, { recursive: true, force: true });
}

/**
 * Checks, decodes and writes the archive file of `path`; throws
 * `ImportFailure`. `phone`: the header read from it, for its start.
 */
export async function prepareImport(
  path: string,
  paths: ImportPaths,
  nowMs: number,
  phone: PhoneRecordingHeader | null = null,
): Promise<PreparedImport> {
  const info = parseAfinfo(await afinfo(path, "-b"));
  if (info !== null && info.seconds > MAX_IMPORT_SECONDS) {
    throw new ImportFailure("too-long", "the recording is longer than 4 hours");
  }
  if (info !== null) {
    // The decoded WAV (its channels) and the mono archive, side by side.
    const needed = Math.ceil(info.seconds * IMPORT_SAMPLE_RATE * 2 * (info.channels + 1));
    const volume = statfsSync(paths.dataDir);
    if (volume.bavail * volume.bsize < needed + DISK_MARGIN_BYTES) {
      throw new ImportFailure("disk-full", "not enough room on the disk for this recording");
    }
  }
  const uid = randomUUID();
  const staging = join(paths.stagingDir, uid);
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  const wavPath = join(staging, "decoded.wav");
  const archiveRelPath = `${paths.archiveDir}/${TRACK_DIR}/${uid}/0001.pcm`;
  const finalPath = join(paths.dataDir, archiveRelPath);
  const tmpPath = `${finalPath}.tmp`;
  try {
    try {
      await convertToWav(path, wavPath);
    } catch (error) {
      if (error instanceof DecodeError) throw new ImportFailure("unreadable", error.message);
      throw error;
    }
    const wav = openSync(wavPath, "r");
    try {
      const layout = readWavLayout(wav, fstatSync(wav).size);
      const sampleCount = layout.dataBytes / (layout.channels * 2);
      if (layout.sampleRate !== IMPORT_SAMPLE_RATE) {
        throw new ImportFailure("unreadable", "the file did not convert to 16 kHz");
      }
      if (sampleCount === 0) throw new ImportFailure("empty", "the recording holds no sound");
      if (sampleCount > MAX_IMPORT_SECONDS * IMPORT_SAMPLE_RATE) {
        throw new ImportFailure("too-long", "the recording is longer than 4 hours");
      }
      mkdirSync(dirname(finalPath), { recursive: true, mode: 0o700 });
      const out = openSync(tmpPath, "w", 0o600);
      const chunks: ImportedChunk[] = [];
      try {
        let sampleStart = 0;
        for (const block of monoBlocks(wav, layout, BLOCK_SAMPLES)) {
          const bytes = new Uint8Array(block.buffer, block.byteOffset, block.byteLength);
          writeSync(out, bytes, 0, bytes.length, sampleStart * 2);
          chunks.push({
            sampleStart,
            sampleCount: block.length,
            byteOffset: sampleStart * 2,
            crc32: crc32(bytes),
          });
          sampleStart += block.length;
        }
        fsyncSync(out);
      } finally {
        closeSync(out);
      }
      const durationMs = Math.round((sampleCount * 1000) / IMPORT_SAMPLE_RATE);
      const start =
        phone === null
          ? { startedWallMs: startOf(statSync(path).mtimeMs, durationMs, nowMs), uncertain: false }
          : phoneStartOf(phone.startedWallMs, durationMs, nowMs);
      return {
        uid,
        fileName: basename(path).slice(0, 200),
        sampleCount,
        startedWallMs: start.startedWallMs,
        timeUncertain: start.uncertain,
        archiveRelPath,
        spoolRelPath: `${paths.spoolDir}/${TRACK_DIR}/${uid}/0001.pcm`,
        chunks,
        tmpPath,
        finalPath,
      };
    } finally {
      closeSync(wav);
    }
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Publishes a prepared import: the archive file takes its name, then `write`
 * stores its rows. If `write` throws, the file goes again. Call it under
 * retention's lock.
 */
export function publishImport<A>(prepared: PreparedImport, write: () => A): A {
  renameSync(prepared.tmpPath, prepared.finalPath);
  const directory = openSync(dirname(prepared.finalPath), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
  try {
    return write();
  } catch (error) {
    unlinkSync(prepared.finalPath);
    throw error;
  }
}

/** Removes a prepared import that will not be published. */
export function discardImport(prepared: PreparedImport): void {
  rmSync(prepared.tmpPath, { force: true });
  rmSync(prepared.finalPath, { force: true });
}
