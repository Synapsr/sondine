import { createHash, type Hash } from "node:crypto";
import { open, rm, type FileHandle } from "node:fs/promises";
import * as z from "zod";
import {
  BackupProtection,
  FrameRejected,
  newProtection,
  openProtection,
  type FrameCodec,
} from "./backup-crypto";
import { BLOCK, parseTarHeader, tarEnd, tarHeader, tarPadding } from "./tar";

// A `.sondine` file (ADR 048):
//
//   "SONDINE\0BACKUP\0\0"   16 bytes
//   u32 BE                  length of the clear header
//   clear header            JSON: format, protection (« none » or the passphrase's parameters)
//   frames                  u32 BE sealed length, u8 flags (1 = last), sealed bytes
//
// The frames carry a tar stream, 1 MiB at a time: `summary.json` first (what
// the restore screen shows, readable from the first frame), then the data
// directory's files, then `manifest.json` with every file's size and
// SHA-256. The last frame holds only the SHA-256 of the clear header and the
// whole tar stream. A missing last frame, a frame out of place, a file whose
// hash differs: the backup is refused before anything replaces the data.

const MAGIC = Buffer.from("SONDINE\0BACKUP\0\0", "latin1");
export const BACKUP_FORMAT = 1;
export const FRAME_BYTES = 1024 * 1024;
/** A frame is never larger than its plaintext and the tag; anything else is damage. */
const MAX_SEALED_BYTES = FRAME_BYTES + 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const DIGEST_BYTES = 32;
export const SUMMARY_NAME = "summary.json";
export const MANIFEST_NAME = "manifest.json";

export const BACKUP_EXTENSION = "sondine";

const ClearHeader = z.strictObject({
  format: z.literal(BACKUP_FORMAT),
  frameBytes: z.literal(FRAME_BYTES),
  protection: BackupProtection,
});
type ClearHeader = z.output<typeof ClearHeader>;

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const BackupSummary = z.strictObject({
  appVersion: z.string().max(64),
  createdAtMs: z.number().int().nonnegative(),
  /** The Mac's name as macOS gives it, shown before a restore. */
  macName: z.string().max(256),
  includeAudio: z.boolean(),
  migrations: z.array(z.strictObject({ name: z.string().max(200), hash: Sha256 })).max(10_000),
  counts: z.strictObject({
    episodes: z.number().int().nonnegative(),
    people: z.number().int().nonnegative(),
    audioMs: z.number().int().nonnegative(),
    contextItems: z.number().int().nonnegative(),
    firstEpisodeAtMs: z.number().int().nullable(),
    lastEpisodeAtMs: z.number().int().nullable(),
  }),
  /** Model artifacts installed on the Mac that made it: not in the backup, offered after a restore. */
  models: z.array(z.string().max(200)).max(200),
  /** The files' bytes, for the restore's space check and progress. */
  bytes: z.number().int().nonnegative(),
});
export type BackupSummary = z.output<typeof BackupSummary>;

const Manifest = z.strictObject({
  files: z.array(
    z.strictObject({ name: z.string(), size: z.number().int().nonnegative(), sha256: Sha256 }),
  ),
});

export class BackupFormatError extends Error {
  override readonly name = "BackupFormatError";
  constructor(
    readonly reason: "not-a-backup" | "damaged" | "unsupported",
    message: string,
  ) {
    super(message);
  }
}

const damaged = (message: string) => new BackupFormatError("damaged", message);

function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

// ——— Writing ———

export interface BackupWriterOptions {
  readonly path: string;
  readonly passphrase: string | null;
  readonly summary: BackupSummary;
  readonly signal?: AbortSignal;
  /** Plaintext bytes written so far, after each frame. */
  readonly onProgress?: (bytes: number) => void;
}

/** Writes a backup to `path`, a file it creates (never one that exists). */
export class BackupWriter {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private index = 0;
  private written = 0;
  private readonly files: { name: string; size: number; sha256: string }[] = [];
  private finished = false;

  private constructor(
    private readonly handle: FileHandle,
    private readonly options: BackupWriterOptions,
    private readonly codec: FrameCodec,
    private readonly stream: Hash,
  ) {}

