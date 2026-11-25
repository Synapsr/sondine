import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, sep } from "node:path";
import type { ContextPreview } from "@sondine/db";

// Files added to a conversation (ADR 024), on disk: copied (an APFS clone
// when the volume allows) into a staging folder of the data directory,
// hashed there, then renamed to `<context>/<sha256>`, so two items with the
// same bytes share one file. An image gets one preview made by `sips`
// (offline), upright, at most 1,568 px, without its metadata (an iPhone
// photo's place and camera). Nothing here logs a file's name or path.

/** Largest file Sondine keeps. */
export const MAX_CONTEXT_FILE_BYTES = 1024 ** 3;
/** Room left on the volume beyond a copy, as imports keep (ADR 021). */
export const CONTEXT_DISK_MARGIN_BYTES = 512 * 1024 ** 2;
/** A preview's longest side. */
export const PREVIEW_MAX_SIDE = 1568;
/** A preview's largest size: what an agent receives as an image. */
export const PREVIEW_MAX_BYTES = 1024 ** 2;
/** Images larger than this are kept as files: decoding them would cost too much memory. */
export const PREVIEW_MAX_PIXELS = 100_000_000;
const SIPS_TIMEOUT_MS = 20_000;
/** The folders main may open copies from: `<tmp>/sondine-open-…`. */
export const OPEN_COPY_PREFIX = "sondine-open-";

export interface ContextPaths {
  /** The data directory: no source may come from inside it, but the staging folder. */
  readonly dataDir: string;
  /** `<data>/context`: the files, by SHA-256. */
  readonly root: string;
  readonly previews: string;
  readonly staging: string;
  /** Where open copies go (the system's temporary folder). */
  readonly tmpDir: string;
}

export type ContextFileProblem =
  /** Not a regular file, unreadable, or Sondine's own data. */
  "unreadable" | "too-large" | "disk-full";

export class ContextFileFailure extends Error {
  override readonly name = "ContextFileFailure";
  constructor(readonly problem: ContextFileProblem) {
    super(problem);
  }
}

export interface StagedFile {
  readonly stagedPath: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mediaType: string;
  /** The name to show: the source's base name, made safe. */
  readonly name: string;
}

const SHA256 = /^[0-9a-f]{64}$/;

/** A file name safe to show and to write: no folders, no control characters, at most 200 characters. */
export function safeFileName(name: string): string {
  const cleaned = [...basename(name)]
    .map((char) =>
      (char.codePointAt(0) ?? 0) < 0x20 || char === "\u007f" || "/\\:".includes(char) ? " " : char,
    )
    .join("")
    .replace(/^\.+/u, "")
    .trim();
  return (cleaned === "" ? "fichier" : cleaned).slice(0, 200);
}

const EXTENSION_TYPES: Readonly<Record<string, string>> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".pdf": "application/pdf",
  ".rtf": "application/rtf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".pages": "application/vnd.apple.pages",
  ".numbers": "application/vnd.apple.numbers",
  ".key": "application/vnd.apple.keynote",
  ".zip": "application/zip",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".aiff": "audio/aiff",
  ".aif": "audio/aiff",
  ".caf": "audio/x-caf",
  ".aac": "audio/aac",
  ".m4b": "audio/mp4",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
};

/**
 * Documents an agent gets as they are (ADR 024): a PDF, a word processor's,
 * a spreadsheet's or a presentation's file. Never an image (its preview,
 * without metadata, goes instead), audio, video, or bytes of no known type.
 */
export const AGENT_DOCUMENT_TYPES: ReadonlySet<string> = new Set([
  "application/pdf",
  "application/rtf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.apple.pages",
  "application/vnd.apple.numbers",
  "application/vnd.apple.keynote",
]);

const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);

