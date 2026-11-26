import { ServiceFailure } from "@sondine/api";
import { Effect, SubscriptionRef } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { Api } from "../src/core/api-services";
import { Database } from "../src/core/database";
import { makeCoreRuntime, type CoreLayerOptions, type CoreRuntime } from "../src/core/runtime";
import { CoreState } from "../src/core/status/core-state";
import { startFakeHelper, type FakeHelper } from "./fake-helper/fake-helper";
import { captureOptions, recordingMain, tempDataDir, waitUntil, type TempDataDir } from "./support";

// Timed pauses through the real core runtime and the fake helper: the
// deadline is stored, ends the pause on time, survives a restart and a
// sleep, and a newer pause or resume replaces it.

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

function setup() {
  const data = tempDataDir();
  cleanups.push(() => data.cleanup());
  return data;
}

async function helper(data: TempDataDir) {
  const fake = await startFakeHelper({ socketPath: data.socketPath, autoplay: null });
  cleanups.push(() => fake.close());
  return fake;
}

function launch(data: TempDataDir, options: CoreLayerOptions = {}) {
  const runtime = makeCoreRuntime(data.config(), recordingMain(), {
    ...captureOptions(data),
    helper: { helloTimeoutMs: 1_000, requestTimeoutMs: 2_000, incompatibleRetryMs: 200 },
    spans: { flushEvery: "1 seconds" },
    ...options,
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await runtime.dispose();
  };
  cleanups.push(stop);
  return { runtime, stop };
}

const status = (runtime: CoreRuntime) =>
  runtime.runPromise(Effect.flatMap(CoreState, (state) => SubscriptionRef.get(state.status)));

const deadlineRow = (runtime: CoreRuntime) =>
  runtime.runPromise(
    Effect.map(Database, (db) =>
      db.statement("SELECT value FROM settings WHERE key = 'capture.pause-deadline'").get(),
    ),
  );

const resumes = (fake: FakeHelper) => fake.received.filter((m) => m.type === "resume").length;

/** Core's state changes first; its `resume` reaches the helper over the socket just after. */
const resumesReach = (fake: FakeHelper, count: number) =>
  waitUntil(() => resumes(fake) >= count, { label: `${count} resume(s) sent` });

const connected = (runtime: CoreRuntime, fake: FakeHelper) =>
  waitUntil(
    async () => (await status(runtime)).helper.connection === "connected" && fake.micRun() !== null,
    { label: "connected with the mic open" },
  );

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("timed pause", () => {
  it("resumes on its own at the deadline", async () => {
    const data = setup();
    const fake = await helper(data);
    const { runtime } = launch(data);
    await connected(runtime, fake);
    const api = await runtime.runPromise(Api);
    const untilMs = Date.now() + 300;
    const paused = await api.listening.pause({ scope: "all", untilMs });
    expect(paused).toMatchObject({
      desired: "paused",
      effective: "paused",
      pausedUntilMs: untilMs,
    });
    expect(await deadlineRow(runtime)).toBeDefined();
    await waitUntil(async () => (await status(runtime)).listening.desired === "listening", {
      label: "resumed",
      timeoutMs: 3_000,
    });
    expect(Date.now()).toBeGreaterThanOrEqual(untilMs);
    expect((await status(runtime)).listening.pausedUntilMs).toBeNull();
    await resumesReach(fake, 1);
    expect(resumes(fake)).toBe(1);
    expect(fake.micRun()).not.toBeNull();
    expect(await deadlineRow(runtime)).toBeUndefined();
  });

  it("lets a newer pause or resume replace an older deadline", async () => {
    const data = setup();
    const fake = await helper(data);
    const { runtime } = launch(data);
    await connected(runtime, fake);
    const api = await runtime.runPromise(Api);

    await api.listening.pause({ scope: "all", untilMs: Date.now() + 200 });
    const open = await api.listening.pause({ scope: "all" });
    expect(open.pausedUntilMs).toBeNull();
    await sleep(400);
    expect((await status(runtime)).listening.desired).toBe("paused");
    expect(resumes(fake)).toBe(0);

    await api.listening.resume({ scope: "all" });
    await api.listening.pause({ scope: "all", untilMs: Date.now() + 200 });
    await api.listening.resume({ scope: "all" });
    const later = Date.now() + 10_000;
    await api.listening.pause({ scope: "all", untilMs: later });
    await resumesReach(fake, 2);
    await sleep(400);
    expect((await status(runtime)).listening).toMatchObject({
      desired: "paused",
      pausedUntilMs: later,
    });
    expect(resumes(fake)).toBe(2);
  });

  it("refuses a deadline that has passed", async () => {
    const data = setup();
    const { runtime } = launch(data);
    const api = await runtime.runPromise(Api);
    await expect(
      api.listening.pause({ scope: "all", untilMs: Date.now() - 1 }),
    ).rejects.toBeInstanceOf(ServiceFailure);
    await expect(
      api.listening.pause({ scope: "all", untilMs: Date.now() - 1 }),
    ).rejects.toMatchObject({
      code: "invalid-input",
    });
    expect((await status(runtime)).listening.desired).toBe("listening");
  });

  it("keeps the deadline across a restart, and resumes at launch once it has passed", async () => {
    const data = setup();
    const fake = await helper(data);
    const first = launch(data);
    await connected(first.runtime, fake);
    const untilMs = Date.now() + 60_000;
    await (await first.runtime.runPromise(Api)).listening.pause({ scope: "all", untilMs });
    await first.stop();

    // Back before the deadline: still paused, the same deadline.
    const second = launch(data);
    expect((await status(second.runtime)).listening).toMatchObject({
      desired: "paused",
      pausedUntilMs: untilMs,
    });
    await second.stop();

    // Back after it: listening again at once.
    const third = launch(data, { listening: { now: () => Date.now() + 120_000 } });
    await waitUntil(async () => (await status(third.runtime)).listening.desired === "listening", {
      label: "resumed at launch",
    });
    expect(await deadlineRow(third.runtime)).toBeUndefined();
  });

  it("resumes as soon as the Mac wakes past the deadline", async () => {
    const data = setup();
    const fake = await helper(data);
    let offsetMs = 0;
    const { runtime } = launch(data, {
      // Timers stand still during sleep; the hourly check would come too late.
      listening: { now: () => Date.now() + offsetMs, checkIntervalMs: 3_600_000 },
    });
    await connected(runtime, fake);
    const api = await runtime.runPromise(Api);
    await api.listening.pause({ scope: "all", untilMs: Date.now() + 15 * 60_000 });

    const power = (suspended: boolean) =>
      runtime.runPromise(
        Effect.flatMap(CoreState, (state) =>
          state.update((current, nowMs) => ({
            ...current,
            power: { ...current.power, suspended },
            updatedAtMs: nowMs,
          })),
        ),
      );
    await power(true);
    offsetMs = 2 * 3_600_000;
    await power(false);
    await waitUntil(async () => (await status(runtime)).listening.desired === "listening", {
      label: "resumed at wake",
      timeoutMs: 1_000,
    });
    await resumesReach(fake, 1);
    expect(resumes(fake)).toBe(1);
  });
});
