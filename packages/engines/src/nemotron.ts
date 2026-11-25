import type { AsrCapabilities, AsrEngine, EngineManifest, EngineResources } from "./contract.ts";
import { NEMOTRON_ARTIFACT } from "./models/catalog.ts";
import { nemotronProgress } from "./nemotron-progress.ts";
import { repairWordTimes } from "./nemotron-times.ts";
import type { InstalledArtifact } from "./models/store.ts";
import { SPEECH_CPP_RUNTIME } from "./speech-cpp/runtime.ts";
import { assertNoWorkerProcess } from "./speech-cpp/stale-worker.ts";
import {
  createSpeechWorkerEngine,
  type SpeechWorkerDeadlines,
  type SpeechWorkerExit,
} from "./speech-cpp/worker-engine.ts";

// The reference ASR + diarization engine (ADR 005, ADR 016): Nemotron 3.5
// Transcribe 30B-A4B IQ4_NL in a resident speech.cpp worker.

export const NEMOTRON_MANIFEST: EngineManifest = {
  id: "nemotron-3.5-transcribe-iq4nl",
  // 2: word times repaired (nemotron-times.ts).
  version: "2",
  runtime: `${SPEECH_CPP_RUNTIME.name} ${SPEECH_CPP_RUNTIME.version}`,
  adapterClass: "product",
  stages: ["asr", "diarize"],
  artifacts: [{ artifactId: NEMOTRON_ARTIFACT.artifactId, version: NEMOTRON_ARTIFACT.version }],
};

/** `speech info` on the weights: the `language` option's choices. */
const NEMOTRON_LANGUAGES: readonly string[] = (
  "ar bg bn cs da de el en es et fi fr he hi hr hu id it ja ko " +
  "lt lv mr mt nl pl pt ro ru sk sl sv ta te th tl tr uk vi zh"
).split(" ");

export const NEMOTRON_CAPABILITIES: AsrCapabilities = {
  streaming: "none",
  nativeSpeakers: true,
  wordTimestamps: true,
  languages: NEMOTRON_LANGUAGES,
  // The model takes up to an hour; ADR 016 cuts requests at 55 min.
  maxRequestSeconds: 55 * 60,
  locality: "device",
};

/**
 * Peak and cold load measured on Téo's Mac (MacBook Air M5, 32 GB, macOS
 * 27.0.1, `--device gpu --threads 4`, ADR 016 spike). The per-hour peak and
 * the unload latency are estimates until measured (nemotron.real.test.ts
 * reports both); admission then uses the peaks `analysis_runs.metrics` records.
 */
export const NEMOTRON_RESOURCES: EngineResources = {
  peakBytesBase: 17_100_000_000,
  peakBytesPerAudioHour: 2_000_000_000,
  coldLoadMs: 34_000,
  unloadLatencyMs: 2_000,
  // The MoE experts run on the CPU (the model's `experts_on_cpu` default).
  computeUnits: ["gpu", "cpu"],
};

export interface NemotronEngineOptions {
  /** The `speech` executable (core's `speechBinary`). */
  readonly speechBinary: string;
  /** From `verifyArtifact(modelsDir, NEMOTRON_ARTIFACT, …)`. */
  readonly artifact: InstalledArtifact;
  readonly deadlines?: Partial<SpeechWorkerDeadlines>;
  readonly onExit?: (exit: SpeechWorkerExit) => void;
}

export function createNemotronEngine(options: NemotronEngineOptions): AsrEngine {
  const { artifact } = options;
  if (
    artifact.artifactId !== NEMOTRON_ARTIFACT.artifactId ||
    artifact.version !== NEMOTRON_ARTIFACT.version ||
    artifact.sha256 !== NEMOTRON_ARTIFACT.sha256
  ) {
    throw new Error(
      `${artifact.artifactId}@${artifact.version} is not ${NEMOTRON_ARTIFACT.artifactId}@${NEMOTRON_ARTIFACT.version}`,
    );
  }
  return createSpeechWorkerEngine({
    manifest: NEMOTRON_MANIFEST,
    capabilities: NEMOTRON_CAPABILITIES,
    resources: NEMOTRON_RESOURCES,
    executable: options.speechBinary,
    weights: artifact.path,
    modelSha256: artifact.sha256,
    runtimeVersion: SPEECH_CPP_RUNTIME.version,
    device: "gpu",
    threads: 4,
    ...(options.deadlines === undefined ? {} : { deadlines: options.deadlines }),
    ...(options.onExit === undefined ? {} : { onExit: options.onExit }),
    beforeSpawn: () => assertNoWorkerProcess(options.speechBinary, artifact.path),
    progress: nemotronProgress(),
    wordTimes: repairWordTimes,
  });
}
