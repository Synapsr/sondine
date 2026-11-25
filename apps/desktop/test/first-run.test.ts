import { openDatabase } from "@sondine/db";
import { Effect, SubscriptionRef } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { Api } from "../src/core/api-services";
import { Database } from "../src/core/database";
import { makeCoreRuntime, type CoreLayerOptions, type CoreRuntime } from "../src/core/runtime";
import { CoreState } from "../src/core/status/core-state";
import { startFakeHelper, type FakeHelper } from "./fake-helper/fake-helper";
import { migrationsDir, recordingMain, tempDataDir, waitUntil, type TempDataDir } from "./support";

// The first run through the real core runtime and the fake helper: a fresh
// install records nothing until the user starts listening, the step survives
// a relaunch, and an install that already captured never sees it.

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

/** One launch of core; `stop` is a quit. */
function launch(data: TempDataDir, options: CoreLayerOptions = {}) {
  const runtime = makeCoreRuntime(data.config(), recordingMain(), {
    helper: { helloTimeoutMs: 1_000, requestTimeoutMs: 2_000, incompatibleRetryMs: 200 },
    spans: { flushEvery: "1 seconds" },
    models: { homeDir: data.dir },
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

const scalar = async (runtime: CoreRuntime, sql: string) => {
  const [row] = await runtime.runPromise(Effect.map(Database, (db) => db.statement(sql).all()));
  return row === undefined ? undefined : Object.values(row)[0];
};

const snapshots = (fake: FakeHelper) => fake.received.filter((m) => m.type === "snapshot").length;

describe("first run", () => {
  it("keeps a fresh install paused, pausing a new helper before its config", async () => {
    const data = setup();
    const fake = await helper(data);
    const first = launch(data);
    const api = await first.runtime.runPromise(Api);
    await waitUntil(() => snapshots(fake) >= 1, { label: "snapshot" });
    // Paused before `config`, which lets the helper open its sources.
    const types = fake.received.map((message) => message.type);
    expect(types.slice(0, 2)).toEqual(["hello", "pause"]);
    expect(types.indexOf("pause")).toBeLessThan(types.indexOf("config"));
    expect(fake.received[1]).toMatchObject({ type: "pause", scope: "all" });
    await waitUntil(async () => (await status(first.runtime)).listening.effective === "paused", {
      label: "confirmed pause",
    });
    expect(fake.micRun()).toBeNull();
    expect(await scalar(first.runtime, "SELECT count(*) FROM track_runs")).toBe(0);
    expect(await api.onboarding.get()).toEqual({
      completed: false,
      completedAtMs: null,
      origin: "first-run",
      step: "welcome",
      goal: null,
      cloudNotify: false,
    });
    expect(await api.onboarding.advance({ step: "permissions", goal: "meetings" })).toMatchObject({
      step: "permissions",
      goal: "meetings",
    });

    // Granting the microphone relaunched the app: the same step, still paused.
    await first.stop();
    const second = launch(data);
    const again = await second.runtime.runPromise(Api);
    await waitUntil(() => snapshots(fake) >= 2, { label: "second snapshot" });
    // The goal survives the relaunch; « Me prévenir » is kept the same way.
    expect(await again.onboarding.get()).toMatchObject({
      completed: false,
      step: "permissions",
      goal: "meetings",
    });
    expect((await again.onboarding.advance({ step: "model", cloudNotify: true })).cloudNotify).toBe(
      true,
    );
    expect((await status(second.runtime)).listening.desired).toBe("paused");
    expect(fake.micRun()).toBeNull();

    const done = await again.onboarding.complete({ startListening: true });
    expect(done.onboarding).toMatchObject({ completed: true, origin: "first-run", step: "start" });
    expect(done.listening).toMatchObject({ desired: "listening", effective: "listening" });
    expect(fake.micRun()).not.toBeNull();
    // Once only: a second call and a late step change nothing.
    const later = await again.onboarding.complete({ startListening: true });
    expect(later.onboarding.completedAtMs).toBe(done.onboarding.completedAtMs);
    expect((await again.onboarding.advance({ step: "model" })).step).toBe("start");
    // The goal may still change once the first run is done (Settings).
    expect((await again.onboarding.advance({ step: "model", goal: "day" })).goal).toBe("day");

    await second.stop();
    const third = launch(data);
    const last = await third.runtime.runPromise(Api);
    expect(await last.onboarding.get()).toMatchObject({ completed: true, origin: "first-run" });
    expect((await status(third.runtime)).listening.desired).toBe("listening");
  });

  it("counts an install that already captured as onboarded and leaves its listening alone", async () => {
    const data = setup();
    const fake = await helper(data);
    // Capture before the first run existed: one track run, no onboarding setting.
    const before = launch(data, { onboarding: { skipFirstRun: true } });
    await waitUntil(
      async () => (await scalar(before.runtime, "SELECT count(*) FROM track_runs")) === 1,
      { label: "mic run imported" },
    );
    await before.stop();
    const db = openDatabase(data.config().databasePath, { migrationsFolder: migrationsDir });
    db.statement("DELETE FROM settings WHERE key = 'onboarding'").run();
    db.close();

    const pausesBefore = fake.received.filter((message) => message.type === "pause").length;
    const after = launch(data);
    const api = await after.runtime.runPromise(Api);
    await waitUntil(() => snapshots(fake) >= 2, { label: "second snapshot" });
    expect(await api.onboarding.get()).toMatchObject({
      completed: true,
      origin: "existing-install",
    });
    expect((await status(after.runtime)).listening.desired).toBe("listening");
    expect(fake.received.filter((message) => message.type === "pause")).toHaveLength(pausesBefore);
  });
});
