import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { Database } from "@sondine/db";
import {
  EngineError,
  findWorkerProcesses,
  type AsrEngine,
  type AsrRequest,
  type AsrResult,
  type AsrSegment,
  type EngineState,
} from "@sondine/engines";
import { Effect, Layer } from "effect";
import type { SystemSample } from "../src/core/analysis/admission";
import {
  EngineProvider,
  SystemSignals,
  TrackAudioSource,
  type SystemSignalsService,
} from "../src/core/analysis/analysis-layer";
import type { MemoryUse } from "../src/core/analysis/memory-use";
import type { MemoryState } from "../src/core/analysis/system-signals";
import type { ReadTrackAudio } from "../src/core/audio/track-audio";
import { Database as CoreDatabase } from "../src/core/database";
import { waitUntil } from "./support";

// Test doubles for the analysis pipeline: an engine that "hears" non-zero
// stretches of the audio it is sent, an audio reader that synthesizes speech
// inside the recorded regions, and the Mac's signals as plain values.

export const SPOKEN = [" Bonjour", " Sondine"] as const;
const SPEECH_LEVEL = 1_000;

export interface FakeEngineOptions {
  /** Transcription never finishes on its own: it waits for its abort signal. */
  readonly hang?: boolean;
  /** Report progress (default true); without it admission cannot tell time left. */
  readonly progress?: boolean;
  readonly pid?: () => number | undefined;
  readonly speakers?: boolean;
  /** Runs while the request is in flight, before the result returns. */
  readonly whileRunning?: () => void;
  /** Every transcription fails with this error. */
  readonly fail?: EngineError;
  /** True: the model cannot time the request's text (speech.cpp's `untimed`). */
  readonly untimed?: (request: AsrRequest) => boolean;
  /** True: the request ends at the model's limit (`stop: "model_limit"`), its text cut short. */
  readonly modelLimit?: (request: AsrRequest) => boolean;
  /** Holds the load in its `loading` state until the promise settles. */
  readonly loading?: () => Promise<void>;
  /** Runs when a load finishes (true) and once the engine unloaded (false). */
  readonly onLoaded?: (loaded: boolean) => void;
}

export interface FakeEngine extends AsrEngine {
  readonly requests: AsrRequest[];
  loads: number;
  unloads: number;
}

const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

export function fakeEngine(options: FakeEngineOptions = {}): FakeEngine {
  let state: EngineState = "absent";
  const engine: FakeEngine = {
    manifest: {
      id: "fake-asr",
      version: "1",
      runtime: "fake 1",
      adapterClass: "probe",
      stages: ["asr", "diarize"],
      artifacts: [],
    },
    capabilities: {
      streaming: "none",
      nativeSpeakers: true,
      wordTimestamps: true,
      languages: ["fr", "en"],
      maxRequestSeconds: 3_600,
      locality: "device",
    },
    resources: {
      peakBytesBase: 1024 ** 3,
      peakBytesPerAudioHour: 0,
      coldLoadMs: 0,
      unloadLatencyMs: 0,
      computeUnits: ["cpu"],
    },
    requests: [],
    loads: 0,
    unloads: 0,
    state: () => state,
    pid: () => (state === "absent" ? undefined : options.pid?.()),
    async load(signal) {
      if (signal?.aborted === true) throw new EngineError("cancelled", "load cancelled");
      state = "loading";
      engine.loads += 1;
      await (options.loading?.() ?? Promise.resolve());
      // Read again after the wait: the signal may have fired meanwhile.
      if (isAborted(signal)) {
        state = "absent";
        throw new EngineError("cancelled", "load cancelled");
      }
      state = "ready";
      options.onLoaded?.(true);
      return { loadMs: 5 };
    },
    async transcribe(request, transcribeOptions = {}) {
      if (state === "absent") await engine.load(transcribeOptions.signal);
      engine.requests.push(request);
      state = "busy";
      try {
        if (options.progress !== false) transcribeOptions.onProgress?.(0.5);
        if (options.hang === true) {
          await new Promise<never>((_, reject) => {
            const signal = transcribeOptions.signal;
            const fail = () => reject(new EngineError("cancelled", "cancelled"));
            if (signal?.aborted === true) fail();
            signal?.addEventListener("abort", fail, { once: true });
          });
        }
        if (transcribeOptions.signal?.aborted === true) {
          throw new EngineError("cancelled", "cancelled");
        }
        options.whileRunning?.();
        if (options.fail !== undefined) {
          // A refused request or output leaves the worker running; anything else ends it.
          const healthy =
            options.fail.code === "invalid_output" || options.fail.code === "rejected";
          if (!healthy) state = "absent";
          throw options.fail;
        }
        if (options.untimed?.(request) === true) {
          throw new EngineError("invalid_output", "the engine could not time its text", {
            reason: "untimed",
          });
        }
        transcribeOptions.onProgress?.(1);
        const result = resultFor(request, options.speakers ?? true);
        if (options.modelLimit?.(request) !== true) return result;
        return { ...result, stop: "model_limit", segments: result.segments.slice(0, 1) };
      } finally {
        if (state === "busy") state = "ready";
      }
    },
    async unload() {
      engine.unloads += 1;
      state = "absent";
      options.onLoaded?.(false);
    },
  };
  return engine;
}

