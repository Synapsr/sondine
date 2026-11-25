import { mkdir, open, readFile, stat, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import type { CatalogArtifact } from "./catalog.ts";
import {
  ARTIFACT_LAYOUT,
  DISK_HEADROOM_BYTES,
  ModelStoreError,
  artifactDirectory,
  availableBytes,
  errnoCode,
  installVerifiedFile,
  removeDownloadPartial,
  sha256File,
  verifyArtifact,
  writeFileAtomic,
  type HashProgress,
  type InstalledArtifact,
} from "./store.ts";

// Downloads of a file known beforehand by its size and sha256: a model the
// user starts (ADR 002, ADR 016 "Models"), an update they said yes to
// (ADR 045). Only the pinned URL is fetched; redirects may reach only the
// hosts `DownloadPolicy` lists for its host, over https, within a hop limit. The bytes land in a durable partial
// file next to a small state file, so a cancelled, failed or interrupted
// download resumes with `Range` where it stopped. The sha256 runs once, over
// the complete file as it sits on disk, before an atomic rename into place:
// Node's hash state cannot be saved across a restart, and hashing what is on
// disk (one more read of the file) also catches a write that went wrong.
//
// Core owns the job (one per artifact id) and its progress; this module never
// logs.

/** A host a redirect may reach: exactly this name, or any name ending with this suffix. */
export type HostRule = { readonly host: string } | { readonly suffix: string };

export interface DownloadPolicy {
  /** Schemes the pinned URL and every redirect may use. */
  readonly protocols: readonly string[];
  /** For each pinned URL's host, the hosts it and its redirects may reach. A host not listed is refused. */
  readonly hosts: Readonly<Record<string, readonly HostRule[]>>;
  readonly maxRedirects: number;
}

/**
 * The app's policy. Hugging Face answers `/resolve/<rev>/<file>` with a 302 to
 * a signed URL on its own CDN under `hf.co`: `us.aws.cdn.hf.co` for the
 * Nemotron file (checked 2026-11-06), `cas-bridge.xethub.hf.co` (Xet storage),
 * `cdn-lfs.hf.co` and its regional `cdn-lfs-*.hf.co` (LFS). `hf.co` is Hugging
 * Face's own domain, so its subdomains are allowed rather than a list that
 * breaks at their next CDN move; anything else is refused.
 */
export const DOWNLOAD_POLICY: DownloadPolicy = {
  protocols: ["https:"],
  hosts: {
    "huggingface.co": [{ host: "huggingface.co" }, { suffix: ".hf.co" }],
  },
  maxRedirects: 5,
};

const ruleMatches = (rule: HostRule, hostname: string) =>
  "host" in rule
    ? hostname === rule.host
    : hostname.endsWith(rule.suffix) && hostname.length > rule.suffix.length;

/** Whether a request for `pinned` may go to `url`: its scheme, host, port, and no credentials. */
export function urlAllowed(url: URL, pinned: URL, policy: DownloadPolicy): boolean {
  if (!policy.protocols.includes(url.protocol)) return false;
  if (url.username !== "" || url.password !== "") return false;
  // The default port, or the pinned URL's own.
  if (url.port !== "" && url.port !== pinned.port) return false;
  const rules = policy.hosts[pinned.hostname];
  return rules !== undefined && rules.some((rule) => ruleMatches(rule, url.hostname));
}

const DownloadState = z.strictObject({
  format: z.literal("sondine-model-download"),
  formatVersion: z.literal(1),
  artifactId: z.string().min(1),
  version: z.string().min(1),
  url: z.string(),
  sizeBytes: z.int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** The strong ETag of the answer that started the file, sent as `If-Range` on resume. */
  etag: z.string().nullable(),
  /** Bytes known to be on disk (synced); a resume starts here, past them is a crash's leftover. */
  syncedBytes: z.int().nonnegative(),
  startedAtMs: z.number(),
  updatedAtMs: z.number(),
});
type DownloadState = z.output<typeof DownloadState>;

export type DownloadProgress =
  | ({ readonly phase: "download" } & HashProgress)
  | ({ readonly phase: "verify" } & HashProgress)
  | { readonly phase: "done" };

/** What a download is of: the same id, version, URL, size and hash resume the same bytes. */
export type DownloadableFile = Pick<
  CatalogArtifact,
  "artifactId" | "version" | "url" | "sizeBytes" | "sha256"
>;

export interface DownloadOptions {
  readonly root: string;
  readonly artifact: CatalogArtifact;
  /** `DOWNLOAD_POLICY` by default; tests allow http on 127.0.0.1. */
  readonly policy?: DownloadPolicy;
  readonly fetch?: typeof globalThis.fetch;
  /** Free bytes on the volume of a path; `availableBytes` by default (tests shrink it). */
  readonly freeBytes?: (path: string) => number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: DownloadProgress) => void;
  readonly now?: () => number;
  /** Sync the partial and record it this often (64 MiB by default). */
  readonly syncEveryBytes?: number;
}

