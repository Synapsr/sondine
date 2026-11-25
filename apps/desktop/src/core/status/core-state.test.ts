import { Deferred, Effect, Layer, SubscriptionRef } from "effect";
import { expect, it } from "vitest";
import { CoreState, coreStateLayer } from "./core-state";

it("publishes from a plain callback while another fiber holds the status", async () => {
  const program = Effect.gen(function* () {
    const state = yield* CoreState;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    // A fiber inside `changes` setup or an update: the ref's lock is taken.
    yield* Effect.forkChild(
      state.status.semaphore.withPermit(
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      ),
    );
    yield* Deferred.await(entered);
    // What the scheduler did: runSync throws here (its update still lands later).
    expect(() =>
      Effect.runSync(state.update((status) => ({ ...status, updatedAtMs: 1 }))),
    ).toThrow();
    expect(() => state.publish((status) => ({ ...status, updatedAtMs: 42 }))).not.toThrow();
    yield* Deferred.succeed(release, undefined);
    yield* Effect.sleep("20 millis");
    return (yield* SubscriptionRef.get(state.status)).updatedAtMs;
  });
  const updatedAtMs = await Effect.runPromise(
    Effect.scoped(program.pipe(Effect.provide(Layer.fresh(coreStateLayer)))),
  );
  expect(updatedAtMs).toBe(42);
});
