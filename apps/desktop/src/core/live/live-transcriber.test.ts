import type { LiveState } from "@sondine/api";
import {
  bumpInputGeneration,
  getEpisodeDetail,
  publishAnalysis,
  setLiveEnabled,
} from "@sondine/db";
import { EngineError } from "@sondine/engines";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Boot, rows, scalar, tempDb, type Run, type TempDb } from "../../../test/capture-fixture";
import { fakeEngine, regionAudioReader, type FakeEngine } from "../../../test/fake-engine";
import { runEpisodePass } from "../episodes/episode-pass";
import type { ReadTrackAudio } from "../audio/track-audio";
import { LiveTranscriber, type LiveConditions } from "./live-transcriber";

const BOOT = Date.UTC(2026, 10, 8, 10, 0, 0);

let temp: TempDb;
let boot: Boot;
let mic: Run;
let engine: FakeEngine;
let conditions: LiveConditions;
let deletions: number;
let states: { state: LiveState; revision: number }[];
let transcriber: LiveTranscriber | null;
let clock: number;
let reader: (() => ReadTrackAudio) | null;

beforeEach(() => {
  temp = tempDb();
  boot = new Boot(temp.db, BOOT);
  mic = boot.run({ startSec: 0 });
  engine = fakeEngine();
  conditions = { onBattery: false, thermalState: "nominal", memoryPressure: "warn" };
  deletions = 0;
  states = [];
  transcriber = null;
  clock = BOOT;
  reader = null;
  setLiveEnabled(temp.db, true, BOOT);
});

afterEach(async () => {
  await transcriber?.stop();
  temp.cleanup();
});

function live(): LiveTranscriber {
  transcriber = new LiveTranscriber({
    db: temp.db,
    engine: () => engine,
    readAudio: () => reader?.() ?? regionAudioReader(temp.db),
    conditions: async () => conditions,
    deletions: () => deletions,
    blocked: () => false,
    onState: (state, revision) => states.push({ state, revision }),
    log: { info: () => undefined, warn: () => undefined },
    now: () => clock,
  });
  return transcriber;
}

/** Speech the helper heard, imported up to `importedSec`, grouped into an open episode. */
function speech(startSec: number, endSec: number | null, importedSec: number): number {
  boot.chunks(mic, 0, importedSec);
  boot.region(mic, startSec, endSec);
  runEpisodePass(temp.db, { nowMs: boot.wallMs(importedSec), fullScan: true });
  return Number(scalar(temp.db, "SELECT id FROM episodes WHERE state = 'open'"));
}

const liveText = (episodeId: number) =>
  getEpisodeDetail(temp.db, episodeId)?.segments.map((segment) => segment.text) ?? [];
const liveRuns = () =>
  Number(scalar(temp.db, "SELECT count(*) FROM analysis_runs WHERE stage = 'asr_live'"));

