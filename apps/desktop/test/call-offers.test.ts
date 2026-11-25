import type { ListeningStatus } from "@sondine/api";
import type { HelperEvent } from "@sondine/protocol";
import { Effect, Fiber, Stream, SubscriptionRef } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { Api } from "../src/core/api-services";
import { Database } from "../src/core/database";
import { makeCoreRuntime, type CoreLayerOptions, type CoreRuntime } from "../src/core/runtime";
import { CoreState } from "../src/core/status/core-state";
import { fakeSignals } from "./fake-engine";
import { startFakeHelper, type FakeHelper } from "./fake-helper/fake-helper";
import { captureOptions, recordingMain, tempDataDir, waitUntil, type TempDataDir } from "./support";

// A notice when a call starts (ADR 036), through the real core runtime and
// the fake helper: what is offered and when, « Écouter cet appel » and the
// pause coming back when the call ends, « Ne pas écouter cet appel » and
// listening coming back, a newer intent that wins, private zones that keep the
// upper hand, and a restart during the call.

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const MINUTE_MS = 60_000;
const DISCORD = "0f7a2c6e-5b1d-4a3e-8c9f-7d6e5f4a3b2c";
const ZOOM = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

/** Core's wall clock, moved by hand: a pause can be an hour old in a test. */
let offsetMs = 0;
const now = () => Date.now() + offsetMs;

function setup() {
  offsetMs = 0;
  const data = tempDataDir();
  cleanups.push(() => data.cleanup());
  return data;
}

async function helper(data: TempDataDir) {
  const fake = await startFakeHelper({ socketPath: data.socketPath, autoplay: null });
  cleanups.push(() => fake.close());
  fakeNow = fake;
  return fake;
}

