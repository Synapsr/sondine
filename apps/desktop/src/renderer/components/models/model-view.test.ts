import type { ModelArtifactStatus, ModelsStatus } from "@sondine/api";
import { describe, expect, it } from "vitest";
import { modelsBusy, modelsReady, modelsTooBig, modelView } from "./model-view";

const GB = 1_000_000_000;

const artifact = (patch: Partial<ModelArtifactStatus> = {}): ModelArtifactStatus => ({
  artifactId: "nemotron-3.5-transcribe-30b-iq4nl",
  version: "55d2890",
  displayName: "Nemotron",
  sizeBytes: 19 * GB,
  minimumMemoryBytes: 32 * 1024 ** 3,
  role: "final",
  phase: "missing",
  progress: null,
  partialBytes: 0,
  found: null,
  downloadNeedsBytes: 33 * GB,
  problem: null,
  license: { name: "OpenMDW-1.1", url: "https://huggingface.co/org/repo/blob/abc/LICENSE" },
  ...patch,
});

const status = (entry: ModelArtifactStatus, patch: Partial<ModelsStatus> = {}): ModelsStatus => ({
  artifacts: [entry],
  freeDiskBytes: 100 * GB,
  memoryBytes: 32 * 1024 ** 3,
  ...patch,
});

describe("model view", () => {
  it("offers the file found on this Mac first, then a file, then a download", () => {
    const found = artifact({
      phase: "found",
      found: { path: "/Users/t/model.gguf", clones: true },
    });
    expect(modelView(status(found), found)).toEqual({
      busy: false,
      ready: false,
      actions: ["import-found", "pick", "download"],
      missingDiskBytes: 0,
      lowMemory: false,
    });
    const missing = artifact();
    expect(modelView(status(missing), missing).actions).toEqual(["download", "pick"]);
  });

  it("offers to resume or discard a stopped download", () => {
    const stopped = artifact({
      phase: "failed",
      partialBytes: 7 * GB,
      problem: { code: "network", message: "reset", atMs: 0 },
    });
    expect(modelView(status(stopped), stopped).actions).toEqual(["resume", "pick", "discard"]);
  });

  it("offers only to cancel a job in progress", () => {
    for (const phase of ["importing", "downloading", "verifying"] as const) {
      const running = artifact({ phase, progress: 0.62 });
      expect(modelView(status(running), running)).toMatchObject({
        busy: true,
        actions: ["cancel"],
      });
    }
  });

  it("says how much disk a download still needs, and when memory is short", () => {
    const missing = artifact();
    expect(
      modelView(status(missing, { freeDiskBytes: 20 * GB, memoryBytes: 16 * 1024 ** 3 }), missing),
    ).toMatchObject({ missingDiskBytes: 13 * GB, lowMemory: true });
  });

  it("knows when every model is ready or one is busy", () => {
    expect(modelsReady(status(artifact({ phase: "ready" })))).toBe(true);
    expect(modelsReady(status(artifact()))).toBe(false);
    expect(modelsReady({ artifacts: [], freeDiskBytes: 0, memoryBytes: 0 })).toBe(false);
    expect(modelsBusy(status(artifact({ phase: "verifying" })))).toBe(true);
    expect(modelsBusy(status(artifact({ phase: "found" })))).toBe(false);
  });
});

describe("models the transcript needs", () => {
  it("leaves near-live text's model out of onboarding", () => {
    const ready = artifact({ phase: "ready" });
    const live = artifact({ artifactId: "parakeet-tdt-0.6b-v3-f16", role: "live" });
    expect(modelsReady({ ...status(ready), artifacts: [ready, live] })).toBe(true);
    expect(modelsReady({ ...status(live), artifacts: [live] })).toBe(false);
    expect(
      modelsBusy({ ...status(ready), artifacts: [ready, { ...live, phase: "downloading" }] }),
    ).toBe(false);
  });
});

describe("a Mac too small for the local model", () => {
  it("says so only while the model it cannot run is not installed", () => {
    const small = { memoryBytes: 16 * 1024 ** 3 };
    expect(modelsTooBig(status(artifact(), small))).toBe(true);
    expect(modelsTooBig(status(artifact()))).toBe(false);
    // Installed anyway (imported by hand): it is not offered again.
    expect(modelsTooBig(status(artifact({ phase: "ready" }), small))).toBe(false);
  });
});
