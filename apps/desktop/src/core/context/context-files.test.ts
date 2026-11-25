import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyText } from "./context-layer";
import {
  collectContextFiles,
  ContextFileFailure,
  ensureContextFolders,
  jpegOrientation,
  makeOpenCopy,
  makePreview,
  publishStaged,
  readTextFile,
  safeFileName,
  sniffMediaType,
  stageFile,
  stripImageMetadata,
  type ContextPaths,
} from "./context-files";

let root: string;
let paths: ContextPaths;
let outside: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "sondine-context-test-"));
  const dataDir = join(root, "data");
  outside = join(root, "user");
  mkdirSync(outside);
  paths = {
    dataDir,
    root: join(dataDir, "context"),
    previews: join(dataDir, "context/previews"),
    staging: join(dataDir, "context/staging"),
    tmpDir: join(root, "tmp"),
  };
  mkdirSync(paths.tmpDir);
  await ensureContextFolders(paths);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A JPEG with an EXIF APP1 (orientation 6, and a fake GPS-like tag) and a comment. */
function jpegWithMetadata(): Uint8Array {
  const tiff = Buffer.from([
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00,
    0x00, 0x01, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
  const exif = Buffer.concat([Buffer.from("Exif\u0000\u0000", "latin1"), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0, exif.length + 2]), exif]);
  const comment = Buffer.concat([Buffer.from([0xff, 0xfe, 0, 7]), Buffer.from("Paris", "latin1")]);
  const app0 = Buffer.from([0xff, 0xe0, 0, 4, 0x4a, 0x46]);
  const scan = Buffer.from([0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, app1, comment, scan]);
}

describe("context files", () => {
  it("tells types by their first bytes, not their names", () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    expect(sniffMediaType(png, "photo.pdf")).toBe("image/png");
    const heic = Buffer.from("\u0000\u0000\u0000\u0018ftypheic", "latin1");
    expect(sniffMediaType(heic, "IMG_1.HEIC")).toBe("image/heic");
    expect(sniffMediaType(Buffer.from("%PDF-1.7"), "x")).toBe("application/pdf");
    expect(sniffMediaType(Buffer.from("hello"), "notes.md")).toBe("text/markdown");
    expect(sniffMediaType(Buffer.from("hello"), "mystery")).toBe("application/octet-stream");
  });

  it("makes names safe to show and to write", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName(".hidden\u0007name")).toBe("hidden name");
    expect(safeFileName("")).toBe("fichier");
  });

  it("reads a JPEG's orientation and strips its metadata, pixels untouched", () => {
    const jpeg = jpegWithMetadata();
    expect(jpegOrientation(jpeg)).toBe(6);
    const clean = Buffer.from(stripImageMetadata(jpeg));
    expect(clean.includes(Buffer.from("Exif"))).toBe(false);
    expect(clean.includes(Buffer.from("Paris"))).toBe(false);
    expect(clean.includes(Buffer.from([0xff, 0xe0]))).toBe(true);
    expect(clean.subarray(-9)).toEqual(Buffer.from([0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9]));
    expect(jpegOrientation(clean)).toBe(1);
  });

  it("copies, hashes and keeps one file per content, and refuses Sondine's own data", async () => {
    const source = join(outside, "Compte rendu.txt");
    writeFileSync(source, "bonjour\n");
    const staged = await stageFile(source, paths);
    expect(staged).toMatchObject({ bytes: 8, mediaType: "text/plain", name: "Compte rendu.txt" });
    expect(staged.sha256).toMatch(/^[0-9a-f]{64}$/u);
    await publishStaged(staged, null, paths);
    const again = await stageFile(source, paths);
    await publishStaged(again, null, paths);
    expect(readdirSync(paths.root).filter((name) => /^[0-9a-f]{64}$/u.test(name))).toEqual([
      staged.sha256,
    ]);
    expect(readdirSync(paths.staging)).toEqual([]);

    writeFileSync(join(paths.dataDir, "sondine.db"), "secret");
    await expect(stageFile(join(paths.dataDir, "sondine.db"), paths)).rejects.toThrow(
      ContextFileFailure,
    );
    // A link into the data directory is followed, then refused.
    symlinkSync(join(paths.dataDir, "sondine.db"), join(outside, "link"));
    await expect(stageFile(join(outside, "link"), paths)).rejects.toThrow(ContextFileFailure);
    await expect(stageFile(outside, paths)).rejects.toThrow(ContextFileFailure);
  });

  it("moves a pasted image out of staging instead of copying it", async () => {
    const pasted = join(paths.staging, "paste-1.png");
    writeFileSync(pasted, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    const staged = await stageFile(pasted, paths, { name: "Image.png" });
    expect(staged).toMatchObject({ name: "Image.png", mediaType: "image/png" });
    expect(readdirSync(paths.staging)).toEqual([staged.stagedPath.split("/").at(-1)]);
  });

  it("collects what nothing holds, previews and open copies' files included", async () => {
    const keep = "a".repeat(64);
    const drop = "b".repeat(64);
    for (const sha of [keep, drop]) {
      writeFileSync(join(paths.root, sha), sha);
      writeFileSync(join(paths.previews, `${sha}.jpg`), sha);
    }
    expect(await collectContextFiles(paths, new Set([keep]))).toBe(1);
    expect(readdirSync(paths.root).toSorted()).toEqual([keep, "previews", "staging"].toSorted());
    expect(readdirSync(paths.previews)).toEqual([`${keep}.jpg`]);

    const copy = await makeOpenCopy(paths, keep, "../Rapport.pdf");
    expect(copy.path.startsWith(join(paths.tmpDir, "sondine-open-"))).toBe(true);
    expect(copy.path.endsWith("/Rapport.pdf")).toBe(true);
    expect(readFileSync(copy.path, "utf8")).toBe(keep);
  });

  it("reads text files for agents, and nothing else", async () => {
    const text = join(outside, "a.md");
    writeFileSync(text, "é".repeat(10));
    expect(await readTextFile(text, 4)).toEqual({ text: "éééé", truncated: true });
    expect(await readTextFile(text, 100)).toEqual({ text: "é".repeat(10), truncated: false });
    const binary = join(outside, "b.bin");
    writeFileSync(binary, Buffer.from([0x61, 0, 0x62]));
    expect(await readTextFile(binary, 100)).toBeNull();
    const latin = join(outside, "c.txt");
    writeFileSync(latin, Buffer.from([0x63, 0xe9, 0x74]));
    expect(await readTextFile(latin, 100)).toBeNull();
  });

  it("tells a link from a note", () => {
    expect(classifyText("  https://example.com/a?b=1  ")).toEqual({
      kind: "link",
      url: "https://example.com/a?b=1",
      title: null,
    });
    expect(classifyText("voir https://example.com")).toEqual({
      kind: "note",
      text: "voir https://example.com",
    });
    expect(classifyText("ftp://example.com")).toMatchObject({ kind: "note" });
    expect(classifyText("   ")).toEqual({ name: null, problem: "empty" });
    expect(classifyText("x".repeat(20_001))).toEqual({ name: null, problem: "too-long" });
  });
});