  static async create(options: BackupWriterOptions): Promise<BackupWriter> {
    const { protection, codec } = await newProtection(options.passphrase);
    const header = Buffer.from(
      JSON.stringify({
        format: BACKUP_FORMAT,
        frameBytes: FRAME_BYTES,
        protection,
      } satisfies ClearHeader),
      "utf8",
    );
    const handle = await open(options.path, "wx", 0o600);
    const writer = new BackupWriter(
      handle,
      options,
      codec(header),
      createHash("sha256").update(header),
    );
    try {
      await handle.write(Buffer.concat([MAGIC, u32(header.length), header]));
      await writer.addBuffer(
        SUMMARY_NAME,
        Buffer.from(JSON.stringify(BackupSummary.parse(options.summary)), "utf8"),
      );
    } catch (error) {
      await writer.abort();
      throw error;
    }
    return writer;
  }

  addBuffer(name: string, bytes: Buffer, mtimeMs = Date.now()): Promise<void> {
    return this.addFile(name, bytes.length, [bytes], mtimeMs);
  }

  /** Adds a file of exactly `size` bytes, read from `chunks`. */
  async addFile(
    name: string,
    size: number,
    chunks: AsyncIterable<Buffer> | Iterable<Buffer>,
    mtimeMs = Date.now(),
  ): Promise<void> {
    await this.push(tarHeader(name, size, mtimeMs));
    const hash = createHash("sha256");
    let seen = 0;
    for await (const chunk of chunks) {
      seen += chunk.length;
      if (seen > size) throw new BackupFormatError("damaged", `${name} grew while it was copied`);
      hash.update(chunk);
      await this.push(chunk);
    }
    if (seen !== size) throw new BackupFormatError("damaged", `${name} shrank while it was copied`);
    await this.push(Buffer.alloc(tarPadding(size)));
    this.files.push({ name, size, sha256: hash.digest("hex") });
  }

  /** Writes the manifest, the tar end and the last frame, then syncs and closes. */
  async finish(): Promise<void> {
    await this.addBuffer(MANIFEST_NAME, Buffer.from(JSON.stringify({ files: this.files }), "utf8"));
    await this.push(tarEnd());
    await this.flush();
    const digest = this.stream.digest();
    await this.frame(digest, true);
    await this.handle.sync();
    await this.handle.close();
    this.finished = true;
  }

  /** Stops and removes what was written. */
  async abort(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    await this.handle.close().catch(() => undefined);
    await rm(this.options.path, { force: true });
  }

  private async push(bytes: Buffer): Promise<void> {
    if (bytes.length === 0) return;
    this.options.signal?.throwIfAborted();
    this.stream.update(bytes);
    let rest = bytes;
    while (rest.length > 0) {
      const room = FRAME_BYTES - this.pendingBytes;
      const part = rest.subarray(0, room);
      this.pending.push(part);
      this.pendingBytes += part.length;
      rest = rest.subarray(part.length);
      if (this.pendingBytes === FRAME_BYTES) await this.flush();
    }
  }

  private async flush(): Promise<void> {
    if (this.pendingBytes === 0) return;
    const plain = Buffer.concat(this.pending, this.pendingBytes);
    this.pending = [];
    this.pendingBytes = 0;
    await this.frame(plain, false);
    this.written += plain.length;
    this.options.onProgress?.(this.written);
  }

  private async frame(plain: Buffer, final: boolean): Promise<void> {
    const sealed = this.codec.seal(this.index, final, plain);
    this.index += 1;
    const head = Buffer.alloc(5);
    head.writeUInt32BE(sealed.length, 0);
    head.writeUInt8(final ? 1 : 0, 4);
    await this.handle.write(Buffer.concat([head, sealed]));
  }
}

// ——— Reading ———

async function readExactly(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, done, length - done, position + done);
    if (bytesRead === 0) break;
    done += bytesRead;
  }
  return done === length ? buffer : buffer.subarray(0, done);
}

/** Pulls exact byte counts from the frames' plaintext. */
class PlainStream {
  private buffered: Buffer[] = [];
  private bufferedBytes = 0;
  private index = 0;
  private position: number;
  private ended = false;
  /** The last frame's digest, once reached. */
  digest: Buffer | null = null;

  constructor(
    private readonly handle: FileHandle,
    start: number,
    private readonly codec: FrameCodec,
    private readonly hash: Hash,
    private readonly signal: () => AbortSignal | undefined,
    readonly onFrame: (position: number) => void,
  ) {
    this.position = start;
  }

