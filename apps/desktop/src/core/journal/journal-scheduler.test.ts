import { setJournalSettings, type JournalWriter } from "@sondine/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Boot, scalar, tempDb, type Run, type TempDb } from "../../../test/capture-fixture";
import {
  fakeEngine,
  fakeSignals,
  regionAudioReader,
  type FakeEngine,
} from "../../../test/fake-engine";
import { fakeTextEngine, type FakeTextEngine } from "../../../test/fake-text-engine";
import { waitUntil } from "../../../test/support";
import { EngineError } from "@sondine/engines";
import { AnalysisScheduler, HEAVY_ENGINE_BYTES } from "../analysis/scheduler";
import { runEpisodePass } from "../episodes/episode-pass";
import { JournalWork } from "./journal-work";

// The journal in the analysis scheduler (ADR 028): after transcription, on
// the same admission, one heavy model at a time.

const BOOT = Date.UTC(2026, 10, 5, 8, 0, 0);

let temp: TempDb;
let boot: Boot;
let mic: Run;
let scheduler: AnalysisScheduler | null;
let events: string[];

beforeEach(() => {
  temp = tempDb();
  boot = new Boot(temp.db, BOOT);
  events = [];
  scheduler = null;
  mic = boot.run({ startSec: 0 });
  boot.chunks(mic, 0, 120);
  boot.region(mic, 10, 20);
  runEpisodePass(temp.db, { nowMs: boot.wallMs(120), fullScan: true });
});

afterEach(async () => {
  await scheduler?.stop(200);
  temp.cleanup();
});

/** An ASR engine as heavy as Nemotron, its counters kept on the original. */
function heavyAsr(): { engine: FakeEngine; counters: FakeEngine } {
  const counters = fakeEngine();
  const engine: FakeEngine = {
    ...counters,
    resources: { ...counters.resources, peakBytesBase: HEAVY_ENGINE_BYTES },
  };
  return { engine, counters };
}

function scheduled(
  asr: FakeEngine,
  text: FakeTextEngine,
  signals = fakeSignals(),
  writing: {
    writer?: () => JournalWriter;
    claude?: FakeTextEngine;
    enabled?: () => boolean;
  } = {},
): { scheduler: AnalysisScheduler; work: JournalWork } {
  const work = new JournalWork({
    db: temp.db,
    device: () => text,
    claude: () => writing.claude ?? null,
    writer: writing.writer ?? (() => "device"),
    enabled: writing.enabled ?? (() => true),
    language: () => "fr",
    timeZone: () => "Europe/Paris",
    log: { info: (event) => events.push(event), warn: (event) => events.push(event) },
  });
  const created = new AnalysisScheduler({
    db: temp.db,
    engine: () => asr,
    readAudio: () => regionAudioReader(temp.db),
    signals: signals.service,
    processes: {
      stopAll: async () => ({ stopped: [], survivors: [] }),
      reap: async () => "other-process",
      residentBytes: async () => null,
    },
    onStatus: () => undefined,
    log: { info: (event) => events.push(event), warn: (event) => events.push(event) },
    journal: work,
    textProcesses: { stopAll: async () => ({ stopped: [], survivors: [] }) },
    timing: {
      admissionIntervalMs: 20,
      idleUnloadMs: 50,
      rssIntervalMs: 20,
      noModelPollMs: 20,
      memoryRetryMs: 60,
    },
  });
  scheduler = created;
  return { scheduler: created, work };
}

const published = () =>
  Number(scalar(temp.db, "SELECT count(*) FROM journal_runs WHERE status = 'published'"));

