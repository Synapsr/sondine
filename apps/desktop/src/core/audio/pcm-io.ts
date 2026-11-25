import {
  closeSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  writeSync,
} from "node:fs";
import { endianness } from "node:os";
import { dirname } from "node:path";
import { crc32 as zlibCrc32 } from "node:zlib";

// File access for spool and archive PCM (raw PCM16 LE, 16 kHz mono). Reads
// and writes are synchronous like the rest of core's database work: callers
// do one bounded unit at a time and yield between units.

// Samples are copied straight into Int16Arrays, which use the host's byte order.
if (endianness() !== "LE") throw new Error("Sondine's PCM I/O expects a little-endian host");

/** CRC-32/ISO-HDLC, the value spool commit records carry (zlib's `crc32`). */
export function crc32(bytes: Uint8Array): number {
  return zlibCrc32(bytes) >>> 0;
}

/** One block to read from a file into `target` at `targetOffset`, checked against `crc32`. */
export interface BlockRead {
  readonly position: number;
  readonly length: number;
  readonly crc32: number;
  readonly target: Uint8Array;
  readonly targetOffset: number;
}

/**
 * Reads blocks of one open file, merging neighbours that are contiguous both
 * on disk and in their target into one `read`, then checks each block's CRC.
 * Returns, per block, whether its bytes arrived intact; a failed block's
 * target bytes are zeroed.
 */
export function readBlocks(fd: number, blocks: readonly BlockRead[]): boolean[] {
  const ok = blocks.map(() => false);
  const order = blocks
    .map((block, index) => ({ block, index }))
    .toSorted((a, b) => a.block.position - b.block.position);
  let from = 0;
  while (from < order.length) {
    const first = order[from];
    if (first === undefined) break;
    let length = first.block.length;
    let to = from + 1;
    for (; to < order.length; to++) {
      const candidate = order[to]?.block;
      if (
        candidate === undefined ||
        candidate.target !== first.block.target ||
        candidate.position !== first.block.position + length ||
        candidate.targetOffset !== first.block.targetOffset + length
      ) {
        break;
      }
      length += candidate.length;
    }
    const got = readFully(
      fd,
      first.block.target,
      first.block.targetOffset,
      length,
      first.block.position,
    );
    for (const { block, index } of order.slice(from, to)) {
      const bytes = block.target.subarray(block.targetOffset, block.targetOffset + block.length);
      const complete = block.position + block.length <= first.block.position + got;
      if (complete && crc32(bytes) === block.crc32) ok[index] = true;
      else bytes.fill(0);
    }
    from = to;
  }
  return ok;
}

/** Reads up to `length` bytes at `position`; fewer only at the end of the file. */
export function readFully(
  fd: number,
  target: Uint8Array,
  offset: number,
  length: number,
  position: number,
): number {
  let done = 0;
  while (done < length) {
    const got = readSync(fd, target, offset + done, length - done, position + done);
    if (got === 0) break;
    done += got;
  }
  return done;
}

/** Whether an fs error says the path is not there. */
export function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** The error's code (`ENOENT`, `EIO`…) or name: never a path or content. */
export function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string") return code;
  return error instanceof Error ? error.name : "unknown error";
}

export function withFile<T>(path: string, flags: string, use: (fd: number) => T): T {
  const fd = openSync(path, flags);
  try {
    return use(fd);
  } finally {
    closeSync(fd);
  }
}

/** Syncs a directory, so a rename or unlink inside it survives a power loss. */
export function fsyncDirectory(path: string): void {
  withFile(path, "r", (fd) => fsyncSync(fd));
}

/** Steps of a durable write, for crash tests. */
export type DurableWriteStep = "tmp-written" | "tmp-synced" | "renamed" | "dir-synced";

/**
 * Writes `parts` to `path` so that a crash leaves either the old file or the
 * whole new one: `path.tmp`, fsync, rename, fsync of the directory. Creates
 * missing directories (0700).
 */
export function writeFileDurably(
  path: string,
  parts: readonly Uint8Array[],
  afterStep?: (step: DurableWriteStep) => void,
): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  withFile(tmp, "w", (fd) => {
    for (const part of parts) {
      let done = 0;
      while (done < part.length) done += writeSync(fd, part, done, part.length - done);
    }
    afterStep?.("tmp-written");
    fsyncSync(fd);
  });
  afterStep?.("tmp-synced");
  renameSync(tmp, path);
  afterStep?.("renamed");
  fsyncDirectory(directory);
  afterStep?.("dir-synced");
}

/**
 * Overwrites byte ranges of a file with zeros and syncs it, never past its
 * end. Returns false when the file is gone (nothing left to scrub).
 */
export function zeroRanges(
  path: string,
  ranges: readonly { readonly position: number; readonly length: number }[],
): boolean {
  if (ranges.length === 0) return true;
  let fd: number;
  try {
    fd = openSync(path, "r+");
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  try {
    const size = fstatSync(fd).size;
    const longest = Math.max(...ranges.map((range) => range.length));
    const zeros = new Uint8Array(longest);
    for (const range of ranges) {
      const length = Math.min(range.length, size - range.position);
      let done = 0;
      while (done < length) {
        done += writeSync(fd, zeros, 0, length - done, range.position + done);
      }
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}