  /** Bytes of the file read so far. */
  get offset(): number {
    return this.position;
  }

  private async nextFrame(): Promise<boolean> {
    if (this.ended) return false;
    this.signal()?.throwIfAborted();
    const head = await readExactly(this.handle, this.position, 5);
    if (head.length < 5) throw damaged("the backup ends before its last frame");
    const length = head.readUInt32BE(0);
    const flags = head.readUInt8(4);
    if (length > MAX_SEALED_BYTES || (flags & ~1) !== 0) throw damaged("frame header");
    const sealed = await readExactly(this.handle, this.position + 5, length);
    if (sealed.length < length) throw damaged("the backup ends inside a frame");
    const final = flags === 1;
    let plain: Buffer;
    try {
      plain = this.codec.open(this.index, final, sealed);
    } catch (error) {
      if (error instanceof FrameRejected) throw damaged(`frame ${this.index} is not intact`);
      throw error;
    }
    this.index += 1;
    this.position += 5 + length;
    this.onFrame(this.position);
    if (final) {
      if (plain.length !== DIGEST_BYTES) throw damaged("last frame");
      this.digest = plain;
      this.ended = true;
      return false;
    }
    this.buffered.push(plain);
    this.bufferedBytes += plain.length;
    return true;
  }

  /** Exactly `length` bytes, or fewer only if the frames end. */
  async read(length: number): Promise<Buffer> {
    while (this.bufferedBytes < length && (await this.nextFrame()));
    const all = Buffer.concat(this.buffered, this.bufferedBytes);
    const out = all.subarray(0, Math.min(length, all.length));
    const rest = all.subarray(out.length);
    this.buffered = rest.length > 0 ? [rest] : [];
    this.bufferedBytes = rest.length;
    this.hash.update(out);
    return out;
  }

  /** Up to `max` bytes as soon as a frame has them. */
  async readSome(max: number): Promise<Buffer> {
    if (this.bufferedBytes === 0) await this.nextFrame();
    return this.read(Math.min(max, this.bufferedBytes));
  }

  /** Reads the frame after the tar's end: only the last one may follow. */
  async drain(): Promise<void> {
    if (this.bufferedBytes > 0 || (await this.nextFrame())) {
      throw damaged("bytes after the archive's end");
    }
  }
}

