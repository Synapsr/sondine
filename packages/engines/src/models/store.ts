import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, statfsSync, statSync, type BigIntStats } from "node:fs";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import * as z from "zod";
import type { ArtifactRef } from "../contract.ts";
import { MODEL_CATALOG, catalogArtifact, type CatalogArtifact } from "./catalog.ts";

// The model store (ADR 013, ADR 016 "Models"). Weights live outside the app
// group container, readable by the sandboxed helpers through a read-only
// exception:
//
//   ~/Library/Application Support/Sondine/models/
//     <artifactId>/<version>/
//       <fileName>          the weights, read-only (0444), a clone of the file the user had
//       LICENSE.txt         the license text from the catalog
//       NOTICE.txt          the notices the license asks us to keep
//       manifest.json       written last: the verified sha256 and the file's size, inode and mtime
//       .import-*.partial   an import in progress (removed by the next import)
//       .download.partial   a download's bytes so far, kept for resume (download.ts)
//       .download.json      what that partial is: pinned URL, size, sha256, validator, synced bytes
//
// Import clones with clonefile(2) through `/bin/cp -c`: Node's copyFile
// cannot clone on macOS (COPYFILE_FICLONE copies, COPYFILE_FICLONE_FORCE
// fails with ENOSYS). A clone needs the source on the models folder's volume;
// otherwise the import copies, when its caller allows it and the disk has
// room for the copy plus `DISK_HEADROOM_BYTES`.
//
// An artifact is installed when its manifest exists. At launch a size, inode
// and mtime match is enough; anything else rehashes the file.

/** Home-relative, as in the helpers' read-only sandbox exception (build/entitlements.*.plist). */
export const MODELS_HOME_RELATIVE = "Library/Application Support/Sondine/models";

export function modelsDirectory(homeDir: string = homedir()): string {
  return join(homeDir, MODELS_HOME_RELATIVE);
}

export const ARTIFACT_LAYOUT = {
  manifest: "manifest.json",
  license: "LICENSE.txt",
  notices: "NOTICE.txt",
  partialPrefix: ".import-",
  downloadPartial: ".download.partial",
  downloadState: ".download.json",
} as const;

/**
 * Free space a copy or a download must leave on the models volume: the
 * spool's 4 GiB cap (capture keeps writing meanwhile, ADR 016 "Retention")
 * plus the 10 GiB of swap room analysis admission keeps before a cold load
 * (`SWAP_ROOM_MARGIN_BYTES` in core). The models folder shares its APFS
 * container with the data and swap volumes on a stock Mac.
 */
export const DISK_HEADROOM_BYTES = 14 * 1024 ** 3;

