import type { AnalysisStatus } from "@sondine/api";
import { bumpInputGeneration, recordSituation, updateZone } from "@sondine/db";
import { EngineError, type AsrEngine } from "@sondine/engines";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Boot, rows, scalar, tempDb, type Run, type TempDb } from "../../../test/capture-fixture";
import {
  fakeEngine,
  fakeSignals,
  regionAudioReader,
  type FakeEngine,
  type FakeEngineOptions,
} from "../../../test/fake-engine";
import { TRACE_BATCH } from "../../shared/traces";
import { fakeTextEngine } from "../../../test/fake-text-engine";
import { waitUntil } from "../../../test/support";
import { runEpisodePass } from "../episodes/episode-pass";
import { JournalWork } from "../journal/journal-work";
import { AnalysisScheduler } from "./scheduler";

// A compute server in the final engine's place (ADR 040).

const BOOT = Date.UTC(2026, 10, 5, 8, 0, 0);

let temp: TempDb;
let boot: Boot;
let mic: Run;
let scheduler: AnalysisScheduler | null;
let statuses: AnalysisStatus[];
let events: string[];
let episodeId: number;
let current: AsrEngine | null;

beforeEach(() => {
  temp = tempDb();
  boot = new Boot(temp.db, BOOT);
  mic = boot.run({ startSec: 0 });
  boot.chunks(mic, 0, 120);
  boot.region(mic, 10, 20);
  runEpisodePass(temp.db, { nowMs: boot.wallMs(120), fullScan: true });
  episodeId = Number(scalar(temp.db, "SELECT id FROM episodes"));
  statuses = [];
  events = [];
  scheduler = null;
  current = null;
});

afterEach(async () => {
  await scheduler?.stop(200);
  temp.cleanup();
});

/** Holds nothing here: never loaded, "absent" whenever it is not busy. */
function remoteEngine(options: FakeEngineOptions = {}): FakeEngine {
  const base = fakeEngine(options);
  let busy = false;
  return {
    ...base,
    get requests() {
      return base.requests;
    },
    get loads() {
      return 0;
    },
    get unloads() {
      return base.unloads;
    },
    manifest: { ...base.manifest, id: "fake-asr:own" },
    capabilities: { ...base.capabilities, locality: "remote" },
    state: () => (busy ? "busy" : "absent"),
    load: () => Promise.reject(new Error("a compute server is never loaded")),
    async transcribe(request, transcribeOptions) {
      busy = true;
      try {
        return await base.transcribe(request, transcribeOptions);
      } finally {
        busy = false;
      }
    },
  };
}

