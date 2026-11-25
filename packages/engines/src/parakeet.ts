import type { AsrCapabilities, AsrEngine, EngineManifest, EngineResources } from "./contract.ts";
import { PARAKEET_ARTIFACT } from "./models/catalog.ts";
import type { InstalledArtifact } from "./models/store.ts";
import { SPEECH_CPP_RUNTIME } from "./speech-cpp/runtime.ts";
import { assertNoWorkerProcess } from "./speech-cpp/stale-worker.ts";
import {
  createSpeechWorkerEngine,
  type SpeechWorkerDeadlines,
  type SpeechWorkerExit,
} from "./speech-cpp/worker-engine.ts";

// Near-live text (ADR 018, architecture §10): Parakeet TDT 0.6B v3 in its own
// resident speech.cpp worker, next to Nemotron's. One speaker at a time and no
// diarization; the final pass replaces what it writes.

export const PARAKEET_MANIFEST: EngineManifest = {
  id: "parakeet-tdt-0.6b-v3",
  version: "1",
  runtime: `${SPEECH_CPP_RUNTIME.name} ${SPEECH_CPP_RUNTIME.version}`,
  adapterClass: "product",
  stages: ["asr"],
  artifacts: [{ artifactId: PARAKEET_ARTIFACT.artifactId, version: PARAKEET_ARTIFACT.version }],
};

/** speech.cpp's model table at the pinned release: the 25 European languages. */
const PARAKEET_LANGUAGES: readonly string[] =
  "bg cs da de el en es et fi fr hr hu it lt lv mt nl pl pt ro ru sk sl sv uk".split(" ");

export const PARAKEET_CAPABILITIES: AsrCapabilities = {
  streaming: "none",
  nativeSpeakers: false,
  wordTimestamps: true,
  languages: PARAKEET_LANGUAGES,
  maxRequestSeconds: 10 * 60,
  locality: "device",
};

/**
 * On Téo's Mac (2026-11-08): loaded in 0.3 s, 7.9 s of French transcribed in
 * 0.26 s. The peak is an estimate until `analysis_runs.metrics` records it.
 */
export const PARAKEET_RESOURCES: EngineResources = {
  peakBytesBase: 2_000_000_000,
  peakBytesPerAudioHour: 0,
  coldLoadMs: 1_000,
  unloadLatencyMs: 1_000,
  computeUnits: ["gpu"],
};

export interface ParakeetEngineOptions {
  /** The `speech` executable (core's `speechBinary`). */
  readonly speechBinary: string;
  /** From `verifyArtifact(modelsDir, PARAKEET_ARTIFACT, …)`. */
  readonly artifact: InstalledArtifact;
  readonly deadlines?: Partial<SpeechWorkerDeadlines>;
  readonly onExit?: (exit: SpeechWorkerExit) => void;
}

export function createParakeetEngine(options: ParakeetEngineOptions): AsrEngine {
  const { artifact } = options;
  if (
    artifact.artifactId !== PARAKEET_ARTIFACT.artifactId ||
    artifact.version !== PARAKEET_ARTIFACT.version ||
    artifact.sha256 !== PARAKEET_ARTIFACT.sha256
  ) {
    throw new Error(
      `${artifact.artifactId}@${artifact.version} is not ${PARAKEET_ARTIFACT.artifactId}@${PARAKEET_ARTIFACT.version}`,
    );
  }
  return createSpeechWorkerEngine({
    manifest: PARAKEET_MANIFEST,
    capabilities: PARAKEET_CAPABILITIES,
    resources: PARAKEET_RESOURCES,
    executable: options.speechBinary,
    weights: artifact.path,
    modelSha256: artifact.sha256,
    runtimeVersion: SPEECH_CPP_RUNTIME.version,
    device: "gpu",
    // The final pass may run beside it; two threads leave it the CPU.
    threads: 2,
    ...(options.deadlines === undefined ? {} : { deadlines: options.deadlines }),
    ...(options.onExit === undefined ? {} : { onExit: options.onExit }),
    beforeSpawn: () => assertNoWorkerProcess(options.speechBinary, artifact.path),
  });
}
