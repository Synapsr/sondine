import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { EngineError, type AsrEngine, type AsrRequest } from "../contract.ts";
import { NEMOTRON_CAPABILITIES, NEMOTRON_MANIFEST, NEMOTRON_RESOURCES } from "../nemotron.ts";
import { killStaleWorker } from "./stale-worker.ts";
import {
  createSpeechWorkerEngine,
  type ProgressShape,
  type SpeechWorkerEngineOptions,
  type SpeechWorkerExit,
} from "./worker-engine.ts";

// The worker client against test/fake-speech-worker.ts, a Node script that
// speaks protocol 3 with one scripted behaviour per scenario.

const fakeWorker = resolve(import.meta.dirname, "../../test/fake-speech-worker.ts");
let dir: string;
let weights: string;
let runs = 0;
const engines: AsrEngine[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sondine-worker-"));
  weights = join(dir, "model.gguf");
  writeFileSync(weights, "GGUF");
});
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.unload()));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function makeEngine(
  scenario: string,
  extra: {
    readonly readyDelayMs?: number;
    readonly weights?: string;
    readonly requestBaseMs?: number;
    readonly progress?: ProgressShape;
    readonly wordTimes?: SpeechWorkerEngineOptions["wordTimes"];
  } = {},
) {
  runs += 1;
  const logFile = join(dir, `run-${runs}.jsonl`);
  const exits: SpeechWorkerExit[] = [];
  const engine = createSpeechWorkerEngine({
    manifest: NEMOTRON_MANIFEST,
    capabilities: NEMOTRON_CAPABILITIES,
    resources: { ...NEMOTRON_RESOURCES, unloadLatencyMs: 100 },
    executable: process.execPath,
    executableArgs: [
      fakeWorker,
      "--scenario",
      scenario,
      "--log",
      logFile,
      "--ready-delay-ms",
      String(extra.readyDelayMs ?? 0),
    ],
    weights: extra.weights ?? weights,
    modelSha256: "ab".repeat(32),
    deadlines: {
      readyMs: 3_000,
      requestBaseMs: extra.requestBaseMs ?? 3_000,
      requestPerAudioSecondMs: 0,
      cancelMs: 300,
      unloadGraceMs: 300,
    },
    onExit: (exit) => exits.push(exit),
    ...(extra.progress === undefined ? {} : { progress: extra.progress }),
    ...(extra.wordTimes === undefined ? {} : { wordTimes: extra.wordTimes }),
  });
  engines.push(engine);
  const log = (): Record<string, unknown>[] =>
    existsSync(logFile)
      ? readFileSync(logFile, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  return { engine, exits, log };
}

/** `seconds` of a quiet ramp, mono 16 kHz. */
function request(id: string, seconds: number, extra: Partial<AsrRequest> = {}): AsrRequest {
  const samples = new Int16Array(Math.round(seconds * 16_000));
  for (let i = 0; i < samples.length; i += 1) samples[i] = (i % 200) - 100;
  return { id, samples, sampleRate: 16_000, speakers: true, timestamps: true, ...extra };
}

async function engineError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EngineError) return error.code;
    throw error;
  }
  return "resolved";
}