function launch(data: TempDataDir, options: CoreLayerOptions = {}) {
  const runtime = makeCoreRuntime(data.config(), recordingMain(), {
    ...captureOptions(data),
    helper: { helloTimeoutMs: 1_000, requestTimeoutMs: 2_000, incompatibleRetryMs: 200 },
    spans: { flushEvery: "1 seconds" },
    listening: { now },
    callOffers: { now, endGraceMs: 100 },
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

const listening = async (runtime: CoreRuntime) => (await status(runtime)).listening;

const until = (
  runtime: CoreRuntime,
  label: string,
  check: (listening: ListeningStatus) => boolean,
) => waitUntil(async () => check(await listening(runtime)), { label, timeoutMs: 3_000 });

const connected = (runtime: CoreRuntime) =>
  waitUntil(async () => (await status(runtime)).helper.connection === "connected", {
    label: "connected",
  });

const callListenRow = (runtime: CoreRuntime) =>
  runtime.runPromise(
    Effect.map(Database, (db) =>
      db.statement("SELECT value FROM settings WHERE key = 'capture.call-listen'").get(),
    ),
  );

let fakeNow: FakeHelper | null = null;
const at = () => fakeNow?.clockNow() ?? { hostTicks: 1_000n, continuousNs: 1_000n };
const seen = (
  callId: string,
  state: "active" | "ended",
  bundleId = "com.hnc.Discord",
  name: string | null = "Discord",
): HelperEvent => ({
  type: "call.seen",
  callId,
  state,
  at: at(),
  bundleId,
  name,
  via: "call-app",
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Paused an hour ago, as far as core can tell. */
async function pausedLongAgo(runtime: CoreRuntime, untilMs?: number) {
  const api = await runtime.runPromise(Api);
  await api.listening.pause(untilMs === undefined ? { scope: "all" } : { scope: "all", untilMs });
  offsetMs += 60 * MINUTE_MS;
  return api;
}

async function started(fake: FakeHelper, data: TempDataDir, options?: CoreLayerOptions) {
  const launched = launch(data, options);
  await connected(launched.runtime);
  // The snapshot has ended once the helper has been asked for it.
  await fake.waitFor("snapshot");
  return launched;
}

describe("call offers", () => {
  it("offers a call during an old pause, listens to it, then pauses again", async () => {
    const data = setup();
    const fake = await helper(data);
    const { runtime } = await started(fake, data);
    const api = await pausedLongAgo(runtime);

    fake.emit(seen(DISCORD, "active"));
    await until(runtime, "offered", (l) => l.callOffer?.callId === DISCORD);
    expect((await listening(runtime)).callOffer).toMatchObject({
      bundleId: "com.hnc.Discord",
      name: "Discord",
    });

    const resumed = await api.callOffers.listen({ callId: DISCORD });
    expect(resumed).toMatchObject({
      desired: "listening",
      callOffer: null,
      forCall: { bundleId: "com.hnc.Discord", name: "Discord" },
    });
    expect(await callListenRow(runtime)).toBeDefined();
    await fake.waitFor("resume");

    // The call drops and comes back within the grace: one call.
    fake.emit(seen(DISCORD, "ended"));
    fake.emit(seen(ZOOM, "active", "com.hnc.Discord"));
    await sleep(300);
    expect((await listening(runtime)).desired).toBe("listening");

    // The pause that comes back never offers the call that is over.
    const offered: string[] = [];
    const watching = runtime.runFork(
      Effect.flatMap(CoreState, (state) =>
        SubscriptionRef.changes(state.status).pipe(
          Stream.runForEach(({ listening: l }) =>
            Effect.sync(() => {
              if (l.callOffer !== null) offered.push(l.callOffer.callId);
            }),
          ),
        ),
      ),
    );
    fake.emit(seen(ZOOM, "ended", "com.hnc.Discord"));
    await until(runtime, "paused again", (l) => l.desired === "paused" && l.forCall === null);
    await until(runtime, "said", (l) => l.callEnded?.restored === "paused");
    await runtime.runPromise(Fiber.interrupt(watching));
    expect(offered).toEqual([]);
    expect(await callListenRow(runtime)).toBeUndefined();
  });

  it("offers nothing for a pause taken just before the call, a muted app, or when off", async () => {
    const data = setup();
    const fake = await helper(data);
    const { runtime } = await started(fake, data);
    const api = await runtime.runPromise(Api);
    await api.listening.pause({ scope: "all" });

    // A pause younger than a minute was meant for this call.
    offsetMs += 30_000;
    fake.emit(seen(DISCORD, "active"));
    await sleep(200);
    expect((await listening(runtime)).callOffer).toBeNull();
    // Its switch is there all the same: only the notice waits for an older pause.
    expect((await listening(runtime)).call).toMatchObject({ callId: DISCORD });
    fake.emit(seen(DISCORD, "ended"));
    await until(runtime, "over", (l) => l.call === null);

    // « Pas pour cette app »: Discord's next call is not offered; Zoom's is.
    offsetMs += 10 * MINUTE_MS;
    fake.emit(seen(ZOOM, "active"));
    await until(runtime, "offered", (l) => l.callOffer?.callId === ZOOM);
    await api.callOffers.decline({ callId: ZOOM, forApp: true });
    expect((await api.callOffers.settings()).mutedApps).toEqual([
      { bundleId: "com.hnc.Discord", name: "Discord" },
    ]);
    expect(await listening(runtime)).toMatchObject({ callOffer: null, call: null });
    fake.emit(seen(ZOOM, "ended"));
    await sleep(200);
    fake.emit(seen(DISCORD, "active", "com.hnc.Discord"));
    await sleep(200);
    expect((await listening(runtime)).callOffer).toBeNull();

    // Offered again once allowed, and not at all when turned off.
    await api.callOffers.allowApp({ bundleId: "com.hnc.Discord" });
    await until(runtime, "offered again", (l) => l.callOffer?.callId === DISCORD);
    await api.callOffers.setEnabled({ enabled: false });
    await until(runtime, "withdrawn", (l) => l.callOffer === null);
    await expect(api.callOffers.listen({ callId: DISCORD })).rejects.toMatchObject({
      code: "not-found",
    });
  });

  it("offers nothing while a private zone holds capture", async () => {
    const data = setup();
    const fake = await helper(data);
    const { runtime } = await started(fake, data);
    await pausedLongAgo(runtime);
    fake.emit({
      type: "holds",
      holds: [
        {
          occurrenceId: "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
          reason: "calls",
          scope: "all",
          since: at(),
          sinceWallMs: Date.now(),
          lifted: false,
        },
      ],
    });
    fake.emit(seen(DISCORD, "active"));
    await sleep(200);
    expect((await listening(runtime)).callOffer).toBeNull();

    // « Écouter quand même » lifted the zone for this call: the pause is offered.
    fake.emit({
      type: "holds",
      holds: [
        {
          occurrenceId: "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
          reason: "calls",
          scope: "all",
          since: at(),
          sinceWallMs: Date.now(),
          lifted: true,
        },
      ],
    });
    await until(runtime, "offered", (l) => l.callOffer?.callId === DISCORD);
  });

  it("never rewrites a pause or resume the user made during the call", async () => {
    const data = setup();
    const fake = await helper(data);
    const { runtime } = await started(fake, data);
    const api = await pausedLongAgo(runtime);

    // Resumed for good during the call: still listening after it.
    fake.emit(seen(DISCORD, "active"));
    await until(runtime, "offered", (l) => l.callOffer !== null);
    await api.callOffers.listen({ callId: DISCORD });
    await api.listening.resume({ scope: "all" });
    expect((await listening(runtime)).forCall).toBeNull();
    fake.emit(seen(DISCORD, "ended"));
    await sleep(300);
    expect((await listening(runtime)).desired).toBe("listening");

    // Paused for an hour during the call: that pause stays, with its end.
    await api.listening.pause({ scope: "all" });
    offsetMs += 60 * MINUTE_MS;
    fake.emit(seen(ZOOM, "active"));
    await until(runtime, "offered", (l) => l.callOffer?.callId === ZOOM);
    await api.callOffers.listen({ callId: ZOOM });
    const untilMs = now() + 60 * MINUTE_MS;
    await api.listening.pause({ scope: "microphone", untilMs });
    fake.emit(seen(ZOOM, "ended"));
    await sleep(300);
    expect(await listening(runtime)).toMatchObject({ pausedUntilMs: untilMs, forCall: null });
  });

  it("does not bring back a timed pause whose end passed during the call", async () => {
    const data = setup();
    const fake = await helper(data);
    const { runtime } = await started(fake, data);
    const api = await runtime.runPromise(Api);
    await api.listening.pause({ scope: "all", untilMs: now() + 2 * 60 * MINUTE_MS });
    offsetMs += 60 * MINUTE_MS;
    fake.emit(seen(DISCORD, "active"));
    await until(runtime, "offered", (l) => l.callOffer !== null);
    await api.callOffers.listen({ callId: DISCORD });
    offsetMs += 2 * 60 * MINUTE_MS;
    fake.emit(seen(DISCORD, "ended"));
    await until(runtime, "call over", (l) => l.forCall === null);
    expect((await listening(runtime)).desired).toBe("listening");
  });

  it("keeps listening across a restart while the call goes on, and pauses once it is gone", async () => {
    const data = setup();
    const fake = await helper(data);
    const first = await started(fake, data);
    const api = await pausedLongAgo(first.runtime);
    fake.emit(seen(DISCORD, "active"));
    await until(first.runtime, "offered", (l) => l.callOffer !== null);
    await api.callOffers.listen({ callId: DISCORD });
    await first.stop();

    // The call goes on: the snapshot replays it, listening stays.
    const second = await started(fake, data);
    await until(second.runtime, "listening for the call", (l) => l.forCall !== null);
    await sleep(300);
    expect((await listening(second.runtime)).desired).toBe("listening");
    await second.stop();

    // The call ended while Sondine was off: the next snapshot lacks it.
    fake.emit(seen(DISCORD, "ended"));
    const third = await started(fake, data);
    await until(third.runtime, "paused again", (l) => l.desired === "paused" && l.forCall === null);
  });

  it("withdraws the offer when the user pauses again during the call", async () => {
    const data = setup();
    const fake = await helper(data);
    const { runtime } = await started(fake, data);
    const api = await pausedLongAgo(runtime);
    fake.emit(seen(DISCORD, "active"));
    await until(runtime, "offered", (l) => l.callOffer?.callId === DISCORD);
    // « Pause 1 h » while the call goes on: that pause is meant for it.
    await api.listening.pause({ scope: "all", untilMs: now() + 60 * MINUTE_MS });
    await until(runtime, "withdrawn", (l) => l.callOffer === null);
    // Its switch stays: the user may still listen to this call.
    expect(await api.callOffers.listen({ callId: DISCORD })).toMatchObject({
      desired: "listening",
      forCall: { kind: "listen" },
    });
  });

  it("brings back each part of a mixed pause with its own end", async () => {
    const data = setup();
    const fake = await helper(data);
    const { runtime } = await started(fake, data);
    const api = await runtime.runPromise(Api);
    await api.listening.pause({ scope: "microphone" });
    const untilMs = now() + 2 * 60 * MINUTE_MS;
    await api.listening.pause({ scope: "system-audio", untilMs });
    offsetMs += 60 * MINUTE_MS;

    // Ends before the system audio's deadline: both come back, the deadline on system audio.
    fake.emit(seen(DISCORD, "active"));
    await until(runtime, "offered", (l) => l.callOffer?.callId === DISCORD);
    await api.callOffers.listen({ callId: DISCORD });
    fake.emit(seen(DISCORD, "ended"));
    await until(runtime, "paused again", (l) => l.desired === "paused" && l.forCall === null);
    expect((await listening(runtime)).pausedUntilMs).toBe(untilMs);

    // The pause came back as old as it was: a call right after is offered.
    // Ends after it: the microphone's open-ended pause alone comes back.
    fake.emit(seen(ZOOM, "active"));
    await until(runtime, "offered", (l) => l.callOffer?.callId === ZOOM);
    await api.callOffers.listen({ callId: ZOOM });
    offsetMs += 2 * 60 * MINUTE_MS;
    fake.emit(seen(ZOOM, "ended"));
    await until(runtime, "call over", (l) => l.forCall === null);
    await waitUntil(async () => fake.received.filter((m) => m.type === "pause").length >= 4, {
      label: "microphone paused again",
    });
    const last = fake.received.findLast((m) => m.type === "pause");
    expect(last).toMatchObject({ scope: "microphone" });
    expect((await listening(runtime)).pausedUntilMs).toBeNull();
  });

  it("says a call while listening, pauses for it, then listens again", async () => {
    const data = setup();
    const fake = await helper(data);
    const { runtime } = await started(fake, data);
    const api = await runtime.runPromise(Api);

    fake.emit(seen(DISCORD, "active"));
    await until(runtime, "notified", (l) => l.callOffer?.callId === DISCORD);
    expect((await listening(runtime)).callOffer).toMatchObject({ kind: "skip", name: "Discord" });
    await expect(api.callOffers.listen({ callId: DISCORD })).rejects.toMatchObject({
      code: "not-found",
    });

    const paused = await api.callOffers.skip({ callId: DISCORD });
    expect(paused).toMatchObject({
      desired: "paused",
      callOffer: null,
      forCall: { kind: "skip", bundleId: "com.hnc.Discord", name: "Discord" },
    });
    expect(await callListenRow(runtime)).toBeDefined();
    await fake.waitFor("pause");

    // The call drops and comes back within the grace: still paused, nothing offered.
    fake.emit(seen(DISCORD, "ended"));
    fake.emit(seen(ZOOM, "active", "com.hnc.Discord"));
    await sleep(300);
    expect(await listening(runtime)).toMatchObject({ desired: "paused", callOffer: null });

    fake.emit(seen(ZOOM, "ended", "com.hnc.Discord"));
    await until(runtime, "listening again", (l) => l.desired === "listening" && l.forCall === null);
    expect(await callListenRow(runtime)).toBeUndefined();
    await waitUntil(async () => fake.received.findLast((m) => m.type === "resume") !== undefined, {
      label: "resumed",
    });
    expect(fake.received.findLast((m) => m.type === "resume")).toMatchObject({ scope: "all" });
  });

  it("tries the resume again when the helper refuses it at the call's end", async () => {
    const data = setup();
    const fake = await helper(data);
    const { runtime } = await started(fake, data, { listening: { now, checkIntervalMs: 100 } });
    const api = await runtime.runPromise(Api);
    fake.emit(seen(DISCORD, "active"));
    await until(runtime, "notified", (l) => l.callOffer?.kind === "skip");
    await api.callOffers.skip({ callId: DISCORD });
    await fake.waitFor("pause");

    fake.rejectNext("resume", "internal");
    fake.emit(seen(DISCORD, "ended"));
    await waitUntil(async () => fake.received.filter((m) => m.type === "resume").length >= 2, {
      label: "resumed again",
      timeoutMs: 3_000,
    });
    await until(
      runtime,
      "listening",
      (l) => l.desired === "listening" && l.effective === "listening",
    );
  });

  it("keeps the user's own choice over a call they skipped", async () => {
    const data = setup();
    const fake = await helper(data);
    const { runtime } = await started(fake, data);
    const api = await runtime.runPromise(Api);

    // Resumed by hand during the call: listening, and nothing changes at its end.
    fake.emit(seen(DISCORD, "active"));
    await until(runtime, "notified", (l) => l.callOffer?.kind === "skip");
    await api.callOffers.skip({ callId: DISCORD });
    await api.listening.resume({ scope: "all" });
    expect(await listening(runtime)).toMatchObject({ desired: "listening", forCall: null });
    expect(await callListenRow(runtime)).toBeUndefined();
    fake.emit(seen(DISCORD, "ended"));
    await sleep(300);
    expect((await listening(runtime)).desired).toBe("listening");

    // Paused for an hour by hand during the call: that pause stays, with its end.
    fake.emit(seen(ZOOM, "active"));
    await until(runtime, "notified", (l) => l.callOffer?.callId === ZOOM);
    await api.callOffers.skip({ callId: ZOOM });
    const untilMs = now() + 60 * MINUTE_MS;
    await api.listening.pause({ scope: "all", untilMs });
    fake.emit(seen(ZOOM, "ended"));
    await sleep(300);
    expect(await listening(runtime)).toMatchObject({
      desired: "paused",
      pausedUntilMs: untilMs,
      forCall: null,
    });
  });

  it("listens again after a restart once the skipped call is gone", async () => {
    const data = setup();
    const fake = await helper(data);
    const first = await started(fake, data);
    const api = await first.runtime.runPromise(Api);
    fake.emit(seen(DISCORD, "active"));
    await until(first.runtime, "notified", (l) => l.callOffer?.kind === "skip");
    await api.callOffers.skip({ callId: DISCORD });
    await first.stop();

    // The call goes on: still paused for it.
    const second = await started(fake, data);
    await until(second.runtime, "paused for the call", (l) => l.forCall?.kind === "skip");
    await sleep(300);
    expect((await listening(second.runtime)).desired).toBe("paused");
    await second.stop();

    // The call ended while Sondine was off: listening comes back.
    fake.emit(seen(DISCORD, "ended"));
    const third = await started(fake, data);
    await until(
      third.runtime,
      "listening again",
      (l) => l.desired === "listening" && l.forCall === null,
    );
  });

  it("says nothing while listening under a private zone or for a muted app", async () => {
    const data = setup();
    const fake = await helper(data);
    const { runtime } = await started(fake, data);
    const api = await runtime.runPromise(Api);
    const hold = (lifted: boolean): HelperEvent => ({
      type: "holds",
      holds: [
        {
          occurrenceId: "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
          reason: "calls",
          scope: "all",
          since: at(),
          sinceWallMs: Date.now(),
          lifted,
        },
      ],
    });
    fake.emit(hold(false));
    fake.emit(seen(DISCORD, "active"));
    await sleep(200);
    expect((await listening(runtime)).callOffer).toBeNull();

    // The zone lifted: the call is said; « Pas pour Discord » mutes both kinds.
    fake.emit(hold(true));
    await until(runtime, "notified", (l) => l.callOffer?.kind === "skip");
    await api.callOffers.decline({ callId: DISCORD, forApp: true });
    expect((await listening(runtime)).callOffer).toBeNull();
    fake.emit(seen(DISCORD, "ended"));
    await api.listening.pause({ scope: "all" });
    offsetMs += 60 * MINUTE_MS;
    fake.emit(seen(ZOOM, "active", "com.hnc.Discord"));
    await sleep(200);
    expect((await listening(runtime)).callOffer).toBeNull();
  });

  it("keeps one call through the moments its app drops the microphone", async () => {
    const data = setup();
    const fake = await helper(data);
    const { runtime } = await started(fake, data);
    const offers = new Set<string>();
    const gone: boolean[] = [];
    fake.emit(seen(DISCORD, "active"));
    await until(runtime, "notified", (l) => l.callOffer?.callId === DISCORD);
    for (const id of [ZOOM, "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e"]) {
      fake.emit(seen(id === ZOOM ? DISCORD : ZOOM, "ended"));
      fake.emit(seen(id, "active", "com.hnc.Discord"));
      await sleep(60);
      const { callOffer, call } = await listening(runtime);
      offers.add(callOffer?.callId ?? "none");
      gone.push(call === null);
    }
    expect([...offers]).toEqual([DISCORD]);
    expect(gone).toEqual([false, false]);

    // Away for longer than the grace, it is another call.
    fake.emit(seen("2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e", "ended"));
    await until(runtime, "over", (l) => l.call === null && l.callOffer === null);
    fake.emit(seen(ZOOM, "active", "com.hnc.Discord"));
    await until(runtime, "another call", (l) => l.callOffer?.callId === ZOOM);
  });

  it("takes either answer back while the call goes on", async () => {
    const data = setup();
    const fake = await helper(data);
    const { runtime } = await started(fake, data);
    const api = await runtime.runPromise(Api);

    // Listening: not this call, then this call after all.
    fake.emit(seen(DISCORD, "active"));
    await until(runtime, "going on", (l) => l.call?.callId === DISCORD);
    await api.callOffers.skip({ callId: DISCORD });
    expect(await listening(runtime)).toMatchObject({
      desired: "paused",
      call: { callId: DISCORD },
      forCall: { kind: "skip" },
    });
    expect(await api.callOffers.listen({ callId: DISCORD })).toMatchObject({
      desired: "listening",
      forCall: null,
    });
    expect(await callListenRow(runtime)).toBeUndefined();
    await until(runtime, "listening", (l) => l.effective === "listening");

    // During an hour's pause: this call, then not after all. The pause is the one before.
    const untilMs = now() + 60 * MINUTE_MS;
    await api.listening.pause({ scope: "all", untilMs });
    await api.callOffers.listen({ callId: DISCORD });
    expect(await listening(runtime)).toMatchObject({ desired: "listening", pausedUntilMs: null });
    expect(await api.callOffers.skip({ callId: DISCORD })).toMatchObject({
      desired: "paused",
      pausedUntilMs: untilMs,
      forCall: null,
    });

    // The pause it would bring back is over: the call is skipped all the same.
    await api.callOffers.listen({ callId: DISCORD });
    offsetMs += 2 * 60 * MINUTE_MS;
    expect(await api.callOffers.skip({ callId: DISCORD })).toMatchObject({
      desired: "paused",
      forCall: { kind: "skip" },
    });
    fake.emit(seen(DISCORD, "ended"));
    await until(runtime, "listening again", (l) => l.desired === "listening" && l.forCall === null);
  });

  it("never pauses over a resume that comes while an answer is taken back", async () => {
    const data = setup();
    const fake = await helper(data);
    const { runtime } = await started(fake, data);
    const api = await runtime.runPromise(Api);
    await api.listening.pause({ scope: "microphone" });
    offsetMs += 60 * MINUTE_MS;
    fake.emit(seen(DISCORD, "active"));
    await until(runtime, "going on", (l) => l.call?.callId === DISCORD);
    await api.callOffers.listen({ callId: DISCORD });
    const skipping = api.callOffers.skip({ callId: DISCORD });
    await waitUntil(() => fake.received.findLast((m) => m.type === "pause")?.scope !== undefined, {
      label: "pausing again",
    });
    await Promise.all([skipping, api.listening.resume({ scope: "all" })]);
    await until(runtime, "listening", (l) => l.effective === "listening");
    expect(await listening(runtime)).toMatchObject({ desired: "listening", forCall: null });
  });

  it("says nothing came back while the helper refuses it", async () => {
    const data = setup();
    const fake = await helper(data);
    const { runtime } = await started(fake, data, { listening: { now, checkIntervalMs: 60_000 } });
    const api = await runtime.runPromise(Api);
    fake.emit(seen(DISCORD, "active"));
    await until(runtime, "going on", (l) => l.call?.callId === DISCORD);
    await api.callOffers.skip({ callId: DISCORD });
    fake.rejectNext("resume", "internal");
    fake.emit(seen(DISCORD, "ended"));
    await until(runtime, "over", (l) => l.call === null && l.forCall === null);
    await sleep(100);
    expect(await listening(runtime)).toMatchObject({ effective: "paused", callEnded: null });
  });

  it("says the pause that came back after a restart, with no call seen", async () => {
    const data = setup();
    const fake = await helper(data);
    const first = await started(fake, data);
    const api = await pausedLongAgo(first.runtime);
    fake.emit(seen(DISCORD, "active"));
    await until(first.runtime, "going on", (l) => l.call !== null);
    await api.callOffers.listen({ callId: DISCORD });
    await first.stop();
    fake.emit(seen(DISCORD, "ended"));
    const second = await started(fake, data);
    await until(second.runtime, "ended", (l) => l.callEnded !== null);
    expect((await listening(second.runtime)).callEnded).toMatchObject({
      name: "Discord",
      restored: "paused",
    });
  });

  it("pauses the rest for a call during a partial pause, and brings only the rest back", async () => {
    const data = setup();
    const fake = await helper(data);
    const { runtime } = await started(fake, data);
    const api = await runtime.runPromise(Api);
    await api.listening.pause({ scope: "microphone" });
    fake.emit(seen(DISCORD, "active"));
    await until(runtime, "going on", (l) => l.call?.callId === DISCORD);
    expect(await api.callOffers.skip({ callId: DISCORD })).toMatchObject({
      desired: "paused",
      forCall: { kind: "skip" },
    });
    fake.emit(seen(DISCORD, "ended"));
    await until(runtime, "system audio back", (l) => l.systemAudioPaused === false);
    expect(await listening(runtime)).toMatchObject({ microphonePaused: true, forCall: null });
    expect(fake.received.findLast((m) => m.type === "resume")).toMatchObject({
      scope: "system-audio",
    });
  });

  it("says the intent that came back with the call's end, until the next call", async () => {
    const data = setup();
    const fake = await helper(data);
    const { runtime } = await started(fake, data);
    const api = await runtime.runPromise(Api);
    fake.emit(seen(DISCORD, "active"));
    await until(runtime, "going on", (l) => l.call?.callId === DISCORD);
    await api.callOffers.skip({ callId: DISCORD });
    fake.emit(seen(DISCORD, "ended"));
    await until(runtime, "ended", (l) => l.callEnded !== null);
    expect(await listening(runtime)).toMatchObject({
      call: null,
      callEnded: { callId: DISCORD, name: "Discord", recording: null, restored: "listening" },
    });

    // Nothing recorded and nothing to bring back: nothing to say.
    fake.emit(seen(ZOOM, "active", "us.zoom.xos", "Zoom"));
    await until(runtime, "going on", (l) => l.call?.callId === ZOOM && l.callEnded === null);
    fake.emit(seen(ZOOM, "ended", "us.zoom.xos", "Zoom"));
    await until(runtime, "over", (l) => l.call === null);
    await sleep(200);
    expect((await listening(runtime)).callEnded).toBeNull();
  });

  it("keeps the call through a reconnection, and ends it when it is gone", async () => {
    const data = setup();
    const fake = await helper(data);
    const { runtime } = await started(fake, data);
    fake.emit(seen(DISCORD, "active"));
    await until(runtime, "going on", (l) => l.call?.callId === DISCORD);
    fake.dropConnections();
    await waitUntil(async () => (await status(runtime)).helper.connection !== "connected", {
      label: "away",
    });
    await connected(runtime);
    await until(runtime, "still going on", (l) => l.call?.callId === DISCORD);
    fake.emit(seen(DISCORD, "ended"));
    await until(runtime, "over", (l) => l.call === null);
  });
});

describe("a forgotten pause", () => {
  const HOUR_MS = 60 * MINUTE_MS;
  async function paused(untilIn?: number) {
    const data = setup();
    const fake = await helper(data);
    const signals = fakeSignals({ idleSeconds: 900, locked: true });
    const options: CoreLayerOptions = {
      pauseReminder: { now, checkIntervalMs: 20 },
      analysis: { signals: signals.layer },
    };
    const launched = await started(fake, data, options);
    const api = await launched.runtime.runPromise(Api);
    await api.listening.pause(
      untilIn === undefined ? { scope: "all" } : { scope: "all", untilMs: now() + untilIn },
    );
    /** The clock moved by hand: the reminder looks when the intent or power changes. */
    const later = async (ms: number) => {
      offsetMs += ms;
      await launched.runtime.runPromise(
        Effect.flatMap(CoreState, (state) =>
          state.update((s) => ({ ...s, power: { ...s.power, suspended: true } })),
        ),
      );
      await launched.runtime.runPromise(
        Effect.flatMap(CoreState, (state) =>
          state.update((s) => ({ ...s, power: { ...s.power, suspended: false } })),
        ),
      );
    };
    return { data, fake, api, options, later, signals, ...launched };
  }

  it("is said once someone is there, once per pause, and goes when it ends", async () => {
    const { runtime, later, stop, fake, data, options, signals } = await paused();
    await later(2 * HOUR_MS);
    await sleep(100);
    expect((await listening(runtime)).pauseReminder).toBeNull();
    await later(2 * HOUR_MS);
    await sleep(100);
    expect((await listening(runtime)).pauseReminder).toBeNull();
    signals.set({ idleSeconds: 5, locked: false });
    await until(runtime, "said", (l) => l.pauseReminder !== null);

    // A restart never says it again.
    await stop();
    const again = await started(fake, data, options);
    await sleep(200);
    expect((await listening(again.runtime)).pauseReminder).toBeNull();
  });

  it("goes as soon as the pause does", async () => {
    const { runtime, api, later, signals } = await paused();
    signals.set({ idleSeconds: 5, locked: false });
    await later(4 * HOUR_MS);
    await until(runtime, "said", (l) => l.pauseReminder !== null);
    await api.listening.resume({ scope: "all" });
    await until(runtime, "gone", (l) => l.pauseReminder === null);
  });

  it("is never said of a pause the helper refused", async () => {
    const { runtime, fake, api, later, signals } = await paused();
    await api.listening.resume({ scope: "all" });
    fake.rejectNext("pause", "internal");
    await expect(api.listening.pause({ scope: "all" })).rejects.toBeDefined();
    expect(await listening(runtime)).toMatchObject({ desired: "paused", effective: "listening" });
    signals.set({ idleSeconds: 5, locked: false });
    await later(4 * HOUR_MS);
    await sleep(100);
    expect((await listening(runtime)).pauseReminder).toBeNull();
  });

  it("is never said of a pause with an end", async () => {
    const { runtime, later, signals } = await paused(10 * HOUR_MS);
    signals.set({ idleSeconds: 5, locked: false });
    await later(4 * HOUR_MS);
    await sleep(100);
    expect((await listening(runtime)).pauseReminder).toBeNull();
  });
});
