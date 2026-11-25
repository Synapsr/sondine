import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ModelsStatus } from "@sondine/api";
import {
  ARTIFACT_LAYOUT,
  artifactDirectory,
  importArtifact,
  type CatalogArtifact,
  type DownloadPolicy,
  type InstalledArtifact,
} from "@sondine/engines";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { waitUntil } from "../../../test/support";
import { ModelManager, ModelRequestError, type PickRequest } from "./model-manager";

// The model jobs against a local HTTP server on 127.0.0.1 and a test catalog
// of a few MiB: nothing reaches the network, nothing near 19 GB.

const content = randomBytes(3 * 1024 * 1024 + 7);
const sha256 = createHash("sha256").update(content).digest("hex");
const policy: DownloadPolicy = {
  protocols: ["http:"],
  hosts: { "127.0.0.1": [{ host: "127.0.0.1" }] },
  maxRedirects: 3,
};

let dir: string;
let home: string;
let root: string;
let server: Server;
let origin: string;
let requests: { path: string; range: string | undefined }[];
/** Answers the first `dropFirst` requests with 1 MiB, then a dropped connection. */
let dropFirst: number;
/** Holds the body after 512 KiB until released (for cancel and idempotence tests). */
let hold: boolean;
const held = new Set<ServerResponse>();

function handle(request: IncomingMessage, response: ServerResponse) {
  requests.push({ path: request.url ?? "/", range: request.headers.range });
  const body = request.url === "/wrong" ? Buffer.alloc(content.byteLength, 1) : content;
  const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? "");
  const start = range === null ? 0 : Number(range[1]);
  const headers =
    range === null
      ? { etag: '"v1"', "content-length": body.byteLength }
      : {
          etag: '"v1"',
          "content-length": body.byteLength - start,
          "content-range": `bytes ${start}-${body.byteLength - 1}/${body.byteLength}`,
        };
  response.writeHead(range === null ? 200 : 206, headers);
  const rest = body.subarray(start);
  if (dropFirst > 0) {
    dropFirst -= 1;
    response.write(rest.subarray(0, 1024 * 1024), () => response.destroy());
    return;
  }
  if (hold) {
    held.add(response);
    response.write(rest.subarray(0, 512 * 1024));
    return;
  }
  response.end(rest);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "sondine-models-"));
  home = join(dir, "home");
  root = join(home, "Library/Application Support/Sondine/models");
  requests = [];
  dropFirst = 0;
  hold = false;
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const response of held) response.destroy();
  held.clear();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

const artifact = (path = "/model.gguf"): CatalogArtifact => ({
  artifactId: "test-model",
  version: "abc1234",
  label: "Test model",
  fileName: "model.gguf",
  url: `${origin}${path}`,
  sizeBytes: content.byteLength,
  sha256,
  license: { id: "MIT", text: "MIT License\n", sha256: "", url: "https://example.invalid/LICENSE" },
  notices: "Copyright (c) Test\n",
  distribution: "user-download",
  minimumMemoryBytes: 32 * 1024 ** 3,
  knownLocations: ["Old App/model.gguf"],
  role: "final",
});

interface Harness {
  readonly manager: ModelManager;
  readonly statuses: ModelsStatus[];
  readonly installed: InstalledArtifact[];
  readonly picks: PickRequest[];
  readonly logged: { event: string; fields: Record<string, unknown> }[];
  latest(): ModelsStatus["artifacts"][number];
}

const managers: ModelManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stop();
});

function harness(
  options: {
    catalog?: CatalogArtifact[];
    pick?: string | null;
    free?: number;
    retryDelaysMs?: number[];
  } = {},
): Harness {
  const statuses: ModelsStatus[] = [];
  const installed: InstalledArtifact[] = [];
  const picks: PickRequest[] = [];
  const logged: Harness["logged"] = [];
  const record = (event: string, fields: Record<string, unknown> = {}) =>
    logged.push({ event, fields });
  const manager = new ModelManager({
    root,
    homeDir: home,
    catalog: options.catalog ?? [artifact()],
    policy,
    freeBytes: () => options.free ?? 1e15,
    memoryBytes: 32 * 1024 ** 3,
    pickFile: async (request) => {
      picks.push(request);
      return options.pick ?? null;
    },
    onStatus: (status) => statuses.push(status),
    onInstalled: (entry) => installed.push(entry),
    log: { info: record, warn: record },
    timing: { publishEveryMs: 250, retryDelaysMs: options.retryDelaysMs ?? [20, 20] },
  });
  managers.push(manager);
  return {
    manager,
    statuses,
    installed,
    picks,
    logged,
    latest: () => {
      const [first] = manager.status().artifacts;
      if (first === undefined) throw new Error("no artifact");
      return first;
    },
  };
}

const phase = (h: Harness, wanted: string) =>
  waitUntil(() => h.latest().phase === wanted, { label: `phase ${wanted}` });

