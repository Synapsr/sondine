import type { EngineManifest, EngineResources, TextCapabilities, TextEngine } from "./contract.ts";
import { EngineError } from "./contract.ts";
import { LLAMA_CPP_RUNTIME } from "./llama-cpp/runtime.ts";
import { createLlamaServerEngine, type LlamaServerExit } from "./llama-cpp/server-engine.ts";
import { JOURNAL_ARTIFACT } from "./models/catalog.ts";
import type { InstalledArtifact } from "./models/store.ts";
import { findWorkerProcesses } from "./speech-cpp/stale-worker.ts";

// The daily journal's model (ADR 028): Qwen3.5 9B Q4_K_M in a resident
// llama-server, on a Unix socket, its output held to the request's schema.

export const JOURNAL_MANIFEST: EngineManifest = {
  id: "qwen3.5-9b-journal",
  version: "1",
  runtime: `${LLAMA_CPP_RUNTIME.name} ${LLAMA_CPP_RUNTIME.version}`,
  adapterClass: "product",
  stages: ["textgen"],
  artifacts: [{ artifactId: JOURNAL_ARTIFACT.artifactId, version: JOURNAL_ARTIFACT.version }],
};

export const JOURNAL_CAPABILITIES: TextCapabilities = {
  languages: ["fr", "en"],
  // A window is at most 24,000 characters of transcript (about 8,000 tokens),
  // its instructions and its answer: 16,384 leaves room, and the server
  // allocates only that.
  contextTokens: 16_384,
  maxOutputTokens: 4_096,
  schemaConstrained: true,
  locality: "device",
};

/**
 * Measured on Téo's Mac (MacBook Air M5, 32 GB, macOS 27, `bench/results/journal-2026-11-09.md`):
 * the server's resident memory at its peak (the weights are mapped from the
 * file, so macOS can give their pages back), and its load from a warm file.
 */
export const JOURNAL_RESOURCES: EngineResources = {
  peakBytesBase: 6_300_000_000,
  peakBytesPerAudioHour: 0,
  coldLoadMs: 10_000,
  unloadLatencyMs: 2_000,
  computeUnits: ["gpu", "cpu"],
};

export interface JournalEngineOptions {
  /** `llama-server`: core's `textServer.binary`. */
  readonly server: string;
  /** Where it listens: core's `textServer.socket`. */
  readonly socket: string;
  /** From the model manager's verified install of `JOURNAL_ARTIFACT`. */
  readonly artifact: InstalledArtifact;
  readonly onExit?: (exit: LlamaServerExit) => void;
}

/** Throws `worker_running` while any process runs `server`: one server at a time. */
export async function assertNoServerProcess(server: string): Promise<void> {
  let pids: number[];
  try {
    pids = await findWorkerProcesses(server);
  } catch (error) {
    throw new EngineError("worker_running", "cannot check for a running text server", {
      cause: error,
    });
  }
  if (pids.length > 0) {
    throw new EngineError("worker_running", `a text server already runs (pid ${pids.join(", ")})`);
  }
}

export function createJournalEngine(options: JournalEngineOptions): TextEngine {
  const { artifact } = options;
  if (
    artifact.artifactId !== JOURNAL_ARTIFACT.artifactId ||
    artifact.version !== JOURNAL_ARTIFACT.version ||
    artifact.sha256 !== JOURNAL_ARTIFACT.sha256
  ) {
    throw new Error(
      `${artifact.artifactId}@${artifact.version} is not ${JOURNAL_ARTIFACT.artifactId}@${JOURNAL_ARTIFACT.version}`,
    );
  }
  return createLlamaServerEngine({
    manifest: JOURNAL_MANIFEST,
    capabilities: JOURNAL_CAPABILITIES,
    resources: JOURNAL_RESOURCES,
    executable: options.server,
    weights: artifact.path,
    modelSha256: artifact.sha256,
    socketPath: options.socket,
    beforeSpawn: () => assertNoServerProcess(options.server),
    ...(options.onExit === undefined ? {} : { onExit: options.onExit }),
  });
}