/** The deepest existing directory at or above `path`. */
export function nearestExistingDirectory(path: string): string {
  let current = path;
  for (;;) {
    try {
      if (statSync(current).isDirectory()) return current;
    } catch {
      // Missing: look at its parent.
    }
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/** Bytes an unprivileged process may still write on the volume holding `path` (or its nearest parent). */
export function availableBytes(path: string): number {
  const volume = statfsSync(nearestExistingDirectory(path));
  return volume.bavail * volume.bsize;
}

const Digits = z.string().regex(/^\d+$/);

const FileFingerprint = z.strictObject({
  sizeBytes: z.int().nonnegative(),
  ino: Digits,
  mtimeNs: Digits,
});
type FileFingerprint = z.output<typeof FileFingerprint>;

export const ArtifactManifest = z.strictObject({
  format: z.literal("sondine-model-artifact"),
  formatVersion: z.literal(1),
  artifactId: z.string().min(1),
  version: z.string().min(1),
  fileName: z.string().min(1),
  sizeBytes: z.int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  licenseId: z.string().min(1),
  url: z.string(),
  importedAtMs: z.number(),
  verifiedAtMs: z.number(),
  file: FileFingerprint,
});
export type ArtifactManifest = z.output<typeof ArtifactManifest>;

export type ModelStoreErrorCode =
  | "not_a_file"
  | "size_mismatch"
  | "hash_mismatch"
  /** The source is not on the models folder's APFS volume, or the volume cannot clone. */
  | "clone_failed"
  /** Not enough room for the file plus `DISK_HEADROOM_BYTES`. */
  | "disk_full"
  /** The connection failed, stalled, or closed early (download.ts). */
  | "network"
  /** The server answered with a status the download cannot use. */
  | "http_status"
  /** A redirect left the hosts allowed for the pinned URL, changed scheme, or looped. */
  | "redirect_refused"
  /** The server announced or sent more bytes than the catalog's size. */
  | "too_large"
  /** A malformed answer: a `206` whose `Content-Range` does not match, an encoded body. */
  | "bad_response"
  | "cancelled";

export class ModelStoreError extends Error {
  readonly code: ModelStoreErrorCode;
  /** Trying again later may succeed (a dropped connection, a busy server); a resume keeps the bytes. */
  readonly retryable: boolean;
  constructor(
    code: ModelStoreErrorCode,
    message: string,
    options?: ErrorOptions & { readonly retryable?: boolean },
  ) {
    super(message, options);
    this.name = "ModelStoreError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
  }
}

export interface InstalledArtifact extends ArtifactRef {
  readonly dir: string;
  /** The weights file. */
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly licenseId: string;
}

export function artifactDirectory(root: string, ref: ArtifactRef): string {
  return join(root, ref.artifactId, ref.version);
}

export interface HashProgress {
  readonly bytes: number;
  readonly totalBytes: number;
}

const HASH_READ_BYTES = 8 * 1024 * 1024;
/** How often hashing and copying report progress; callers throttle what they show. */
export const PROGRESS_EVERY_BYTES = 64 * 1024 * 1024;

/** Streams a file through sha256; progress comes every 64 MiB and at the end. */
export async function sha256File(
  path: string,
  options: {
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: HashProgress) => void;
  } = {},
): Promise<string> {
  const { size } = await stat(path);
  const hash = createHash("sha256");
  let bytes = 0;
  let reported = 0;
  try {
    const stream = createReadStream(path, {
      highWaterMark: HASH_READ_BYTES,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    for await (const chunk of stream) {
      if (!Buffer.isBuffer(chunk)) throw new TypeError("expected bytes from the file stream");
      hash.update(chunk);
      bytes += chunk.byteLength;
      if (bytes - reported >= PROGRESS_EVERY_BYTES) {
        reported = bytes;
        options.onProgress?.({ bytes, totalBytes: size });
      }
    }
  } catch (error) {
    if (options.signal?.aborted === true) {
      throw new ModelStoreError("cancelled", "hashing was cancelled", { cause: error });
    }
    throw error;
  }
  options.onProgress?.({ bytes, totalBytes: size });
  return hash.digest("hex");
}

export const errnoCode = (error: unknown): unknown =>
  error instanceof Error && "code" in error ? error.code : undefined;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const fingerprintOf = (stats: BigIntStats): FileFingerprint => ({
  sizeBytes: Number(stats.size),
  ino: stats.ino.toString(),
  mtimeNs: stats.mtimeNs.toString(),
});

const sameFingerprint = (a: FileFingerprint, b: FileFingerprint) =>
  a.sizeBytes === b.sizeBytes && a.ino === b.ino && a.mtimeNs === b.mtimeNs;

export async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Writes a small file durably: a temporary name, fsync, rename. */
export async function writeFileAtomic(path: string, data: string, mode = 0o644): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "w", mode);
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

async function readManifest(dir: string): Promise<ArtifactManifest | "missing" | "invalid"> {
  let text: string;
  try {
    text = await readFile(join(dir, ARTIFACT_LAYOUT.manifest), "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return "missing";
    throw error;
  }
  try {
    const parsed = ArtifactManifest.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : "invalid";
  } catch {
    return "invalid";
  }
}

const installedFrom = (dir: string, manifest: ArtifactManifest): InstalledArtifact => ({
  artifactId: manifest.artifactId,
  version: manifest.version,
  dir,
  path: join(dir, manifest.fileName),
  sizeBytes: manifest.sizeBytes,
  sha256: manifest.sha256,
  licenseId: manifest.licenseId,
});

export type VerifyResult =
  | {
      readonly status: "verified";
      readonly installed: InstalledArtifact;
      readonly rehashed: boolean;
    }
  /** No manifest: not installed. */
  | { readonly status: "missing" }
  /** The file's size, inode or mtime changed and the policy did not allow a rehash. */
  | { readonly status: "changed"; readonly reason: string }
  | { readonly status: "corrupt"; readonly reason: string };

export interface VerifyOptions {
  /** `if-changed` (launch): rehash only when size, inode or mtime moved. */
  readonly rehash: "never" | "if-changed" | "always";
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: HashProgress) => void;
  readonly now?: () => number;
}

/** Checks an installed artifact against its manifest and the catalog. */
export async function verifyArtifact(
  root: string,
  artifact: CatalogArtifact,
  options: VerifyOptions,
): Promise<VerifyResult> {
  const dir = artifactDirectory(root, artifact);
  const manifest = await readManifest(dir);
  if (manifest === "missing") {
    if (options.rehash === "never") {
      // Weights without a manifest are an install cut short: worth a full check.
      const cutShort = await stat(join(dir, artifact.fileName)).then(
        () => true,
        () => false,
      );
      return cutShort
        ? { status: "changed", reason: "weights without a manifest" }
        : { status: "missing" };
    }
    const recovered = await recoverInstall(dir, artifact, options);
    return recovered === null
      ? { status: "missing" }
      : { status: "verified", installed: recovered, rehashed: true };
  }
  if (manifest === "invalid") return { status: "corrupt", reason: "unreadable manifest" };
  if (
    manifest.artifactId !== artifact.artifactId ||
    manifest.version !== artifact.version ||
    manifest.fileName !== artifact.fileName ||
    manifest.sha256 !== artifact.sha256 ||
    manifest.sizeBytes !== artifact.sizeBytes
  ) {
    return { status: "corrupt", reason: "the manifest does not match the catalog" };
  }
  const path = join(dir, manifest.fileName);
  let current: FileFingerprint;
  try {
    current = fingerprintOf(await stat(path, { bigint: true }));
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      return { status: "corrupt", reason: "the weights file is missing" };
    }
    throw error;
  }
  if (current.sizeBytes !== artifact.sizeBytes) {
    return {
      status: "corrupt",
      reason: `size ${current.sizeBytes}, expected ${artifact.sizeBytes}`,
    };
  }
  const unchanged = sameFingerprint(current, manifest.file);
  if (unchanged && options.rehash !== "always") {
    return { status: "verified", installed: installedFrom(dir, manifest), rehashed: false };
  }
  if (options.rehash === "never") {
    return { status: "changed", reason: "size, inode or mtime changed since the last check" };
  }
  const sha256 = await sha256File(path, options);
  if (sha256 !== artifact.sha256) {
    return { status: "corrupt", reason: `sha256 ${sha256}, expected ${artifact.sha256}` };
  }
  const now = options.now ?? Date.now;
  await writeFileAtomic(
    join(dir, ARTIFACT_LAYOUT.manifest),
    `${JSON.stringify({ ...manifest, verifiedAtMs: now(), file: current } satisfies ArtifactManifest, null, 2)}\n`,
  );
  return { status: "verified", installed: installedFrom(dir, manifest), rehashed: true };
}

export type ImportProgress =
  | { readonly phase: "clone" }
  | ({ readonly phase: "copy" } & HashProgress)
  | ({ readonly phase: "hash" } & HashProgress)
  | { readonly phase: "done" };

/**
 * `clone`: an APFS clone or nothing (the CLI). `clone-or-copy`: a clone when
 * the volume allows it, else a copy (the app). `copy`: always a copy.
 */
export type ImportMethod = "clone" | "clone-or-copy" | "copy";

export interface ImportOptions {
  readonly root: string;
  readonly artifact: CatalogArtifact;
  /** A file the user already has, e.g. a download of `artifact.url`. */
  readonly source: string;
  /** Import again even when a verified copy is installed. */
  readonly force?: boolean;
  /** `clone` by default. */
  readonly method?: ImportMethod;
  /** Free bytes on the volume of a path; `availableBytes` by default (tests shrink it). */
  readonly freeBytes?: (path: string) => number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ImportProgress) => void;
  readonly now?: () => number;
}