/** Bytes of a download's partial file on disk. */
const onDisk = (entry: CatalogArtifact) => {
  try {
    return statSync(join(artifactDirectory(root, entry), ARTIFACT_LAYOUT.downloadPartial)).size;
  } catch {
    return 0;
  }
};

const placeFound = () => {
  const path = join(home, "Old App/model.gguf");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
};

describe("model manager", () => {
  it("reports a missing artifact with its license, the disk and the memory", async () => {
    const h = harness({ free: 50 * 1024 ** 3 });
    h.manager.start();
    await phase(h, "missing");
    expect(h.manager.status()).toEqual({
      artifacts: [
        {
          artifactId: "test-model",
          version: "abc1234",
          displayName: "Test model",
          sizeBytes: content.byteLength,
          minimumMemoryBytes: 32 * 1024 ** 3,
          role: "final",
          phase: "missing",
          progress: null,
          partialBytes: 0,
          found: null,
          downloadNeedsBytes: content.byteLength + 14 * 1024 ** 3,
          problem: null,
          license: { name: "MIT", url: "https://example.invalid/LICENSE" },
        },
      ],
      freeDiskBytes: 50 * 1024 ** 3,
      memoryBytes: 32 * 1024 ** 3,
    });
  });

  it("finds a file the user has, imports it by clone, and reports it installed", async () => {
    const source = placeFound();
    const h = harness();
    h.manager.start();
    await phase(h, "found");
    expect(h.latest().found).toEqual({ path: source, clones: true });
    await h.manager.import("test-model");
    await phase(h, "ready");
    expect(h.installed.map((entry) => entry.artifactId)).toEqual(["test-model"]);
    expect(h.manager.installed("test-model")?.sha256).toBe(sha256);
    expect(h.manager.installedModels()).toEqual([
      { artifactId: "test-model", version: "abc1234", verified: true },
    ]);
    expect(h.latest()).toMatchObject({ found: null, downloadNeedsBytes: 0, problem: null });
    expect(h.statuses.map((status) => status.artifacts[0]?.phase)).toContain("verifying");
    // Starting it again changes nothing.
    await h.manager.import("test-model");
    expect(h.installed).toHaveLength(1);
    // The log names ids, phases and codes, never the path.
    expect(JSON.stringify(h.logged)).not.toContain(source);
  });

  it("runs one job when an import and a download start together", async () => {
    placeFound();
    const h = harness();
    h.manager.start();
    await phase(h, "found");
    // The import reads the disk before starting; the download must not slip in, nor the reverse.
    await Promise.all([h.manager.import("test-model"), h.manager.download("test-model")]);
    const started = h.logged.filter(
      (entry) => entry.event === "models.job" && entry.fields["phase"] === "started",
    );
    expect(started).toHaveLength(1);
    await phase(h, "ready");
    expect(h.installed).toHaveLength(1);
  });

  it("starts a request made during the launch check once the check is done", async () => {
    const h = harness();
    h.manager.start();
    expect(h.latest().phase).toBe("verifying");
    await h.manager.download("test-model");
    await phase(h, "ready");
  });

  it("refuses an unknown artifact, and an import with no file to import", async () => {
    const h = harness();
    h.manager.start();
    await phase(h, "missing");
    await expect(h.manager.import("whisper")).rejects.toBeInstanceOf(ModelRequestError);
    await expect(h.manager.import("test-model")).rejects.toMatchObject({ reason: "no-file" });
    await expect(h.manager.download("whisper")).rejects.toBeInstanceOf(ModelRequestError);
  });

  it("fails an import whose file is not the model, without naming the file", async () => {
    const path = join(dir, "other.gguf");
    writeFileSync(path, Buffer.alloc(content.byteLength, 2));
    const h = harness();
    h.manager.start();
    await phase(h, "missing");
    await h.manager.import("test-model", path);
    await phase(h, "failed");
    expect(h.latest().problem).toMatchObject({ code: "hash_mismatch" });
    expect(h.latest().problem?.message).not.toContain(path);
  });

  it("imports the file the user picks in the open panel", async () => {
    const path = join(dir, "picked.gguf");
    writeFileSync(path, content);
    const h = harness({ pick: path });
    h.manager.start();
    await phase(h, "missing");
    const result = await h.manager.pick("test-model");
    expect(result.outcome).toBe("importing");
    expect(h.picks).toEqual([
      { artifactId: "test-model", label: "Test model", extensions: ["gguf"] },
    ]);
    await phase(h, "ready");
    const closed = harness({ catalog: [{ ...artifact(), artifactId: "other" }], pick: null });
    expect((await closed.manager.pick("other")).outcome).toBe("cancelled");
  });

  it("downloads once however often it is asked, with progress at most 4 times a second", async () => {
    hold = true;
    const h = harness();
    h.manager.start();
    await phase(h, "missing");
    void h.manager.download("test-model");
    await phase(h, "downloading");
    await waitUntil(() => onDisk(artifact()) === 512 * 1024, { label: "first bytes" });
    // Already running: the same job.
    expect((await h.manager.download("test-model")).artifacts[0]?.phase).toBe("downloading");
    expect((await h.manager.pick("test-model")).outcome).toBe("busy");
    expect(requests).toHaveLength(1);
    const released = h.statuses.length;
    // The rest arrives at once: about ten progress reports, coalesced.
    for (const response of held) response.end(content.subarray(512 * 1024));
    await phase(h, "ready");
    expect(requests).toHaveLength(1);
    const burst = h.statuses
      .slice(released)
      .filter((status) => status.artifacts[0]?.phase === "downloading");
    expect(burst.length).toBeLessThanOrEqual(1);
  });

  it("cancels a download keeping its bytes, resumes it with Range, and discards on request", async () => {
    hold = true;
    const h = harness();
    h.manager.start();
    await phase(h, "missing");
    void h.manager.download("test-model");
    await waitUntil(() => onDisk(artifact()) === 512 * 1024, { label: "first bytes" });
    const cancelled = await h.manager.cancel("test-model", false);
    expect(cancelled.artifacts[0]).toMatchObject({ phase: "missing", partialBytes: 512 * 1024 });
    expect(cancelled.artifacts[0]?.downloadNeedsBytes).toBe(
      content.byteLength - 512 * 1024 + 14 * 1024 ** 3,
    );

    hold = false;
    void h.manager.download("test-model");
    await phase(h, "ready");
    expect(requests.at(-1)?.range).toBe(`bytes=${512 * 1024}-`);

    // Another artifact: cancel with discard deletes the kept bytes.
    hold = true;
    const other = { ...artifact(), artifactId: "other" };
    const h2 = harness({ catalog: [other] });
    h2.manager.start();
    await phase(h2, "missing");
    void h2.manager.download("other");
    await waitUntil(() => onDisk(other) === 512 * 1024, { label: "other bytes" });
    const discarded = await h2.manager.cancel("other", true);
    expect(discarded.artifacts[0]).toMatchObject({ phase: "missing", partialBytes: 0 });
    expect(existsSync(join(artifactDirectory(root, other), ARTIFACT_LAYOUT.downloadPartial))).toBe(
      false,
    );
  });

  it("resumes on its own after a dropped connection, then fails past its retries", async () => {
    dropFirst = 1;
    const h = harness();
    h.manager.start();
    await phase(h, "missing");
    void h.manager.download("test-model");
    await phase(h, "ready");
    expect(requests.map((request) => request.range)).toEqual([
      undefined,
      expect.stringMatching(/^bytes=\d+-$/),
    ]);
    expect(h.logged.some((entry) => entry.event === "models.download-retry")).toBe(true);

    // Nothing listens there: every try fails without a new byte.
    const broken = harness({
      catalog: [{ ...artifact(), artifactId: "broken", url: "http://127.0.0.1:1/model.gguf" }],
      retryDelaysMs: [10, 10],
    });
    broken.manager.start();
    await phase(broken, "missing");
    void broken.manager.download("broken");
    await phase(broken, "failed");
    expect(broken.latest().problem?.code).toBe("network");
    expect(broken.logged.filter((entry) => entry.event === "models.download-retry")).toHaveLength(
      2,
    );
  });

  it("fails a download whose file is not the model, and one the disk cannot hold", async () => {
    const wrong = harness({ catalog: [artifact("/wrong")] });
    wrong.manager.start();
    await phase(wrong, "missing");
    void wrong.manager.download("test-model");
    await phase(wrong, "failed");
    expect(wrong.latest()).toMatchObject({ partialBytes: 0, problem: { code: "hash_mismatch" } });

    const full = harness({ catalog: [{ ...artifact(), artifactId: "full" }], free: 1024 });
    full.manager.start();
    await phase(full, "missing");
    void full.manager.download("full");
    await phase(full, "failed");
    expect(full.latest().problem?.code).toBe("disk_full");
  });

  it("finishes at launch an install a crash cut before its manifest", async () => {
    const source = join(dir, "source.gguf");
    writeFileSync(source, content);
    await importArtifact({ root, artifact: artifact(), source });
    rmSync(join(artifactDirectory(root, artifact()), ARTIFACT_LAYOUT.manifest));
    const h = harness();
    h.manager.start();
    await phase(h, "ready");
    expect(h.installed).toHaveLength(1);
    expect(requests).toHaveLength(0);
  });

  it("checks an installed artifact at launch, and reports a changed one as corrupt", async () => {
    const source = join(dir, "source.gguf");
    writeFileSync(source, content);
    await importArtifact({ root, artifact: artifact(), source });
    const h = harness();
    h.manager.start();
    await phase(h, "ready");
    expect(h.installed).toHaveLength(1);

    const other = { ...artifact(), sha256: "0".repeat(64) };
    const corrupt = harness({ catalog: [other] });
    corrupt.manager.start();
    await phase(corrupt, "failed");
    expect(corrupt.latest().problem?.code).toBe("corrupt");
    expect(corrupt.manager.installed("test-model")).toBeNull();
  });
});