/** The media type from a file's first bytes, else from its extension. */
export function sniffMediaType(head: Uint8Array, name: string): string {
  const ascii = (from: number, to: number) =>
    Buffer.from(head.subarray(from, to)).toString("latin1");
  if (head[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(4, 8) === "ftyp" && HEIF_BRANDS.has(ascii(8, 12))) return "image/heic";
  if (ascii(0, 4) === "II*\u0000" || ascii(0, 4) === "MM\u0000*") return "image/tiff";
  if (ascii(0, 2) === "BM" && head.length >= 26) return "image/bmp";
  if (ascii(0, 5) === "%PDF-") return "application/pdf";
  return EXTENSION_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";
}

/** Types `sips` may turn into a preview. */
export const isImageType = (mediaType: string) =>
  [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/heic",
    "image/tiff",
    "image/bmp",
  ].includes(mediaType);

async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function headOf(path: string, length = 64): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const buffer = new Uint8Array(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Makes a rename durable: the folder's entry is on disk before the row that names it. */
async function syncFolder(path: string): Promise<void> {
  try {
    await syncFile(path);
  } catch {
    // Some volumes refuse to fsync a folder; the rename stands anyway.
  }
}

const inside = (path: string, folder: string) => path === folder || path.startsWith(folder + sep);

export async function ensureContextFolders(paths: ContextPaths): Promise<void> {
  for (const folder of [paths.root, paths.previews, paths.staging]) {
    await mkdir(folder, { recursive: true, mode: 0o700 });
  }
}

/**
 * Copies a file the user chose into staging and hashes the copy: what
 * Sondine keeps, whatever the source becomes. The source is followed once
 * through its links (`realpath`), must be a regular file of at most 1 GiB,
 * and must not be Sondine's own data, but a pasted image main wrote to
 * staging, which is moved rather than copied.
 */
export async function stageFile(
  source: string,
  paths: ContextPaths,
  options: { readonly name?: string } = {},
): Promise<StagedFile> {
  let real: string;
  try {
    real = await realpath(source);
  } catch {
    throw new ContextFileFailure("unreadable");
  }
  const dataDir = await realpath(paths.dataDir).catch(() => paths.dataDir);
  const staging = await realpath(paths.staging).catch(() => paths.staging);
  const fromStaging = inside(real, staging) && real !== staging;
  if (inside(real, dataDir) && !fromStaging) throw new ContextFileFailure("unreadable");
  const info = await lstat(real).catch(() => null);
  if (info === null || !info.isFile()) throw new ContextFileFailure("unreadable");
  if (info.size > MAX_CONTEXT_FILE_BYTES) throw new ContextFileFailure("too-large");
  const name = safeFileName(options.name ?? basename(source));
  const stagedPath = join(paths.staging, randomUUID());
  try {
    if (fromStaging) {
      await rename(real, stagedPath);
    } else {
      try {
        // An APFS clone: no space, no time; refused across volumes.
        await copyFile(real, stagedPath, constants.COPYFILE_FICLONE_FORCE);
      } catch {
        const free = await statfs(paths.staging);
        if (free.bavail * free.bsize < info.size + CONTEXT_DISK_MARGIN_BYTES) {
          throw new ContextFileFailure("disk-full");
        }
        await copyFile(real, stagedPath);
      }
    }
    const copied = await stat(stagedPath);
    if (copied.size > MAX_CONTEXT_FILE_BYTES) throw new ContextFileFailure("too-large");
    await syncFile(stagedPath);
    const [sha256, head] = await Promise.all([sha256Of(stagedPath), headOf(stagedPath)]);
    return {
      stagedPath,
      sha256,
      bytes: copied.size,
      mediaType: sniffMediaType(head, name),
      name,
    };
  } catch (error) {
    await rm(stagedPath, { force: true });
    if (error instanceof ContextFileFailure) throw error;
    if (error instanceof Error && "code" in error && error.code === "ENOSPC") {
      throw new ContextFileFailure("disk-full");
    }
    throw new ContextFileFailure("unreadable");
  }
}

/**
 * Moves a staged file to `<context>/<sha256>` and its preview to
 * `previews/`, or drops them when those bytes are there already. Runs in
 * the add's turn, so no collection runs between this and the rows.
 */
export async function publishStaged(
  staged: StagedFile,
  preview: StagedPreview | null,
  paths: ContextPaths,
): Promise<void> {
  const target = join(paths.root, staged.sha256);
  const existing = await stat(target).catch(() => null);
  if (existing !== null && existing.size === staged.bytes) {
    await rm(staged.stagedPath, { force: true });
  } else {
    await rename(staged.stagedPath, target);
    await syncFolder(paths.root);
  }
  if (preview === null) return;
  const shown = previewPath(paths, staged.sha256, preview.format);
  if ((await stat(shown).catch(() => null)) !== null) {
    await rm(preview.stagedPath, { force: true });
    return;
  }
  await rename(preview.stagedPath, shown);
  await syncFolder(paths.previews);
}

export const previewPath = (paths: ContextPaths, sha256: string, preview: ContextPreview) =>
  join(paths.previews, `${sha256}.${preview === "jpeg" ? "jpg" : "png"}`);

const run = (command: string, args: readonly string[]) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      command,
      [...args],
      { timeout: SIPS_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: { PATH: "/usr/bin:/bin" } },
      (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
    );
  });

/** What `sips -g` says of an image; null when it cannot read it. */
async function imageInfo(
  path: string,
): Promise<{ width: number; height: number; alpha: boolean } | null> {
  try {
    const out = await run("/usr/bin/sips", [
      "-g",
      "pixelWidth",
      "-g",
      "pixelHeight",
      "-g",
      "hasAlpha",
      path,
    ]);
    const field = (key: string) => new RegExp(`^\\s*${key}: (.+)$`, "mu").exec(out)?.[1]?.trim();
    const width = Number(field("pixelWidth"));
    const height = Number(field("pixelHeight"));
    if (!(width > 0 && height > 0)) return null;
    return { width, height, alpha: field("hasAlpha") === "yes" };
  } catch {
    return null;
  }
}

