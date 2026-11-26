import { getEventListeners } from "node:events";
import type { AnalysisStatus } from "@sondine/api";
import { bumpInputGeneration, checkSearchIndex, loadAnalysisInput } from "@sondine/db";
import { EngineError } from "@sondine/engines";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Boot, rows, scalar, tempDb, type Run, type TempDb } from "../../../test/capture-fixture";
import {
  fakeEngine,
  fakeSignals,
  regionAudioReader,
  type FakeEngine,
} from "../../../test/fake-engine";
import { waitUntil } from "../../../test/support";
import type { ReadTrackAudio } from "../audio/track-audio";
import { runEpisodePass } from "../episodes/episode-pass";
import { AnalysisScheduler, defaultSchedulerTiming, type SchedulerTiming } from "./scheduler";
import type { WorkerProcessTools } from "./worker-process";

const BOOT = Date.UTC(2026, 10, 5, 8, 0, 0);

let temp: TempDb;
let boot: Boot;
let scheduler: AnalysisScheduler | null;
let statuses: AnalysisStatus[];
let episodeId: number;
let mic: Run;
type Fields = Readonly<Record<string, unknown>>;
let events: { readonly event: string; readonly fields: Fields }[];

beforeEach(() => {
  temp = tempDb();
  boot = new Boot(temp.db, BOOT);
  statuses = [];
  events = [];
  scheduler = null;
  // One closed moment with a queued job.
  mic = boot.run({ startSec: 0 });
  boot.chunks(mic, 0, 120);
  boot.region(mic, 10, 20);
  runEpisodePass(temp.db, { nowMs: boot.wallMs(120), fullScan: true });
  episodeId = Number(scalar(temp.db, "SELECT id FROM episodes"));
});

afterEach(async () => {
  await scheduler?.stop(200);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  temp.cleanup();
});

const attemptOutcomes = () => rows(temp.db, "SELECT outcome, worker_pid FROM job_attempts");

const quietProcesses = (
  options: { readonly survivors?: readonly number[]; readonly reapFails?: boolean } = {},
): WorkerProcessTools & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    stopAll: async () => {
      calls.push("stopAll");
      return { stopped: [7], survivors: options.survivors ?? [] };
    },
    reap: async (pid) => {
      // The attempt must still be running (and so remembered) while its worker is reaped.
      calls.push(
        `reap ${pid} ${attemptOutcomes()
          .map((row) => row["outcome"])
          .join()}`,
      );
      if (options.reapFails === true) throw new Error(`speech worker ${pid} survived SIGKILL`);
      return "other-process";
    },
    residentBytes: async () => 2 * 1024 ** 3,
  };
};

/** The scheduler's log, kept for the test to read. */
const record = (event: string, fields: Fields = {}) => void events.push({ event, fields });

function scheduled(
  engine: FakeEngine | null,
  options: {
    /** Parakeet's handle, for dictations. */
    readonly dictationEngine?: FakeEngine | null;
    readonly dictated?: ConstructorParameters<typeof AnalysisScheduler>[0]["dictated"];
    readonly timing?: Partial<SchedulerTiming>;
    readonly readAudio?: ReadTrackAudio;
    readonly processes?: WorkerProcessTools;
    readonly signals?: ReturnType<typeof fakeSignals>;
    readonly now?: () => number;
    readonly tracesPerWarmSession?: number;
    readonly onStatus?: (status: AnalysisStatus) => void;
  } = {},
) {
  const readAudio = options.readAudio ?? regionAudioReader(temp.db);
  const created = new AnalysisScheduler({
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.tracesPerWarmSession === undefined
      ? {}
      : { tracesPerWarmSession: options.tracesPerWarmSession }),
    db: temp.db,
    engine: () => engine,
    ...(options.dictationEngine === undefined
      ? {}
      : { dictationEngine: () => options.dictationEngine ?? null }),
    ...(options.dictated === undefined ? {} : { dictated: options.dictated }),
    readAudio: () => readAudio,
    signals: (options.signals ?? fakeSignals()).service,
    processes: options.processes ?? quietProcesses(),
    onStatus: options.onStatus ?? ((status) => statuses.push(status)),
    log: { info: record, warn: record },
    timing: {
      admissionIntervalMs: 20,
      idleUnloadMs: 50,
      rssIntervalMs: 20,
      noModelPollMs: 20,
      memoryRetryMs: 60,
      swapSettleMs: 0,
      ...options.timing,
    },
  });
  scheduler = created;
  return created;
}

function start(engine: FakeEngine, readAudio?: ReadTrackAudio) {
  const created = scheduled(engine, readAudio === undefined ? {} : { readAudio });
  created.start();
  return created;
}

const expiredAudio: ReadTrackAudio = (range) => ({
  samples: new Int16Array(range.sampleEnd - range.sampleStart),
  missing: [{ sampleStart: range.sampleStart, sampleEnd: range.sampleEnd, reason: "expired" }],
});

const jobState = () => scalar(temp.db, "SELECT state FROM jobs");

const succeededJobs = () => scalar(temp.db, "SELECT count(*) FROM jobs WHERE state = 'succeeded'");

/** A second closed moment, 3 min after the first: two jobs queued. */
function secondEpisode(): void {
  boot.chunks(mic, 120, 300);
  boot.region(mic, 200, 210);
  runEpisodePass(temp.db, { nowMs: boot.wallMs(300), fullScan: true });
}

/** Closed traces (1 s of speech) 100 s apart after the first moment, each with its trace job. */
function traces(count: number): void {
  boot.chunks(mic, 120, 300 + count * 100);
  for (let index = 0; index < count; index += 1) {
    boot.region(mic, 200 + index * 100, 201 + index * 100);
  }
  runEpisodePass(temp.db, { nowMs: boot.wallMs(300 + count * 100), fullScan: true });
}

const queuedTraces = () =>
  scalar(temp.db, "SELECT count(*) FROM jobs WHERE state = 'queued' AND priority = 50");

/** The scheduler's log, `analysis.` dropped: `started`, `loaded`, `unloaded admission`. */
const story = () =>
  events.map(({ event, fields }) => {
    const name = event.replace(/^analysis\./, "");
    return name === "unloaded" ? `unloaded ${String(fields["reason"])}` : name;
  });

const logged = (event: string) => events.filter((entry) => entry.event === event);

function interruptedAttempt(): void {
  temp.db.client
    .prepare(
      `UPDATE jobs SET state = 'running', attempts = 1 WHERE id = (SELECT id FROM jobs LIMIT 1)`,
    )
    .run();
  temp.db.client
    .prepare(
      `INSERT INTO job_attempts (job_id, attempt, outcome, worker_pid, started_at_ms)
       SELECT id, 1, 'running', 4242, 0 FROM jobs`,
    )
    .run();
}

describe("a status that cannot be published", () => {
  // 2026-11-18: at launch, main's power event held the status lock while the
  // first tick published; Effect.runSync threw, the catch published again,
  // threw again, and the loop died with « thermal » on screen for 16 h.
  it("never stops the queue", async () => {
    let failures = 0;
    const engine = fakeEngine();
    scheduled(engine, {
      onStatus: (status) => {
        if (failures < 5) {
          failures += 1;
          throw new Error("An asynchronous Effect was executed with Effect.runSync");
        }
        statuses.push(status);
      },
    }).start();
    await waitUntil(() => jobState() === "succeeded", { label: "job published" });
    expect(failures).toBe(5);
    expect(logged("analysis.status-failed").length).toBeGreaterThan(0);
  });
});

