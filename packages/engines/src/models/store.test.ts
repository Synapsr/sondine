import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CatalogArtifact } from "./catalog.ts";
import {
  ARTIFACT_LAYOUT,
  ArtifactManifest,
  DISK_HEADROOM_BYTES,
  ModelStoreError,
  artifactDirectory,
  importArtifact,
  listInstalled,
  modelsDirectory,
  verifyArtifact,
  type ImportProgress,
} from "./store.ts";

let dir: string;
let root: string;
let source: string;
let content: Buffer;
let artifact: CatalogArtifact;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sondine-store-"));
  root = join(dir, "models");
  source = join(dir, "download.gguf");
  content = randomBytes(3 * 1024 * 1024 + 17);
  writeFileSync(source, content);
  artifact = {
    artifactId: "test-model",
    version: "abc1234",
    label: "Test model",
    fileName: "model.gguf",
    url: "https://example.invalid/model.gguf",
    sizeBytes: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
    license: {
      id: "MIT",
      text: "MIT License\n",
      sha256: "",
      url: "https://example.invalid/LICENSE",
    },
    notices: "Copyright (c) Test\n",
    distribution: "user-download",
    minimumMemoryBytes: 0,
    knownLocations: [],
    role: "final",
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const manifestOf = (ref: CatalogArtifact) =>
  ArtifactManifest.parse(
    JSON.parse(readFileSync(join(artifactDirectory(root, ref), ARTIFACT_LAYOUT.manifest), "utf8")),
  );

const weights = () => join(artifactDirectory(root, artifact), artifact.fileName);

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ModelStoreError) return error.code;
    throw error;
  }
  throw new Error("expected a ModelStoreError");
};