/** A JPEG's EXIF orientation (1 to 8), read from its APP1 segment; 1 when it has none. */
export function jpegOrientation(bytes: Uint8Array): number {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 2;
  while (at + 4 <= view.length && view[at] === 0xff) {
    const marker = view[at + 1] ?? 0;
    const length = view.readUInt16BE(at + 2);
    if (marker === 0xda) break;
    if (marker === 0xe1 && view.toString("latin1", at + 4, at + 10) === "Exif\u0000\u0000") {
      const tiff = at + 10;
      const little = view.toString("latin1", tiff, tiff + 2) === "II";
      const u16 = (offset: number) =>
        little ? view.readUInt16LE(offset) : view.readUInt16BE(offset);
      const u32 = (offset: number) =>
        little ? view.readUInt32LE(offset) : view.readUInt32BE(offset);
      try {
        const ifd = tiff + u32(tiff + 4);
        const entries = u16(ifd);
        for (let index = 0; index < entries; index += 1) {
          const entry = ifd + 2 + index * 12;
          if (u16(entry) === 0x0112) {
            const value = u16(entry + 8);
            return value >= 1 && value <= 8 ? value : 1;
          }
        }
      } catch {
        return 1;
      }
      return 1;
    }
    at += 2 + length;
  }
  return 1;
}

/** `sips` turns and flips that make an EXIF orientation upright. */
function uprightArgs(orientation: number): string[] {
  switch (orientation) {
    case 2:
      return ["-f", "horizontal"];
    case 3:
      return ["-r", "180"];
    case 4:
      return ["-f", "vertical"];
    case 5:
      return ["-r", "90", "-f", "horizontal"];
    case 6:
      return ["-r", "90"];
    case 7:
      return ["-r", "270", "-f", "horizontal"];
    case 8:
      return ["-r", "270"];
    default:
      return [];
  }
}

/**
 * Removes what a preview should not carry: a JPEG's APP1 to APP15 segments
 * (EXIF, XMP, IPTC: place, camera, dates) and comments, a PNG's text, time
 * and EXIF chunks. The pixels are untouched; an unknown layout is returned
 * as is only when it has no such parts.
 */
export function stripImageMetadata(bytes: Uint8Array): Uint8Array {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view[0] === 0xff && view[1] === 0xd8) {
    const parts: Buffer[] = [view.subarray(0, 2)];
    let at = 2;
    while (at + 4 <= view.length && view[at] === 0xff) {
      const marker = view[at + 1] ?? 0;
      if (marker === 0xda) break;
      const length = view.readUInt16BE(at + 2);
      const keep = !(marker >= 0xe1 && marker <= 0xef) && marker !== 0xfe;
      if (keep) parts.push(view.subarray(at, at + 2 + length));
      at += 2 + length;
    }
    parts.push(view.subarray(at));
    return Buffer.concat(parts);
  }
  if (view.toString("latin1", 1, 4) === "PNG") {
    const parts: Buffer[] = [view.subarray(0, 8)];
    let at = 8;
    const dropped = new Set(["tEXt", "zTXt", "iTXt", "tIME", "eXIf"]);
    while (at + 12 <= view.length) {
      const length = view.readUInt32BE(at);
      const type = view.toString("latin1", at + 4, at + 8);
      const end = at + 12 + length;
      if (!dropped.has(type)) parts.push(view.subarray(at, end));
      at = end;
      if (type === "IEND") break;
    }
    return Buffer.concat(parts);
  }
  return bytes;
}

/** A preview made in staging, published with its file in the add's turn. */
export interface StagedPreview {
  readonly format: ContextPreview;
  readonly stagedPath: string;
}

/**
 * Makes an image's preview in staging: upright, at most 1,568 px and 1 MiB,
 * no metadata. `publishStaged` moves it to `previews/<sha256>.jpg|png`. Null
 * when `sips` cannot read the image, it is too large to decode, or no
 * preview fits: the image is then kept as a file.
 */
