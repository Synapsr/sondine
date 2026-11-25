import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CatalogArtifact } from "./catalog.ts";
import {
  DOWNLOAD_POLICY,
  discardDownload,
  downloadArtifact,
  downloadedBytes,
  urlAllowed,
  type DownloadPolicy,
  type DownloadProgress,
} from "./download.ts";
import { ARTIFACT_LAYOUT, ModelStoreError, artifactDirectory, verifyArtifact } from "./store.ts";

// A local HTTP server on 127.0.0.1 stands for Hugging Face and its CDN; the
// files are a few MiB of random bytes. Nothing here reaches the network.

const ETAG = '"v1"';
const content = randomBytes(2 * 1024 * 1024 + 13);
const sha256 = createHash("sha256").update(content).digest("hex");

interface Seen {
  readonly path: string;
  readonly range: string | undefined;
  readonly ifRange: string | undefined;
}

let dir: string;
let root: string;
let server: Server;
let origin: string;
let seen: Seen[];
let drops: number;

const testPolicy: DownloadPolicy = {
  protocols: ["http:"],
  hosts: { "127.0.0.1": [{ host: "127.0.0.1" }] },
  maxRedirects: 3,
};

/** Serves `body` with Range support, as a CDN does. */
function serveFile(request: IncomingMessage, response: ServerResponse, body: Buffer = content) {
  const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? "");
  const ifRange = request.headers["if-range"];
  if (range !== null && (ifRange === undefined || ifRange === ETAG)) {
    const start = Number(range[1]);
    if (start >= body.byteLength) {
      response.writeHead(416, { "content-range": `bytes */${body.byteLength}` }).end();
      return;
    }
    response.writeHead(206, {
      etag: ETAG,
      "content-length": body.byteLength - start,
      "content-range": `bytes ${start}-${body.byteLength - 1}/${body.byteLength}`,
    });
    response.end(body.subarray(start));
    return;
  }
  response.writeHead(200, { etag: ETAG, "content-length": body.byteLength });
  response.end(body);
}

function handle(request: IncomingMessage, response: ServerResponse) {
  const path = request.url ?? "/";
  seen.push({
    path,
    range: request.headers.range,
    ifRange: request.headers["if-range"] as string | undefined,
  });
  const hops = /^\/redirect\/(\d+)$/.exec(path);
  if (hops !== null) {
    const left = Number(hops[1]);
    response.writeHead(302, { location: left === 0 ? "/file" : `/redirect/${left - 1}` }).end();
    return;
  }
  switch (path) {
    case "/file":
      serveFile(request, response);
      return;
    case "/no-range":
      response.writeHead(200, { etag: ETAG, "content-length": content.byteLength });
      response.end(content);
      return;
    case "/drop":
      // The first answer stops after 1 MiB, as a dropped Wi-Fi would; later ones resume.
      if (drops === 0) {
        drops += 1;
        response.writeHead(200, { etag: ETAG, "content-length": content.byteLength });
        response.write(content.subarray(0, 1024 * 1024), () => response.destroy());
        return;
      }
      serveFile(request, response);
      return;
    case "/slow":
      response.writeHead(200, { etag: ETAG, "content-length": content.byteLength });
      response.write(content.subarray(0, 256 * 1024));
      return;
    case "/elsewhere":
      response.writeHead(302, { location: `${origin.replace("127.0.0.1", "localhost")}/file` });
      response.end();
      return;
    case "/https":
      response.writeHead(302, { location: `${origin.replace("http:", "https:")}/file` }).end();
      return;
    case "/announce-big":
      response.writeHead(200, { "content-length": content.byteLength + 1 }).end();
      return;
    case "/send-big":
      // Chunked, no length announced: the excess shows only while reading.
      response.writeHead(200);
      response.write(content);
      response.end(Buffer.from("extra"));
      return;
    case "/bad-range":
      if (request.headers.range !== undefined) {
        response.writeHead(206, {
          "content-range": `bytes 0-${content.byteLength - 1}/${content.byteLength}`,
        });
        response.end(content);
        return;
      }
      response.writeHead(200, { etag: ETAG, "content-length": content.byteLength });
      response.write(content.subarray(0, 1024 * 1024), () => response.destroy());
      return;
    case "/gone-range":
      if (request.headers.range !== undefined) {
        response.writeHead(416).end();
        return;
      }
      serveFile(request, response);
      return;
    case "/encoded":
      response.writeHead(200, { "content-encoding": "gzip" }).end(content);
      return;
    case "/wrong": {
      const other = Buffer.from(content);
      other[0] = (other[0] ?? 0) ^ 0xff;
      serveFile(request, response, other);
      return;
    }
    case "/busy":
      response.writeHead(503).end();
      return;
    default:
      response.writeHead(404).end();
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "sondine-download-"));
  root = join(dir, "models");
  seen = [];
  drops = 0;
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

const artifactAt = (path: string): CatalogArtifact => ({
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
  minimumMemoryBytes: 0,
  knownLocations: [],
  role: "final",
});