function start(
  engine: AsrEngine,
  options: {
    readonly signals?: ReturnType<typeof fakeSignals>;
    readonly idleEngine?: AsrEngine;
    readonly dictationEngine?: AsrEngine;
    readonly journal?: JournalWork;
    readonly idleUnloadMs?: number;
    readonly now?: () => number;
  } = {},
) {
  current = engine;
  const readAudio = regionAudioReader(temp.db);
  const record = (event: string) => void events.push(event);
  scheduler = new AnalysisScheduler({
    db: temp.db,
    engine: () => current,
    ...(options.idleEngine === undefined ? {} : { idleEngine: () => options.idleEngine ?? null }),
    ...(options.dictationEngine === undefined
      ? {}
      : { dictationEngine: () => options.dictationEngine ?? null }),
    ...(options.journal === undefined ? {} : { journal: options.journal }),
    readAudio: () => readAudio,
    signals: (options.signals ?? fakeSignals()).service,
    processes: {
      stopAll: async () => ({ stopped: [], survivors: [] }),
      reap: async () => "other-process",
      residentBytes: async () => null,
    },
    onStatus: (status) => void statuses.push(status),
    log: { info: record, warn: record },
    timing: {
      admissionIntervalMs: 20,
      idleUnloadMs: options.idleUnloadMs ?? 50,
      rssIntervalMs: 20,
      swapSettleMs: 0,
    },
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  scheduler.start();
  return scheduler;
}

const jobState = () => scalar(temp.db, "SELECT state FROM jobs WHERE kind = 'analysis'");
const jobStates = () =>
  rows(temp.db, "SELECT state FROM jobs WHERE kind = 'analysis' ORDER BY state").map(
    (row) => row["state"],
  );
const attempts = () => rows(temp.db, "SELECT outcome, error_code FROM job_attempts");
const last = () => statuses.at(-1);

describe("a compute server", () => {
  it("transcribes on battery, in use, short of memory: no model is loaded here", async () => {
    const engine = remoteEngine();
    const signals = fakeSignals({
      onBattery: true,
      idleSeconds: 0,
      memoryPressure: "warn",
      swapRoomBytes: 0,
    });
    start(engine, { signals });
    await waitUntil(() => jobState() === "succeeded", { label: "published" });
    expect(engine.unloads).toBe(0);
    expect(events).not.toContain("analysis.loaded");
    expect(rows(temp.db, "SELECT engine_id FROM analysis_runs")).toEqual([
      { engine_id: "fake-asr:own" },
    ]);
  });

  it("leaves a Mac in trouble alone", async () => {
    const engine = remoteEngine();
    const signals = fakeSignals({ memoryPressure: "critical" });
    start(engine, { signals });
    await waitUntil(() => last()?.waitingFor.includes("memory") === true, { label: "waiting" });
    expect(engine.requests).toHaveLength(0);
    signals.set({ memoryPressure: "normal" });
    await waitUntil(() => jobState() === "succeeded", { label: "published" });
  });

  it("waits for a server that does not answer, without counting a failure, and goes on when asked", async () => {
    const failing: { error: EngineError | null } = {
      error: new EngineError("network_unavailable", "down"),
    };
    const base = remoteEngine();
    const engine: FakeEngine = {
      ...base,
      transcribe: (request, options) =>
        failing.error === null ? base.transcribe(request, options) : Promise.reject(failing.error),
    };
    const started = start(engine);
    await waitUntil(() => last()?.waitingFor.includes("server-offline") === true, {
      label: "offline",
    });
    expect(last()?.retryAtMs).toBeGreaterThan(Date.now());
    expect(attempts()).toEqual([{ outcome: "cancelled", error_code: "network_unavailable" }]);
    expect(jobState()).toBe("queued");
    expect((await started.check()).reasons).toEqual(["server-offline"]);
    expect((await started.check()).remote).toBe(true);
    // The user asks again: tried now, not when the pause ends.
    failing.error = null;
    expect(started.request(episodeId)?.outcome).toBe("already-queued");
    await waitUntil(() => jobState() === "succeeded", { label: "published" });
  });

  it.each([
    ["unauthorized", "server-refused"],
    ["server_mismatch", "server-refused"],
    ["server_busy", "server-busy"],
    ["quota_exhausted", "server-quota"],
  ] as const)("says why it waits: %s", async (code, reason) => {
    start(remoteEngine({ fail: new EngineError(code, "no") }));
    await waitUntil(() => last()?.waitingFor.includes(reason) === true, { label: reason });
    expect(jobState()).toBe("queued");
  });

  it("counts the model's own failures as before", async () => {
    start(remoteEngine({ fail: new EngineError("invalid_output", "no", { reason: "x" }) }));
    await waitUntil(() => attempts().length > 0 && attempts()[0]?.["outcome"] === "failed", {
      label: "failed",
    });
  });

  it("stops what is leaving when the episode changes, and sends it as it is now", async () => {
    const engine = remoteEngine({ hang: true });
    start(engine);
    await waitUntil(() => engine.requests.length === 1, { label: "sent" });
    bumpInputGeneration(temp.db, episodeId, Date.now());
    await waitUntil(() => attempts()[0]?.["error_code"] === "not_sent", { label: "stopped" });
    await waitUntil(() => engine.requests.length === 2, { label: "sent again" });
  });

  it("stops at once when the user goes back to this Mac, which takes the job", async () => {
    const engine = remoteEngine({ hang: true });
    const local = fakeEngine();
    const started = start(engine, { idleEngine: local });
    await waitUntil(() => engine.requests.length === 1, { label: "sent" });
    current = local;
    started.placeChanged();
    // At once: not at the next look.
    await waitUntil(() => attempts()[0]?.["error_code"] === "not_sent", { timeoutMs: 400 });
    await waitUntil(() => jobState() === "succeeded", { label: "published here" });
    expect(attempts()[0]).toMatchObject({ outcome: "cancelled", error_code: "not_sent" });
    expect(local.requests).toHaveLength(1);
  });

  it("stops when the episode is deleted, and publishes nothing", async () => {
    const engine = remoteEngine({ hang: true });
    start(engine);
    await waitUntil(() => engine.requests.length === 1, { label: "sent" });
    temp.db.statement("DELETE FROM episodes WHERE id = ?").run(episodeId);
    await waitUntil(() => events.includes("analysis.cancelled"), { label: "stopped" });
    expect(scalar(temp.db, "SELECT count(*) FROM episode_analysis")).toBe(0);
  });

  it("never gets an episode of a private zone, even asked for; this Mac still does", async () => {
    // The screen was away all along, and that zone keeps the audio without its text.
    updateZone(temp.db, "screen", { on: true, outcome: "audio_only" }, BOOT);
    recordSituation(temp.db, { screenAway: true, networks: [] }, BOOT);
    temp.db.statement("DELETE FROM jobs").run();
    const engine = remoteEngine();
    const started = start(engine);
    expect(started.request(episodeId)).toEqual({ outcome: "private-zone", jobId: null });
    expect(engine.requests).toHaveLength(0);
    current = fakeEngine();
    expect(started.request(episodeId)?.outcome).toBe("queued");
  });

  it("publishes nothing that comes back after the choice was taken back", async () => {
    const local = fakeEngine();
    const engine = remoteEngine({ whileRunning: () => (current = local) });
    start(engine, { idleEngine: local });
    await waitUntil(() => jobState() === "succeeded", { label: "published here" });
    expect(
      rows(
        temp.db,
        "SELECT r.engine_id FROM episode_analysis a JOIN analysis_runs r ON r.id = a.run_id",
      ),
    ).toEqual([{ engine_id: "fake-asr" }]);
  });

  it("sends nothing around the speech beside a zone that keeps no text", async () => {
    const samples = (engine: FakeEngine) => engine.requests[0]?.samples.length;
    const wide = remoteEngine();
    start(wide);
    await waitUntil(() => jobState() === "succeeded", { label: "published" });
    await scheduler?.stop(200);
    updateZone(temp.db, "screen", { on: true, outcome: "audio_only" }, BOOT);
    const narrow = remoteEngine();
    const started = start(narrow);
    started.request(episodeId);
    await waitUntil(() => samples(narrow) !== undefined, { label: "sent" });
    // The 10 s of speech, without the second and a half before nor what follows.
    expect(samples(narrow)).toBe(10 * 16_000);
    expect(samples(wide)).toBeGreaterThan(10 * 16_000);
  });

  it("lets this Mac's model go while a server transcribes", async () => {
    const local = fakeEngine();
    current = local;
    const started = start(local, { idleEngine: local });
    await waitUntil(() => jobState() === "succeeded", { label: "published" });
    current = remoteEngine({ hang: true });
    started.request(episodeId);
    // Before the server's answer, however long it takes.
    await waitUntil(() => (current as FakeEngine).requests.length === 1, { label: "sent" });
    await waitUntil(() => local.unloads === 1, { label: "let go" });
  });
});

describe("beside a compute server's job", () => {
  /** A second episode, at 200 s: the first one's job is asked for, so it goes first. */
  function second(context: "dictation" | "in_person"): number {
    boot.chunks(mic, 120, 300);
    boot.region(mic, 200, 210);
    runEpisodePass(temp.db, { nowMs: boot.wallMs(300), fullScan: true });
    const id = Number(scalar(temp.db, "SELECT max(id) FROM episodes"));
    temp.db.statement("UPDATE episodes SET context = ? WHERE id = ?").run(context, id);
    return id;
  }
  const stateOf = (id: number) =>
    scalar(temp.db, "SELECT state FROM jobs WHERE kind = 'analysis' AND episode_id = ?", id);

  it("transcribes a dictation here while the server works", async () => {
    const dictation = second("dictation");
    temp.db.statement("UPDATE jobs SET priority = 10 WHERE episode_id = ?").run(episodeId);
    const server = remoteEngine({ hang: true });
    const parakeet = fakeEngine({ speakers: false });
    start(server, { dictationEngine: parakeet });
    await waitUntil(() => stateOf(dictation) === "succeeded", { label: "dictation published" });
    expect(server.requests).toHaveLength(1);
    expect(stateOf(episodeId)).toBe("running");
    expect(parakeet.requests).toHaveLength(1);
    // What the status shows is the job that lasts.
    await waitUntil(() => last()?.running?.episodeId === episodeId, { label: "shown" });
    // One request at a time on the server, whatever else waits for it.
    const other = second("in_person");
    scheduler?.request(other);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.requests).toHaveLength(1);
  });

  it("transcribes dictations on battery and in use, as this Mac alone does not", async () => {
    const dictation = second("dictation");
    const signals = fakeSignals({ onBattery: true, idleSeconds: 0 });
    const parakeet = fakeEngine({ speakers: false });
    start(remoteEngine(), { signals, dictationEngine: parakeet });
    await waitUntil(() => stateOf(dictation) === "succeeded", { label: "dictation published" });
    expect(parakeet.requests).toHaveLength(1);
    // Back on this Mac, the next one waits as before.
    current = fakeEngine();
    scheduler?.placeChanged();
    boot.chunks(mic, 300, 500);
    boot.region(mic, 400, 410);
    runEpisodePass(temp.db, { nowMs: boot.wallMs(500), fullScan: true });
    const next = Number(scalar(temp.db, "SELECT max(id) FROM episodes"));
    temp.db.statement("UPDATE episodes SET context = 'dictation' WHERE id = ?").run(next);
    scheduler?.wake();
    await waitUntil(() => last()?.waitingFor.includes("on-battery") === true, { label: "waits" });
    expect(stateOf(next)).toBe("queued");
  });

  it("is not held back by a dictation that waits for the Mac", async () => {
    const dictation = second("dictation");
    temp.db.statement("UPDATE jobs SET priority = 10 WHERE episode_id = ?").run(dictation);
    const signals = fakeSignals({ thermalState: "serious" });
    start(remoteEngine(), { signals, dictationEngine: fakeEngine({ speakers: false }) });
    await waitUntil(() => stateOf(episodeId) === "succeeded", { label: "published" });
    expect(stateOf(dictation)).toBe("queued");
    await waitUntil(() => last()?.waitingFor.includes("thermal") === true, {
      label: "the dictation says why it waits",
    });
    expect(last()?.waitingEpisodeId).toBe(dictation);
  });

  it("does not say the model is missing for a dictation without Parakeet while it works", async () => {
    second("dictation");
    const server = remoteEngine({ hang: true });
    start(server);
    await waitUntil(() => last()?.running?.episodeId === episodeId, { label: "running" });
    scheduler?.wake();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(last()?.server).toEqual({ waitingFor: [], dictationsWaitingFor: ["no-model"] });
  });

  it("takes the traces after other work, and never for themselves", async () => {
    const traces = (startSec: number): number => {
      boot.chunks(mic, startSec - 80, startSec + 100);
      boot.region(mic, startSec, startSec + 1);
      runEpisodePass(temp.db, { nowMs: boot.wallMs(startSec + 100), fullScan: true });
      return Number(scalar(temp.db, "SELECT max(id) FROM episodes"));
    };
    const first = traces(200);
    const second = traces(400);
    expect(
      rows(temp.db, "SELECT DISTINCT priority FROM jobs WHERE episode_id IN (?, ?)", first, second),
    ).toEqual([{ priority: 50 }]);
    const server = remoteEngine();
    const running = start(server, { idleUnloadMs: 400 });
    await waitUntil(() => stateOf(first) === "succeeded" && stateOf(second) === "succeeded", {
      label: "traces published",
    });
    // The conversation first; then nothing until other work has the model loaded again.
    expect(server.requests).toHaveLength(3);
    expect(stateOf(episodeId)).toBe("succeeded");
    await new Promise((resolve) => setTimeout(resolve, 450));
    const third = traces(600);
    running.wake();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stateOf(third)).toBe("queued");
    running.request(episodeId);
    await waitUntil(() => stateOf(third) === "succeeded", { label: "after other work" });
  });

  it("sends every trace at once when thirty wait, without a conversation", async () => {
    temp.db.statement("UPDATE jobs SET state = 'succeeded'").run();
    const add = (from: number, count: number) => {
      boot.chunks(mic, 120 + from * 100, 300 + (from + count) * 100);
      for (let index = from; index < from + count; index += 1) {
        boot.region(mic, 200 + index * 100, 201 + index * 100);
      }
      runEpisodePass(temp.db, { nowMs: boot.wallMs(300 + (from + count) * 100), fullScan: true });
    };
    const queued = () =>
      Number(scalar(temp.db, "SELECT count(*) FROM jobs WHERE state = 'queued' AND priority = 50"));
    add(0, TRACE_BATCH - 1);
    expect(queued()).toBe(TRACE_BATCH - 1);
    const server = remoteEngine();
    const running = start(server, { idleUnloadMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(server.requests).toHaveLength(0);
    add(TRACE_BATCH - 1, 1);
    running.wake();
    await waitUntil(() => queued() === 0, { label: "all gone", timeoutMs: 10_000 });
    expect(server.requests).toHaveLength(TRACE_BATCH);
    // The next one waits for company again.
    add(TRACE_BATCH, 1);
    running.wake();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(queued()).toBe(1);
  });

  it("says it transcribes itself again once the choice is this Mac", async () => {
    const local = fakeEngine();
    start(remoteEngine(), { idleEngine: local });
    await waitUntil(() => jobState() === "succeeded", { label: "published" });
    expect(last()?.server).toEqual({ waitingFor: [], dictationsWaitingFor: [] });
    current = local;
    scheduler?.placeChanged();
    await waitUntil(() => last()?.server === null, { label: "this Mac" });
  });

  it("keeps the server's reason while a dictation goes on here", async () => {
    const dictation = second("dictation");
    const down = remoteEngine({ fail: new EngineError("network_unavailable", "down") });
    start(down, { dictationEngine: fakeEngine({ speakers: false }) });
    await waitUntil(() => stateOf(dictation) === "succeeded", { label: "dictation published" });
    await waitUntil(() => last()?.waitingFor.join() === "server-offline", { label: "offline" });
    expect(last()?.waitingEpisodeId).toBe(episodeId);
  });

  it("writes the journal of what came back while the server works on the next", async () => {
    const text = fakeTextEngine();
    const journal = new JournalWork({
      db: temp.db,
      device: () => text,
      claude: () => null,
      writer: () => "device",
      enabled: () => true,
      language: () => "fr",
      timeZone: () => "Europe/Paris",
      log: { info: () => undefined, warn: () => undefined },
    });
    let answered = 0;
    const base = remoteEngine();
    const server: FakeEngine = {
      ...base,
      transcribe: (request, options) => {
        answered += 1;
        if (answered === 1) return base.transcribe(request, options);
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () =>
            reject(new EngineError("cancelled", "cancelled")),
          );
        });
      },
    };
    second("in_person");
    start(server, { journal });
    await waitUntil(
      () => scalar(temp.db, "SELECT count(*) FROM journal_runs WHERE status = 'published'") === 1,
      { label: "journal published" },
    );
    expect(answered).toBe(2);
    expect(jobStates()).toEqual(["running", "succeeded"]);
  });

  it("stops both at once", async () => {
    const dictation = second("dictation");
    temp.db.statement("UPDATE jobs SET priority = 10 WHERE episode_id = ?").run(episodeId);
    const server = remoteEngine({ hang: true });
    const parakeet = fakeEngine({ speakers: false, hang: true });
    const running = start(server, { dictationEngine: parakeet });
    await waitUntil(() => server.requests.length === 1 && parakeet.requests.length === 1, {
      label: "both running",
    });
    await running.stop(400);
    // Left for the next start to recover; nothing written since.
    expect([stateOf(episodeId), stateOf(dictation)]).toEqual(["running", "running"]);
    expect(attempts().every((attempt) => attempt["outcome"] === "running")).toBe(true);
  });
});
