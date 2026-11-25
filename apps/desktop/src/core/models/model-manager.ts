import { extname } from "node:path";
import type {
  InstalledModel,
  ModelArtifactStatus,
  ModelPhase,
  ModelPickResult,
  ModelProblem,
  ModelProblemCode,
  ModelsStatus,
} from "@sondine/api";
import {
  DISK_HEADROOM_BYTES,
  ModelStoreError,
  availableBytes,
  discardDownload,
  downloadArtifact,
  downloadedBytes,
  findArtifactFile,
  importArtifact,
  verifyArtifact,
  type CatalogArtifact,
  type DownloadPolicy,
  type DownloadProgress,
  type FoundFile,
  type ImportProgress,
  type InstalledArtifact,
} from "@sondine/engines";

// Core's model jobs (ADR 016 "Models"): at most one job per artifact id, an
// import (clone or copy, then hash) or a download (resumable, then hash), and
// the check at launch. Starting what already runs, or what is installed,
// changes nothing. Status updates go out at once on a phase change and at
// most every `publishEveryMs` for progress. The log holds artifact ids,
// phases, byte counts and codes: no path, URL or message.

type Fields = Record<string, string | number | boolean | null>;

export interface ModelManagerLog {
  info(event: string, fields?: Fields): void;
  warn(event: string, fields?: Fields): void;
}

export interface ModelTiming {
  /** Progress reaches the status at most this often (4 a second). */
  readonly publishEveryMs: number;
  /**
   * Waits before resuming a download that failed in a way that may pass (a
   * dropped connection, a busy server); one per failure in a row without new
   * bytes. Past the last one the job fails and keeps its bytes.
   */
  readonly retryDelaysMs: readonly number[];
}

export const defaultModelTiming: ModelTiming = {
  publishEveryMs: 250,
  retryDelaysMs: [2_000, 15_000, 60_000],
};

export interface PickRequest {
  readonly artifactId: string;
  readonly label: string;
  /** File extensions the open panel allows, without the dot. */
  readonly extensions: readonly string[];
}

export interface ModelManagerDeps {
  /** The model store (`~/Library/Application Support/Sondine/models`). */
  readonly root: string;
  /** Where `findArtifactFile` looks for files the user already has. */
  readonly homeDir: string;
  readonly catalog: readonly CatalogArtifact[];
  /** `DOWNLOAD_POLICY` by default. */
  readonly policy?: DownloadPolicy;
  readonly fetch?: typeof globalThis.fetch;
  /** Free bytes on the volume of a path; `availableBytes` by default. */
  readonly freeBytes?: (path: string) => number;
  readonly memoryBytes: number;
  /** Main's open panel; resolves to the chosen path, or null when the user closed it. */
  readonly pickFile: (request: PickRequest) => Promise<string | null>;
  readonly onStatus: (status: ModelsStatus) => void;
  /** An artifact became ready (launch check, import or download). */
  readonly onInstalled: (installed: InstalledArtifact) => void;
  /** An import, a download or a check failed (ADR 042). */
  readonly onFailed?: (code: ModelProblem["code"]) => void;
  readonly log: ModelManagerLog;
  readonly now?: () => number;
  readonly timing?: Partial<ModelTiming>;
}

/** A request the manager cannot start: no such artifact, or no file to import. */
export class ModelRequestError extends Error {
  override readonly name = "ModelRequestError";
  constructor(
    readonly reason: "unknown-artifact" | "no-file",
    message: string,
  ) {
    super(message);
  }
}

type Activity = "importing" | "downloading" | "verifying";
type JobKind = "import" | "download" | "verify";

interface Job {
  readonly kind: JobKind;
  readonly controller: AbortController;
  /** Set by `cancel`: also delete a download's kept bytes. */
  discard: boolean;
  done: Promise<void>;
}

interface Entry {
  readonly artifact: CatalogArtifact;
  installed: InstalledArtifact | null;
  job: Job | null;
  activity: Activity | null;
  progress: number | null;
  problem: ModelProblem | null;
  partialBytes: number;
  found: FoundFile | null;
  picking: boolean;
}

