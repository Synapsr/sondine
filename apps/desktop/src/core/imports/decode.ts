import { execFile } from "node:child_process";
import { readSync } from "node:fs";

// An audio file the user imports, as Sondine keeps audio: 16 kHz mono
// s16le. macOS's `afconvert` reads what Core Audio reads (m4a, mp3, wav,
// aiff, caf, aac) and resamples into a 16-bit WAV with the file's channels;
// the channels are averaged here (`afconvert -c 1` drops them instead).

export const IMPORT_SAMPLE_RATE = 16_000;
/** The longest recording an import takes. */
export const MAX_IMPORT_SECONDS = 4 * 3_600;
const AFCONVERT = "/usr/bin/afconvert";

export type DecodeProblem = "unreadable" | "too-long" | "empty";

export class DecodeError extends Error {
  override readonly name = "DecodeError";
  constructor(
    readonly problem: DecodeProblem,
    message: string,
  ) {
    super(message);
  }
}

/** Converts `input` to a 16 kHz 16-bit WAV at `output`, keeping its channels. */
export function convertToWav(
  input: string,
  output: string,
  timeoutMs = 20 * 60_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      AFCONVERT,
      ["-f", "WAVE", "-d", `LEI16@${IMPORT_SAMPLE_RATE}`, input, output],
      { timeout: timeoutMs },
      (error) =>
        error === null
          ? resolve()
          : reject(new DecodeError("unreadable", "afconvert could not read the file")),
    );
  });
}

/** Where a WAV's samples are, from its header. */
export interface WavLayout {
  readonly channels: number;
  readonly sampleRate: number;
  readonly dataOffset: number;
  /** Bytes of samples, whole frames only. */
  readonly dataBytes: number;
}

function read(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const count = readSync(fd, buffer, 0, length, position);
  return buffer.subarray(0, count);
}

/** Reads a 16-bit PCM WAV's header: its `fmt ` and `data` chunks. */
export function readWavLayout(fd: number, fileBytes: number): WavLayout {
  const head = read(fd, 0, 12);
  if (
    head.length < 12 ||
    head.toString("ascii", 0, 4) !== "RIFF" ||
    head.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new DecodeError("unreadable", "not a WAV file");
  }
  let position = 12;
  let format: { channels: number; sampleRate: number; bits: number } | null = null;
  while (position + 8 <= fileBytes) {
    const chunk = read(fd, position, 8);
    if (chunk.length < 8) break;
    const id = chunk.toString("ascii", 0, 4);
    const size = chunk.readUInt32LE(4);
    const body = position + 8;
    if (id === "fmt ") {
      const fields = read(fd, body, 16);
      format = {
        channels: fields.readUInt16LE(2),
        sampleRate: fields.readUInt32LE(4),
        bits: fields.readUInt16LE(14),
      };
    } else if (id === "data") {
      if (format === null || format.bits !== 16 || format.channels < 1) {
        throw new DecodeError("unreadable", "the converted file is not 16-bit PCM");
      }
      const frameBytes = format.channels * 2;
      const available = Math.min(size, fileBytes - body);
      return {
        channels: format.channels,
        sampleRate: format.sampleRate,
        dataOffset: body,
        dataBytes: available - (available % frameBytes),
      };
    }
    // Chunks are padded to an even length.
    position = body + size + (size % 2);
  }
  throw new DecodeError("unreadable", "the converted file has no samples");
}

/** Mono frames, `blockFrames` at a time (the last block may be shorter), channels averaged. */
export function* monoBlocks(
  fd: number,
  layout: WavLayout,
  blockFrames: number,
): Generator<Int16Array> {
  const frameBytes = layout.channels * 2;
  const frames = layout.dataBytes / frameBytes;
  for (let start = 0; start < frames; start += blockFrames) {
    const count = Math.min(blockFrames, frames - start);
    const bytes = read(fd, layout.dataOffset + start * frameBytes, count * frameBytes);
    const mono = new Int16Array(count);
    for (let frame = 0; frame < count; frame += 1) {
      let sum = 0;
      for (let channel = 0; channel < layout.channels; channel += 1) {
        sum += bytes.readInt16LE((frame * layout.channels + channel) * 2);
      }
      mono[frame] = Math.round(sum / layout.channels);
    }
    yield mono;
  }
}