describe("speech.cpp worker client", () => {
  it("loads, sends 10 s chunks, maps the result, and unloads", async () => {
    const { engine, exits, log } = makeEngine("normal");
    expect(engine.state()).toBe("absent");
    const { loadMs } = await engine.load();
    expect(loadMs).toBeGreaterThanOrEqual(0);
    expect(engine.state()).toBe("ready");
    const pid = engine.pid();
    expect(pid).toBeTypeOf("number");

    const result = await engine.transcribe(request("attempt-1", 25));
    expect(engine.state()).toBe("ready");

    expect(log()[0]).toEqual({
      event: "start",
      argv: ["worker", weights, "--device", "gpu", "--threads", "4"],
      noUpdateCheck: "1",
    });
    expect(log().filter((entry) => entry.event === "chunk")).toEqual([
      { event: "chunk", id: "attempt-1", seq: 0, samples: 160_000 },
      { event: "chunk", id: "attempt-1", seq: 1, samples: 160_000 },
      { event: "chunk", id: "attempt-1", seq: 2, samples: 80_000 },
    ]);
    expect(log().find((entry) => entry.event === "transcribe")?.message).toEqual({
      type: "transcribe",
      id: "attempt-1",
      sample_rate: 16_000,
      timestamps: true,
      speakers: true,
    });
    expect(result.requestId).toBe("attempt-1");
    expect(result.stop).toBe("complete");
    expect(
      result.segments.map((segment) => [segment.startSec, segment.endSec, segment.speaker]),
    ).toEqual([
      [0, 10, 0],
      [10, 20, 1],
      [20, 25, 0],
    ]);
    expect(result.segments[2]?.tokens.map((token) => token.text)).toEqual([
      " chunk",
      " 2",
      " 80000",
      " samples.",
    ]);
    expect(result.text).toBe(result.segments.map((segment) => segment.text).join(" "));
    expect(result.metrics.audioMs).toBe(25_000);
    expect(result.provenance).toEqual({
      engineId: "nemotron-3.5-transcribe-iq4nl",
      engineVersion: NEMOTRON_MANIFEST.version,
      runtime: "speech.cpp 0.9.3",
      adapterClass: "product",
      modelSha256: "ab".repeat(32),
      config: { device: "gpu", threads: 4, timestamps: true, speakers: true, language: "auto" },
    });

    await engine.unload();
    expect(engine.state()).toBe("absent");
    expect(engine.pid()).toBeUndefined();
    expect(alive(pid ?? 0)).toBe(false);
    expect(log().at(-1)).toEqual({ event: "eof" });
    expect(exits).toEqual([
      expect.objectContaining({ pid, code: 0, signal: null, during: "unloading", expected: true }),
    ]);
  });

  it("loads on the first request and passes a language", async () => {
    const { engine, log } = makeEngine("normal");
    const result = await engine.transcribe(request("r", 1, { language: "fr" }));
    expect(result.provenance.config.language).toBe("fr");
    expect(log().find((entry) => entry.event === "transcribe")?.message).toMatchObject({
      language: "fr",
    });
  });

  it("reports progress while busy", async () => {
    const progress: [number, string][] = [];
    const { engine } = makeEngine("progress");
    await engine.transcribe(request("r", 3), {
      onProgress: (done) => progress.push([done, engine.state()]),
    });
    expect(progress).toEqual([
      [0.25, "busy"],
      [0.5, "busy"],
      [0.75, "busy"],
      [1, "busy"],
    ]);
    expect(engine.state()).toBe("ready");
  });

  it("reshapes progress for the model, and says when the request ended", async () => {
    const calls: string[] = [];
    const shape: ProgressShape = {
      start: (seconds) => {
        calls.push(`start ${seconds}`);
        return {
          report: (done) => done / 2,
          end: () => calls.push("end"),
        };
      },
    };
    const progress: number[] = [];
    const { engine } = makeEngine("progress", { progress: shape });
    await engine.transcribe(request("r", 3), { onProgress: (done) => progress.push(done) });
    expect(progress).toEqual([0.125, 0.25, 0.375, 0.5]);
    expect(calls).toEqual(["start 3", "end"]);
  });

  it("corrects word times when timestamps are asked for", async () => {
    const seen: number[] = [];
    const { engine } = makeEngine("normal", {
      wordTimes: (segments, durationSec) => {
        seen.push(durationSec);
        return segments.map((segment) => ({ ...segment, startSec: segment.startSec + 1 }));
      },
    });
    const timed = await engine.transcribe(request("timed", 25));
    expect(timed.segments.map((segment) => segment.startSec)).toEqual([1, 11, 21]);
    const untimed = await engine.transcribe(request("untimed", 25, { timestamps: false }));
    expect(untimed.segments.map((segment) => segment.startSec)).toEqual([0, 10, 20]);
    expect(seen).toEqual([25]);
  });

  it("drops messages for other request ids", async () => {
    const progress: number[] = [];
    const { engine } = makeEngine("wrong-id");
    const result = await engine.transcribe(request("mine", 12), {
      onProgress: (done) => progress.push(done),
    });
    expect(result.requestId).toBe("mine");
    expect(result.segments).toHaveLength(2);
    expect(progress).toEqual([]);
  });

  it("fails a refused request and keeps the worker", async () => {
    const { engine } = makeEngine("error");
    await engine.load();
    const pid = engine.pid();
    await expect(engine.transcribe(request("r", 1))).rejects.toThrow(
      /invalid_argument \(language\): no/,
    );
    expect(engine.state()).toBe("ready");
    expect(engine.pid()).toBe(pid);
  });

  it("fails a request whose worker crashes, with its stderr", async () => {
    const { engine, exits } = makeEngine("crash");
    const error = await engine.transcribe(request("r", 1)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EngineError);
    expect(error).toMatchObject({ code: "crashed" });
    expect(String(error)).toMatch(/exit 3/);
    expect(String(error)).toMatch(/fake worker: about to crash/);
    expect(engine.state()).toBe("absent");
    expect(exits).toEqual([expect.objectContaining({ code: 3, during: "busy", expected: false })]);
  });

  it("reports a worker that dies while idle", async () => {
    const { engine, exits } = makeEngine("crash-idle");
    await engine.load();
    // The worker exits shortly after it is ready: wait for the exit itself.
    await expect.poll(() => exits.length, { timeout: 10_000 }).toBe(1);
    expect(engine.state()).toBe("absent");
    expect(exits).toEqual([expect.objectContaining({ code: 4, during: "ready", expected: false })]);
  });

  it("cancels on a request deadline, then kills a worker that does not answer", async () => {
    const { engine, exits, log } = makeEngine("hang", { requestBaseMs: 200 });
    await engine.load();
    const pid = engine.pid() ?? 0;
    expect(await engineError(engine.transcribe(request("r", 1)))).toBe("deadline");
    expect(log().some((entry) => entry.event === "cancel" && entry.id === "r")).toBe(true);
    expect(alive(pid)).toBe(false);
    expect(engine.state()).toBe("absent");
    expect(exits).toEqual([expect.objectContaining({ signal: "SIGKILL", expected: true })]);
  });

  it("keeps a worker that answers the deadline's cancel", async () => {
    const { engine } = makeEngine("hang-cancellable", { requestBaseMs: 200 });
    await engine.load();
    const pid = engine.pid();
    expect(await engineError(engine.transcribe(request("r", 1)))).toBe("deadline");
    expect(engine.state()).toBe("ready");
    expect(engine.pid()).toBe(pid);
  });

  it("cancels on abort", async () => {
    const { engine, log } = makeEngine("hang-cancellable");
    await engine.load();
    const controller = new AbortController();
    const pending = engine.transcribe(request("r", 1), { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    expect(await engineError(pending)).toBe("cancelled");
    expect(log().filter((entry) => entry.event === "cancel")).toEqual([
      { event: "cancel", id: "r" },
    ]);
    expect(engine.state()).toBe("ready");
  });

  it("runs one request at a time", async () => {
    const { engine } = makeEngine("hang-cancellable");
    const first = engine.transcribe(request("one", 1));
    expect(await engineError(engine.transcribe(request("two", 1)))).toBe("rejected");
    await engine.unload();
    expect(await engineError(first)).toBe("cancelled");
  });

  it("gives up on a worker that never gets ready", async () => {
    const { engine, exits } = makeEngine("never-ready");
    expect(await engineError(engine.load())).toBe("deadline");
    expect(engine.state()).toBe("unloading");
    await engine.unload();
    expect(engine.state()).toBe("absent");
    expect(exits).toEqual([expect.objectContaining({ during: "loading", signal: "SIGKILL" })]);
  });

  it.each([
    ["bad-protocol", "protocol"],
    ["bad-version", "load_failed"],
    ["fatal", "load_failed"],
  ])("refuses a worker that starts wrong (%s)", async (scenario, code) => {
    const { engine } = makeEngine(scenario);
    expect(await engineError(engine.load())).toBe(code);
    await engine.unload();
    expect(engine.state()).toBe("absent");
  });

  it.each([
    ["garbage", "protocol"],
    ["refuse-line", "protocol"],
    ["past-the-audio", "invalid_output"],
    ["mismatched-text", "invalid_output"],
    ["untimed", "invalid_output"],
    ["infinite-time", "invalid_output"],
  ])("fails the request on %s", async (scenario, code) => {
    const { engine } = makeEngine(scenario);
    expect(await engineError(engine.transcribe(request("r", 2)))).toBe(code);
  });

  it("drops a worker after a protocol defect", async () => {
    const { engine } = makeEngine("garbage");
    await engine.load();
    const pid = engine.pid() ?? 0;
    await engineError(engine.transcribe(request("r", 1)));
    await engine.unload();
    expect(alive(pid)).toBe(false);
  });

  it("never starts without its weights, so speech.cpp cannot fetch a model by name", async () => {
    const { engine, log } = makeEngine("normal", { weights: join(dir, "missing.gguf") });
    const error = await engine.load().catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "load_failed",
      message: expect.stringMatching(/no readable weights/),
    });
    expect(log()).toEqual([]);
  });

  it.each([
    ["no audio", request("r", 0)],
    ["another rate", { ...request("r", 1), sampleRate: 8_000 as 16_000 }],
    ["a language it does not take", request("r", 1, { language: "xx" })],
    ["more than 55 min", request("r", 55 * 60 + 1)],
  ])("rejects a request with %s before loading", async (_, asked) => {
    const { engine } = makeEngine("normal");
    expect(await engineError(engine.transcribe(asked))).toBe("rejected");
    expect(engine.state()).toBe("absent");
  });

  it("unloads while loading", async () => {
    const { engine } = makeEngine("normal", { readyDelayMs: 2_000 });
    const loading = engine.load();
    await sleep(100);
    const pid = engine.pid() ?? 0;
    await engine.unload();
    expect(await engineError(loading)).toBe("cancelled");
    expect(alive(pid)).toBe(false);
  });

  it("kills a worker that does not exit after stdin closes", async () => {
    const { engine, exits } = makeEngine("slow-exit");
    await engine.load();
    const started = performance.now();
    await engine.unload();
    // unloadLatencyMs 100 + grace 300.
    expect(performance.now() - started).toBeGreaterThanOrEqual(350);
    expect(exits).toEqual([expect.objectContaining({ signal: "SIGKILL", during: "unloading" })]);
  });

  it("starts a new worker only after the previous one has exited", async () => {
    const { engine } = makeEngine("slow-exit");
    await engine.load();
    const first = engine.pid() ?? 0;
    const unloading = engine.unload();
    await engine.load();
    expect(alive(first)).toBe(false);
    expect(engine.pid()).not.toBe(first);
    await unloading;
  });
});

describe("stale worker", () => {
  it("kills a recorded pid only while it runs our worker", async () => {
    const child = spawn(process.execPath, [fakeWorker, "--scenario", "hang", "worker", weights], {
      stdio: "ignore",
    });
    const pid = child.pid ?? 0;
    await sleep(200);
    expect(await killStaleWorker(pid, "/somewhere/else/speech")).toBe("other-process");
    expect(alive(pid)).toBe(true);
    expect(await killStaleWorker(pid, process.execPath)).toBe("killed");
    expect(alive(pid)).toBe(false);
    expect(await killStaleWorker(pid, process.execPath)).toBe("not-running");
  });
});