describe("what a request shows", () => {
  it("names the episode the queue waits on, and a failed request's code", async () => {
    const signals = fakeSignals({ thermalState: "serious" });
    const created = scheduled(fakeEngine({ untimed: () => true }), { signals });
    created.request(episodeId);
    created.start();
    await waitUntil(() => statuses.at(-1)?.waitingFor.includes("thermal"), { label: "hot" });
    expect(statuses.at(-1)).toMatchObject({
      waitingEpisodeId: episodeId,
      requests: [{ episodeId, state: "queued", failure: null }],
    });
    signals.set({ thermalState: "nominal" });
    await waitUntil(() => jobState() === "failed", { label: "failed" });
    await waitUntil(() => statuses.at(-1)?.requests[0]?.state === "failed", { label: "shown" });
    expect(statuses.at(-1)).toMatchObject({
      waitingEpisodeId: null,
      requests: [{ episodeId, state: "failed", failure: "invalid_output" }],
    });
  });
});

describe("dictations", () => {
  const dictate = (id: number) =>
    temp.db.client.prepare("UPDATE episodes SET context = 'dictation' WHERE id = ?").run(id);

  it("transcribes a dictation on Parakeet, one voice and no speakers", async () => {
    dictate(episodeId);
    const final = fakeEngine();
    const parakeet = fakeEngine({ speakers: false });
    scheduled(final, { dictationEngine: parakeet }).start();
    await waitUntil(() => jobState() === "succeeded", { label: "dictation published" });
    expect(final.requests).toHaveLength(0);
    expect(parakeet.requests.map((request) => request.speakers)).toEqual([false]);
    const labels = rows(temp.db, "SELECT DISTINCT speaker_label FROM segments");
    expect(labels).toHaveLength(1);
    expect(String(labels[0]?.["speaker_label"])).toMatch(/\/1$/);
    expect(
      scalar(temp.db, "SELECT json_extract(engine_config, '$.speakers') FROM analysis_runs"),
    ).toBe(0);
  });

  it("takes a dictation's text from its app, with no model and nothing to wait for", async () => {
    dictate(episodeId);
    const parakeet = fakeEngine({ speakers: false });
    scheduled(fakeEngine(), {
      dictationEngine: parakeet,
      signals: fakeSignals({ onBattery: true, idleSeconds: 0, thermalState: "serious" }),
      dictated: (input) => {
        const region = input.regions[0];
        if (region === undefined) return null;
        const { trackRunId, trackKey, sliceStart: sampleStart } = region;
        return {
          bundleId: "anomaly.hex",
          segments: [
            {
              trackRunId,
              sampleStart,
              sampleEnd: sampleStart + 16_000,
              startMs: region.wallStartMs,
              endMs: region.wallStartMs + 1_000,
              text: "Ajoute du lait.",
              speakerLabel: `${trackKey}/voice/1`,
            },
          ],
        };
      },
    }).start();
    await waitUntil(() => jobState() === "succeeded", { label: "dictation published" });
    expect(parakeet.loads).toBe(0);
    expect(rows(temp.db, "SELECT text FROM segments")).toEqual([{ text: "Ajoute du lait." }]);
    expect(rows(temp.db, "SELECT engine_id, status FROM analysis_runs")).toEqual([
      { engine_id: "dictation-text:anomaly.hex", status: "published" },
    ]);
  });

  it("takes it without Parakeet too, and the others still wait for their model", async () => {
    secondEpisode();
    const second = Number(scalar(temp.db, "SELECT max(id) FROM episodes"));
    dictate(episodeId);
    dictate(second);
    scheduled(fakeEngine(), {
      dictationEngine: null,
      dictated: (input) =>
        input.episodeId === second ? { bundleId: "anomaly.hex", segments: [] } : null,
    }).start();
    await waitUntil(() => succeededJobs() === 1, { label: "the one its app kept" });
    expect(scalar(temp.db, "SELECT state FROM jobs WHERE episode_id = ?", episodeId)).toBe(
      "queued",
    );
    await waitUntil(() => statuses.at(-1)?.waitingFor.includes("no-model"), { label: "no-model" });
  });

  it("replaces a past dictation's transcript at once, and only that", async () => {
    dictate(episodeId);
    const parakeet = fakeEngine({ speakers: false });
    const created = scheduled(fakeEngine(), { dictationEngine: parakeet });
    created.start();
    await waitUntil(() => jobState() === "succeeded", { label: "dictation published" });
    const input = loadAnalysisInput(temp.db, episodeId);
    if (input === null) throw new Error("no input");
    const text = { bundleId: "anomaly.hex", segments: [] };
    expect(created.publishPastDictation(input, text)).toBe(true);
    expect(
      rows(
        temp.db,
        "SELECT r.engine_id FROM episode_analysis a JOIN analysis_runs r ON r.id = a.run_id",
      ),
    ).toEqual([{ engine_id: "dictation-text:anomaly.hex" }]);
    expect(parakeet.requests).toHaveLength(1);
    // Already queued for something else: that goes on.
    created.request(episodeId);
    expect(created.publishPastDictation(input, text)).toBe(false);
  });

  it("transcribes a dictation its app does not account for", async () => {
    dictate(episodeId);
    const parakeet = fakeEngine({ speakers: false });
    scheduled(fakeEngine(), { dictationEngine: parakeet, dictated: () => null }).start();
    await waitUntil(() => jobState() === "succeeded", { label: "dictation published" });
    expect(parakeet.requests).toHaveLength(1);
  });

  it("runs a dictation while the job ahead of it waits for room", async () => {
    // 2026-11-18: a 1 h 46 call at the head held every dictation behind it.
    secondEpisode();
    const dictation = Number(scalar(temp.db, "SELECT max(id) FROM episodes"));
    dictate(dictation);
    temp.db.client.prepare("UPDATE jobs SET priority = 10 WHERE episode_id = ?").run(episodeId);
    const plain = fakeEngine();
    const final = { ...plain, resources: { ...plain.resources, peakBytesBase: 100 * 1024 ** 3 } };
    const parakeet = fakeEngine({ speakers: false });
    scheduled(final, { dictationEngine: parakeet }).start();
    await waitUntil(
      () =>
        scalar(temp.db, "SELECT state FROM jobs WHERE episode_id = ?", dictation) === "succeeded",
      { label: "the dictation published" },
    );
    expect(plain.requests).toHaveLength(0);
    expect(scalar(temp.db, "SELECT state FROM jobs WHERE episode_id = ?", episodeId)).toBe(
      "queued",
    );
    await waitUntil(() => statuses.at(-1)?.waitingFor.includes("memory"), {
      label: "the call says it waits for memory",
    });
  });

  it("lets the other jobs run while Parakeet is not installed", async () => {
    dictate(episodeId);
    secondEpisode();
    const final = fakeEngine();
    scheduled(final, { dictationEngine: null }).start();
    await waitUntil(() => succeededJobs() === 1, { label: "the other job" });
    expect(scalar(temp.db, "SELECT state FROM jobs WHERE episode_id = ?", episodeId)).toBe(
      "queued",
    );
    expect(final.requests.every((request) => request.speakers)).toBe(true);
    // Only the dictation is left: it waits for its model.
    await waitUntil(() => statuses.at(-1)?.waitingFor.includes("no-model"), {
      label: "the dictation waits for Parakeet",
    });
  });

  it("runs dictations first when only Parakeet is installed", async () => {
    secondEpisode();
    const second = Number(scalar(temp.db, "SELECT max(id) FROM episodes"));
    dictate(second);
    const parakeet = fakeEngine({ speakers: false });
    scheduled(null, { dictationEngine: parakeet }).start();
    await waitUntil(
      () => scalar(temp.db, "SELECT state FROM jobs WHERE episode_id = ?", second) === "succeeded",
      { label: "the dictation" },
    );
    expect(scalar(temp.db, "SELECT state FROM jobs WHERE episode_id = ?", episodeId)).toBe(
      "queued",
    );
    await waitUntil(() => statuses.at(-1)?.waitingFor.includes("no-model"), {
      label: "no-model for the rest",
    });
  });
});

