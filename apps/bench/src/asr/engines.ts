import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  NEMOTRON_ARTIFACT,
  SPEECH_CPP_RUNTIME,
  createNemotronEngine,
  createSpeechWorkerEngine,
  modelsDirectory,
  verifyArtifact,
  type AsrCapabilities,
  type AsrEngine,
  type EngineManifest,
  type EngineResources,
} from "@sondine/engines";
import { repoRoot } from "../paths.ts";
import { fetchPinned, PROBE_WEIGHTS, speechExecutable, type ProbeId } from "./assets.ts";
import type { EngineId } from "./ids.ts";

// The engines the bench compares (M1 exit): Nemotron 30B through the product
// adapter, and challengers as `probe` adapters on the same speech.cpp worker.
// Nemotron runs the app's own sandboxed `speech`: the product's worker guard
// matches that path, so the bench and Sondine never load two at once.

export interface BenchEngine {
  readonly engine: AsrEngine;
  /** Needs the Mac on power, idle-ish memory, and no Sondine worker (17 GB). */
  readonly heavy: boolean;
  readonly license: string;
}

/** The packaged app's speech worker; `$SONDINE_APP` points at another Sondine.app. */
export function appSpeechExecutable(): string {
  const app =
    process.env["SONDINE_APP"] ?? join(repoRoot, "apps/desktop/release/mac-arm64/Sondine.app");
  const path = join(app, "Contents/Helpers/Sondine Speech.app/Contents/MacOS/speech");
  if (!existsSync(path))
    throw new Error(`no app speech worker at ${path}: build the app or set SONDINE_APP`);
  return path;
}

interface ProbeSpec {
  readonly languages: readonly string[];
  readonly maxRequestSeconds: number;
  readonly peakBytesBase: number;
}

// Languages and limits from speech.cpp's model table at the pinned revision;
// peaks are rough until the bench measures them.
const PROBES: Record<ProbeId, ProbeSpec> = {
  "parakeet-tdt-0.6b-v3": {
    languages: "bg cs da de el en es et fi fr hr hu it lt lv mt nl pl pt ro ru sk sl sv uk".split(
      " ",
    ),
    maxRequestSeconds: 10 * 60,
    peakBytesBase: 2_000_000_000,
  },
  "qwen3-asr-1.7b": {
    languages: ["fr", "en"],
    maxRequestSeconds: 20 * 60,
    peakBytesBase: 3_000_000_000,
  },
  "qwen3-asr-0.6b": {
    languages: ["fr", "en"],
    maxRequestSeconds: 20 * 60,
    peakBytesBase: 1_500_000_000,
  },
};

export async function createBenchEngine(
  id: EngineId,
  log: (line: string) => void,
): Promise<BenchEngine> {
  if (id === "nemotron") {
    const verified = await verifyArtifact(modelsDirectory(), NEMOTRON_ARTIFACT, {
      rehash: "if-changed",
    });
    if (verified.status !== "verified") {
      throw new Error(
        `Nemotron is not installed and verified in ${modelsDirectory()} (${verified.status})`,
      );
    }
    return {
      engine: createNemotronEngine({
        speechBinary: appSpeechExecutable(),
        artifact: verified.installed,
      }),
      heavy: true,
      license: NEMOTRON_ARTIFACT.license.id,
    };
  }
  const weights = PROBE_WEIGHTS[id];
  const spec = PROBES[id];
  const path = await fetchPinned(weights, log);
  const manifest: EngineManifest = {
    id,
    version: "1",
    runtime: `${SPEECH_CPP_RUNTIME.name} ${SPEECH_CPP_RUNTIME.version}`,
    adapterClass: "probe",
    stages: ["asr"],
    artifacts: [{ artifactId: id, version: weights.sha256.slice(0, 12) }],
  };
  const capabilities: AsrCapabilities = {
    streaming: "none",
    nativeSpeakers: false,
    wordTimestamps: false,
    languages: spec.languages,
    maxRequestSeconds: spec.maxRequestSeconds,
    locality: "device",
  };
  const resources: EngineResources = {
    peakBytesBase: spec.peakBytesBase,
    peakBytesPerAudioHour: 0,
    coldLoadMs: 5_000,
    unloadLatencyMs: 1_000,
    computeUnits: ["gpu"],
  };
  return {
    engine: createSpeechWorkerEngine({
      manifest,
      capabilities,
      resources,
      executable: await speechExecutable(),
      weights: path,
      modelSha256: weights.sha256,
    }),
    heavy: false,
    license: weights.license,
  };
}