export interface ImportResult {
  readonly status: "imported" | "already-installed";
  readonly installed: InstalledArtifact;
  /** How the file came in; null when it was already installed. */
  readonly method: "clone" | "copy" | null;
  readonly hashMs: number;
}

const execFileAsync = promisify(execFile);

const cancelledBy = (signal: AbortSignal | undefined, error: unknown) =>
  signal?.aborted === true
    ? new ModelStoreError("cancelled", "the import was cancelled", { cause: error })
    : null;

/** Whether `source` and `dir` (or its nearest existing parent) sit on one volume, so a clone can share blocks. */
export async function sameVolume(source: string, dir: string): Promise<boolean> {
  const [from, into] = await Promise.all([stat(source), stat(nearestExistingDirectory(dir))]);
  return from.dev === into.dev;
}

/** An APFS clone of `source` at `target`, sharing its blocks; both on one volume. */
async function cloneFile(source: string, target: string, signal?: AbortSignal): Promise<void> {
  try {
    await execFileAsync("/bin/cp", ["-c", source, target], signal === undefined ? {} : { signal });
  } catch (error) {
    throw (
      cancelledBy(signal, error) ??
      new ModelStoreError("clone_failed", `cannot clone ${source}: ${errorMessage(error)}`, {
        cause: error,
      })
    );
  }
}