describe("traces", () => {
  it("never loads the engine for traces alone", async () => {
    temp.db.client.prepare("UPDATE jobs SET state = 'succeeded'").run();
    traces(2);
    const engine = fakeEngine();
    scheduled(engine).start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(engine.loads).toBe(0);
    expect(queuedTraces()).toBe(2);
    expect(statuses.at(-1)?.queued).toMatchObject({ traces: 2, moments: 0 });
    expect(statuses.at(-1)?.waitingFor).toEqual([]);
  });

  it("runs traces after every other job on the loaded engine, at most a bounded number per load", async () => {
    traces(3);
    let clock = Date.now();
    const engine = fakeEngine();
    scheduled(engine, { tracesPerWarmSession: 2, now: () => clock }).start();
    await waitUntil(() => succeededJobs() === 3, { label: "the traces published" });
    // The idle delay (50 ms in these tests) starts only now: a slow machine
    // would otherwise unload between two traces.
    clock += 60;
    await waitUntil(() => engine.unloads === 1, { label: "idle unload" });
    expect(engine.loads).toBe(1);
    expect(succeededJobs()).toBe(3);
    expect(queuedTraces()).toBe(1);
    expect(logged("analysis.started").map((entry) => entry.fields["trace"])).toEqual([
      false,
      true,
      true,
    ]);
    expect(story().at(-1)).toBe("unloaded idle");
  });

  it("never keeps the engine loaded: the idle unload counts from the last job that was not a trace", async () => {
    traces(3);
    let clock = Date.now();
    let requests = 0;
    const engine = fakeEngine({
      whileRunning: () => {
        requests += 1;
        // The first trace runs past the idle delay (50 ms in these tests).
        if (requests === 2) clock += 60;
      },
    });
    scheduled(engine, { now: () => clock }).start();
    await waitUntil(() => engine.unloads === 1, { label: "idle unload" });
    expect(succeededJobs()).toBe(2);
    expect(queuedTraces()).toBe(2);
    expect(story().at(-1)).toBe("unloaded idle");
  });

  it("runs a user request on a trace like any request, loading the engine", async () => {
    temp.db.client.prepare("UPDATE jobs SET state = 'succeeded'").run();
    traces(1);
    const engine = fakeEngine();
    const created = scheduled(engine);
    const trace = Number(scalar(temp.db, "SELECT episode_id FROM jobs WHERE state = 'queued'"));
    expect(created.request(trace)?.outcome).toBe("already-queued");
    created.start();
    await waitUntil(() => succeededJobs() === 2, { label: "requested trace published" });
    expect(engine.loads).toBe(1);
  });
});

