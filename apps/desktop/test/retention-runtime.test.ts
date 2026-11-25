import { existsSync } from "node:fs";
import { Effect, SubscriptionRef } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { Database } from "../src/core/database";
import { makeCoreRuntime } from "../src/core/runtime";
import { CoreState } from "../src/core/status/core-state";
import { startFakeHelper } from "./fake-helper/fake-helper";
import { RATE, SpoolFixture } from "./spool-fixture";
import { captureOptions, recordingMain, tempDataDir, waitUntil } from "./support";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

describe("spool retention in the core runtime", () => {
  it("runs after the first reconciliation and reports what the spool and archive hold", async () => {
    const data = tempDataDir();
    cleanups.push(() => data.cleanup());
    const runtime = makeCoreRuntime(data.config(), recordingMain(), {
      ...captureOptions(data),
      helper: { helloTimeoutMs: 1_000, requestTimeoutMs: 2_000, incompatibleRetryMs: 200 },
      spans: { flushEvery: "1 seconds" },
    });
    cleanups.push(() => runtime.dispose());

    // A run that ended three days ago: its spool file is past retention.
    const db = await runtime.runPromise(Database);
    const run = new SpoolFixture(db, data.dir).run({
      startedWallMs: Date.now() - 3 * 24 * 60 * 60 * 1_000,
    });
    const file = run.file("B".repeat(40));
    run.region(2 * RATE, 3 * RATE);
    run.close();
    expect(existsSync(file.pcm)).toBe(true);

    const fake = await startFakeHelper({ socketPath: data.socketPath, autoplay: null });
    cleanups.push(() => fake.close());
    const status = () =>
      runtime.runPromise(Effect.flatMap(CoreState, (state) => SubscriptionRef.get(state.status)));
    const retention = await waitUntil(
      async () => {
        const current = (await status()).retention;
        return current.archivedBytes > 0 && current;
      },
      { label: "a retention pass" },
    );
    expect(retention).toEqual({
      spoolBytes: 0,
      archivedBytes: retention.archivedBytes,
      blocked: 0,
      lastProblem: null,
    });
    expect(existsSync(file.pcm)).toBe(false);
  });
});
