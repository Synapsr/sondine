import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, hostname, totalmem } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  charErrorRate,
  ERROR_RATE_VERSION,
  frNormId,
  frNormTokens,
  wordErrorRate,
  type ErrorCounts,
} from "@sondine/core";
import type { Corpus } from "./corpus.ts";
import { loadSamples } from "./corpus.ts";
import { createBenchEngine } from "./engines.ts";
import type { EngineId } from "./ids.ts";
import { bootstrapRate } from "./score.ts";

// One engine over one corpus: cold load, each item transcribed as the product
// sends it (no language hint), scored with fr-norm, and its costs. Results go
// to bench/results/local (git-ignored); never audio, always the references.

const run = promisify(execFile);

export const ASR_RESULT_SCHEMA = "sondine-bench/asr/1";

export interface ItemResult {
  readonly id: string;
  readonly language: "fr" | "en";
  readonly durationMs: number;
  readonly reference: string;
  readonly hypothesis: string;
  readonly languages: readonly string[];
  readonly stop: "complete" | "model_limit";
  readonly computeMs: number;
  readonly wallMs: number;
  readonly words: ErrorCounts;
  readonly chars: ErrorCounts;
}

export interface AsrRunResult {
  readonly schema: typeof ASR_RESULT_SCHEMA;
  readonly label: string;
  readonly engine: {
    readonly id: EngineId;
    readonly manifest: unknown;
    readonly provenance: unknown;
    readonly license: string;
    readonly request: { readonly speakers: boolean; readonly timestamps: boolean };
  };
  readonly corpus: {
    readonly id: string;
    readonly manifestSha256: string;
    readonly items: number;
    readonly audioMs: number;
    readonly license: string;
  };
  readonly host: Readonly<Record<string, unknown>>;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: "complete" | "stopped";
  readonly stopReason: string | null;
  readonly scoring: { readonly normalizer: string; readonly errorRate: string };
  readonly cost: {
    readonly coldLoadMs: number;
    readonly computeMs: number;
    readonly wallMs: number;
    /** Audio seconds per compute second, warm. */
    readonly rtfx: number;
    readonly peakFootprintBytes: number | null;
    readonly swapUsedMbStart: number | null;
    /** The stop rule's baseline: a cold load pushes other apps to swap by design. */
    readonly swapUsedMbAfterLoad: number | null;
    readonly swapUsedMbEnd: number | null;
  };
  readonly totals: {
    readonly wer: number | null;
    readonly werCi95: readonly [number, number] | null;
    readonly cer: number | null;
  };
  readonly items: readonly ItemResult[];
}

async function text(command: string, args: readonly string[]): Promise<string | null> {
  try {
    return (await run(command, [...args], { timeout: 10_000 })).stdout;
  } catch {
    return null;
  }
}