describe("analysis scheduler", () => {
  it("discards a run made stale during inference and requeues at the new generation", async () => {
    let bumped = false;
    const engine = fakeEngine({
      whileRunning: () => {
        if (bumped) return;
        bumped = true;
        bumpInputGeneration(temp.db, episodeId);
      },
    });
    start(engine);
    await waitUntil(() => jobState() === "succeeded", { label: "published" });
    expect(engine.requests).toHaveLength(2);
    expect(
      rows(temp.db, "SELECT status, error_code, input_generation FROM analysis_runs ORDER BY id"),
    ).toEqual([
      { status: "discarded", error_code: "stale_generation", input_generation: 1 },
      { status: "published", error_code: null, input_generation: 2 },
    ]);
    expect(rows(temp.db, "SELECT outcome, error_code FROM job_attempts ORDER BY attempt")).toEqual([
      { outcome: "cancelled", error_code: "stale_generation" },
      { outcome: "succeeded", error_code: null },
    ]);
    expect(scalar(temp.db, "SELECT count(*) FROM segments")).toBe(1);
    checkSearchIndex(temp.db);
  });

  it("keeps the engine loaded across queued jobs while its weights hold pressure at warn", async () => {
    secondEpisode();
    // On Téo's Mac, Nemotron's 17 GB hold pressure at warn while it is loaded (2026-11-05).
    const signals = fakeSignals({ swapUsedBytes: 3 * 1024 ** 3 });
    const engine = fakeEngine({
      onLoaded: (loaded) => signals.set({ memoryPressure: loaded ? "warn" : "normal" }),
    });
    scheduled(engine, { signals }).start();
    await waitUntil(() => succeededJobs() === 2, { label: "both published" });
    expect(engine.loads).toBe(1);
    expect(story().slice(0, 5)).toEqual(["started", "loaded", "published", "started", "published"]);
    expect(logged("analysis.loaded")[0]?.fields).toMatchObject({
      loadMs: 5,
      swapBaselineMb: 3_072,
    });
    expect(logged("analysis.published").map((entry) => entry.fields)).toEqual([
      expect.objectContaining({ audioMs: expect.any(Number), computeMs: 1, loadMs: 5 }),
      expect.objectContaining({ audioMs: expect.any(Number), computeMs: 1, loadMs: 0 }),
    ]);
    // The queue drained: the engine goes after its idle delay, not before.
    await waitUntil(() => engine.unloads === 1, { label: "idle unload" });
    expect(story().at(-1)).toBe("unloaded idle");
  });

  it.each([
    ["pressure turns critical", { memoryPressure: "critical" }, "memory"],
    ["Téo comes back", { idleSeconds: 0 }, "not-idle"],
  ] as const)(
    "unloads between jobs when %s, and loads again once admitted",
    async (_name, refusing, reason) => {
      secondEpisode();
      const signals = fakeSignals();
      let changed = false;
      const engine = fakeEngine({
        whileRunning: () => {
          if (changed) return;
          changed = true;
          signals.set(refusing);
        },
      });
      scheduled(engine, { signals }).start();
      await waitUntil(() => statuses.at(-1)?.waitingFor.join() === reason, { label: "waiting" });
      expect(succeededJobs()).toBe(1);
      expect(engine.state()).toBe("absent");
      expect(logged("analysis.unloaded")[0]?.fields).toMatchObject({
        reason: "admission",
        reasons: reason,
        ...refusing,
      });

      signals.set({ memoryPressure: "normal", idleSeconds: 600 });
      await waitUntil(() => succeededJobs() === 2, { label: "second published" });
      expect(engine.loads).toBe(2);
      expect(story().slice(0, 8)).toEqual([
        "started",
        "loaded",
        "published",
        "waiting",
        "unloaded admission",
        "started",
        "loaded",
        "published",
      ]);
      expect(logged("analysis.waiting")[0]?.fields).toMatchObject({
        requested: false,
        reasons: reason,
      });
    },
  );

  it("logs why it cancels a job and unloads", async () => {
    const signals = fakeSignals({ swapUsedBytes: 1024 ** 3 });
    const engine = fakeEngine({ hang: true, progress: false });
    scheduled(engine, { signals }).start();
    await waitUntil(() => engine.requests.length === 1, { label: "inference started" });
    signals.set({ idleSeconds: 0, memoryPressure: "warn", swapUsedBytes: 2 * 1024 ** 3 });
    await waitUntil(() => logged("analysis.unloaded").length === 1, { label: "unloaded" });
    expect(jobState()).toBe("queued");
    expect(logged("analysis.cancelled")[0]?.fields).toEqual({
      jobId: expect.any(Number),
      reason: "admission",
      reasons: "not-idle",
      onBattery: false,
      thermalState: "nominal",
      idleSeconds: 0,
      locked: false,
      memoryPressure: "warn",
      swapUsedMb: 2_048,
      swapBaselineMb: 1_024,
    });
    expect(logged("analysis.unloaded")[0]?.fields).toEqual({
      reason: "admission",
      engine: "fake-asr",
      reasons: "not-idle",
    });
  });

  it("judges swap growth from after the load settled, not from the load", async () => {
    // 2026-11-19: Nemotron paging its weights in grew swap 2.6 GB in 40 s, every time.
    const GB = 1024 ** 3;
    const signals = fakeSignals({ swapUsedBytes: 16 * GB, idleSeconds: 0 });
    const engine = fakeEngine({ hang: true, progress: false });
    temp.db.client.prepare(`UPDATE jobs SET payload = '{"requested":true}'`).run();
    scheduled(engine, { signals, timing: { swapSettleMs: 150 } }).start();
    await waitUntil(() => engine.requests.length === 1, { label: "inference started" });
    signals.set({ swapUsedBytes: 19 * GB });
    await waitUntil(() => logged("analysis.swap-baseline").length === 1, { label: "rebased" });
    expect(logged("analysis.cancelled")).toHaveLength(0);
    expect(logged("analysis.swap-baseline")[0]?.fields["swapBaselineMb"]).toBe(19 * 1024);
    // Growth past the new baseline still stops the job.
    signals.set({ swapUsedBytes: 22 * GB });
    await waitUntil(() => logged("analysis.cancelled").length === 1, { label: "cancelled" });
    expect(logged("analysis.cancelled")[0]?.fields["reasons"]).toBe("swap");
  });

  it("keeps the requests a stopped attempt finished for the next attempt", async () => {
    const signals = fakeSignals();
    const base = fakeEngine();
    let calls = 0;
    // Requests of 4 s at most: the 10 s region, with its roll, goes in four.
    const engine: FakeEngine = {
      ...base,
      capabilities: { ...base.capabilities, maxRequestSeconds: 4 },
      async transcribe(request, options) {
        calls += 1;
        if (calls === 2) {
          // The second request hangs until the attempt is stopped.
          await new Promise<never>((_, reject) =>
            options?.signal?.addEventListener(
              "abort",
              () => reject(new EngineError("cancelled", "cancelled")),
              { once: true },
            ),
          );
        }
        return base.transcribe(request, options);
      },
    };
    scheduled(engine, { signals }).start();
    await waitUntil(() => calls === 2, { label: "second request sent" });
    // Memory runs short: the attempt stops, its first request done.
    signals.set({ memoryPressure: "critical" });
    await waitUntil(() => jobState() === "queued", { label: "stopped" });
    signals.set({ memoryPressure: "normal" });
    await waitUntil(() => jobState() === "succeeded", { label: "published" });
    // Each request reached the engine once: the first is not sent again.
    expect(base.requests).toHaveLength(4);
    expect(calls).toBe(5);
  });

  it("keeps a stopped job's finished requests while a dictation runs between", async () => {
    // Codex review: the dictation that passed a waiting call erased its kept work.
    const signals = fakeSignals();
    const base = fakeEngine();
    let calls = 0;
    const engine: FakeEngine = {
      ...base,
      capabilities: { ...base.capabilities, maxRequestSeconds: 4 },
      resources: { ...base.resources, peakBytesBase: 5 * 1024 ** 3 },
      async transcribe(request, options) {
        calls += 1;
        if (calls === 2) {
          await new Promise<never>((_, reject) =>
            options?.signal?.addEventListener(
              "abort",
              () => reject(new EngineError("cancelled", "cancelled")),
              { once: true },
            ),
          );
        }
        return base.transcribe(request, options);
      },
    };
    secondEpisode();
    const dictation = Number(scalar(temp.db, "SELECT max(id) FROM episodes"));
    temp.db.client.prepare("UPDATE episodes SET context = 'dictation' WHERE id = ?").run(dictation);
    temp.db.client.prepare("UPDATE jobs SET priority = 10 WHERE episode_id = ?").run(episodeId);
    const parakeet = fakeEngine({ speakers: false });
    scheduled(engine, {
      signals,
      dictationEngine: parakeet,
      timing: { memoryRetryMs: 300 },
    }).start();
    await waitUntil(() => calls === 2, { label: "second request sent" });
    signals.set({ memoryPressure: "critical" });
    await waitUntil(() => logged("analysis.cancelled").length > 0, { label: "stopped" });
    signals.set({ memoryPressure: "normal" });
    await waitUntil(
      () =>
        scalar(temp.db, "SELECT state FROM jobs WHERE episode_id = ?", dictation) === "succeeded",
      { label: "the dictation ran during the pause" },
    );
    await waitUntil(
      () =>
        scalar(temp.db, "SELECT state FROM jobs WHERE episode_id = ?", episodeId) === "succeeded",
      { label: "the call published" },
    );
    expect(base.requests).toHaveLength(4);
    expect(calls).toBe(5);
  });

  it("keeps the swap grace of a fresh load for the jobs after the first", async () => {
    // Codex review: a first job shorter than the grace left the next ones judged from the load.
    const GB = 1024 ** 3;
    const signals = fakeSignals({ swapUsedBytes: 16 * GB });
    const engine = fakeEngine();
    scheduled(engine, { signals, timing: { swapSettleMs: 400, idleUnloadMs: 5_000 } }).start();
    await waitUntil(() => jobState() === "succeeded", { label: "first published" });
    signals.set({ swapUsedBytes: 19 * GB });
    secondEpisode();
    scheduler?.wake();
    await waitUntil(() => succeededJobs() === 2, { label: "second published" });
    expect(logged("analysis.unloaded")).toHaveLength(0);
    await waitUntil(() => logged("analysis.swap-baseline").length === 1, { label: "rebased" });
    expect(logged("analysis.swap-baseline")[0]?.fields["swapBaselineMb"]).toBe(19 * 1024);
    expect(logged("analysis.unloaded")).toHaveLength(0);
  });

  it("names the episode the queue waits on while it waits for a retry", async () => {
    // Codex review: a lone failed request read « behind another request ».
    scheduled(fakeEngine({ fail: new EngineError("crashed", "worker exited") })).start();
    await waitUntil(() => statuses.at(-1)?.waitingFor.includes("retry-later"), {
      label: "waits for its retry",
    });
    expect(statuses.at(-1)?.waitingEpisodeId).toBe(episodeId);
  });

  it("re-decides the size with the published speakers and turns", async () => {
    start(fakeEngine());
    await waitUntil(() => jobState() === "succeeded", { label: "published" });
    const kind = JSON.parse(String(scalar(temp.db, "SELECT kind_inputs FROM episodes"))) as Record<
      string,
      unknown
    >;
    expect(kind).toMatchObject({ speakers: 1, turns: 1, episodeOpen: false, rule: "moment" });
    expect(scalar(temp.db, "SELECT size_state FROM episodes")).toBe("final");
  });

  it("fails without retry when no audio is left", async () => {
    const engine = fakeEngine();
    start(engine, expiredAudio);
    await waitUntil(() => jobState() === "failed", { label: "failed" });
    expect(engine.requests).toHaveLength(0);
    expect(rows(temp.db, "SELECT outcome, error_code FROM job_attempts")).toEqual([
      { outcome: "failed", error_code: "audio_unavailable" },
    ]);
    expect(scalar(temp.db, "SELECT analysis_state FROM episodes")).toBe("failed");
    await waitUntil(() => statuses.at(-1)?.lastError?.code === "analysis.audio_unavailable", {
      label: "status error",
    });
  });

  it("keeps a published transcript when a new pass would lack a request's audio", async () => {
    const usb = boot.run({ trackKey: "input:USBMic", startSec: 0 });
    boot.chunks(usb, 0, 120);
    boot.region(usb, 12, 18);
    runEpisodePass(temp.db, { nowMs: boot.wallMs(130), fullScan: true });
    const engine = fakeEngine();
    let reader = regionAudioReader(temp.db);
    const created = start(engine, (range) => reader(range));
    await waitUntil(() => jobState() === "succeeded", { label: "published" });
    const segments = scalar(temp.db, "SELECT count(*) FROM segments");
    expect(segments).toBe(2);

    // The USB track's audio expired; a new generation would publish the mic alone.
    const full = reader;
    reader = (range) => (range.trackRunId === usb.trackRunId ? expiredAudio(range) : full(range));
    bumpInputGeneration(temp.db, episodeId);
    created.request(episodeId);
    await waitUntil(() => jobState() === "failed", { label: "failed" });
    expect(engine.requests).toHaveLength(2);
    expect(
      rows(temp.db, "SELECT outcome, error_code FROM job_attempts ORDER BY attempt").at(-1),
    ).toEqual({ outcome: "failed", error_code: "audio_unavailable" });
    expect(rows(temp.db, "SELECT status FROM analysis_runs ORDER BY id")).toEqual([
      { status: "published" },
      { status: "failed" },
    ]);
    expect(scalar(temp.db, "SELECT count(*) FROM segments")).toBe(segments);
    checkSearchIndex(temp.db);
  });

  it("transcribes a transcribed episode again when asked (« Retranscrire »)", async () => {
    const engine = fakeEngine();
    const created = start(engine);
    await waitUntil(() => succeededJobs() === 1, { label: "published" });
    expect(created.request(episodeId)?.outcome).toBe("queued");
    expect(scalar(temp.db, "SELECT analysis_state FROM episodes")).toBe("queued");
    await waitUntil(() => succeededJobs() === 2, { label: "published again" });
    expect(engine.requests).toHaveLength(2);
    expect(rows(temp.db, "SELECT status FROM analysis_runs ORDER BY id")).toEqual([
      { status: "superseded" },
      { status: "published" },
    ]);
    expect(scalar(temp.db, "SELECT analysis_state FROM episodes")).toBe("complete");
    checkSearchIndex(temp.db);
  });

  it("publishes the requests that have audio when nothing was published, with lower coverage", async () => {
    const usb = boot.run({ trackKey: "input:USBMic", startSec: 0 });
    boot.chunks(usb, 0, 120);
    boot.region(usb, 12, 18);
    runEpisodePass(temp.db, { nowMs: boot.wallMs(130), fullScan: true });
    const full = regionAudioReader(temp.db);
    start(fakeEngine(), (range) =>
      range.trackRunId === usb.trackRunId ? expiredAudio(range) : full(range),
    );
    await waitUntil(() => jobState() === "succeeded", { label: "published" });
    expect(scalar(temp.db, "SELECT count(*) FROM segments")).toBe(1);
    const coverage = Number(scalar(temp.db, "SELECT coverage FROM analysis_runs"));
    expect(coverage).toBeGreaterThan(0);
    expect(coverage).toBeLessThan(1);
  });

  it("halves a request the model truncates, with speakers per part", async () => {
    // A second, 5 min episode: truncated above 100 s, its request is halved twice.
    boot.chunks(mic, 120, 1_500);
    boot.region(mic, 1_000, 1_300);
    runEpisodePass(temp.db, { nowMs: boot.wallMs(1_500), fullScan: true });
    const engine = fakeEngine({ modelLimit: (request) => request.samples.length > 100 * 16_000 });
    start(engine);
    await waitUntil(
      () => scalar(temp.db, "SELECT count(*) FROM jobs WHERE state = 'succeeded'") === 2,
      { label: "both published" },
    );
    const labels = rows(
      temp.db,
      "SELECT DISTINCT speaker_label FROM segments WHERE episode_id != ? ORDER BY 1",
      episodeId,
    ).map((row) => row["speaker_label"]);
    expect(labels).toEqual(
      ["1.1.1", "1.1.2", "1.2.1", "1.2.2"].map((n) => `input:BuiltInMicrophoneDevice/${n}/1`),
    );
    checkSearchIndex(temp.db);
  });

  it("halves a request whose text the model cannot time, instead of failing the attempt", async () => {
    // Seen on 2026-11-18: a 55 min request came back untimed three times.
    boot.chunks(mic, 120, 1_500);
    boot.region(mic, 1_000, 1_300);
    runEpisodePass(temp.db, { nowMs: boot.wallMs(1_500), fullScan: true });
    const engine = fakeEngine({ untimed: (request) => request.samples.length > 100 * 16_000 });
    start(engine);
    await waitUntil(() => succeededJobs() === 2, { label: "both published" });
    expect(scalar(temp.db, "SELECT count(*) FROM job_attempts WHERE outcome = 'failed'")).toBe(0);
    expect(logged("analysis.split").map((entry) => entry.fields["reason"])).toEqual([
      "untimed",
      "untimed",
      "untimed",
    ]);
    expect(
      Number(
        scalar(
          temp.db,
          "SELECT max(json_extract(metrics, '$.untimedSplits')) FROM analysis_runs WHERE status = 'published'",
        ),
      ),
    ).toBe(3);
    checkSearchIndex(temp.db);
  });

  it("publishes no speech when the model cannot time a noise under a second", async () => {
    // Seen on 2026-11-25: traces of 0.3 s of speech failed untimed, again and again.
    boot.chunks(mic, 120, 300);
    boot.region(mic, 200, 200.4);
    runEpisodePass(temp.db, { nowMs: boot.wallMs(300), fullScan: true });
    const short = Number(scalar(temp.db, "SELECT max(id) FROM episodes"));
    const engine = fakeEngine({ untimed: (request) => request.samples.length < 5 * 16_000 });
    start(engine);
    await waitUntil(() => succeededJobs() === 2, { label: "both published" });
    expect(scalar(temp.db, "SELECT count(*) FROM job_attempts WHERE outcome = 'failed'")).toBe(0);
    expect(scalar(temp.db, "SELECT analysis_state FROM episodes WHERE id = ?", short)).toBe(
      "complete",
    );
    expect(scalar(temp.db, "SELECT count(*) FROM segments WHERE episode_id = ?", short)).toBe(0);
    expect(
      Number(
        scalar(
          temp.db,
          "SELECT json_extract(metrics, '$.untimedSilent') FROM analysis_runs WHERE episode_id = ? AND status = 'published'",
          short,
        ),
      ),
    ).toBe(1);
    // Sent once: no voiceless retry for a noise.
    expect(engine.requests.filter((request) => request.samples.length < 5 * 16_000)).toHaveLength(
      1,
    );
    expect(logged("analysis.untimed").map((entry) => entry.fields)).toEqual([
      expect.objectContaining({ outcome: "silent", speechMs: 400 }),
    ]);
    checkSearchIndex(temp.db);
  });

  it("sends a request it cannot halve again without voices, and publishes it as one voice", async () => {
    const engine = fakeEngine({ untimed: (request) => request.speakers });
    start(engine);
    await waitUntil(() => jobState() === "succeeded", { label: "published" });
    expect(engine.requests.map((request) => request.speakers)).toEqual([true, false]);
    expect(rows(temp.db, "SELECT DISTINCT speaker_label FROM segments")).toEqual([
      { speaker_label: "input:BuiltInMicrophoneDevice/1/1" },
    ]);
    expect(
      Number(
        scalar(
          temp.db,
          "SELECT json_extract(metrics, '$.untimedRetries') FROM analysis_runs WHERE status = 'published'",
        ),
      ),
    ).toBe(1);
    expect(logged("analysis.untimed").map((entry) => entry.fields["outcome"])).toEqual([
      "retry-one-voice",
    ]);
    checkSearchIndex(temp.db);
  });

  it("fails the attempt when a request stays untimed at the smallest split, voices or not", async () => {
    const engine = fakeEngine({ untimed: () => true });
    start(engine);
    await waitUntil(() => jobState() === "failed", { label: "failed" });
    expect(engine.requests.map((request) => request.speakers)).toEqual([true, false]);
    expect(
      rows(temp.db, "SELECT outcome, error_code FROM job_attempts ORDER BY attempt").at(-1),
    ).toEqual({ outcome: "failed", error_code: "invalid_output" });
  });

  it("fails for good when a request hits the model's limit at the smallest split, keeping what was published", async () => {
    let limited = false;
    const engine = fakeEngine({ modelLimit: () => limited });
    const created = start(engine);
    await waitUntil(() => jobState() === "succeeded", { label: "published" });
    limited = true;
    bumpInputGeneration(temp.db, episodeId);
    created.request(episodeId);
    await waitUntil(() => jobState() === "failed", { label: "failed" });
    expect(
      rows(temp.db, "SELECT outcome, error_code FROM job_attempts ORDER BY attempt").at(-1),
    ).toEqual({ outcome: "failed", error_code: "model_limit" });
    expect(rows(temp.db, "SELECT status FROM analysis_runs ORDER BY id")).toEqual([
      { status: "published" },
      { status: "failed" },
    ]);
    expect(scalar(temp.db, "SELECT count(*) FROM segments")).toBe(1);
    checkSearchIndex(temp.db);
  });

  it("retries a crashed attempt after a minute and says so", async () => {
    const engine = fakeEngine({ fail: new EngineError("crashed", "worker exited") });
    start(engine);
    await waitUntil(() => statuses.at(-1)?.waitingFor.join() === "retry-later", {
      label: "retry later",
    });
    expect(jobState()).toBe("queued");
    const [job] = rows(temp.db, "SELECT not_before_ms, updated_at_ms FROM jobs");
    expect(Number(job?.["not_before_ms"]) - Number(job?.["updated_at_ms"])).toBe(60_000);
    expect(statuses.at(-1)).toMatchObject({
      worker: "absent",
      running: null,
      lastError: { code: "analysis.crashed" },
      queued: { moments: 1 },
    });
  });

  it("keeps the worker after output it refused, and logs a reason without the text", async () => {
    const engine = fakeEngine({
      fail: new EngineError("invalid_output", "segment 0 ends at 12 s, past the 10 s", {
        reason: "time-past-audio",
      }),
    });
    start(engine);
    await waitUntil(() => statuses.at(-1)?.waitingFor.join() === "retry-later", {
      label: "retry later",
    });
    expect(logged("analysis.failed")[0]?.fields).toMatchObject({
      code: "invalid_output",
      reason: "time-past-audio",
    });
    expect(rows(temp.db, "SELECT error_code, error_message FROM job_attempts")).toEqual([
      { error_code: "invalid_output", error_message: "time-past-audio" },
    ]);
    expect(logged("analysis.unloaded").map((entry) => entry.fields?.["reason"])).not.toContain(
      "failure",
    );
  });

  it("stops orphan workers, then reaps a recorded pid before abandoning its attempt", async () => {
    interruptedAttempt();
    const processes = quietProcesses();
    await expect(scheduled(null, { processes }).recover()).resolves.toEqual({
      abandoned: 1,
      killed: 1,
      enqueued: 0,
      blocked: false,
    });
    expect(processes.calls).toEqual(["stopAll", "reap 4242 running"]);
    expect(attemptOutcomes()).toEqual([{ outcome: "abandoned", worker_pid: 4242 }]);
    expect(jobState()).toBe("queued");
  });

  it("does not start while a speech worker survives", async () => {
    const engine = fakeEngine();
    const created = scheduled(engine, { processes: quietProcesses({ survivors: [9999] }) });
    await expect(created.recover()).resolves.toMatchObject({ blocked: true });
    created.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(engine.loads).toBe(0);
    expect(jobState()).toBe("queued");
    expect(statuses.at(-1)?.lastError).toMatchObject({ code: "analysis.stray_worker" });
  });

  it("does not swallow a failed reap, and keeps the attempt with its pid to retry", async () => {
    interruptedAttempt();
    const engine = fakeEngine();
    const created = scheduled(engine, { processes: quietProcesses({ reapFails: true }) });
    await expect(created.recover()).resolves.toMatchObject({ blocked: true });
    created.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(engine.loads).toBe(0);
    expect(attemptOutcomes()).toEqual([{ outcome: "running", worker_pid: 4242 }]);
    expect(statuses.at(-1)?.lastError).toMatchObject({ code: "analysis.stray_worker" });
  });
});

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("resource regression", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BOOT + 600_000);
  });

  const timing = {
    admissionIntervalMs: 10_000,
    idleUnloadMs: 90_000,
    rssIntervalMs: 2_000,
    memoryRetryMs: 60_000,
  };
  const prepare = (engine: FakeEngine, signals = fakeSignals()) =>
    scheduled(engine, { signals, timing });

  it.each([
    { idleSeconds: 0 },
    { memoryPressure: "critical" },
    { swapUsedBytes: 3 * 1024 ** 3 },
  ] as const)("rechecks empty queue admission: %j", async (refusal) => {
    const signals = fakeSignals();
    const engine = fakeEngine();
    prepare(engine, signals).start();
    await flush();
    expect(succeededJobs()).toBe(1);
    signals.set(refusal);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(engine.state()).toBe("absent");
    expect(logged("analysis.unloaded")[0]?.fields).toMatchObject({ reason: "admission" });
    expect(succeededJobs()).toBe(1);
  });

  it("keeps an admitted empty engine until exactly 90 seconds", async () => {
    const engine = fakeEngine();
    prepare(engine).start();
    await flush();
    await vi.advanceTimersByTimeAsync(89_999);
    expect(engine.state()).toBe("ready");
    await vi.advanceTimersByTimeAsync(1);
    expect(engine.state()).toBe("absent");
    expect(story().at(-1)).toBe("unloaded idle");
  });

  it.each([
    [false, { idleSeconds: 0 }, 0],
    [false, { memoryPressure: "critical" }, 0],
    [true, { idleSeconds: 0, onBattery: true }, 1],
    [true, { memoryPressure: "critical" }, 0],
  ] as const)("rechecks after load (requested=%s, %j)", async (requested, refusal, count) => {
    const signals = fakeSignals();
    const engine = fakeEngine({
      onLoaded: (loaded) => {
        if (loaded) signals.set(refusal);
      },
    });
    const created = prepare(engine, signals);
    if (requested) created.request(episodeId);
    created.start();
    await flush();
    // Critical pressure gets the settle time to fall back; here it stays.
    await vi.advanceTimersByTimeAsync(defaultSchedulerTiming.loadSettleMs);
    expect(engine.requests).toHaveLength(count);
    expect(jobState()).toBe(count === 0 ? "queued" : "succeeded");
    if (count === 0) {
      expect(engine.state()).toBe("absent");
      expect(rows(temp.db, "SELECT outcome, error_code FROM job_attempts")).toEqual([
        { outcome: "cancelled", error_code: "admission" },
      ]);
      expect(scalar(temp.db, "SELECT count(*) FROM segments")).toBe(0);
    }
  });

  it.each([0.5, 1])(
    "cancels critical pressure at first poll even at progress %s",
    async (progress) => {
      const signals = fakeSignals();
      const engine = fakeEngine({ hang: true });
      const transcribe = engine.transcribe.bind(engine);
      engine.transcribe = (request, options = {}) =>
        transcribe(request, {
          ...options,
          onProgress: () => options.onProgress?.(progress),
        });
      prepare(engine, signals).start();
      await flush();
      signals.set({ memoryPressure: "critical" });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(engine.state()).toBe("absent");
      expect(jobState()).toBe("queued");
      expect(logged("analysis.cancelled")).toHaveLength(1);
    },
  );

  it.each([false, true])(
    "bounds swap reload and preserves request priority (requested=%s)",
    async (requested) => {
      secondEpisode();
      const other = Number(scalar(temp.db, "SELECT max(id) FROM episodes"));
      const signals = fakeSignals();
      const engine = fakeEngine({ hang: true, progress: false });
      const created = prepare(engine, signals);
      created.start();
      await flush();
      signals.set({ swapUsedBytes: 3 * 1024 ** 3 });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(engine.loads).toBe(1);
      expect(engine.state()).toBe("absent");
      expect(rows(temp.db, "SELECT outcome, error_code FROM job_attempts")).toEqual([
        { outcome: "cancelled", error_code: "admission" },
      ]);
      if (requested) created.request(other);
      for (let i = 0; i < 3; i++) {
        created.wake();
        await flush();
      }
      await vi.advanceTimersByTimeAsync(59_999);
      expect(engine.loads).toBe(1);
      expect(statuses.at(-1)?.waitingFor).toEqual(["retry-later"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(engine.loads).toBe(2);
      expect(statuses.at(-1)?.running?.episodeId).toBe(requested ? other : episodeId);
      expect(scalar(temp.db, "SELECT count(*) FROM segments")).toBe(0);
    },
  );

  it("still checks memory when the cooldown expires", async () => {
    const signals = fakeSignals();
    const engine = fakeEngine({ hang: true, progress: false });
    prepare(engine, signals).start();
    await flush();
    signals.set({ swapUsedBytes: 3 * 1024 ** 3 });
    await vi.advanceTimersByTimeAsync(10_000);
    signals.set({ memoryPressure: "critical" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(engine.loads).toBe(1);
    expect(statuses.at(-1)?.waitingFor).toEqual(["memory"]);
    signals.set({ memoryPressure: "normal" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(engine.loads).toBe(2);
  });

  it("doubles the memory pause after refusals in a row", async () => {
    const signals = fakeSignals();
    const engine = fakeEngine({ hang: true, progress: false });
    prepare(engine, signals).start();
    await flush();
    signals.set({ swapUsedBytes: 3 * 1024 ** 3 });
    await vi.advanceTimersByTimeAsync(10_000);
    signals.set({ swapUsedBytes: 0 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(engine.loads).toBe(2);
    signals.set({ swapUsedBytes: 3 * 1024 ** 3 });
    await vi.advanceTimersByTimeAsync(10_000);
    signals.set({ swapUsedBytes: 0 });
    await vi.advanceTimersByTimeAsync(119_999);
    expect(engine.loads).toBe(2);
    expect(statuses.at(-1)).toMatchObject({
      waitingFor: ["retry-later"],
      retryAtMs: Date.now() + 1,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(engine.loads).toBe(3);
    expect(logged("analysis.cancelled").map((entry) => entry.fields?.["retryInMs"])).toEqual([
      60_000, 120_000,
    ]);
  });

  it("does not reload immediately after swap refusal between jobs", async () => {
    secondEpisode();
    const signals = fakeSignals();
    const engine = fakeEngine({
      whileRunning: () => signals.set({ swapUsedBytes: 3 * 1024 ** 3 }),
    });
    prepare(engine, signals).start();
    await flush();
    expect(succeededJobs()).toBe(1);
    expect(engine.state()).toBe("absent");
    await vi.advanceTimersByTimeAsync(59_999);
    expect(engine.loads).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(engine.loads).toBe(2);
    expect(succeededJobs()).toBe(2);
    checkSearchIndex(temp.db);
  });

  it("stops while preparing and removes the forwarded abort listener", async () => {
    const signals = fakeSignals();
    const gate = Promise.withResolvers<void>();
    const engine = fakeEngine();
    const load = engine.load.bind(engine);
    engine.load = async (signal) => {
      await gate.promise;
      return load(signal);
    };
    const remove = vi.spyOn(AbortSignal.prototype, "removeEventListener");
    const created = prepare(engine, signals);
    created.start();
    await flush();
    const stopped = created.stop(200);
    gate.resolve();
    await stopped;
    await flush();
    expect(engine.requests).toHaveLength(0);
    expect(jobState()).toBe("running");
    expect(remove.mock.calls.some(([name]) => name === "abort")).toBe(true);
    for (const signal of remove.mock.contexts) {
      expect(signal).toBeInstanceOf(AbortSignal);
      if (signal instanceof AbortSignal) expect(getEventListeners(signal, "abort")).toHaveLength(0);
    }
    expect(logged("analysis.cancelled")).toHaveLength(0);
  });

  it("ignores an admission sample that resolves after publication", async () => {
    const signals = fakeSignals();
    const engine = fakeEngine();
    const inference = Promise.withResolvers<void>();
    const aborted = vi.fn();
    const transcribe = engine.transcribe.bind(engine);
    engine.transcribe = async (...args) => {
      args[1]?.signal?.addEventListener("abort", aborted, { once: true });
      await inference.promise;
      return transcribe(...args);
    };
    prepare(engine, signals).start();
    await flush();
    const sample = Promise.withResolvers<Awaited<ReturnType<typeof signals.service.memory>>>();
    vi.spyOn(signals.service, "memory").mockImplementationOnce(() => sample.promise);
    await vi.advanceTimersByTimeAsync(10_000);
    inference.resolve();
    await flush();
    expect(succeededJobs()).toBe(1);
    sample.resolve({ memoryPressure: "critical", swapUsedBytes: 0, swapRoomBytes: 80 * 1024 ** 3 });
    await flush();
    expect(aborted).not.toHaveBeenCalled();
    expect(statuses.at(-1)?.waitingFor).toEqual([]);
    expect(logged("analysis.cancelled")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(engine.state()).toBe("ready");
    checkSearchIndex(temp.db);
  });

  it("does not read pressure while loading; the check after the load decides", async () => {
    const signals = fakeSignals();
    let finishLoad = (): void => undefined;
    const engine = fakeEngine({
      loading: () =>
        new Promise<void>((resolve) => {
          finishLoad = resolve;
        }),
    });
    prepare(engine, signals).start();
    await flush();
    expect(engine.state()).toBe("loading");
    // The load's own spike, as on Téo's Mac: critical for two checks.
    signals.set({ memoryPressure: "critical" });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(engine.state()).toBe("loading");
    expect(logged("analysis.cancelled")).toHaveLength(0);
    signals.set({ memoryPressure: "warn" });
    finishLoad();
    await flush();
    expect(succeededJobs()).toBe(1);
    expect(engine.loads).toBe(1);
  });

  it("cancels after the load when pressure is still critical", async () => {
    const signals = fakeSignals();
    let finishLoad = (): void => undefined;
    const engine = fakeEngine({
      loading: () =>
        new Promise<void>((resolve) => {
          finishLoad = resolve;
        }),
    });
    prepare(engine, signals).start();
    await flush();
    signals.set({ memoryPressure: "critical" });
    await vi.advanceTimersByTimeAsync(10_000);
    finishLoad();
    await flush();
    await vi.advanceTimersByTimeAsync(defaultSchedulerTiming.loadSettleMs);
    expect(engine.requests).toHaveLength(0);
    expect(engine.state()).toBe("absent");
    expect(jobState()).toBe("queued");
    expect(logged("analysis.cancelled")[0]?.fields).toMatchObject({ reasons: "memory" });
  });

  it("lets the load's own pressure spike fall back before checking", async () => {
    const signals = fakeSignals();
    const engine = fakeEngine({
      onLoaded: (loaded) => {
        if (loaded) signals.set({ memoryPressure: "critical" });
      },
    });
    prepare(engine, signals).start();
    await flush();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(engine.requests).toHaveLength(0);
    signals.set({ memoryPressure: "warn" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(engine.requests).toHaveLength(1);
    expect(logged("analysis.cancelled")).toHaveLength(0);
  });
});

describe("what transcription waits for", () => {
  const GB = 1024 ** 3;

  it("reads every condition the way the queue does, with what the Mac reports", async () => {
    // Téo at the Mac, on power: only idle is missing.
    const signals = fakeSignals({ idleSeconds: 3.6 });
    const check = await scheduled(fakeEngine(), { signals }).check();
    expect(check).toEqual({
      requested: false,
      waitFor: { power: true, idle: true, memory: true },
      remote: false,
      reasons: ["not-idle"],
      onBattery: false,
      idleSeconds: 3,
      idleRequiredSeconds: 120,
      locked: false,
      thermalState: "nominal",
      memoryPressure: "normal",
      swapRoomBytes: 80 * GB,
      // The fake engine's 1 GB peak and the 10 GB margin for a cold load.
      swapRoomNeededBytes: 11 * GB,
      memoryUse: null,
    });
  });

  it("says what holds the memory while pressure refuses, and where it stops", async () => {
    const use = {
      uncompressedBytes: 11 * GB,
      compressedBytes: 14 * GB,
      apps: [{ name: "Cursor", appPath: "/Applications/Cursor.app", bytes: 4 * GB }],
    };
    const signals = fakeSignals({ memoryPressure: "warn" }, use);
    const check = await scheduled(fakeEngine(), { signals }).check();
    expect(check.reasons).toEqual(["memory"]);
    // Cold and automatic: back to normal under 40 % of the 25 GB macOS counts.
    expect(check.memoryUse).toEqual({
      countedBytes: 25 * GB,
      compressedBytes: 14 * GB,
      limitBytes: 10 * GB,
      apps: [{ name: "Cursor", appPath: "/Applications/Cursor.app", bytes: 4 * GB }],
    });
    // A request only needs pressure out of critical: under 60 %.
    const critical = fakeSignals({ memoryPressure: "critical" }, use);
    const created = scheduled(fakeEngine(), { signals: critical });
    created.request(episodeId);
    expect((await created.check()).memoryUse?.limitBytes).toBe(15 * GB);
    // Normal pressure: nothing to read.
    expect(
      (await scheduled(fakeEngine(), { signals: fakeSignals({}, use) }).check()).memoryUse,
    ).toBeNull();
  });

  it("reads memory even when power and idle already refuse", async () => {
    const signals = fakeSignals({
      onBattery: true,
      idleSeconds: 0,
      memoryPressure: "warn",
      swapRoomBytes: 5 * GB,
    });
    const check = await scheduled(fakeEngine(), { signals }).check();
    expect(check.reasons).toEqual(["on-battery", "memory", "not-idle"]);
  });

  it("says when no model is installed, and still reads the Mac", async () => {
    const check = await scheduled(null, { signals: fakeSignals({ idleSeconds: 0 }) }).check();
    expect(check.reasons).toEqual(["no-model", "not-idle"]);
    expect(check.swapRoomNeededBytes).toBeNull();
  });

  it("checks the user's request on its own terms: no power, no idle, warn pressure", async () => {
    const signals = fakeSignals({ onBattery: true, idleSeconds: 0, memoryPressure: "warn" });
    const created = scheduled(fakeEngine(), { signals });
    expect(created.request(episodeId)?.outcome).toBe("already-queued");
    const check = await created.check();
    expect(check.requested).toBe(true);
    expect(check.reasons).toEqual([]);
  });

  it("says a retry delay holds the queue, as the queue itself waits", async () => {
    // A failed job, due again in a minute: nothing else to run.
    temp.db.statement("UPDATE jobs SET not_before_ms = ?").run(Date.now() + 60_000);
    const check = await scheduled(fakeEngine()).check();
    expect(check.reasons).toEqual(["retry-later"]);
  });

  it("starts at once once the user stops waiting for idle", async () => {
    const signals = fakeSignals({ idleSeconds: 0 });
    const engine = fakeEngine();
    const created = scheduled(engine, { signals });
    created.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(engine.requests).toHaveLength(0);
    expect(created.setWaitFor("idle", false)).toEqual({ power: true, idle: false, memory: true });
    await waitUntil(() => engine.requests.length > 0, { label: "started while used" });
    const check = await created.check();
    expect(check.waitFor.idle).toBe(false);
  });

  it("checks a loaded engine on warm terms: its weights hold pressure at warn", async () => {
    const engine = fakeEngine();
    await engine.load();
    const signals = fakeSignals({ memoryPressure: "warn", swapRoomBytes: 1 * GB });
    const check = await scheduled(engine, { signals }).check();
    expect(check.reasons).toEqual([]);
    expect([check.swapRoomBytes, check.swapRoomNeededBytes]).toEqual([null, null]);
  });
});