describe("the journal in the analysis scheduler", () => {
  it("writes a conversation once it is transcribed, the transcription model gone first", async () => {
    const { engine, counters } = heavyAsr();
    const text = fakeTextEngine();
    const { scheduler: running } = scheduled(engine, text);
    await running.recover();
    running.start();
    await waitUntil(() => published() === 1, { label: "journal published" });
    expect(counters.loads).toBe(1);
    // Nemotron left before the text model came: never both in memory.
    expect(counters.unloads).toBeGreaterThanOrEqual(1);
    expect(events.indexOf("analysis.published")).toBeLessThan(events.indexOf("journal.loaded"));
    expect(events.filter((event) => event === "analysis.unloaded").length).toBeGreaterThanOrEqual(
      1,
    );
    expect(scalar(temp.db, "SELECT count(*) FROM journal_items")).toBe(2);
    expect(text.requests).toHaveLength(1);
    expect(text.requests[0]?.user).toContain("<transcript>");
  });

  it("waits for idle and power like transcription, unless the user asked for the day", async () => {
    const asr = fakeEngine();
    const text = fakeTextEngine();
    // On battery: only what the user asks for runs.
    const signals = fakeSignals({ onBattery: true });
    const { scheduler: running, work } = scheduled(asr, text, signals);
    await running.recover();
    const episodeId = Number(scalar(temp.db, "SELECT id FROM episodes"));
    running.request(episodeId);
    running.start();
    await waitUntil(
      () => scalar(temp.db, "SELECT count(*) FROM jobs WHERE state = 'succeeded'") === 1,
      { label: "transcribed on request" },
    );
    await waitUntil(() => events.includes("journal.waiting"), { label: "journal waits" });
    expect(published()).toBe(0);
    work.request({ fromMs: BOOT - 3_600_000, toMs: BOOT + 3_600_000 * 4 });
    running.wake();
    await waitUntil(() => published() === 1, { label: "requested journal published" });
  });

  it("stops a pass the Mac refuses midway, without counting it as a failure", async () => {
    const asr = fakeEngine();
    const text = fakeTextEngine({ hang: true });
    const signals = fakeSignals();
    const { scheduler: running } = scheduled(asr, text, signals);
    await running.recover();
    running.start();
    await waitUntil(() => text.requests.length === 1, { label: "journal started" });
    signals.set({ memoryPressure: "critical" });
    await waitUntil(
      () => scalar(temp.db, "SELECT count(*) FROM journal_runs WHERE status = 'cancelled'") === 1,
      { label: "journal cancelled" },
    );
    expect(scalar(temp.db, "SELECT count(*) FROM journal_runs WHERE status = 'failed'")).toBe(0);
    await waitUntil(() => text.state() === "absent", { label: "text model unloaded" });
  });

  it("writes nothing while the user turned the journal off", async () => {
    setJournalSettings(temp.db, { enabled: false }, BOOT);
    const asr = fakeEngine();
    const text = fakeTextEngine();
    const work = new JournalWork({
      db: temp.db,
      device: () => text,
      claude: () => null,
      writer: () => "device",
      enabled: () => false,
      language: () => "fr",
      timeZone: () => "Europe/Paris",
      log: { info: () => undefined, warn: () => undefined },
    });
    expect(work.next()).toBeNull();
    const { scheduler: running } = scheduled(asr, text);
    void running;
    expect(text.loads).toBe(0);
  });
});

const commitments = () =>
  Number(scalar(temp.db, "SELECT count(*) FROM journal_items WHERE kind = 'commitment'"));
const metrics = () =>
  JSON.parse(
    String(scalar(temp.db, "SELECT metrics FROM journal_runs WHERE status = 'published'")),
  );