async function swapUsedMb(): Promise<number | null> {
  const out = await text("sysctl", ["-n", "vm.swapusage"]);
  const match = out?.match(/used = ([\d.]+)M/);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/** 1 normal, 2 warn, 4 critical (kern.memorystatus_vm_pressure_level). */
async function pressureLevel(): Promise<number | null> {
  const out = await text("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]);
  return out === null ? null : Number(out.trim());
}

async function onAc(): Promise<boolean | null> {
  const out = await text("pmset", ["-g", "batt"]);
  return out === null ? null : out.includes("'AC Power'");
}

/** The process's physical footprint (what Activity Monitor shows), from `footprint`. */
async function footprintBytes(pid: number): Promise<number | null> {
  const out = await text("footprint", ["-p", String(pid)]);
  const match = out?.match(/Footprint:\s+([\d.]+)\s+(KB|MB|GB)/);
  if (match?.[1] === undefined) return null;
  const unit = { KB: 1e3, MB: 1e6, GB: 1e9 }[match[2] as "KB" | "MB" | "GB"];
  return Math.round(Number(match[1]) * unit);
}

function host(): Record<string, unknown> {
  const sw = (key: string) => {
    try {
      return execFileSync("sw_vers", [key], { encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  };
  let model: string | null = null;
  try {
    model = execFileSync("sysctl", ["-n", "hw.model"], { encoding: "utf8" }).trim();
  } catch {
    model = null;
  }
  return {
    hostname: hostname(),
    model,
    cpu: cpus()[0]?.model ?? null,
    memoryBytes: totalmem(),
    os: sw("-productVersion"),
    osBuild: sw("-buildVersion"),
  };
}

/**
 * Swap growth past the loaded engine that stops a run: the Mac is thrashing
 * and the costs mean nothing (the product's admission uses the same rule).
 */
const SWAP_GROWTH_STOP_MB = 2048;

export async function runAsr(options: {
  readonly engineId: EngineId;
  readonly corpus: Corpus;
  readonly label: string;
  readonly resultsDirectory: string;
  readonly log: (line: string) => void;
}): Promise<{ readonly path: string; readonly result: AsrRunResult }> {
  const { corpus, log } = options;
  const bench = await createBenchEngine(options.engineId, log);
  const { engine } = bench;
  // The product's own request for Nemotron; text only for the challengers.
  const request = bench.heavy
    ? { speakers: true, timestamps: true }
    : { speakers: false, timestamps: false };

  if (bench.heavy) {
    if ((await onAc()) === false) throw new Error("Nemotron runs only on AC power");
    const level = await pressureLevel();
    if (level !== null && level !== 1)
      throw new Error("memory pressure is not normal: try again later");
  }
  const swapStart = await swapUsedMb();
  const startedAt = new Date().toISOString();
  let peak: number | null = null;
  const samplePeak = async () => {
    const pid = engine.pid();
    if (pid === undefined) return;
    const bytes = await footprintBytes(pid);
    if (bytes !== null) peak = Math.max(peak ?? 0, bytes);
  };
  // Every second during long requests, plus after the load and after each item.
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      await samplePeak();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  })();

  const items: ItemResult[] = [];
  let status: "complete" | "stopped" = "complete";
  let stopReason: string | null = null;
  let provenance: unknown = null;
  let coldLoadMs = 0;
  let swapAfterLoad: number | null = null;
  try {
    log(`loading ${options.engineId}`);
    coldLoadMs = (await engine.load()).loadMs;
    await samplePeak();
    swapAfterLoad = await swapUsedMb();
    log(`loaded in ${(coldLoadMs / 1000).toFixed(1)} s`);
    for (const [index, item] of corpus.items.entries()) {
      const swap = await swapUsedMb();
      if (swapAfterLoad !== null && swap !== null && swap - swapAfterLoad > SWAP_GROWTH_STOP_MB) {
        status = "stopped";
        stopReason = `swap grew ${Math.round(swap - swapAfterLoad)} MB after the load`;
        break;
      }
      const samples = loadSamples(corpus, item);
      const began = performance.now();
      const result = await engine.transcribe({
        id: `${options.label}-${index}`,
        samples,
        sampleRate: 16_000,
        speakers: request.speakers,
        timestamps: request.timestamps,
      });
      const wallMs = performance.now() - began;
      await samplePeak();
      provenance ??= result.provenance;
      const ref = frNormTokens(item.reference, { language: item.language });
      const hyp = frNormTokens(result.text, { language: item.language });
      const words = wordErrorRate(ref, hyp, { alignment: false });
      const chars = charErrorRate(ref.join(" "), hyp.join(" "), { alignment: false });
      items.push({
        id: item.id,
        language: item.language,
        durationMs: item.durationMs,
        reference: item.reference,
        hypothesis: result.text,
        languages: result.languages,
        stop: result.stop,
        computeMs: result.metrics.computeMs,
        wallMs: Math.round(wallMs),
        words: strip(words),
        chars: strip(chars),
      });
      if ((index + 1) % 10 === 0) log(`${index + 1}/${corpus.items.length}`);
    }
  } finally {
    sampling = false;
    await sampler;
    await engine.unload();
  }

  const computeMs = items.reduce((sum, item) => sum + item.computeMs, 0);
  const wallMs = items.reduce((sum, item) => sum + item.wallMs, 0);
  const audioMs = items.reduce((sum, item) => sum + item.durationMs, 0);
  const wer = bootstrapRate(items.map((item) => item.words));
  const cer = bootstrapRate(items.map((item) => item.chars));
  const result: AsrRunResult = {
    schema: ASR_RESULT_SCHEMA,
    label: options.label,
    engine: {
      id: options.engineId,
      manifest: engine.manifest,
      provenance,
      license: bench.license,
      request,
    },
    corpus: {
      id: corpus.id,
      manifestSha256: corpus.manifestSha256,
      items: items.length,
      audioMs,
      license: corpus.license,
    },
    host: { ...host(), acPower: await onAc() },
    startedAt,
    finishedAt: new Date().toISOString(),
    status,
    stopReason,
    scoring: { normalizer: frNormId(), errorRate: ERROR_RATE_VERSION },
    cost: {
      coldLoadMs,
      computeMs,
      wallMs,
      rtfx: computeMs > 0 ? audioMs / computeMs : 0,
      peakFootprintBytes: peak,
      swapUsedMbStart: swapStart,
      swapUsedMbAfterLoad: swapAfterLoad,
      swapUsedMbEnd: await swapUsedMb(),
    },
    totals: { wer: wer.rate, werCi95: wer.ci95, cer: cer.rate },
    items,
  };
  mkdirSync(options.resultsDirectory, { recursive: true });
  const stamp = startedAt.replaceAll(":", "-").replace(/\.\d+Z$/, "Z");
  const path = join(options.resultsDirectory, `asr-${options.engineId}-${corpus.id}-${stamp}.json`);
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
  return { path, result };
}

function strip(counts: ErrorCounts): ErrorCounts {
  const { hits, substitutions, insertions, deletions, errors, refLength, hypLength } = counts;
  return { hits, substitutions, insertions, deletions, errors, refLength, hypLength };
}