export async function makePreview(
  staged: StagedFile,
  paths: ContextPaths,
): Promise<StagedPreview | null> {
  if (!isImageType(staged.mediaType)) return null;
  const info = await imageInfo(staged.stagedPath);
  if (info === null || info.width * info.height > PREVIEW_MAX_PIXELS) return null;
  const orientation =
    staged.mediaType === "image/jpeg"
      ? jpegOrientation(await headOf(staged.stagedPath, 128 * 1024))
      : 1;
  const attempts: { format: ContextPreview; side: number; quality: string }[] = [
    { format: info.alpha ? "png" : "jpeg", side: PREVIEW_MAX_SIDE, quality: "80" },
    { format: "jpeg", side: 1024, quality: "70" },
  ];
  for (const attempt of attempts) {
    const out = join(paths.staging, `${randomUUID()}.${attempt.format === "jpeg" ? "jpg" : "png"}`);
    try {
      const resize =
        Math.max(info.width, info.height) > attempt.side ? ["-Z", String(attempt.side)] : [];
      await run("/usr/bin/sips", [
        ...uprightArgs(orientation),
        ...resize,
        "-s",
        "format",
        attempt.format,
        ...(attempt.format === "jpeg" ? ["-s", "formatOptions", attempt.quality] : []),
        staged.stagedPath,
        "--out",
        out,
      ]);
      const handle = await open(out, "r");
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await handle.readFile());
      } finally {
        await handle.close();
      }
      const clean = stripImageMetadata(bytes);
      if (clean.byteLength > PREVIEW_MAX_BYTES) {
        await rm(out, { force: true });
        continue;
      }
      const write = await open(out, "w");
      try {
        await write.writeFile(clean);
        await write.sync();
      } finally {
        await write.close();
      }
      return { format: attempt.format, stagedPath: out };
    } catch {
      await rm(out, { force: true });
      continue;
    }
  }
  return null;
}

/** Empties staging: what an interrupted add left (private bytes), at each start. */
export async function clearContextStaging(paths: ContextPaths): Promise<void> {
  await rm(paths.staging, { recursive: true, force: true });
  await mkdir(paths.staging, { recursive: true, mode: 0o700 });
}

/**
 * Removes every file and preview no item and no ⌘Z step holds (`keep`), and
 * returns how many files went. A file is unlinked, not overwritten: APFS
 * writes elsewhere, so zeroing would not reach the old blocks (ADR 024).
 */
export async function collectContextFiles(
  paths: ContextPaths,
  keep: ReadonlySet<string>,
): Promise<number> {
  let removed = 0;
  for (const name of await readdir(paths.root).catch(() => [])) {
    if (!SHA256.test(name) || keep.has(name)) continue;
    await unlink(join(paths.root, name)).catch(() => undefined);
    removed += 1;
  }
  for (const name of await readdir(paths.previews).catch(() => [])) {
    const sha256 = name.split(".")[0] ?? "";
    if (SHA256.test(sha256) && keep.has(sha256)) continue;
    await unlink(join(paths.previews, name)).catch(() => undefined);
  }
  return removed;
}

/** A copy of a kept file in its own private temporary folder, for another app to open. */
export async function makeOpenCopy(
  paths: ContextPaths,
  sha256: string,
  name: string,
): Promise<{ folder: string; path: string }> {
  const folder = await mkdtemp(join(paths.tmpDir, OPEN_COPY_PREFIX));
  const path = join(folder, safeFileName(name));
  try {
    await copyFile(join(paths.root, sha256), path, constants.COPYFILE_FICLONE);
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
  return { folder, path };
}

/** Every open copy's folder, at start: what an earlier run left. */
export async function clearOpenCopies(paths: ContextPaths): Promise<void> {
  for (const name of await readdir(paths.tmpDir).catch(() => [])) {
    if (name.startsWith(OPEN_COPY_PREFIX)) {
      await rm(join(paths.tmpDir, name), { recursive: true, force: true });
    }
  }
}

/** Default paths under a data directory. */
export function contextPaths(
  dataDir: string,
  layout: { readonly root: string; readonly previews: string; readonly staging: string },
): ContextPaths {
  return {
    dataDir,
    root: join(dataDir, layout.root),
    previews: join(dataDir, layout.previews),
    staging: join(dataDir, layout.staging),
    tmpDir: tmpdir(),
  };
}

/** Up to `limit` characters of a file that reads as UTF-8 text with no NUL; null for any other file. */
export async function readTextFile(
  path: string,
  limit: number,
): Promise<{ text: string; truncated: boolean } | null> {
  // Four bytes per character at most, and a little more to tell where it ends.
  const budget = limit * 4 + 4;
  const handle = await open(path, "r");
  let bytes: Uint8Array;
  let size: number;
  try {
    size = (await handle.stat()).size;
    const buffer = new Uint8Array(Math.min(size, budget));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    bytes = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  if (bytes.includes(0)) return null;
  let text: string;
  try {
    // A cut in the middle of a character is not a reason to call it binary.
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: size > bytes.length });
  } catch {
    return null;
  }
  const truncated = size > bytes.length || text.length > limit;
  return { text: text.slice(0, limit), truncated };
}