export interface DownloadResult {
  readonly status: "downloaded" | "already-installed";
  readonly installed: InstalledArtifact;
  /** Bytes the partial held when this call started; 0 for a fresh start. */
  readonly resumedFromBytes: number;
  /** The server ignored the range (or no longer had it) and the file started over. */
  readonly restarted: boolean;
  readonly hashMs: number;
}

const SYNC_EVERY_BYTES = 64 * 1024 * 1024;
const REPORT_EVERY_BYTES = 256 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const partialPaths = (dir: string) => ({
  dir,
  partial: join(dir, ARTIFACT_LAYOUT.downloadPartial),
  state: join(dir, ARTIFACT_LAYOUT.downloadState),
});

async function readState(path: string): Promise<DownloadState | null> {
  try {
    const parsed = DownloadState.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The state describes this exact artifact: same pinned URL, size and hash. */
const describes = (state: DownloadState, artifact: DownloadableFile) =>
  state.artifactId === artifact.artifactId &&
  state.version === artifact.version &&
  state.url === artifact.url &&
  state.sizeBytes === artifact.sizeBytes &&
  state.sha256 === artifact.sha256;

async function sizeOnDisk(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

/** Bytes of `artifact` a download kept for resume; 0 when there is none. */
export async function downloadedBytes(root: string, artifact: CatalogArtifact): Promise<number> {
  const paths = partialPaths(artifactDirectory(root, artifact));
  const state = await readState(paths.state);
  if (state === null || !describes(state, artifact)) return 0;
  const onDisk = await sizeOnDisk(paths.partial);
  return onDisk === null ? 0 : Math.min(onDisk, state.syncedBytes);
}

/** Deletes a kept partial download of `artifact` (an explicit discard). */
export async function discardDownload(root: string, artifact: CatalogArtifact): Promise<void> {
  await removeDownloadPartial(artifactDirectory(root, artifact));
}

const strongEtag = (response: Response): string | null => {
  const etag = response.headers.get("etag");
  return etag === null || etag.startsWith("W/") ? null : etag;
};

const contentLength = (response: Response): number | null => {
  const value = response.headers.get("content-length");
  return value !== null && /^\d+$/.test(value) ? Number(value) : null;
};

function contentRange(response: Response): { start: number; end: number; total: number } | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
  if (match === null) return null;
  const [start, end, total] = match.slice(1).map(Number);
  return start === undefined || end === undefined || total === undefined
    ? null
    : { start, end, total };
}

const discardBody = (response: Response) => response.body?.cancel().catch(() => undefined);

/** A thrown abort, or the network failing under us; never a `ModelStoreError` already thrown. */
function transferError(error: unknown, signal: AbortSignal | undefined, what: string): Error {
  if (error instanceof ModelStoreError) return error;
  if (signal?.aborted === true) {
    return new ModelStoreError("cancelled", "the download was cancelled", { cause: error });
  }
  if (errnoCode(error) === "ENOSPC") {
    return new ModelStoreError("disk_full", "the disk filled up during the download", {
      cause: error,
    });
  }
  return new ModelStoreError("network", `${what} failed`, { cause: error, retryable: true });
}

interface Transfer {
  readonly artifact: DownloadableFile;
  readonly pinned: URL;
  readonly policy: DownloadPolicy;
  readonly fetch: typeof globalThis.fetch;
  readonly freeBytes: (path: string) => number;
  readonly headroomBytes: number;
  readonly userAgent: string | undefined;
  readonly signal: AbortSignal | undefined;
  readonly onProgress: ((progress: DownloadProgress) => void) | undefined;
  readonly now: () => number;
  readonly syncEveryBytes: number;
  readonly paths: ReturnType<typeof partialPaths>;
}

/** GETs the pinned URL, following only the redirects the policy allows. */
async function request(transfer: Transfer, headers: Record<string, string>): Promise<Response> {
  const { pinned, policy, signal } = transfer;
  let url = pinned;
  for (let hop = 0; ; hop += 1) {
    let response: Response;
    try {
      response = await transfer.fetch(url, {
        headers,
        redirect: "manual",
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      throw transferError(error, signal, "the request");
    }
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    await discardBody(response);
    if (hop >= policy.maxRedirects) {
      throw new ModelStoreError("redirect_refused", `more than ${policy.maxRedirects} redirects`);
    }
    const location = response.headers.get("location");
    let next: URL | null = null;
    try {
      next = location === null ? null : new URL(location, url);
    } catch {
      next = null;
    }
    if (next === null) {
      throw new ModelStoreError("bad_response", "a redirect without a usable Location");
    }
    if (!urlAllowed(next, pinned, policy)) {
      // The host only: a CDN URL carries signed tokens.
      throw new ModelStoreError(
        "redirect_refused",
        `a redirect to ${next.protocol}//${next.host}, which this download may not reach`,
      );
    }
    url = next;
  }
}

/**
 * Brings the partial from `offset` to the artifact's size. Returns whether
 * the file started over (the server answered a resume with the whole file).
 */
async function fetchRemaining(
  transfer: Transfer,
  initial: { offset: number; state: DownloadState },
): Promise<boolean> {
  const { artifact, paths, signal } = transfer;
  const size = artifact.sizeBytes;
  let { offset, state } = initial;
  let restarted = false;
  const save = async (next: DownloadState) => {
    state = { ...next, updatedAtMs: transfer.now() };
    await writeFileAtomic(paths.state, `${JSON.stringify(state)}\n`);
  };

  for (let attempt = 0; ; attempt += 1) {
    const headers: Record<string, string> = { "accept-encoding": "identity" };
    if (transfer.userAgent !== undefined) headers["user-agent"] = transfer.userAgent;
    if (offset > 0) {
      headers["range"] = `bytes=${offset}-`;
      if (state.etag !== null) headers["if-range"] = state.etag;
    }
    const response = await request(transfer, headers);
    let start: number;
    if (response.status === 206 && offset > 0) {
      const range = contentRange(response);
      const length = contentLength(response);
      if (
        range === null ||
        range.start !== offset ||
        range.total !== size ||
        range.end < range.start ||
        range.end >= size ||
        (length !== null && length !== range.end - range.start + 1)
      ) {
        await discardBody(response);
        throw new ModelStoreError(
          "bad_response",
          `the server answered bytes=${offset}- with Content-Range ${response.headers.get("content-range") ?? "(none)"}`,
        );
      }
      start = offset;
    } else if (response.status === 200) {
      const length = contentLength(response);
      if (length !== null && length !== size) {
        await discardBody(response);
        throw length > size
          ? new ModelStoreError("too_large", `the server announces ${length} bytes, not ${size}`)
          : new ModelStoreError(
              "size_mismatch",
              `the server announces ${length} bytes, not ${size}`,
            );
      }
      // A resume answered with the whole file (no range support, or a changed
      // file under If-Range): start over from its first byte.
      restarted ||= offset > 0;
      start = 0;
    } else if (response.status === 416 && offset > 0 && attempt === 0) {
      // The server has no byte at `offset`: the partial is not its file. Start over once.
      await discardBody(response);
      offset = 0;
      restarted = true;
      await truncate(paths.partial, 0);
      await save({ ...state, etag: null, syncedBytes: 0 });
      continue;
    } else {
      await discardBody(response);
      const transient =
        response.status === 408 || response.status === 429 || response.status >= 500;
      throw new ModelStoreError("http_status", `the server answered HTTP ${response.status}`, {
        retryable: transient,
      });
    }
    const encoding = response.headers.get("content-encoding");
    if ((encoding !== null && encoding !== "identity") || response.body === null) {
      await discardBody(response);
      throw new ModelStoreError("bad_response", "the server sent an encoded or empty body");
    }
    if (start === 0 && offset > 0) await truncate(paths.partial, 0);
    await save({
      ...state,
      etag: start === 0 ? strongEtag(response) : state.etag,
      syncedBytes: start,
      ...(start === 0 ? { startedAtMs: transfer.now() } : {}),
    });

    const handle = await open(paths.partial, "r+");
    let position = start;
    let synced = start;
    let reported = start;
    const report = () => {
      reported = position;
      transfer.onProgress?.({ phase: "download", bytes: position, totalBytes: size });
    };
    report();
    let failure: unknown = null;
    try {
      for await (const chunk of response.body) {
        if (position + chunk.byteLength > size) {
          throw new ModelStoreError("too_large", `the server sent more than ${size} bytes`);
        }
        await handle.write(chunk, 0, chunk.byteLength, position);
        position += chunk.byteLength;
        if (position - synced >= transfer.syncEveryBytes) {
          await handle.sync();
          synced = position;
          await save({ ...state, syncedBytes: synced });
          if (transfer.freeBytes(paths.dir) < transfer.headroomBytes) {
            throw new ModelStoreError(
              "disk_full",
              `less than ${transfer.headroomBytes} bytes left on the disk`,
            );
          }
        }
        if (position - reported >= REPORT_EVERY_BYTES) report();
      }
    } catch (error) {
      failure = transferError(error, signal, "the transfer");
    } finally {
      // What reached the disk stays for the next resume.
      try {
        await handle.sync();
        if (position !== synced) await save({ ...state, syncedBytes: position });
      } finally {
        await handle.close();
      }
    }
    if (position !== reported) report();
    if (failure !== null) throw failure;
    if (position < size) {
      throw new ModelStoreError(
        "network",
        `the connection closed after ${position} of ${size} bytes`,
        { retryable: true },
      );
    }
    return restarted;
  }
}

export interface FileDownloadOptions extends Omit<DownloadOptions, "root" | "artifact"> {
  /** The folder of the partial, its own. */
  readonly dir: string;
  readonly file: DownloadableFile;
  /** Free space to leave on the disk; `DISK_HEADROOM_BYTES` by default. */
  readonly headroomBytes?: number;
  /** fetch's own by default. */
  readonly userAgent?: string;
}

export interface FileDownloadResult {
  /** The complete, verified partial. */
  readonly path: string;
  readonly resumedFromBytes: number;
  readonly restarted: boolean;
  readonly hashMs: number;
}

/**
 * Downloads `file` from its pinned URL into `dir`, resuming a kept partial,
 * then verifies the complete file's sha256. Throws `ModelStoreError`; the
 * partial stays for a resume unless its hash was wrong or it described
 * another file.
 */
export async function downloadFile(options: FileDownloadOptions): Promise<FileDownloadResult> {
  const { file, dir, signal } = options;
  const now = options.now ?? Date.now;
  const policy = options.policy ?? DOWNLOAD_POLICY;
  const headroomBytes = options.headroomBytes ?? DISK_HEADROOM_BYTES;
  const pinned = new URL(file.url);
  if (!urlAllowed(pinned, pinned, policy)) {
    throw new ModelStoreError(
      "redirect_refused",
      `${pinned.protocol}//${pinned.host} is not an allowed download host`,
    );
  }
  const paths = partialPaths(dir);
  await mkdir(paths.dir, { recursive: true, mode: 0o755 });

  let state = await readState(paths.state);
  let onDisk = await sizeOnDisk(paths.partial);
  if (state === null || !describes(state, file) || onDisk === null) {
    await removeDownloadPartial(paths.dir);
    onDisk = null;
    state = {
      format: "sondine-model-download",
      formatVersion: 1,
      artifactId: file.artifactId,
      version: file.version,
      url: file.url,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
      etag: null,
      syncedBytes: 0,
      startedAtMs: now(),
      updatedAtMs: now(),
    };
  }
  // Bytes past the last sync may be a crash's garbage: they are fetched again.
  let offset = Math.min(onDisk ?? 0, state.syncedBytes);
  if (offset > file.sizeBytes) offset = 0;
  if (onDisk === null) await writeFile(paths.partial, "", { mode: 0o644 });
  else if (onDisk !== offset) await truncate(paths.partial, offset);
  const resumedFromBytes = offset;

  let restarted = false;
  if (offset < file.sizeBytes) {
    const free = (options.freeBytes ?? availableBytes)(paths.dir);
    const needed = file.sizeBytes - offset + headroomBytes;
    if (free < needed) {
      throw new ModelStoreError(
        "disk_full",
        `the download needs ${needed} free bytes, the volume has ${free}`,
      );
    }
    restarted = await fetchRemaining(
      {
        artifact: file,
        pinned,
        policy,
        fetch: options.fetch ?? globalThis.fetch,
        freeBytes: options.freeBytes ?? availableBytes,
        headroomBytes,
        userAgent: options.userAgent,
        signal,
        onProgress: options.onProgress,
        now,
        syncEveryBytes: options.syncEveryBytes ?? SYNC_EVERY_BYTES,
        paths,
      },
      { offset, state },
    );
  }

  const started = performance.now();
  options.onProgress?.({ phase: "verify", bytes: 0, totalBytes: file.sizeBytes });
  const sha256 = await sha256File(paths.partial, {
    ...(signal === undefined ? {} : { signal }),
    onProgress: (progress) => options.onProgress?.({ phase: "verify", ...progress }),
  });
  const hashMs = Math.round(performance.now() - started);
  if (sha256 !== file.sha256) {
    // These bytes are not the file; resuming them would fail again.
    await removeDownloadPartial(paths.dir);
    throw new ModelStoreError(
      "hash_mismatch",
      `the downloaded file has sha256 ${sha256}, not ${file.sha256}`,
    );
  }
  return { path: paths.partial, resumedFromBytes, restarted, hashMs };
}

/**
 * Downloads `artifact` into the store (`downloadFile`) and installs it, its
 * manifest written last.
 */
export async function downloadArtifact(options: DownloadOptions): Promise<DownloadResult> {
  const { artifact, root, ...download } = options;
  const existing = await verifyArtifact(root, artifact, { rehash: "never" });
  if (existing.status === "verified") {
    return {
      status: "already-installed",
      installed: existing.installed,
      resumedFromBytes: 0,
      restarted: false,
      hashMs: 0,
    };
  }
  const dir = artifactDirectory(root, artifact);
  const { path, ...downloaded } = await downloadFile({ ...download, dir, file: artifact });
  const installed = await installVerifiedFile({
    root,
    artifact,
    file: path,
    sha256: artifact.sha256,
    now: options.now ?? Date.now,
  });
  options.onProgress?.({ phase: "done" });
  return { status: "downloaded", installed, ...downloaded };
}