export interface OpenedBackup {
  readonly summary: BackupSummary;
  readonly protected: boolean;
  /** The file's size, for progress. */
  readonly fileBytes: number;
  /**
   * Reads every file after the summary into `sink`, then checks the manifest
   * and the stream's digest. `accept` refuses a name before any byte of it
   * is written; anything refused or unchecked throws.
   */
  extract(handlers: {
    readonly accept: (name: string, size: number) => boolean;
    readonly sink: (name: string, size: number) => Promise<FileSink>;
    readonly onProgress?: (fileBytesRead: number) => void;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  close(): Promise<void>;
}

export interface FileSink {
  write(bytes: Buffer): Promise<void>;
  end(): Promise<void>;
}

/** Reads the clear header only: whether the backup needs a passphrase. */
export async function readProtection(path: string): Promise<BackupProtection> {
  const handle = await open(path, "r");
  try {
    return (await readHeader(handle)).header.protection;
  } finally {
    await handle.close();
  }
}

async function readHeader(
  handle: FileHandle,
): Promise<{ header: ClearHeader; bytes: Buffer; end: number }> {
  const start = await readExactly(handle, 0, MAGIC.length + 4);
  if (start.length < MAGIC.length + 4 || !start.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new BackupFormatError("not-a-backup", "not a Sondine backup");
  }
  const length = start.readUInt32BE(MAGIC.length);
  if (length > MAX_HEADER_BYTES) throw damaged("clear header");
  const bytes = await readExactly(handle, start.length, length);
  if (bytes.length < length) throw damaged("clear header");
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw damaged("clear header");
  }
  const format =
    typeof value === "object" && value !== null ? (value as { format?: unknown }).format : null;
  if (typeof format === "number" && format > BACKUP_FORMAT) {
    throw new BackupFormatError("unsupported", "a newer backup format");
  }
  const parsed = ClearHeader.safeParse(value);
  if (!parsed.success) throw damaged("clear header");
  return { header: parsed.data, bytes, end: start.length + length };
}

/**
 * Opens a backup and reads its summary. Throws `WrongPassphrase` when the
 * passphrase is missing or not its own, `BackupFormatError` otherwise.
 */
export async function openBackup(path: string, passphrase: string | null): Promise<OpenedBackup> {
  const handle = await open(path, "r");
  try {
    const fileBytes = (await handle.stat()).size;
    const { header, bytes, end } = await readHeader(handle);
    const codec = await openProtection(header.protection, passphrase, bytes);
    let onFrame: (position: number) => void = () => undefined;
    let signal: AbortSignal | undefined;
    const hash = createHash("sha256").update(bytes);
    const stream = new PlainStream(
      handle,
      end,
      codec,
      hash,
      () => signal,
      (position) => onFrame(position),
    );
    const readEntry = async () => {
      const block = await stream.read(BLOCK);
      if (block.length < BLOCK) throw damaged("the archive ends early");
      try {
        return parseTarHeader(block);
      } catch {
        throw damaged("tar header");
      }
    };
    const first = await readEntry();
    if (first === null || first.name !== SUMMARY_NAME || first.size > MAX_HEADER_BYTES) {
      throw damaged("summary");
    }
    const summaryBytes = await stream.read(first.size + tarPadding(first.size));
    const summaryText = summaryBytes.subarray(0, first.size);
    let summaryValue: unknown;
    try {
      summaryValue = JSON.parse(summaryText.toString("utf8"));
    } catch {
      throw damaged("summary");
    }
    const summary = BackupSummary.safeParse(summaryValue);
    if (!summary.success) throw damaged("summary");
    const summarySha = createHash("sha256").update(summaryText).digest("hex");

    return {
      summary: summary.data,
      protected: header.protection.kind !== "none",
      fileBytes,
      async extract(handlers) {
        signal = handlers.signal;
        onFrame = (position) => handlers.onProgress?.(position);
        const seen = new Map<string, { size: number; sha256: string }>([
          [SUMMARY_NAME, { size: first.size, sha256: summarySha }],
        ]);
        let manifest: z.output<typeof Manifest> | null = null;
        for (;;) {
          const entry = await readEntry();
          if (entry === null) break;
          if (manifest !== null) throw damaged("a file after the manifest");
          if (seen.has(entry.name)) throw damaged(`${entry.name} twice`);
          if (entry.name === MANIFEST_NAME) {
            if (entry.size > 64 * 1024 * 1024) throw damaged("manifest");
            const raw = await stream.read(entry.size + tarPadding(entry.size));
            try {
              manifest = Manifest.parse(JSON.parse(raw.subarray(0, entry.size).toString("utf8")));
            } catch {
              throw damaged("manifest");
            }
            continue;
          }
          if (!handlers.accept(entry.name, entry.size)) {
            throw damaged(`unexpected file in the backup: ${entry.name}`);
          }
          const sink = await handlers.sink(entry.name, entry.size);
          const fileHash = createHash("sha256");
          let left = entry.size;
          while (left > 0) {
            const part = await stream.readSome(Math.min(left, FRAME_BYTES));
            if (part.length === 0) throw damaged("the archive ends inside a file");
            fileHash.update(part);
            await sink.write(part);
            left -= part.length;
          }
          await sink.end();
          const padding = tarPadding(entry.size);
          if (padding > 0 && (await stream.read(padding)).length < padding) {
            throw damaged("the archive ends inside a file");
          }
          seen.set(entry.name, { size: entry.size, sha256: fileHash.digest("hex") });
        }
        // The second empty block of the tar's end.
        const second = await stream.read(BLOCK);
        if (second.length < BLOCK || second.some((byte) => byte !== 0)) throw damaged("tar end");
        const expected = hash.copy().digest();
        await stream.drain();
        if (stream.digest === null || !stream.digest.equals(expected)) {
          throw damaged("the stream's digest differs");
        }
        if (manifest === null) throw damaged("no manifest");
        if (manifest.files.length !== seen.size) throw damaged("manifest and files differ");
        for (const file of manifest.files) {
          const actual = seen.get(file.name);
          if (actual === undefined || actual.size !== file.size || actual.sha256 !== file.sha256) {
            throw damaged(`${file.name} differs from the manifest`);
          }
        }
      },
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}