/** Messages without paths: the store's own may name the user's files. */
const fixedMessages: Partial<Record<ModelProblemCode, string>> = {
  not_a_file: "The chosen file is not a regular file, or no longer exists.",
  size_mismatch: "The file's size is not the model's.",
  hash_mismatch: "The file is not the pinned model: its sha256 differs.",
  disk_full: "Not enough free disk space for the model plus the room kept for capture and swap.",
  io: "Reading or writing the models folder failed.",
};

function problemOf(error: unknown, atMs: number): ModelProblem {
  let code: ModelProblemCode = "io";
  let message: string | undefined;
  if (error instanceof ModelStoreError) {
    switch (error.code) {
      case "not_a_file":
      case "size_mismatch":
      case "hash_mismatch":
      case "disk_full":
        code = error.code;
        break;
      case "network":
      case "http_status":
      case "redirect_refused":
      case "too_large":
      case "bad_response":
        // The downloader's messages name hosts, statuses and byte counts only.
        code = error.code;
        message = error.message;
        break;
      case "clone_failed":
      case "cancelled":
        code = "io";
        break;
    }
  } else if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    code = "not_a_file";
  }
  return { code, message: (message ?? fixedMessages[code] ?? "").slice(0, 1024), atMs };
}

const isCancelled = (error: unknown, signal: AbortSignal) =>
  signal.aborted || (error instanceof ModelStoreError && error.code === "cancelled");