/** One segment per stretch of non-zero audio: "Bonjour Sondine", with word times. */
function resultFor(request: AsrRequest, speakers: boolean): AsrResult {
  const rate = request.sampleRate;
  const segments: AsrSegment[] = [];
  let start: number | null = null;
  const flush = (end: number) => {
    if (start === null) return;
    const startSec = start / rate;
    segments.push({
      startSec,
      endSec: end / rate,
      text: SPOKEN.join(""),
      speaker: speakers ? segments.length % 2 : null,
      tokens: SPOKEN.map((text, index) => ({
        startSec: startSec + index * 0.6,
        endSec: startSec + index * 0.6 + 0.5,
        text,
      })),
    });
    start = null;
  };
  request.samples.forEach((sample, index) => {
    if (sample !== 0 && start === null) start = index;
    if (sample === 0 && start !== null) flush(index);
  });
  flush(request.samples.length);
  return {
    requestId: request.id,
    text: segments.map((segment) => segment.text).join(""),
    stop: "complete",
    segments,
    languages: ["fr"],
    provenance: {
      engineId: "fake-asr",
      engineVersion: "1",
      runtime: "fake 1",
      adapterClass: "probe",
      modelSha256: "0".repeat(64),
      config: { speakers: request.speakers, timestamps: request.timestamps },
    },
    metrics: { audioMs: Math.round((request.samples.length * 1000) / rate), computeMs: 1 },
  };
}

/** Audio with speech inside every recorded region of the run, silence elsewhere. */
export function regionAudioReader(db: Database): ReadTrackAudio {
  return (range) => {
    const samples = new Int16Array(range.sampleEnd - range.sampleStart);
    const regions = db
      .statement(
        `SELECT sample_start, coalesce(sample_end, sample_start) AS sample_end FROM speech_regions
         WHERE track_run_id = ? AND sample_start < ? AND coalesce(sample_end, sample_start) > ?`,
      )
      .all(range.trackRunId, range.sampleEnd, range.sampleStart);
    for (const region of regions) {
      const from = Math.max(Number(region["sample_start"]), range.sampleStart);
      const to = Math.min(Number(region["sample_end"]), range.sampleEnd);
      samples.fill(SPEECH_LEVEL, from - range.sampleStart, to - range.sampleStart);
    }
    return { samples, missing: [] };
  };
}

export const idleOnPower: SystemSample = {
  onBattery: false,
  thermalState: "nominal",
  idleSeconds: 600,
  locked: false,
  memoryPressure: null,
  swapUsedBytes: null,
  swapRoomBytes: null,
};

export const roomyMemory: MemoryState = {
  memoryPressure: "normal",
  swapUsedBytes: 0,
  swapRoomBytes: 80 * 1024 ** 3,
};

/** Signals the test changes as it goes. */
export function fakeSignals(
  initial: Partial<SystemSample & MemoryState> = {},
  memoryUse: MemoryUse | null = null,
) {
  const current = { ...idleOnPower, ...roomyMemory, ...initial };
  const service: SystemSignalsService = {
    cheap: async () => ({
      ...current,
      memoryPressure: null,
      swapUsedBytes: null,
      swapRoomBytes: null,
    }),
    memory: async () => ({
      memoryPressure: current.memoryPressure,
      swapUsedBytes: current.swapUsedBytes,
      swapRoomBytes: current.swapRoomBytes,
    }),
    memoryUse: async () => memoryUse,
    receiveIdle: () => undefined,
  };
  return {
    current,
    set(values: Partial<SystemSample & MemoryState>) {
      Object.assign(current, values);
    },
    service,
    layer: Layer.succeed(SystemSignals, SystemSignals.of(service)),
  };
}

export function engineLayer(engine: () => AsrEngine | null) {
  return Layer.succeed(EngineProvider, EngineProvider.of({ current: engine }));
}

/** The region-synthesizing reader over core's own database. */
export const regionAudioLayer = Layer.effect(
  TrackAudioSource,
  Effect.map(CoreDatabase, (db) => {
    const reader = regionAudioReader(db);
    return TrackAudioSource.of({ reader: () => reader });
  }),
);

/**
 * A process whose command line reads `<dir>/bin/speech … worker …`, standing
 * for a worker a killed core left behind (core matches the speech binary's
 * exact path, which `ps` reports from argv[0], and for a recorded pid the
 * `worker` subcommand). Resolves once `ps` lists it that way: a loaded
 * machine can take seconds to, and a core started sooner would not see it.
 */
export async function straySpeechWorker(dir: string): Promise<{
  readonly child: ChildProcess;
  readonly binary: string;
}> {
  const binary = join(dir, "bin", "speech");
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)", "worker", "weights.gguf"],
    { argv0: binary, stdio: "ignore" },
  );
  try {
    await waitUntil(async () => (await findWorkerProcesses(binary)).includes(child.pid ?? -1), {
      label: "stray worker listed",
      timeoutMs: 20_000,
    });
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  return { child, binary };
}
