import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Source } from "./schema.ts";

export const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
export async function json(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
export async function command(file: string, args: readonly string[], timeout = 120_000) {
  return new Promise<{ stdout: string; stderr: string; pid: number }>((resolve, reject) => {
    let stopped = false;
    // execFile does not forward detached to spawn. Use spawn explicitly so the
    // wrapper and its helper actually belong to a group owned by this call.
    const child = spawn(file, [...args], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text: string) => {
      bytes += Buffer.byteLength(text);
      if (bytes > 8 * 1024 * 1024) stop();
      else stdout += text;
    });
    child.stderr.on("data", (text: string) => {
      bytes += Buffer.byteLength(text);
      if (bytes > 8 * 1024 * 1024) stop();
      else stderr += text;
    });
    function cleanup() {
      clearTimeout(timer);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
    child.once("error", (error) => {
      cleanup();
      stop();
      reject(error);
    });
    child.once("close", (code) => {
      cleanup();
      if (code !== 0 || stopped || child.pid === undefined)
        reject(
          new Error(
            `${file} failed${stopped ? " (stopped or timed out)" : ""}: ${stderr.slice(-6000)}`,
          ),
        );
      else resolve({ stdout, stderr, pid: child.pid });
    });
    function stop() {
      stopped = true;
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
    const timer = setTimeout(stop, timeout);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

/** Cache is content-addressed. A partial/changed download can never become a corpus input. */
export async function acquire(
  url: string,
  expected: string,
  cache: string,
  limit = 130_000_000,
): Promise<string> {
  const dir = join(cache, "objects");
  await mkdir(dir, { recursive: true });
  const destination = join(dir, expected);
  try {
    if (sha256(await readFile(destination)) === expected) return destination;
    throw new Error(`Corrupt cached object: ${destination}`);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const response = await fetch(url, {
    signal: AbortSignal.timeout(120_000),
    headers: { "User-Agent": "Sondine-public-benchmark/1" },
  });
  if (!response.ok)
    throw new Error(
      `Corpus download HTTP ${response.status}; retry after ${response.headers.get("retry-after") ?? "unspecified"}. No automatic retry.`,
    );
  if (!response.body) throw new Error("Empty download response");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > limit) throw new Error("Corpus download exceeds byte limit");
    chunks.push(chunk);
  }
  const content = Buffer.concat(chunks);
  if (sha256(content) !== expected)
    throw new Error(`SHA-256 mismatch for corpus object ${expected}`);
  await writeFile(`${destination}.partial`, content);
  await rename(`${destination}.partial`, destination);
  return destination;
}

const rowsSchema = z.object({
  rows: z.array(
    z.object({
      row_idx: z.number(),
      row: z.object({ audio: z.array(z.object({ src: z.url() })).min(1) }),
    }),
  ),
});
export async function prepareSource(source: Source, cache: string) {
  let url = source.url;
  const cached = join(cache, "objects", source.sha256);
  try {
    if (sha256(await readFile(cached)) !== source.sha256)
      throw new Error(`Corrupt cached source: ${source.id}`);
    return decode(cached, source, cache);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  // FLEURS public download URLs have short-lived signatures. Resolve a fresh URL,
  // then enforce both the selected dataset revision and original content hash.
  if (source.lookup) {
    const response = await fetch(source.lookup.url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Corpus lookup HTTP ${response.status}`);
    const rows = rowsSchema.parse(await response.json());
    const row = rows.rows.find((item) => item.row_idx === source.lookup?.rowIndex);
    const src = row?.row.audio[0]?.src;
    if (!src) throw new Error("Selected FLEURS row missing");
    const parsed = new URL(src);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "datasets-server.huggingface.co" ||
      !parsed.pathname.includes(`/--/${source.lookup.revision}/--/`)
    )
      throw new Error("FLEURS revision or host changed");
    url = src;
  }
  let original: string;
  if (source.archive) {
    const archive = await acquire(url, source.archive.sha256, cache);
    const member = source.archive.member;
    if (!/^\.\/(yes|no)\/[a-z0-9_]+\.wav$/.test(member)) throw new Error("Invalid archive member");
    const result = await new Promise<Buffer>((resolve, reject) =>
      execFile(
        "tar",
        ["-xOf", archive, member],
        { encoding: "buffer", maxBuffer: 1024 * 1024 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      ),
    );
    if (sha256(result) !== source.sha256) throw new Error("Archive member hash changed");
    original = join(cache, "objects", source.sha256);
    await writeFile(original, result);
  } else original = await acquire(url, source.sha256, cache, 10_000_000);
  return decode(original, source, cache);
}
async function decode(original: string, source: Source, cache: string) {
  const destination = join(cache, "decoded", `${source.id}.wav`);
  await mkdir(join(cache, "decoded"), { recursive: true });
  await command("ffmpeg", [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    original,
    "-map",
    "0:a:0",
    "-ar",
    "16000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    "-fflags",
    "+bitexact",
    "-flags:a",
    "+bitexact",
    "-map_metadata",
    "-1",
    destination,
  ]);
  return destination;
}