const fraction = (bytes: number, total: number) =>
  total > 0 ? Math.min(1, Math.max(0, bytes / total)) : null;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ModelStoreError("cancelled", "the download was cancelled"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ModelStoreError("cancelled", "the download was cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class ModelManager {
  private readonly entries: Map<string, Entry>;
  private readonly timing: ModelTiming;
  private readonly now: () => number;
  private readonly freeBytes: (path: string) => number;
  private lastPublishAt = Number.NEGATIVE_INFINITY;
  private trailing: ReturnType<typeof setTimeout> | null = null;
  private lastKey = "";
  private stopped = false;

  constructor(private readonly deps: ModelManagerDeps) {
    this.timing = { ...defaultModelTiming, ...deps.timing };
    this.now = deps.now ?? Date.now;
    this.freeBytes = deps.freeBytes ?? availableBytes;
    this.entries = new Map(
      deps.catalog.map((artifact) => [
        artifact.artifactId,
        {
          artifact,
          installed: null,
          job: null,
          // Until the launch check says otherwise.
          activity: "verifying",
          progress: null,
          problem: null,
          partialBytes: 0,
          found: null,
          picking: false,
        },
      ]),
    );
  }

  /** Checks every installed artifact (a rehash only when size, inode or mtime changed). */
  start(): void {
    for (const entry of this.entries.values()) {
      this.startJob(entry, "verify", (signal) => this.verifyInstalled(entry, signal));
    }
  }

  /** Stops every job (a download keeps its bytes) and waits for them. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.trailing !== null) clearTimeout(this.trailing);
    this.trailing = null;
    const jobs = [...this.entries.values()].flatMap((entry) =>
      entry.job === null ? [] : [entry.job],
    );
    for (const job of jobs) job.controller.abort();
    await Promise.all(jobs.map((job) => job.done));
  }

  status(): ModelsStatus {
    let freeDiskBytes = 0;
    try {
      freeDiskBytes = Math.max(0, Math.floor(this.freeBytes(this.deps.root)));
    } catch {
      freeDiskBytes = 0;
    }
    return {
      artifacts: [...this.entries.values()].map((entry) => this.artifactStatus(entry)),
      freeDiskBytes,
      memoryBytes: this.deps.memoryBytes,
    };
  }

  /** The verified file of an artifact; null until the launch check, an import or a download confirms it. */
  installed(artifactId: string): InstalledArtifact | null {
    return this.entries.get(artifactId)?.installed ?? null;
  }

  /** What `status.analysis.models` lists. */
  installedModels(): InstalledModel[] {
    return [...this.entries.values()].flatMap((entry) =>
      entry.installed === null
        ? []
        : [
            {
              artifactId: entry.artifact.artifactId,
              version: entry.artifact.version,
              verified: true,
            },
          ],
    );
  }

  /** Looks again for found files and kept downloads, then reports. */
  async refresh(): Promise<ModelsStatus> {
    await Promise.all([...this.entries.values()].map((entry) => this.refreshLocal(entry)));
    this.publish(true);
    return this.status();
  }

  /** Imports `path`, or the found file. */
  async import(artifactId: string, path?: string): Promise<ModelsStatus> {
    const entry = this.entry(artifactId);
    await this.afterLaunchCheck(entry);
    if (entry.job !== null || entry.picking || entry.installed !== null) return this.status();
    if (path === undefined) {
      await this.refreshLocal(entry);
      // Another request may have started a job while the disk was read.
      if (entry.job !== null || entry.picking || entry.installed !== null) return this.status();
    }
    const source = path ?? entry.found?.path;
    if (source === undefined) {
      throw new ModelRequestError(
        "no-file",
        `No file of ${artifactId} was found; choose one or download it.`,
      );
    }
    this.startJob(entry, "import", async (signal) => {
      const result = await importArtifact({
        root: this.deps.root,
        artifact: entry.artifact,
        source,
        method: "clone-or-copy",
        freeBytes: this.freeBytes,
        signal,
        now: this.now,
        onProgress: (progress) => this.importProgress(entry, progress),
      });
      if (result.method !== null) {
        this.deps.log.info("models.imported", {
          artifact: artifactId,
          method: result.method,
          hashMs: result.hashMs,
        });
      }
      return result.installed;
    });
    return this.status();
  }

  /** Asks main for an open panel, then imports the chosen file. */
  async pick(artifactId: string): Promise<ModelPickResult> {
    const entry = this.entry(artifactId);
    await this.afterLaunchCheck(entry);
    if (entry.job !== null || entry.picking) return { outcome: "busy", models: this.status() };
    entry.picking = true;
    let path: string | null;
    try {
      path = await this.deps.pickFile({
        artifactId,
        label: entry.artifact.label,
        extensions: [extname(entry.artifact.fileName).slice(1) || "bin"],
      });
    } finally {
      entry.picking = false;
    }
    if (path === null) return { outcome: "cancelled", models: this.status() };
    if (entry.job !== null) return { outcome: "busy", models: this.status() };
    return { outcome: "importing", models: await this.import(artifactId, path) };
  }

  /** Downloads from the pinned URL, resuming kept bytes; retries what may pass on its own. */
  async download(artifactId: string): Promise<ModelsStatus> {
    const entry = this.entry(artifactId);
    await this.afterLaunchCheck(entry);
    if (entry.job !== null || entry.picking || entry.installed !== null) return this.status();
    this.startJob(entry, "download", (signal) => this.runDownload(entry, signal));
    return this.status();
  }

  /** Stops an import or a download; a download's bytes stay for resume unless `discard`. */
  async cancel(artifactId: string, discard: boolean): Promise<ModelsStatus> {
    const entry = this.entry(artifactId);
    const job = entry.job;
    if (job !== null && job.kind !== "verify") {
      job.discard = discard;
      job.controller.abort();
      await job.done;
    } else if (job === null && discard && entry.installed === null) {
      await discardDownload(this.deps.root, entry.artifact);
      this.deps.log.info("models.discarded", { artifact: artifactId });
      entry.problem = null;
      await this.refreshLocal(entry);
      this.publish(true);
    }
    return this.status();
  }

  /** A request made while the launch check runs waits for its answer (installed or not). */
  private async afterLaunchCheck(entry: Entry): Promise<void> {
    while (entry.job?.kind === "verify") await entry.job.done;
  }

  private entry(artifactId: string): Entry {
    const entry = this.entries.get(artifactId);
    if (entry === undefined) {
      throw new ModelRequestError("unknown-artifact", `No model ${artifactId} in the catalog.`);
    }
    return entry;
  }

  private phaseOf(entry: Entry): ModelPhase {
    if (entry.activity !== null) return entry.activity;
    if (entry.installed !== null) return "ready";
    if (entry.problem !== null) return "failed";
    return entry.found === null ? "missing" : "found";
  }

  private artifactStatus(entry: Entry): ModelArtifactStatus {
    const { artifact } = entry;
    const ready = entry.installed !== null;
    return {
      artifactId: artifact.artifactId,
      version: artifact.version,
      displayName: artifact.label,
      role: artifact.role,
      sizeBytes: artifact.sizeBytes,
      minimumMemoryBytes: artifact.minimumMemoryBytes,
      phase: this.phaseOf(entry),
      progress: entry.activity === null ? null : entry.progress,
      partialBytes: ready ? 0 : entry.partialBytes,
      found: ready ? null : entry.found,
      downloadNeedsBytes: ready
        ? 0
        : Math.max(0, artifact.sizeBytes - entry.partialBytes) + DISK_HEADROOM_BYTES,
      problem: entry.problem,
      license: { name: artifact.license.id, url: artifact.license.url },
    };
  }

  private async refreshLocal(entry: Entry): Promise<void> {
    if (entry.job !== null || entry.installed !== null) return;
    const local = await this.readLocal(entry);
    if (local === null) return;
    entry.partialBytes = local.partialBytes;
    entry.found = local.found;
  }

  /** The kept download bytes and a found file on disk; null when reading failed (logged). */
  private async readLocal(
    entry: Entry,
  ): Promise<{ partialBytes: number; found: Entry["found"] } | null> {
    try {
      const [partialBytes, found] = await Promise.all([
        downloadedBytes(this.deps.root, entry.artifact),
        findArtifactFile(entry.artifact, {
          homeDir: this.deps.homeDir,
          modelsRoot: this.deps.root,
        }),
      ]);
      return { partialBytes, found };
    } catch (error) {
      this.deps.log.warn("models.refresh-failed", {
        artifact: entry.artifact.artifactId,
        code: problemOf(error, 0).code,
      });
      return null;
    }
  }

  private async verifyInstalled(
    entry: Entry,
    signal: AbortSignal,
  ): Promise<InstalledArtifact | null> {
    const { artifact } = entry;
    const quick = await verifyArtifact(this.deps.root, artifact, { rehash: "never" });
    if (quick.status === "verified") return quick.installed;
    if (quick.status === "missing") return null;
    if (quick.status === "corrupt") {
      entry.problem = { code: "corrupt", message: quick.reason.slice(0, 1024), atMs: this.now() };
      return null;
    }
    // Moved or touched since the last check: hash it again.
    entry.progress = 0;
    this.publish(true);
    const full = await verifyArtifact(this.deps.root, artifact, {
      rehash: "if-changed",
      signal,
      now: this.now,
      onProgress: (progress) => {
        entry.progress = fraction(progress.bytes, progress.totalBytes);
        this.publish();
      },
    });
    if (full.status === "verified") return full.installed;
    if (full.status === "corrupt") {
      entry.problem = { code: "corrupt", message: full.reason.slice(0, 1024), atMs: this.now() };
    }
    return null;
  }

  private importProgress(entry: Entry, progress: ImportProgress): void {
    switch (progress.phase) {
      case "clone":
        entry.activity = "importing";
        entry.progress = null;
        break;
      case "copy":
        entry.activity = "importing";
        entry.progress = fraction(progress.bytes, progress.totalBytes);
        break;
      case "hash":
        if (entry.activity !== "verifying") {
          entry.activity = "verifying";
          this.publish(true);
        }
        entry.progress = fraction(progress.bytes, progress.totalBytes);
        break;
      case "done":
        return;
    }
    this.publish();
  }

  private downloadProgress(entry: Entry, progress: DownloadProgress): void {
    if (progress.phase === "done") return;
    const activity = progress.phase === "download" ? "downloading" : "verifying";
    const changed = entry.activity !== activity;
    entry.activity = activity;
    entry.progress = fraction(progress.bytes, progress.totalBytes);
    if (progress.phase === "download") entry.partialBytes = progress.bytes;
    this.publish(changed);
  }

  private async runDownload(entry: Entry, signal: AbortSignal): Promise<InstalledArtifact> {
    const { artifact } = entry;
    let failures = 0;
    for (;;) {
      const before = await downloadedBytes(this.deps.root, artifact);
      try {
        const result = await downloadArtifact({
          root: this.deps.root,
          artifact,
          ...(this.deps.policy === undefined ? {} : { policy: this.deps.policy }),
          ...(this.deps.fetch === undefined ? {} : { fetch: this.deps.fetch }),
          freeBytes: this.freeBytes,
          signal,
          now: this.now,
          onProgress: (progress) => this.downloadProgress(entry, progress),
        });
        this.deps.log.info("models.downloaded", {
          artifact: artifact.artifactId,
          resumedFromBytes: result.resumedFromBytes,
          restarted: result.restarted,
          hashMs: result.hashMs,
        });
        return result.installed;
      } catch (error) {
        if (!(error instanceof ModelStoreError) || !error.retryable || signal.aborted) throw error;
        const after = await downloadedBytes(this.deps.root, artifact);
        // New bytes since the last try: the connection works, count again from one.
        failures = after > before ? 1 : failures + 1;
        const delayMs = this.timing.retryDelaysMs[failures - 1];
        if (delayMs === undefined) throw error;
        this.deps.log.info("models.download-retry", {
          artifact: artifact.artifactId,
          code: error.code,
          bytes: after,
          attempt: failures,
          delayMs,
        });
        entry.activity = "downloading";
        entry.progress = fraction(after, artifact.sizeBytes);
        this.publish(true);
        await sleep(delayMs, signal);
      }
    }
  }

  private startJob(
    entry: Entry,
    kind: JobKind,
    run: (signal: AbortSignal) => Promise<InstalledArtifact | null>,
  ): void {
    // One job per artifact: callers check before starting, this guards the rest.
    if (entry.job !== null)
      throw new Error(`a ${entry.job.kind} of ${entry.artifact.artifactId} is running`);
    const controller = new AbortController();
    const job: Job = { kind, controller, discard: false, done: Promise.resolve() };
    const artifactId = entry.artifact.artifactId;
    entry.job = job;
    entry.problem = null;
    entry.activity =
      kind === "import" ? "importing" : kind === "download" ? "downloading" : "verifying";
    entry.progress =
      kind === "download" ? fraction(entry.partialBytes, entry.artifact.sizeBytes) : null;
    if (kind !== "verify")
      this.deps.log.info("models.job", { artifact: artifactId, kind, phase: "started" });
    job.done = (async () => {
      let installed: InstalledArtifact | null = null;
      try {
        installed = await run(controller.signal);
      } catch (error) {
        if (isCancelled(error, controller.signal)) {
          if (job.discard)
            await discardDownload(this.deps.root, entry.artifact).catch(() => undefined);
          this.deps.log.info("models.job", {
            artifact: artifactId,
            kind,
            phase: "cancelled",
            discarded: job.discard,
          });
        } else {
          entry.problem = problemOf(error, this.now());
          this.deps.log.warn("models.job", {
            artifact: artifactId,
            kind,
            phase: "failed",
            code: entry.problem.code,
          });
          this.deps.onFailed?.(entry.problem.code);
        }
      }
      // Read the disk before the job ends: a throttled publish may fire while
      // reading, and must not show the new phase with the old partial size.
      const local = installed === null ? await this.readLocal(entry) : null;
      entry.job = null;
      entry.activity = null;
      entry.progress = null;
      if (installed !== null) {
        entry.installed = installed;
        entry.problem = null;
        entry.partialBytes = 0;
        entry.found = null;
        this.deps.log.info("models.job", { artifact: artifactId, kind, phase: "ready" });
        this.deps.onInstalled(installed);
      } else if (local !== null) {
        entry.partialBytes = local.partialBytes;
        entry.found = local.found;
      }
      this.publish(true);
    })();
    this.publish(true);
  }

  private publish(force = false): void {
    if (this.stopped) return;
    const at = performance.now();
    const since = at - this.lastPublishAt;
    if (!force && since < this.timing.publishEveryMs) {
      this.trailing ??= setTimeout(() => {
        this.trailing = null;
        this.publish(true);
      }, this.timing.publishEveryMs - since);
      return;
    }
    if (this.trailing !== null) {
      clearTimeout(this.trailing);
      this.trailing = null;
    }
    this.lastPublishAt = at;
    const status = this.status();
    const key = JSON.stringify(status);
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.deps.onStatus(status);
  }
}