describe("model store", () => {
  it("lives in ~/Library/Application Support/Sondine/models", () => {
    expect(modelsDirectory("/Users/t")).toBe("/Users/t/Library/Application Support/Sondine/models");
  });

  it("imports a matching file with its license, notices and manifest", async () => {
    const progress: ImportProgress[] = [];
    const result = await importArtifact({
      root,
      artifact,
      source,
      onProgress: (step) => progress.push(step),
      now: () => 1_000,
    });
    const target = join(root, "test-model", "abc1234");
    expect(result.status).toBe("imported");
    expect(result.installed).toEqual({
      artifactId: "test-model",
      version: "abc1234",
      dir: target,
      path: join(target, "model.gguf"),
      sizeBytes: content.byteLength,
      sha256: artifact.sha256,
      licenseId: "MIT",
    });
    expect(readFileSync(result.installed.path).equals(content)).toBe(true);
    expect(statSync(result.installed.path).mode & 0o777).toBe(0o444);
    expect(readFileSync(join(target, "LICENSE.txt"), "utf8")).toBe("MIT License\n");
    expect(readFileSync(join(target, "NOTICE.txt"), "utf8")).toBe("Copyright (c) Test\n");
    expect(readdirSync(target).toSorted()).toEqual([
      "LICENSE.txt",
      "NOTICE.txt",
      "manifest.json",
      "model.gguf",
    ]);
    const manifest = manifestOf(artifact);
    const stats = statSync(result.installed.path, { bigint: true });
    expect(manifest).toMatchObject({
      sha256: artifact.sha256,
      importedAtMs: 1_000,
      file: {
        sizeBytes: content.byteLength,
        ino: stats.ino.toString(),
        mtimeNs: stats.mtimeNs.toString(),
      },
    });
    expect(progress[0]).toEqual({ phase: "clone" });
    expect(progress.at(-2)).toEqual({
      phase: "hash",
      bytes: content.byteLength,
      totalBytes: content.byteLength,
    });
    expect(progress.at(-1)).toEqual({ phase: "done" });
    // The source stays where it was.
    expect(readFileSync(source).equals(content)).toBe(true);
  });

  it("clones by default, and copies only when allowed or asked", async () => {
    const cloned = await importArtifact({ root, artifact, source, method: "clone-or-copy" });
    expect(cloned).toMatchObject({ status: "imported", method: "clone" });
    const progress: ImportProgress[] = [];
    const copied = await importArtifact({
      root,
      artifact,
      source,
      method: "copy",
      force: true,
      // Independent of the machine's free disk: the headroom check has its own test.
      freeBytes: () => Number.MAX_SAFE_INTEGER,
      onProgress: (step) => progress.push(step),
    });
    expect(copied).toMatchObject({ status: "imported", method: "copy" });
    expect(readFileSync(copied.installed.path).equals(content)).toBe(true);
    expect(progress.filter((step) => step.phase === "copy").at(-1)).toEqual({
      phase: "copy",
      bytes: content.byteLength,
      totalBytes: content.byteLength,
    });
    expect(progress.some((step) => step.phase === "clone")).toBe(false);
  });

  it("refuses a copy that would leave less than the headroom free", async () => {
    const result = importArtifact({
      root,
      artifact,
      source,
      method: "copy",
      freeBytes: () => DISK_HEADROOM_BYTES + content.byteLength - 1,
    });
    expect(await failure(result)).toBe("disk_full");
    expect(readdirSync(artifactDirectory(root, artifact))).toEqual([]);
  });

  it("removes a download's partial once the artifact is installed", async () => {
    const target = artifactDirectory(root, artifact);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, ARTIFACT_LAYOUT.downloadPartial), "half");
    writeFileSync(join(target, ARTIFACT_LAYOUT.downloadState), "{}");
    await importArtifact({ root, artifact, source });
    expect(existsSync(join(target, ARTIFACT_LAYOUT.downloadPartial))).toBe(false);
    expect(existsSync(join(target, ARTIFACT_LAYOUT.downloadState))).toBe(false);
  });

  it("refuses a file of another size before copying anything", async () => {
    writeFileSync(source, content.subarray(1));
    expect(await failure(importArtifact({ root, artifact, source }))).toBe("size_mismatch");
    expect(existsSync(artifactDirectory(root, artifact))).toBe(false);
  });

  it("refuses a file of another hash and leaves nothing installed", async () => {
    const tampered = Buffer.from(content);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    writeFileSync(source, tampered);
    expect(await failure(importArtifact({ root, artifact, source }))).toBe("hash_mismatch");
    expect(readdirSync(artifactDirectory(root, artifact))).toEqual([]);
    expect(await verifyArtifact(root, artifact, { rehash: "if-changed" })).toEqual({
      status: "missing",
    });
  });

  it("refuses a directory", async () => {
    expect(await failure(importArtifact({ root, artifact, source: dir }))).toBe("not_a_file");
  });

  it("does not hash again what is installed, unless forced", async () => {
    await importArtifact({ root, artifact, source });
    const again = await importArtifact({ root, artifact, source });
    expect(again).toMatchObject({ status: "already-installed", hashMs: 0 });
    const forced = await importArtifact({ root, artifact, source, force: true });
    expect(forced.status).toBe("imported");
    expect(readdirSync(artifactDirectory(root, artifact))).toHaveLength(4);
  });

  it("removes partial files a crashed import left", async () => {
    const target = artifactDirectory(root, artifact);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, ".import-1-x.partial"), "half");
    await importArtifact({ root, artifact, source });
    expect(readdirSync(target).some((name) => name.endsWith(".partial"))).toBe(false);
  });

  describe("launch verification", () => {
    beforeEach(async () => {
      await importArtifact({ root, artifact, source, now: () => 1_000 });
    });

    it("trusts an unchanged size, inode and mtime without hashing", async () => {
      const result = await verifyArtifact(root, artifact, { rehash: "if-changed" });
      expect(result).toMatchObject({ status: "verified", rehashed: false });
    });

    it("rehashes after an mtime change and records the new fingerprint", async () => {
      utimesSync(weights(), new Date(), new Date(Date.now() + 5_000));
      expect(await verifyArtifact(root, artifact, { rehash: "never" })).toMatchObject({
        status: "changed",
      });
      const result = await verifyArtifact(root, artifact, {
        rehash: "if-changed",
        now: () => 2_000,
      });
      expect(result).toMatchObject({ status: "verified", rehashed: true });
      expect(manifestOf(artifact)).toMatchObject({
        importedAtMs: 1_000,
        verifiedAtMs: 2_000,
        file: { mtimeNs: statSync(weights(), { bigint: true }).mtimeNs.toString() },
      });
      expect(await verifyArtifact(root, artifact, { rehash: "if-changed" })).toMatchObject({
        status: "verified",
        rehashed: false,
      });
    });

    it("finds a file whose bytes changed", async () => {
      chmodSync(weights(), 0o644);
      const tampered = Buffer.from(content);
      tampered[5] = (tampered[5] ?? 0) ^ 1;
      writeFileSync(weights(), tampered);
      expect(await verifyArtifact(root, artifact, { rehash: "if-changed" })).toMatchObject({
        status: "corrupt",
      });
    });

    it("finishes an install a crash cut between moving the weights and writing the manifest", async () => {
      rmSync(join(artifactDirectory(root, artifact), ARTIFACT_LAYOUT.manifest));
      expect(await verifyArtifact(root, artifact, { rehash: "never" })).toEqual({
        status: "changed",
        reason: "weights without a manifest",
      });
      const result = await verifyArtifact(root, artifact, {
        rehash: "if-changed",
        now: () => 3_000,
      });
      expect(result).toMatchObject({ status: "verified", rehashed: true });
      expect(manifestOf(artifact)).toMatchObject({ sha256: artifact.sha256, verifiedAtMs: 3_000 });
    });

    it("removes weights left without a manifest that are not the artifact", async () => {
      rmSync(join(artifactDirectory(root, artifact), ARTIFACT_LAYOUT.manifest));
      chmodSync(weights(), 0o644);
      const tampered = Buffer.from(content);
      tampered[5] = (tampered[5] ?? 0) ^ 1;
      writeFileSync(weights(), tampered);
      expect(await verifyArtifact(root, artifact, { rehash: "if-changed" })).toEqual({
        status: "missing",
      });
      expect(existsSync(weights())).toBe(false);
    });

    it("reports a missing weights file and an unreadable manifest", async () => {
      rmSync(weights());
      expect(await verifyArtifact(root, artifact, { rehash: "if-changed" })).toEqual({
        status: "corrupt",
        reason: "the weights file is missing",
      });
      writeFileSync(join(artifactDirectory(root, artifact), ARTIFACT_LAYOUT.manifest), "{");
      expect(await verifyArtifact(root, artifact, { rehash: "if-changed" })).toEqual({
        status: "corrupt",
        reason: "unreadable manifest",
      });
    });

    it("refuses a manifest that does not match the catalog", async () => {
      const other = { ...artifact, sha256: "0".repeat(64) };
      expect(await verifyArtifact(root, other, { rehash: "if-changed" })).toMatchObject({
        status: "corrupt",
        reason: "the manifest does not match the catalog",
      });
    });

    it("lists artifacts with a manifest, never the VAD folder", async () => {
      mkdirSync(join(root, "silero-vad"), { recursive: true });
      writeFileSync(join(root, "silero-vad", "silero_vad.onnx"), "onnx");
      const old = { ...artifact, version: "0000000" };
      mkdirSync(artifactDirectory(root, old), { recursive: true });
      writeFileSync(
        join(artifactDirectory(root, old), ARTIFACT_LAYOUT.manifest),
        JSON.stringify(manifestOf(artifact)),
      );
      const entries = await listInstalled(root, [artifact]);
      expect(
        entries.map(({ artifactId, version, verified, status }) => ({
          artifactId,
          version,
          verified,
          status,
        })),
      ).toEqual([
        { artifactId: "test-model", version: "0000000", verified: false, status: "not-in-catalog" },
        { artifactId: "test-model", version: "abc1234", verified: true, status: "verified" },
      ]);
      expect(await listInstalled(join(dir, "nowhere"))).toEqual([]);
    });
  });
});

describe("import-model CLI", () => {
  const cli = resolve(import.meta.dirname, "../cli/import-model.ts");
  const runCli = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args, "--models-dir", root], { encoding: "utf8" });

  it("runs under plain Node and refuses a file that is not the artifact", () => {
    const result = runCli("nemotron-3.5-transcribe-30b-iq4nl", source);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("OpenMDW License Agreement, version 1.1");
    expect(result.stderr).toContain("size_mismatch");
  });

  it("lists what is installed and names unknown artifacts", () => {
    expect(runCli("--list").stdout).toContain("No artifacts in");
    const unknown = runCli("whisper", source);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("nemotron-3.5-transcribe-30b-iq4nl");
  });
});