const download = (path: string, options: Partial<Parameters<typeof downloadArtifact>[0]> = {}) =>
  downloadArtifact({
    root,
    artifact: artifactAt(path),
    policy: testPolicy,
    freeBytes: () => Number.MAX_SAFE_INTEGER,
    syncEveryBytes: 64 * 1024,
    ...options,
  });

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ModelStoreError) return error;
    throw error;
  }
  throw new Error("expected a ModelStoreError");
};

const files = (path: string) => readdirSync(artifactDirectory(root, artifactAt(path))).toSorted();
const partialOf = (path: string) =>
  join(artifactDirectory(root, artifactAt(path)), ARTIFACT_LAYOUT.downloadPartial);

describe("download policy", () => {
  const pinned = new URL(
    "https://huggingface.co/org/repo/resolve/55d289085ed6b1acd1cfd2e6cf279fdeb32fee5f/model.gguf",
  );
  const allowed = (url: string) => urlAllowed(new URL(url), pinned, DOWNLOAD_POLICY);

  it("allows the pinned host and Hugging Face's CDN, over https only", () => {
    expect(allowed(pinned.href)).toBe(true);
    expect(allowed("https://us.aws.cdn.hf.co/xet-bridge-us/abc?X-Amz-Signature=1")).toBe(true);
    expect(allowed("https://cas-bridge.xethub.hf.co/xet-bridge-us/abc")).toBe(true);
    expect(allowed("https://cdn-lfs-us-1.hf.co/repos/x")).toBe(true);
    expect(allowed("http://us.aws.cdn.hf.co/x")).toBe(false);
    expect(allowed("https://hf.co/x")).toBe(false);
    expect(allowed("https://hf.co.example.com/x")).toBe(false);
    expect(allowed("https://evilhf.co/x")).toBe(false);
    expect(allowed("https://example.com/x")).toBe(false);
    expect(allowed("https://us.aws.cdn.hf.co:8443/x")).toBe(false);
    expect(allowed("https://user:secret@us.aws.cdn.hf.co/x")).toBe(false);
  });

  it("refuses a pinned URL whose host has no rule", () => {
    const other = new URL("https://example.com/model.gguf");
    expect(urlAllowed(other, other, DOWNLOAD_POLICY)).toBe(false);
  });

  it("never fetches a pinned URL the app's policy refuses", async () => {
    const error = await failure(
      downloadArtifact({ root, artifact: artifactAt("/file"), freeBytes: () => 1e15 }),
    );
    expect(error.code).toBe("redirect_refused");
    expect(seen).toEqual([]);
  });
});