describe("who writes the journal", () => {
  const day = { fromMs: BOOT - 3_600_000, toMs: BOOT + 3_600_000 * 4 };

  it("lets the user's Claude read each commitment again, and drops what it says was asked", async () => {
    const text = fakeTextEngine();
    const claude = fakeTextEngine({
      provider: true,
      check: { says: "asks-someone", when: "later" },
    });
    const { scheduler: running } = scheduled(fakeEngine(), text, fakeSignals(), {
      writer: () => "device-checked",
      claude,
    });
    await running.recover();
    running.start();
    await waitUntil(() => published() === 1, { label: "journal published" });
    expect(commitments()).toBe(0);
    expect(scalar(temp.db, "SELECT count(*) FROM journal_items WHERE kind = 'event'")).toBe(1);
    expect(claude.requests.map((request) => request.id.endsWith("-check"))).toEqual([true]);
    expect(metrics()).toMatchObject({ writer: "device-checked", checked: 1, checkDropped: 1 });
  });

  it("writes with the user's Claude, nothing loaded here, keeping what it says is promised", async () => {
    const text = fakeTextEngine();
    const claude = fakeTextEngine({ provider: true, check: { says: "will-do", when: "later" } });
    const { scheduler: running } = scheduled(fakeEngine(), text, fakeSignals(), {
      writer: () => "claude",
      claude,
    });
    await running.recover();
    running.start();
    await waitUntil(() => published() === 1, { label: "journal published" });
    expect(text.loads).toBe(0);
    expect(commitments()).toBe(1);
    expect(claude.requests).toHaveLength(2);
    expect(metrics()).toMatchObject({ writer: "claude", checked: 1, checkDropped: 0 });
  });

  it("waits when Claude does not answer, never counting it against the conversation", async () => {
    const claude = fakeTextEngine({
      provider: true,
      fail: () => new EngineError("rejected", "refused", { reason: "http-401" }),
    });
    const { scheduler: running, work } = scheduled(fakeEngine(), fakeTextEngine(), fakeSignals(), {
      writer: () => "claude",
      claude,
    });
    await running.recover();
    running.start();
    await waitUntil(
      () => scalar(temp.db, "SELECT count(*) FROM journal_runs WHERE status = 'cancelled'") === 1,
      { label: "journal cancelled" },
    );
    expect(scalar(temp.db, "SELECT error_code FROM journal_runs")).toBe("claude-http-401");
    expect(scalar(temp.db, "SELECT count(*) FROM journal_runs WHERE status = 'failed'")).toBe(0);
    expect(work.claudePaused()).toBe(true);
    expect(work.next()).toBeNull();
    // The user asking for the day asks Claude again.
    work.request(day);
    expect(work.claudePaused()).toBe(false);
  });

  it("sends nothing more to Claude once the user went back to this Mac mid-pass", async () => {
    let writer: JournalWriter = "claude";
    const claude = fakeTextEngine({ provider: true });
    const generate = claude.generate.bind(claude);
    claude.generate = async (request, options) => {
      // The user chooses « Ce Mac » while Claude writes the first window.
      writer = "device";
      return await generate(request, options);
    };
    const { scheduler: running } = scheduled(fakeEngine(), fakeTextEngine(), fakeSignals(), {
      writer: () => writer,
      claude,
    });
    await running.recover();
    running.start();
    // The Mac writes it once Claude's pass stopped: its publication replaces the cancelled one.
    await waitUntil(() => published() === 1, { label: "written by the Mac" });
    expect(metrics()).toMatchObject({ writer: "device" });
    // Claude's window was answered; the check never went out.
    expect(claude.requests).toHaveLength(1);
  });

  it("sends nothing more to Claude once the user turned the journal off mid-pass", async () => {
    let enabled = true;
    const claude = fakeTextEngine({ provider: true });
    const generate = claude.generate.bind(claude);
    claude.generate = async (request, options) => {
      enabled = false;
      return await generate(request, options);
    };
    const { scheduler: running } = scheduled(fakeEngine(), fakeTextEngine(), fakeSignals(), {
      writer: () => "claude",
      claude,
      enabled: () => enabled,
    });
    await running.recover();
    running.start();
    await waitUntil(
      () =>
        scalar(temp.db, "SELECT count(*) FROM journal_runs WHERE error_code = 'writer-changed'") ===
        1,
      { label: "pass cancelled" },
    );
    expect(claude.requests).toHaveLength(1);
    expect(published()).toBe(0);
  });

  it("never sends to an engine the user left between its choice and its pass", async () => {
    let writer: JournalWriter = "device";
    const claude = fakeTextEngine({ provider: true });
    const { scheduler: running, work } = scheduled(fakeEngine(), fakeTextEngine(), fakeSignals(), {
      writer: () => writer,
      claude,
    });
    await running.recover();
    running.start();
    await waitUntil(() => published() === 1, { label: "journal published" });
    await running.stop(200);
    scheduler = null;
    const unit = { episodeId: Number(scalar(temp.db, "SELECT id FROM episodes")), requested: true };
    // Claude was chosen, then « Ce Mac » again before the pass began.
    writer = "device";
    expect(await work.run(claude, unit, new AbortController().signal)).toBe("discarded");
    expect(claude.requests).toHaveLength(0);
  });

  it("keeps what is written when the writer changes, and writes a day again on request", async () => {
    let writer: JournalWriter = "device";
    const claude = fakeTextEngine({ provider: true });
    const { scheduler: running, work } = scheduled(fakeEngine(), fakeTextEngine(), fakeSignals(), {
      writer: () => writer,
      claude,
    });
    await running.recover();
    running.start();
    await waitUntil(() => published() === 1, { label: "journal published" });
    await running.stop(200);
    scheduler = null;
    writer = "claude";
    expect(work.next()).toBeNull();
    work.request(day, true);
    expect(work.next()).toEqual({
      episodeId: Number(scalar(temp.db, "SELECT id FROM episodes")),
      requested: true,
    });
  });
});
