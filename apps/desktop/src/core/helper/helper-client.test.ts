import type { HelperEvent } from "@sondine/protocol";
import { Effect, Layer, PubSub, SubscriptionRef } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { startFakeHelper } from "../../../test/fake-helper/fake-helper";
import { tempDataDir, waitUntil } from "../../../test/support";
import { coreConfigLayer } from "../config";
import { HelperClient, helperClientLayer, startupPauseScope } from "./helper-client";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

describe("helper client", () => {
  it("bounds its event backlog when a subscriber falls behind, and drops nothing", async () => {
    const data = tempDataDir();
    cleanups.push(() => data.cleanup());
    const fake = await startFakeHelper({ socketPath: data.socketPath, autoplay: null });
    cleanups.push(() => fake.close());
    const buffer = 16;
    const total = 5_000;

    const program = Effect.gen(function* () {
      const helper = yield* HelperClient;
      const subscription = yield* PubSub.subscribe(helper.events);
      yield* Effect.forkScoped(helper.run);
      yield* Effect.promise(() =>
        waitUntil(
          () => Effect.runSync(SubscriptionRef.get(helper.connection)).state === "connected",
          { label: "connected" },
        ),
      );
      // The session's own events (ready, snapshot) come first; skip them.
      yield* Effect.promise(() => fake.waitFor("snapshot"));
      yield* Effect.sleep("100 millis");
      while (PubSub.sizeUnsafe(helper.events) > 0) yield* PubSub.take(subscription);

      for (let index = 0; index < total; index++) {
        fake.emit({ type: "warning", code: "pcm.overflow", message: `w${index}` });
      }
      // The subscriber takes nothing for a while: the client must stop reading.
      yield* Effect.sleep("300 millis");
      const queued = PubSub.sizeUnsafe(helper.events);
      const backlog = helper.backlog();

      const messages: string[] = [];
      while (messages.length < total) {
        const event: HelperEvent = yield* PubSub.take(subscription);
        if (event.type === "warning") messages.push(event.message);
      }
      return { queued, backlog, messages };
    }).pipe(
      Effect.scoped,
      Effect.provide(
        helperClientLayer({ eventBuffer: buffer, helloTimeoutMs: 1_000 }).pipe(
          Layer.provide(coreConfigLayer(data.config())),
        ),
      ),
    );

    const { queued, backlog, messages } = await Effect.runPromise(program);
    expect(queued).toBeLessThanOrEqual(buffer);
    // The buffer, the high-water mark, and at most one socket read past it.
    expect(backlog).toBeLessThan(total / 5);
    expect(messages).toEqual(Array.from({ length: total }, (_, index) => `w${index}`));
  });

  it("pauses the paused sources of a new helper before its config", async () => {
    const data = tempDataDir();
    cleanups.push(() => data.cleanup());
    const fake = await startFakeHelper({ socketPath: data.socketPath, autoplay: null });
    cleanups.push(() => fake.close());
    const program = Effect.gen(function* () {
      const helper = yield* HelperClient;
      yield* helper.setPausedSources({ microphone: true, systemAudio: false });
      yield* Effect.forkScoped(helper.run);
      yield* Effect.promise(() => fake.waitFor("snapshot"));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        helperClientLayer({ helloTimeoutMs: 1_000 }).pipe(
          Layer.provide(coreConfigLayer(data.config())),
        ),
      ),
    );
    await Effect.runPromise(program);
    expect(fake.received.slice(0, 3)).toMatchObject([
      { type: "hello" },
      { type: "pause", scope: "microphone" },
      { type: "config" },
    ]);
    // The paused microphone never opened.
    expect(fake.micRun()).toBeNull();
  });

  it("pauses only what the helper has not paused yet", () => {
    const none = { microphone: false, systemAudio: false };
    const all = { microphone: true, systemAudio: true };
    expect(startupPauseScope(all, none)).toBe("all");
    expect(startupPauseScope(all, { microphone: true, systemAudio: false })).toBe("system-audio");
    expect(startupPauseScope({ microphone: true, systemAudio: false }, none)).toBe("microphone");
    expect(startupPauseScope(all, all)).toBeNull();
    expect(startupPauseScope(none, all)).toBeNull();
  });
});
