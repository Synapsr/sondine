import type { Status } from "@sondine/api";
import { describe, expect, it } from "vitest";
import { waitUntil } from "../../test/support";
import { createCoreStatusTracker } from "./core-status";

const status = (desired: Status["listening"]["desired"]): Status => ({
  listening: {
    desired,
    effective: "listening",
    microphonePaused: false,
    systemAudioPaused: false,
    changedAtMs: 1,
    pausedUntilMs: null,
    holds: [],
    callOffer: null,
    forCall: null,
    call: null,
    callEnded: null,
    pauseReminder: null,
  },
  helper: {
    connection: "connected",
    process: "running",
    pid: 4242,
    restarts: 0,
    sessionId: "6f1c2a4e-8b3d-4c5e-9f10-2a3b4c5d6e7f",
    version: "0.1.0",
    connectedAtMs: 1,
    lastError: null,
  },
  permissions: null,
  tracks: [],
  spool: [],
  lastHealth: null,
  power: { onBattery: false, suspended: false, thermalState: null },
  importer: { imported: 0, errors: 0, lastError: null },
  analysis: {
    worker: "absent",
    queued: { requested: 0, conversations: 0, moments: 0, media: 0, traces: 0 },
    running: null,
    waitingFor: [],
    waitingEpisodeId: null,
    server: null,
    requests: [],
    retryAtMs: null,
    lastError: null,
    models: [],
  },
  live: { enabled: false, state: "off", revision: 0 },
  updates: {
    automatic: null,
    searches: false,
    blocked: "development",
    current: "0.2.0",
    available: null,
    phase: "idle",
    progress: null,
    waitingFor: [],
    requested: false,
    checkedAtMs: null,
    problem: null,
    updated: null,
  },
  retention: { spoolBytes: 0, archivedBytes: 0, blocked: 0, lastProblem: null },
  deletions: 0,
  kept: 0,
  changes: 0,
  updatedAtMs: 1,
});

/** A status stream that, like a dead core's port, may never end on its own. */
function stream() {
  const queue: Status[] = [];
  let wake: (() => void) | null = null;
  const iterable: AsyncIterable<Status> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const next = queue.shift();
        if (next !== undefined) yield next;
        else await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };
  return {
    watch: async () => iterable,
    push(next: Status) {
      queue.push(next);
      wake?.();
      wake = null;
    },
  };
}

describe("core status tracker", () => {
  it("drops core's status when core exits, and ignores the dead core's stream", async () => {
    let changes = 0;
    const tracker = createCoreStatusTracker({ onChange: () => (changes += 1) });
    const first = stream();
    void tracker.follow(first.watch);
    first.push(status("listening"));
    await waitUntil(() => tracker.current() !== null, { label: "first status" });

    tracker.stopped(false);
    expect(tracker.current()).toBeNull();
    expect(changes).toBe(2);

    // A late value from the old core must not bring its status back.
    first.push(status("paused"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(tracker.current()).toBeNull();

    const second = stream();
    void tracker.follow(second.watch);
    second.push(status("paused"));
    await waitUntil(() => tracker.current()?.listening.desired === "paused", {
      label: "second core's status",
    });
  });

  it("forgets the call when its stream ends, if asked to", async () => {
    const values = [status("listening")];
    const ended = async function* () {
      yield* values;
      throw new Error("stream closed");
    };
    const kept = createCoreStatusTracker({ onChange: () => undefined });
    await kept.follow(async () => ended());
    expect(kept.current()).not.toBeNull();
    let ends = 0;
    const cleared = createCoreStatusTracker({
      onChange: () => undefined,
      onStreamEnd: () => (ends += 1),
      clearOnEnd: true,
    });
    await cleared.follow(async () => ended());
    expect(cleared.current()).toBeNull();
    expect(ends).toBe(1);
  });

  it("reports a core crash loop until a core starts again", () => {
    const tracker = createCoreStatusTracker({ onChange: () => undefined });
    tracker.stopped(true);
    expect(tracker.crashLoop()).toBe(true);
    void tracker.follow(stream().watch);
    expect(tracker.crashLoop()).toBe(false);
  });
});
