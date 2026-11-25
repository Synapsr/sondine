import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { SPEECH_CPP_RUNTIME } from "@sondine/engines";

// What the ASR bench downloads, each pinned to one upstream revision, size and
// sha256 (architecture §13: corpora and probe weights stay outside the repo).
// Engines never download (ADR 005): the bench fetches here, then hands paths.

/** `$SONDINE_BENCH_CACHE`, else ~/Library/Caches/sondine-bench. */
export const benchCache =
  process.env["SONDINE_BENCH_CACHE"] ?? join(homedir(), "Library", "Caches", "sondine-bench");

export interface PinnedFile {
  readonly url: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  /** Where it goes, relative to the bench cache. */
  readonly path: string;
}

export interface ProbeWeights extends PinnedFile {
  readonly license: string;
}

const hf = (repo: string, revision: string, file: string) =>
  `https://huggingface.co/${repo}/resolve/${revision}/${file}`;

/** Challenger weights, GGUF for the pinned speech.cpp (README at revision 6c16627 lists them). */
export const PROBE_WEIGHTS = {
  "parakeet-tdt-0.6b-v3": {
    url: hf(
      "sakasegawa/parakeet-tdt-0.6b-v3-GGUF",
      "b7ed82dbfba6e63da0ef9cf5104f5fc67da44414",
      "parakeet-tdt-0.6B-v3-F16.gguf",
    ),
    sizeBytes: 1_255_370_688,
    sha256: "7b74de31ac48427934104f0d074613f8d759d7d108777c114476346789d94426",
    path: "models/parakeet-tdt-0.6b-v3/parakeet-tdt-0.6B-v3-F16.gguf",
    license: "CC-BY-4.0",
  },
  "qwen3-asr-1.7b": {
    url: hf(
      "sakasegawa/Qwen3-ASR-1.7B-GGUF",
      "81e2423d24073cdeeccb5951df16accc89e075a2",
      "Qwen3-ASR-1.7B-Q8_0.gguf",
    ),
    sizeBytes: 2_176_109_216,
    sha256: "5f219b78a1d9c3b9e97da27708b36f8a0bc1bfc1650b541c0a6dbaf87c9a62d0",
    path: "models/qwen3-asr-1.7b/Qwen3-ASR-1.7B-Q8_0.gguf",
    license: "Apache-2.0",
  },
  "qwen3-asr-0.6b": {
    url: hf(
      "sakasegawa/Qwen3-ASR-0.6B-GGUF",
      "ee78f8709547f39bea3b924a16c72403826cac92",
      "Qwen3-ASR-0.6B-Q8_0.gguf",
    ),
    sizeBytes: 841_502_336,
    sha256: "416e10c15b4a3d9002bd337d18fc450233fdf68502b6e10d1379d2789838afd0",
    path: "models/qwen3-asr-0.6b/Qwen3-ASR-0.6B-Q8_0.gguf",
    license: "Apache-2.0",
  },
} as const satisfies Record<string, ProbeWeights>;

export type ProbeId = keyof typeof PROBE_WEIGHTS;

/** Region detection and speakers for the challengers' meeting pipeline (`speech asr --vad --diarize`). */
export const SILERO_VAD: PinnedFile = {
  url: hf(
    "sakasegawa/silero-vad-GGUF",
    "7fcb7aa2a70c312f8579fc987b3e1cdecf9321ca",
    "silero-vad-309K-v6.2-F32.gguf",
  ),
  sizeBytes: 1_238_624,
  sha256: "2fc312514e5fc4fa4ffd02b25c76a4853fa4130e8fb9777d01502183b01238cb",
  path: "models/silero-vad/silero-vad-309K-v6.2-F32.gguf",
};

export function cachePath(relative: string): string {
  return join(benchCache, relative);
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** Attempts before a download gives up; each resumes where the last one stopped. */
const DOWNLOAD_ATTEMPTS = 6;

/** Appends the rest of `url` to `partial` from its current size (HTTP range). */
async function resume(url: string, partial: string, total: number): Promise<void> {
  const have = existsSync(partial) ? statSync(partial).size : 0;
  if (have >= total) return;
  const response = await fetch(url, { headers: have > 0 ? { Range: `bytes=${have}-` } : {} });
  if (response.body === null || !(response.status === 200 || response.status === 206)) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  // A server that ignores the range sends the whole file again.
  const append = have > 0 && response.status === 206;
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(partial, { flags: append ? "a" : "w" }),
  );
}

/** The file from the cache when it matches, else downloaded (resumed on a cut) and checked. */
export async function fetchPinned(file: PinnedFile, log: (line: string) => void): Promise<string> {
  const path = cachePath(file.path);
  if (existsSync(path) && statSync(path).size === file.sizeBytes) {
    if ((await sha256File(path)) === file.sha256) return path;
  }
  mkdirSync(dirname(path), { recursive: true });
  log(`downloading ${basename(path)} (${(file.sizeBytes / 1e9).toFixed(2)} GB)`);
  const partial = `${path}.partial`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await resume(file.url, partial, file.sizeBytes);
      break;
    } catch (error) {
      if (attempt >= DOWNLOAD_ATTEMPTS) throw error;
      const have = existsSync(partial) ? statSync(partial).size : 0;
      log(
        `download cut at ${(have / 1e9).toFixed(2)} GB, resuming (${attempt}/${DOWNLOAD_ATTEMPTS - 1})`,
      );
      await new Promise((done) => setTimeout(done, 2_000 * attempt));
    }
  }
  const size = statSync(partial).size;
  const digest = await sha256File(partial);
  if (size !== file.sizeBytes || digest !== file.sha256) {
    rmSync(partial, { force: true });
    throw new Error(`${file.url} does not match its pinned size and sha256`);
  }
  renameSync(partial, path);
  return path;
}

/**
 * The pinned speech.cpp executable, unpacked from the archive the desktop
 * build caches (`$SONDINE_BUILD_CACHE`), checked against its sha256. Probes run
 * it outside the app's sandbox; Nemotron runs the app's own copy (engines.ts).
 */
export async function speechExecutable(): Promise<string> {
  const buildCache =
    process.env["SONDINE_BUILD_CACHE"] ?? join(homedir(), "Library", "Caches", "Sondine", "build");
  const archive = join(
    buildCache,
    "speech.cpp",
    basename(new URL(SPEECH_CPP_RUNTIME.archive.url).pathname),
  );
  const target = cachePath(`speech-cpp/${SPEECH_CPP_RUNTIME.version}/speech`);
  if (existsSync(target) && (await sha256File(target)) === SPEECH_CPP_RUNTIME.executable.sha256) {
    return target;
  }
  if (!existsSync(archive)) {
    throw new Error(
      `no speech.cpp archive at ${archive}: run pnpm --filter @sondine/desktop build:mac once`,
    );
  }
  const bytes = execFileSync("unzip", ["-p", archive, SPEECH_CPP_RUNTIME.executable.name], {
    maxBuffer: 256 * 1024 * 1024,
  });
  if (createHash("sha256").update(bytes).digest("hex") !== SPEECH_CPP_RUNTIME.executable.sha256) {
    throw new Error(`the speech executable in ${archive} does not match its pinned sha256`);
  }
  mkdirSync(dirname(target), { recursive: true });
  await writeFile(target, bytes);
  await chmod(target, 0o755);
  return target;
}