const SYSTEM_JPEG = "/System/Library/CoreServices/DefaultBackground.jpg";

describe.skipIf(!existsSync(SYSTEM_JPEG))("image previews", () => {
  it("makes an upright preview without metadata, at most 1568 px, with sips", async () => {
    const source = join(outside, "photo.jpg");
    // The system's picture, given a rotated orientation and a comment to strip.
    const original = readFileSync(SYSTEM_JPEG);
    const tagged = Buffer.concat([
      original.subarray(0, 2),
      Buffer.from(jpegWithMetadata().subarray(8, 8 + 36)),
      original.subarray(2),
    ]);
    writeFileSync(source, tagged);
    const staged = await stageFile(source, paths);
    expect(staged.mediaType).toBe("image/jpeg");
    const preview = await makePreview(staged, paths);
    expect(preview?.format).toBe("jpeg");
    // Made in staging; the add's turn publishes it with its file.
    expect(readdirSync(paths.previews)).toEqual([]);
    await publishStaged(staged, preview, paths);
    const [made] = readdirSync(paths.previews);
    expect(made).toBe(`${staged.sha256}.jpg`);
    const shown = readFileSync(join(paths.previews, made ?? ""));
    expect(shown.includes(Buffer.from("Exif"))).toBe(false);
    const size = execFileSync(
      "/usr/bin/sips",
      ["-g", "pixelWidth", "-g", "pixelHeight", join(paths.previews, made ?? "")],
      {
        encoding: "utf8",
      },
    );
    const width = Number(/pixelWidth: (\d+)/u.exec(size)?.[1]);
    const height = Number(/pixelHeight: (\d+)/u.exec(size)?.[1]);
    expect(Math.max(width, height)).toBeLessThanOrEqual(1568);
    // Orientation 6 turned it upright: the landscape picture is now portrait.
    expect(height).toBeGreaterThan(width);

    // Not an image at all: kept as a file.
    const text = join(outside, "fake.png");
    writeFileSync(text, "not an image");
    expect(await makePreview(await stageFile(text, paths), paths)).toBeNull();
  });
});