describe("downloadArtifact", () => {
  it("downloads, verifies the complete file, and installs it", async () => {
    const progress: DownloadProgress[] = [];
    const result = await download("/redirect/2", {
      onProgress: (step) => progress.push(step),
      now: () => 5_000,
    });
    expect(result).toMatchObject({ status: "downloaded", resumedFromBytes: 0, restarted: false });
    expect(readFileSync(result.installed.path).equals(content)).toBe(true);
    expect(statSync(result.installed.path).mode & 0o777).toBe(0o444);
    expect(files("/redirect/2")).toEqual([
      "LICENSE.txt",
      "NOTICE.txt",
      "manifest.json",
      "model.gguf",
    ]);
    expect(
      await verifyArtifact(root, artifactAt("/redirect/2"), { rehash: "always" }),
    ).toMatchObject({ status: "verified" });
    expect(seen.map((request) => request.path)).toEqual([
      "/redirect/2",
      "/redirect/1",
      "/redirect/0",
      "/file",
    ]);
    expect(seen.every((request) => request.range === undefined)).toBe(true);
    const downloads = progress.filter((step) => step.phase === "download");
    expect(downloads.at(-1)).toEqual({
      phase: "download",
      bytes: content.byteLength,
      totalBytes: content.byteLength,
    });
    expect(progress.at(-2)).toEqual({
      phase: "verify",
      bytes: content.byteLength,
      totalBytes: content.byteLength,
    });
    expect(progress.at(-1)).toEqual({ phase: "done" });
  });

  it("does nothing for an artifact already installed", async () => {
    await download("/file");
    seen = [];
    expect(await download("/file")).toMatchObject({ status: "already-installed" });
    expect(seen).toEqual([]);
  });

  it("refuses a redirect to another host, another scheme, or past the hop limit", async () => {
    expect((await failure(download("/elsewhere"))).code).toBe("redirect_refused");
    expect((await failure(download("/https"))).code).toBe("redirect_refused");
    seen = [];
    expect((await failure(download("/redirect/5"))).code).toBe("redirect_refused");
    // The pinned request and three redirects, then nothing more.
    expect(seen).toHaveLength(4);
  });

  it("checks the disk before any request: the file plus the headroom", async () => {
    const error = await failure(download("/file", { freeBytes: () => content.byteLength }));
    expect(error.code).toBe("disk_full");
    expect(seen).toEqual([]);
  });

  it("resumes a dropped transfer with Range and If-Range, keeping the bytes it had", async () => {
    const dropped = await failure(download("/drop"));
    expect(dropped).toMatchObject({ code: "network", retryable: true });
    const kept = await downloadedBytes(root, artifactAt("/drop"));
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThanOrEqual(1024 * 1024);
    expect(statSync(partialOf("/drop")).size).toBe(kept);

    const result = await download("/drop");
    expect(result).toMatchObject({
      status: "downloaded",
      resumedFromBytes: kept,
      restarted: false,
    });
    expect(seen.at(-1)).toEqual({ path: "/drop", range: `bytes=${kept}-`, ifRange: ETAG });
    expect(readFileSync(result.installed.path).equals(content)).toBe(true);
    expect(files("/drop")).not.toContain(ARTIFACT_LAYOUT.downloadState);
  });

  it("drops bytes written after the last sync, as after a crash", async () => {
    await failure(download("/drop"));
    const kept = await downloadedBytes(root, artifactAt("/drop"));
    appendFileSync(partialOf("/drop"), Buffer.alloc(4096, 0xee));
    const result = await download("/drop");
    expect(result.resumedFromBytes).toBe(kept);
    expect(readFileSync(result.installed.path).equals(content)).toBe(true);
  });

  it("starts over cleanly when the server answers a resume with the whole file", async () => {
    await failure(download("/drop"));
    // The same partial, now served by a server without range support.
    const from = artifactDirectory(root, artifactAt("/drop"));
    const state = JSON.parse(
      readFileSync(join(from, ARTIFACT_LAYOUT.downloadState), "utf8"),
    ) as Record<string, unknown>;
    writeFileSync(
      join(from, ARTIFACT_LAYOUT.downloadState),
      JSON.stringify({ ...state, url: `${origin}/no-range` }),
    );
    const result = await download("/no-range");
    expect(result).toMatchObject({ status: "downloaded", restarted: true });
    expect(seen.at(-1)?.range).toMatch(/^bytes=\d+-$/);
    expect(readFileSync(result.installed.path).equals(content)).toBe(true);
  });

  it("starts over when the server no longer has the range", async () => {
    await failure(download("/drop"));
    const from = artifactDirectory(root, artifactAt("/drop"));
    const state = JSON.parse(
      readFileSync(join(from, ARTIFACT_LAYOUT.downloadState), "utf8"),
    ) as Record<string, unknown>;
    writeFileSync(
      join(from, ARTIFACT_LAYOUT.downloadState),
      JSON.stringify({ ...state, url: `${origin}/gone-range` }),
    );
    const result = await download("/gone-range");
    expect(result).toMatchObject({ status: "downloaded", restarted: true });
    expect(seen.slice(-2).map((request) => request.range)).toEqual([
      expect.stringMatching(/^bytes=\d+-$/),
      undefined,
    ]);
  });

  it("refuses a 206 whose Content-Range is not the range asked for", async () => {
    await failure(download("/bad-range"));
    const kept = await downloadedBytes(root, artifactAt("/bad-range"));
    expect(kept).toBeGreaterThan(0);
    const error = await failure(download("/bad-range"));
    expect(error.code).toBe("bad_response");
    // Nothing was written: the partial still resumes from the same byte.
    expect(await downloadedBytes(root, artifactAt("/bad-range"))).toBe(kept);
  });

  it("refuses more bytes than the catalog's size, announced or sent", async () => {
    expect((await failure(download("/announce-big"))).code).toBe("too_large");
    expect((await failure(download("/send-big"))).code).toBe("too_large");
    expect(statSync(partialOf("/send-big")).size).toBeLessThanOrEqual(content.byteLength);
  });

  it("refuses an encoded body and reports a busy server as retryable", async () => {
    expect((await failure(download("/encoded"))).code).toBe("bad_response");
    expect(await failure(download("/busy"))).toMatchObject({
      code: "http_status",
      retryable: true,
    });
  });

  it("deletes a complete file whose sha256 is wrong and installs nothing", async () => {
    expect((await failure(download("/wrong"))).code).toBe("hash_mismatch");
    expect(files("/wrong")).toEqual([]);
    expect(await verifyArtifact(root, artifactAt("/wrong"), { rehash: "never" })).toEqual({
      status: "missing",
    });
  });

  it("keeps the partial on cancel, and an explicit discard deletes it", async () => {
    const controller = new AbortController();
    const error = await failure(
      download("/slow", {
        signal: controller.signal,
        onProgress: (step) => {
          if (step.phase === "download" && step.bytes >= 256 * 1024) controller.abort();
        },
      }),
    );
    expect(error.code).toBe("cancelled");
    expect(await downloadedBytes(root, artifactAt("/slow"))).toBe(256 * 1024);
    await discardDownload(root, artifactAt("/slow"));
    expect(await downloadedBytes(root, artifactAt("/slow"))).toBe(0);
    expect(files("/slow")).toEqual([]);
  });

  it("starts from zero when the kept partial describes another file", async () => {
    await failure(download("/drop"));
    // Same directory, another pinned URL: the partial is not this download's.
    const result = await download("/file");
    expect(result.resumedFromBytes).toBe(0);
    expect(seen.at(-1)?.range).toBeUndefined();
    expect(existsSync(partialOf("/file"))).toBe(false);
  });
});