describe("near-live text", () => {
  it("publishes a finished sentence of an open conversation, once", async () => {
    const episodeId = speech(10, 14, 20);
    const transcriber = live();
    await transcriber.tickOnce();
    expect(liveText(episodeId)).toEqual(["Bonjour Sondine"]);
    expect(getEpisodeDetail(temp.db, episodeId)?.episode.live).toBe(true);
    expect(engine.requests).toHaveLength(1);
    expect(states.at(-1)).toEqual({ state: "ready", revision: 1 });
    // Nothing new: no request and no publish.
    await transcriber.tickOnce();
    expect(engine.requests).toHaveLength(1);
    expect(states.at(-1)?.revision).toBe(1);
    expect(liveRuns()).toBe(1);
    // The speaker is the track, without diarization.
    expect(rows(temp.db, "SELECT label FROM episode_speakers").map((row) => row["label"])).toEqual([
      "input:BuiltInMicrophoneDevice/live/1",
    ]);
  });

  it("waits for a sentence to end, and for its audio to be imported", async () => {
    const episodeId = speech(10, null, 13);
    const transcriber = live();
    await transcriber.tickOnce();
    expect(liveText(episodeId)).toEqual([]);
    // Ended, but the last samples are not imported yet (post-roll included).
    boot.close(mic, 10, 14);
    runEpisodePass(temp.db, { nowMs: boot.wallMs(14), fullScan: true });
    await transcriber.tickOnce();
    expect(liveText(episodeId)).toEqual([]);
    boot.chunks(mic, 13, 20);
    await transcriber.tickOnce();
    expect(liveText(episodeId)).toEqual(["Bonjour Sondine"]);
  });

  it("adds each new sentence without sending the earlier ones again", async () => {
    const episodeId = speech(10, 14, 20);
    const transcriber = live();
    await transcriber.tickOnce();
    boot.chunks(mic, 20, 40);
    boot.region(mic, 30, 34);
    runEpisodePass(temp.db, { nowMs: boot.wallMs(40), fullScan: true });
    await transcriber.tickOnce();
    expect(engine.requests).toHaveLength(2);
    expect(liveText(episodeId)).toEqual(["Bonjour Sondine", "Bonjour Sondine"]);
    expect(liveRuns()).toBe(1);
  });

  it("rests on battery, when hot, with memory critical, or when turned off", async () => {
    speech(10, 14, 20);
    const transcriber = live();
    for (const [change, state] of [
      [{ onBattery: true }, "on-battery"],
      [{ onBattery: null }, "on-battery"],
      [{ thermalState: "serious" }, "hot"],
      [{ memoryPressure: "critical" }, "memory"],
    ] as const) {
      conditions = {
        onBattery: false,
        thermalState: "nominal",
        memoryPressure: "normal",
        ...change,
      };
      await transcriber.tickOnce();
      expect(states.at(-1)?.state).toBe(state);
    }
    conditions = { onBattery: false, thermalState: "nominal", memoryPressure: "normal" };
    setLiveEnabled(temp.db, false, BOOT);
    await transcriber.tickOnce();
    expect(states.at(-1)?.state).toBe("off");
    expect(engine.requests).toHaveLength(0);
  });

  it("drops what it read before a deletion", async () => {
    const episodeId = speech(10, 14, 20);
    engine = fakeEngine({ whileRunning: () => void (deletions += 1) });
    const transcriber = live();
    await transcriber.tickOnce();
    expect(liveText(episodeId)).toEqual([]);
    expect(liveRuns()).toBe(0);
    // Read again, afresh, once nothing else is deleted.
    engine = fakeEngine();
    await transcriber.tickOnce();
    expect(liveText(episodeId)).toEqual(["Bonjour Sondine"]);
  });

  it("stops once the final transcript exists", async () => {
    const episodeId = speech(10, 14, 20);
    const generation = Number(
      scalar(temp.db, `SELECT input_generation FROM episodes WHERE id = ${episodeId}`),
    );
    temp.db
      .statement(
        `INSERT INTO analysis_runs (episode_id, stage, status, engine_id, engine_version, engine_runtime,
           adapter_class, input_hash, input_generation, started_at_ms)
         VALUES (?, 'asr', 'succeeded', 'nemotron', '1', 'speech.cpp', 'product', 'h', ?, ?)`,
      )
      .run(episodeId, generation, BOOT);
    const runId = Number(scalar(temp.db, "SELECT max(id) FROM analysis_runs"));
    publishAnalysis(temp.db, {
      episodeId,
      stage: "asr",
      runId,
      inputGeneration: generation,
      segments: [],
      turns: [],
    });
    const transcriber = live();
    await transcriber.tickOnce();
    await transcriber.tickOnce();
    expect(engine.requests).toHaveLength(0);
    expect(liveRuns()).toBe(0);
  });

  it("tries again a sentence whose audio is not all imported yet", async () => {
    const episodeId = speech(10, 14, 20);
    // The reader still misses its last samples (a chunk not imported).
    reader = () => (range) => ({
      ...regionAudioReader(temp.db)(range),
      missing: [
        { sampleStart: range.sampleEnd - 160, sampleEnd: range.sampleEnd, reason: "unrecorded" },
      ],
    });
    const transcriber = live();
    await transcriber.tickOnce();
    expect(engine.requests).toHaveLength(0);
    reader = null;
    await transcriber.tickOnce();
    expect(liveText(episodeId)).toEqual(["Bonjour Sondine"]);
  });

  it("tries a failed request again after a pause", async () => {
    const episodeId = speech(10, 14, 20);
    engine = fakeEngine({ fail: new EngineError("crashed", "the worker died") });
    const transcriber = live();
    await transcriber.tickOnce();
    expect(liveText(episodeId)).toEqual([]);
    engine = fakeEngine();
    await transcriber.tickOnce();
    // Not yet: 30 s after the failure.
    expect(engine.requests).toHaveLength(0);
    clock += 30_000;
    await transcriber.tickOnce();
    expect(liveText(episodeId)).toEqual(["Bonjour Sondine"]);
  });

  it("stops a request when the Mac is unplugged, and keeps nothing of it", async () => {
    const episodeId = speech(10, 14, 20);
    engine = fakeEngine({ hang: true });
    const transcriber = live();
    const tick = transcriber.tickOnce();
    await waitFor(() => engine.requests.length === 1);
    conditions = { ...conditions, onBattery: true };
    transcriber.wake();
    await tick;
    expect(liveText(episodeId)).toEqual([]);
    await transcriber.tickOnce();
    expect(states.at(-1)?.state).toBe("on-battery");
    expect(engine.unloads).toBeGreaterThan(0);
  });

  it("stops a request at once when something is deleted", async () => {
    const episodeId = speech(10, 14, 20);
    engine = fakeEngine({ hang: true });
    const transcriber = live();
    const tick = transcriber.tickOnce();
    await waitFor(() => engine.requests.length === 1);
    deletions += 1;
    transcriber.deleted();
    await tick;
    expect(liveText(episodeId)).toEqual([]);
    expect(liveRuns()).toBe(0);
  });

  it("leaves to the final pass a closed run's sentence whose audio never came", async () => {
    const episodeId = speech(10, 14, 20);
    boot.endRun(mic, 20);
    reader = () => (range) => ({
      ...regionAudioReader(temp.db)(range),
      missing: [
        {
          sampleStart: range.sampleStart,
          sampleEnd: range.sampleStart + 160,
          reason: "unrecorded",
        },
      ],
    });
    const transcriber = live();
    for (let tick = 0; tick < 30; tick++) await transcriber.tickOnce();
    expect(engine.requests).toHaveLength(0);
    // Given up: no reading every tick any more.
    reader = null;
    await transcriber.tickOnce();
    expect(engine.requests).toHaveLength(0);
    expect(liveText(episodeId)).toEqual([]);
  });

  it("follows the sentence being said, then hands it to the published text", async () => {
    const episodeId = speech(10, null, 14);
    reader = speaking;
    const transcriber = live();
    await transcriber.tickOnce();
    // What was imported of it so far: 10 s to 14 s, pre-roll included.
    expect(transcriber.partial(episodeId)?.text).toBe("Bonjour Sondine");
    expect(liveText(episodeId)).toEqual([]);
    // Nothing new imported: not sent again.
    await transcriber.tickOnce();
    expect(engine.requests).toHaveLength(1);
    boot.chunks(mic, 14, 16);
    await transcriber.tickOnce();
    expect(engine.requests).toHaveLength(2);
    // The sentence ends: its unit publishes and the line goes.
    boot.close(mic, 10, 15);
    boot.chunks(mic, 16, 20);
    runEpisodePass(temp.db, { nowMs: boot.wallMs(20), fullScan: true });
    await transcriber.tickOnce();
    expect(liveText(episodeId)).toEqual(["Bonjour Sondine"]);
    expect(transcriber.partial(episodeId)).toBeNull();
  });

  it("sends the sentence being said from its pre-roll to what is imported", async () => {
    speech(10, null, 14);
    reader = speaking;
    await live().tickOnce();
    // 1.5 s of pre-roll before 10 s, up to the 14 s imported.
    expect(engine.requests[0]?.samples.length).toBe(5.5 * 16_000);
  });

  it("shows nothing of a sentence being said that holds deleted speech", async () => {
    const episodeId = speech(10, null, 30);
    reader = speaking;
    temp.db
      .statement(
        `INSERT INTO deleted_ranges
           (scope, track_run_id, sample_start, sample_end, wall_start_ms, wall_end_ms, origin, created_at_ms)
         VALUES ('track_run', ?, ?, ?, ?, ?, 'app', ?)`,
      )
      .run(mic.trackRunId, 20 * 16_000, 22 * 16_000, boot.wallMs(20), boot.wallMs(22), BOOT);
    await live().tickOnce();
    expect(engine.requests).toHaveLength(0);
    expect(transcriber?.partial(episodeId)).toBeNull();
  });

  it("shows no sentence being said while it rests", async () => {
    const episodeId = speech(10, null, 14);
    reader = speaking;
    const transcriber = live();
    await transcriber.tickOnce();
    expect(transcriber.partial(episodeId)).not.toBeNull();
    conditions = { ...conditions, onBattery: true };
    await transcriber.tickOnce();
    expect(transcriber.partial(episodeId)).toBeNull();
  });

  it("publishes again when a region joined while it transcribed", async () => {
    const episodeId = speech(10, 14, 20);
    engine = fakeEngine({ whileRunning: () => bumpInputGeneration(temp.db, episodeId, BOOT) });
    const transcriber = live();
    await transcriber.tickOnce();
    expect(liveText(episodeId)).toEqual([]);
    await transcriber.tickOnce();
    expect(liveText(episodeId)).toEqual(["Bonjour Sondine"]);
    // Read once: the cached text went out at the new generation.
    expect(engine.requests).toHaveLength(1);
  });
});

/** Voice over the whole range read: a sentence still going has no region end to fill up to. */
const speaking = (): ReadTrackAudio => (range) => ({
  samples: new Int16Array(range.sampleEnd - range.sampleStart).fill(1_000),
  missing: [],
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200 && !condition(); tries++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(condition()).toBe(true);
}