/** A plain copy with progress, synced before it returns. */
async function copyFile(
  source: string,
  target: string,
  totalBytes: number,
  options: Pick<ImportOptions, "signal" | "onProgress">,
): Promise<void> {
  const handle = await open(target, "wx", 0o644);
  let bytes = 0;
  let reported = 0;
  try {
    const stream = createReadStream(source, {
      highWaterMark: HASH_READ_BYTES,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    for await (const chunk of stream) {
      if (!Buffer.isBuffer(chunk)) throw new TypeError("expected bytes from the file stream");
      await handle.write(chunk, 0, chunk.byteLength, bytes);
      bytes += chunk.byteLength;
      if (bytes - reported >= PROGRESS_EVERY_BYTES) {
        reported = bytes;
        options.onProgress?.({ phase: "copy", bytes, totalBytes });
      }
    }
    await handle.sync();
  } catch (error) {
    const cancelled = cancelledBy(options.signal, error);
    if (cancelled !== null) throw cancelled;
    if (errnoCode(error) === "ENOSPC") {
      throw new ModelStoreError("disk_full", "the disk filled up during the copy", {
        cause: error,
      });
    }
    throw error;
  } finally {
    await handle.close();
  }
  options.onProgress?.({ phase: "copy", bytes, totalBytes });
}

async function removePartials(dir: string): Promise<void> {
  for (const name of await readdir(dir)) {
    if (name.startsWith(ARTIFACT_LAYOUT.partialPrefix)) await rm(join(dir, name), { force: true });
  }
}

/** Removes a download's partial file and its state; an explicit discard, or an install made it useless. */
export async function removeDownloadPartial(dir: string): Promise<void> {
  await rm(join(dir, ARTIFACT_LAYOUT.downloadPartial), { force: true });
  await rm(join(dir, ARTIFACT_LAYOUT.downloadState), { force: true });
}

/**
 * Moves a hashed file into place as `artifact`: read-only weights, the
 * license and notices, then the manifest, written last. The caller checked
 * `sha256` against the catalog. A download's partial is useless afterwards
 * and goes too.
 */
export async function installVerifiedFile(options: {
  readonly root: string;
  readonly artifact: CatalogArtifact;
  /** A file inside the artifact's directory, hashed by the caller. */
  readonly file: string;
  readonly sha256: string;
  readonly now: () => number;
}): Promise<InstalledArtifact> {
  const { artifact } = options;
  const dir = artifactDirectory(options.root, artifact);
  if (options.sha256 !== artifact.sha256) {
    throw new ModelStoreError("hash_mismatch", "the file's sha256 is not the catalog's");
  }
  // A new install invalidates the old manifest before the weights move.
  await rm(join(dir, ARTIFACT_LAYOUT.manifest), { force: true });
  await chmod(options.file, 0o444);
  await writeFileAtomic(join(dir, ARTIFACT_LAYOUT.license), artifact.license.text);
  await writeFileAtomic(join(dir, ARTIFACT_LAYOUT.notices), artifact.notices);
  const target = join(dir, artifact.fileName);
  await rename(options.file, target);
  const manifest = await writeInstallManifest(dir, artifact, options.sha256, options.now());
  await removeDownloadPartial(dir);
  return installedFrom(dir, manifest);
}

/** The manifest of verified weights already at their place; written last, then the directory synced. */
async function writeInstallManifest(
  dir: string,
  artifact: CatalogArtifact,
  sha256: string,
  atMs: number,
): Promise<ArtifactManifest> {
  const target = join(dir, artifact.fileName);
  const manifest: ArtifactManifest = {
    format: "sondine-model-artifact",
    formatVersion: 1,
    artifactId: artifact.artifactId,
    version: artifact.version,
    fileName: artifact.fileName,
    sizeBytes: artifact.sizeBytes,
    sha256,
    licenseId: artifact.license.id,
    url: artifact.url,
    importedAtMs: atMs,
    verifiedAtMs: atMs,
    file: fingerprintOf(await stat(target, { bigint: true })),
  };
  await writeFileAtomic(
    join(dir, ARTIFACT_LAYOUT.manifest),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await syncDirectory(dir);
  return manifest;
}

/**
 * Weights at their place with no manifest: a crash between moving verified
 * weights in and writing the manifest. Hashes them once; the right bytes get
 * their manifest (no second download), anything else is removed, since only
 * the store puts a file under the catalog's name.
 */
async function recoverInstall(
  dir: string,
  artifact: CatalogArtifact,
  options: VerifyOptions,
): Promise<InstalledArtifact | null> {
  const target = join(dir, artifact.fileName);
  let size: bigint;
  try {
    size = (await stat(target, { bigint: true })).size;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
  if (size === BigInt(artifact.sizeBytes)) {
    const sha256 = await sha256File(target, options);
    if (sha256 === artifact.sha256) {
      const manifest = await writeInstallManifest(
        dir,
        artifact,
        sha256,
        (options.now ?? Date.now)(),
      );
      await removeDownloadPartial(dir);
      return installedFrom(dir, manifest);
    }
  }
  await rm(target, { force: true });
  return null;
}

/**
 * Installs `source` as `artifact`: checks its size, clones it into the store
 * under a temporary name (APFS clone, no extra disk) or copies it when
 * `method` allows, hashes the result (the source may change meanwhile; the
 * clone cannot), writes the license, notices and manifest, then renames it
 * into place.
 */
export async function importArtifact(options: ImportOptions): Promise<ImportResult> {
  const { artifact, root } = options;
  const now = options.now ?? Date.now;
  const method = options.method ?? "clone";
  const source = await stat(options.source);
  if (!source.isFile()) {
    throw new ModelStoreError("not_a_file", `${options.source} is not a regular file`);
  }
  if (source.size !== artifact.sizeBytes) {
    throw new ModelStoreError(
      "size_mismatch",
      `${options.source} has ${source.size} bytes; ${artifact.artifactId}@${artifact.version} has ${artifact.sizeBytes}`,
    );
  }
  const dir = artifactDirectory(root, artifact);
  await mkdir(dir, { recursive: true, mode: 0o755 });
  if (options.force !== true) {
    const existing = await verifyArtifact(root, artifact, { rehash: "never" });
    if (existing.status === "verified") {
      return {
        status: "already-installed",
        installed: existing.installed,
        method: null,
        hashMs: 0,
      };
    }
  }
  await removePartials(dir);

  const partial = join(
    dir,
    `${ARTIFACT_LAYOUT.partialPrefix}${process.pid}-${randomUUID()}.partial`,
  );
  try {
    let used: "clone" | "copy" = "copy";
    if (method !== "copy" && (await sameVolume(options.source, dir))) {
      options.onProgress?.({ phase: "clone" });
      try {
        await cloneFile(options.source, partial, options.signal);
        used = "clone";
      } catch (error) {
        // A volume that cannot clone (HFS+, some network shares) gets a copy.
        if (
          method === "clone" ||
          !(error instanceof ModelStoreError) ||
          error.code !== "clone_failed"
        )
          throw error;
        await rm(partial, { force: true });
      }
    } else if (method === "clone") {
      throw new ModelStoreError(
        "clone_failed",
        `${options.source} is on another volume than ${dir}; move it to that volume first, so the import costs no disk space`,
      );
    }
    if (used === "copy") {
      const free = (options.freeBytes ?? availableBytes)(dir);
      if (free < artifact.sizeBytes + DISK_HEADROOM_BYTES) {
        throw new ModelStoreError(
          "disk_full",
          `a copy needs ${artifact.sizeBytes + DISK_HEADROOM_BYTES} free bytes, the volume has ${free}`,
        );
      }
      await copyFile(options.source, partial, artifact.sizeBytes, options);
    }
    const started = performance.now();
    const sha256 = await sha256File(partial, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onProgress: (progress) => options.onProgress?.({ phase: "hash", ...progress }),
    });
    const hashMs = Math.round(performance.now() - started);
    if (sha256 !== artifact.sha256) {
      throw new ModelStoreError(
        "hash_mismatch",
        `${options.source} has sha256 ${sha256}; ${artifact.artifactId}@${artifact.version} is ${artifact.sha256}`,
      );
    }
    const installed = await installVerifiedFile({ root, artifact, file: partial, sha256, now });
    options.onProgress?.({ phase: "done" });
    return { status: "imported", installed, method: used, hashMs };
  } finally {
    await rm(partial, { force: true });
  }
}

export interface InstalledEntry extends ArtifactRef {
  /** False while `verifyArtifact` has not confirmed it (changed, corrupt, or unknown to the catalog). */
  readonly verified: boolean;
  readonly status: VerifyResult["status"] | "not-in-catalog";
  readonly installed?: InstalledArtifact;
}

async function directories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    throw error;
  }
}

/**
 * Every artifact with a manifest under `root`, checked cheaply (size, inode,
 * mtime; never a rehash). Folders without a manifest, such as the VAD model
 * main copies, are not artifacts.
 */
export async function listInstalled(
  root: string,
  catalog: readonly CatalogArtifact[] = MODEL_CATALOG,
): Promise<InstalledEntry[]> {
  const entries: InstalledEntry[] = [];
  for (const artifactId of (await directories(root)).toSorted()) {
    for (const version of (await directories(join(root, artifactId))).toSorted()) {
      const dir = join(root, artifactId, version);
      const manifest = await readManifest(dir);
      if (manifest === "missing") continue;
      const artifact = catalogArtifact(artifactId, version, catalog);
      if (artifact === undefined) {
        entries.push({ artifactId, version, verified: false, status: "not-in-catalog" });
        continue;
      }
      const result = await verifyArtifact(root, artifact, { rehash: "never" });
      entries.push(
        result.status === "verified"
          ? { artifactId, version, verified: true, status: "verified", installed: result.installed }
          : { artifactId, version, verified: false, status: result.status },
      );
    }
  }
  return entries;
}
