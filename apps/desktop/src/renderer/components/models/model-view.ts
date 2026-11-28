import type { ModelArtifactStatus, ModelsStatus } from "@sondine/api";

// What the model section offers for one catalog artifact, in the first run
// and in Settings (ADR 016 "Models"): a file already on this Mac comes first
// (an import, free when it clones), then choosing a file, then a download the
// user starts. A job in progress can be cancelled; a stopped download keeps
// its bytes to resume, or can be discarded.

export type ModelAction = "import-found" | "pick" | "download" | "resume" | "cancel" | "discard";

export interface ModelView {
  /** A job runs: importing, downloading or verifying. */
  readonly busy: boolean;
  readonly ready: boolean;
  /** The first one is the main action. */
  readonly actions: readonly ModelAction[];
  /** Free space still missing for a download; 0 when there is enough. */
  readonly missingDiskBytes: number;
  /** This Mac has less memory than the model asks for. */
  readonly lowMemory: boolean;
}

export function modelView(status: ModelsStatus, artifact: ModelArtifactStatus): ModelView {
  const missingDiskBytes = Math.max(0, artifact.downloadNeedsBytes - status.freeDiskBytes);
  const lowMemory = status.memoryBytes < artifact.minimumMemoryBytes;
  const base = { missingDiskBytes, lowMemory };
  switch (artifact.phase) {
    case "ready":
      return { ...base, busy: false, ready: true, actions: [] };
    case "importing":
    case "downloading":
    case "verifying":
      return { ...base, busy: true, ready: false, actions: ["cancel"] };
    case "missing":
    case "found":
    case "failed":
      return { ...base, busy: false, ready: false, actions: idleActions(artifact) };
  }
}

function idleActions(artifact: ModelArtifactStatus): ModelAction[] {
  if (artifact.partialBytes > 0) return ["resume", "pick", "discard"];
  if (artifact.found !== null) return ["import-found", "pick", "download"];
  return ["download", "pick"];
}

/** The models every transcript needs (near-live text's has its own setting). */
const finalModels = (status: ModelsStatus) =>
  status.artifacts.filter((artifact) => artifact.role === "final");

/** The memory the transcript's models ask for, in whole GB, and this Mac's. */
export function memoryAsked(status: ModelsStatus): {
  readonly needed: number;
  readonly memory: number;
} {
  const gb = (bytes: number) => Math.round(bytes / 1024 ** 3);
  const needed = Math.max(0, ...finalModels(status).map((artifact) => artifact.minimumMemoryBytes));
  return { needed: gb(needed), memory: gb(status.memoryBytes) };
}

/** Whether every model the transcript needs is installed and verified. */
export function modelsReady(status: ModelsStatus): boolean {
  const models = finalModels(status);
  return models.length > 0 && models.every((artifact) => artifact.phase === "ready");
}

/** Whether a job runs on a model the transcript needs. */
export function modelsBusy(status: ModelsStatus): boolean {
  return finalModels(status).some(
    (artifact) =>
      artifact.phase === "importing" ||
      artifact.phase === "downloading" ||
      artifact.phase === "verifying",
  );
}

/**
 * This Mac cannot run the transcript's model: too little memory for one it
 * needs that is not installed (ADR 037: the first run then offers to go on
 * without transcription, and the cloud card).
 */
export function modelsTooBig(status: ModelsStatus): boolean {
  return finalModels(status).some(
    (artifact) => artifact.phase !== "ready" && status.memoryBytes < artifact.minimumMemoryBytes,
  );
}
