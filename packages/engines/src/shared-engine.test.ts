import { describe, expect, it } from "vitest";
import { EngineError, type AsrEngine, type AsrRequest, type EngineState } from "./contract.ts";
import { PARAKEET_CAPABILITIES, PARAKEET_MANIFEST, PARAKEET_RESOURCES } from "./parakeet.ts";
import { shareEngine } from "./shared-engine.ts";

/** An engine that refuses a second request while one runs, as the speech worker does. */
function oneAtATime() {
  let state: EngineState = "absent";
  const log: string[] = [];
  const pending: (() => void)[] = [];
  const engine: AsrEngine = {
    manifest: PARAKEET_MANIFEST,
    capabilities: PARAKEET_CAPABILITIES,
    resources: PARAKEET_RESOURCES,
    state: () => state,
    pid: () => (state === "absent" ? undefined : 42),
    async load() {
      log.push("load");
      state = "ready";
      return { loadMs: 1 };
    },
    async transcribe(request: AsrRequest) {
      if (state === "busy") throw new EngineError("rejected", "one request at a time");
      state = "busy";
      log.push(`start ${request.id}`);
      await new Promise<void>((resolve) => pending.push(resolve));
      log.push(`end ${request.id}`);
      state = "ready";
      return {
        requestId: request.id,
        text: "",
        stop: "complete",
        segments: [],
        languages: [],
        provenance: {
          engineId: "parakeet",
          engineVersion: "1",
          runtime: "test",
          adapterClass: "product",
          modelSha256: "0",
          config: {},
        },
        metrics: { audioMs: 0, computeMs: 0 },
      };
    },
    async unload() {
      log.push("unload");
      state = "absent";
    },
  };
  const finishNext = async () => {
    // Let queued turns reach the engine before finishing the running request.
    for (let i = 0; i < 5 && pending.length === 0; i += 1) await Promise.resolve();
    pending.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { engine, log, finishNext };
}

const request = (id: string): AsrRequest => ({
  id,
  samples: new Int16Array(16),
  sampleRate: 16_000,
  speakers: false,
  timestamps: true,
});

describe("shareEngine", () => {
  it("runs the users' requests one after the other, each seeing the engine ready meanwhile", async () => {
    const { engine, log, finishNext } = oneAtATime();
    const [live, dictation] = shareEngine(engine, 2);
    if (live === undefined || dictation === undefined) throw new Error("two handles");
    await live.load();
    const first = live.transcribe(request("live-1"));
    const second = dictation.transcribe(request("dictation-1"));
    await finishNext();
    expect(dictation.state()).toBe("busy");
    expect(live.state()).toBe("ready");
    await finishNext();
    await Promise.all([first, second]);
    expect(log).toEqual([
      "load",
      "start live-1",
      "end live-1",
      "start dictation-1",
      "end dictation-1",
    ]);
  });

  it("keeps the worker until every user that held it lets go", async () => {
    const { engine, log, finishNext } = oneAtATime();
    const [live, dictation] = shareEngine(engine, 2);
    if (live === undefined || dictation === undefined) throw new Error("two handles");
    await live.load();
    const done = dictation.transcribe(request("d"));
    await finishNext();
    await done;
    await live.unload();
    expect(engine.state()).toBe("ready");
    await dictation.unload();
    expect(engine.state()).toBe("absent");
    expect(log.filter((entry) => entry === "unload")).toHaveLength(1);
  });

  it("gives up a turn whose signal aborted while it waited", async () => {
    const { engine, finishNext } = oneAtATime();
    const [live, dictation] = shareEngine(engine, 2);
    if (live === undefined || dictation === undefined) throw new Error("two handles");
    const running = live.transcribe(request("live"));
    const controller = new AbortController();
    const waiting = dictation.transcribe(request("late"), { signal: controller.signal });
    controller.abort();
    await finishNext();
    await running;
    await expect(waiting).rejects.toMatchObject({ code: "cancelled" });
  });
});
