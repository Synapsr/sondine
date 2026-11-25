import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSelfEchoDetector, envelopeOf } from "@sondine/engines";
import { echoSignals } from "@sondine/engines/self-echo-synthetic";
import { notePlaying, noteStopped, selfEchoOf } from "@sondine/db";
import { Boot, rows, tempDb, type TempDb } from "../../../test/capture-fixture";
import type { ReadTrackAudio } from "../audio/track-audio";
import { SelfEchoWork } from "./self-echo-work";
import { SelfReference } from "./self-reference";

// Regions heard while Sondine played on the speakers, judged against the
// reference (ADR 035): echo of the playback, the user speaking over it, and
// a region the reference never reached. The playback starts 100 s into the
// boot; the synthetic room's sample 0 is there.

const BOOT = Date.UTC(2026, 10, 14, 9, 0, 0);
const RATE = 16_000;
const PLAYED_SEC = 100;

let temp: TempDb;
let boot: Boot;
beforeEach(() => {
  temp = tempDb();
  boot = new Boot(temp.db, BOOT);
});
afterEach(() => temp.cleanup());

const signals = echoSignals({
  seconds: 40,
  playbackSeed: 3,
  lagMs: 120,
  echoGainDb: -12,
  user: { seed: 50, fromS: 20, toS: 28, gainDb: 0 },
});

/** The mic run's audio: the synthetic room from `PLAYED_SEC`, silence around it. */
const reader: ReadTrackAudio = (range) => {
  const samples = new Int16Array(range.sampleEnd - range.sampleStart);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = signals.mic[range.sampleStart + i - PLAYED_SEC * RATE] ?? 0;
  }
  return { samples, missing: [] };
};

/** The helper's events for room seconds `[fromSec, toSec)`, a second each. */
function feed(reference: SelfReference, fromSec: number, toSec: number): void {
  const envelope = envelopeOf(0, signals.reference);
  for (let frame = fromSec * 100; frame < toSec * 100; frame += 100) {
    const levels = Array.from(envelope.db.subarray(frame, frame + 100), (db) =>
      Number.isNaN(db) ? -1_200 : Math.round(db * 10),
    );
    reference.add({
      type: "self.envelope",
      start: {
        hostTicks: 0n,
        continuousNs: BigInt(boot.continuousUs(PLAYED_SEC + frame / 100)) * 1_000n,
      },
      levels,
    });
  }
}

describe("self-echo work", () => {
  it("judges each region once the reference reaches past it, and gives up on the rest", () => {
    const mic = boot.run({ startSec: 0 });
    boot.chunks(mic, 0, 200);
    for (let sec = PLAYED_SEC - 1; sec < PLAYED_SEC + 40; sec += 3) {
      notePlaying(temp.db, { route: "speakers", nowMs: boot.wallMs(sec) });
    }
    noteStopped(temp.db, boot.wallMs(PLAYED_SEC + 40));
    const echo = boot.region(mic, PLAYED_SEC + 5, PLAYED_SEC + 12);
    const spoke = boot.region(mic, PLAYED_SEC + 20, PLAYED_SEC + 28);
    const late = boot.region(mic, PLAYED_SEC + 32, PLAYED_SEC + 38);
    const reference = new SelfReference();
    let now = boot.wallMs(PLAYED_SEC + 12.5);
    const work = new SelfEchoWork({
      db: temp.db,
      reader: () => reader,
      reference,
      detector: createSelfEchoDetector(),
      log: { info: () => undefined, warn: () => undefined },
      now: () => now,
    });
    const kinds = (run: ReturnType<SelfEchoWork["run"]>) =>
      run.judged.map(({ regionId, verdict }) => [regionId, verdict.kind]);

    // The first region's reference is not in yet (the others are written ahead).
    feed(reference, 0, 12);
    expect(work.run()).toMatchObject({ judged: [], waiting: 3 });
    feed(reference, 12, 13);
    expect(kinds(work.run())).toEqual([[echo, "echo"]]);
    now = boot.wallMs(PLAYED_SEC + 29);
    feed(reference, 13, 29);
    expect(kinds(work.run())).toEqual([[spoke, "near-end"]]);
    // The reference stops at 30 s (the tap failed): the last region waits…
    feed(reference, 29, 30);
    now = boot.wallMs(PLAYED_SEC + 39);
    expect(work.run()).toMatchObject({ judged: [], waiting: 1 });
    const said = selfEchoOf(temp.db, spoke);
    expect(said).toMatchObject({ method: "envelope-echo/1", kind: "near-end" });
    // The lag over a region someone spoke in is rougher than over pure echo.
    expect(said?.lagMs).toBeGreaterThanOrEqual(100);
    expect(said?.lagMs).toBeLessThanOrEqual(300);
    // Echo stretches inside it, in run samples within the region.
    for (const [start, end] of said?.spans ?? []) {
      expect(start).toBeGreaterThanOrEqual((PLAYED_SEC + 20) * RATE);
      expect(end).toBeLessThanOrEqual((PLAYED_SEC + 28) * RATE);
      expect(end - start).toBeGreaterThanOrEqual(RATE / 2);
    }
    // Judged once.
    expect(work.run().judged).toEqual([]);

    // …until the give-up time: ADR 020's rule, stored.
    now = boot.wallMs(PLAYED_SEC + 49);
    const last = work.run();
    expect(kinds(last)).toEqual([[late, "no-reference"]]);
    expect(last.waiting).toBe(0);
    // Numbers only: no column holds any of the reference.
    expect(rows(temp.db, "SELECT * FROM self_echoes").map((row) => Object.keys(row))).toEqual(
      Array.from({ length: 3 }, () => [
        "speech_region_id",
        "method",
        "verdict",
        "voiced_ms",
        "covered_ms",
        "echo_ms",
        "near_end_ms",
        "lag_ms",
        "correlation",
        "spans",
        "judged_at_ms",
      ]),
    );
  });

  it("waits for the region's own audio to be committed", () => {
    const mic = boot.run({ startSec: 0 });
    for (let sec = PLAYED_SEC - 1; sec < PLAYED_SEC + 40; sec += 3) {
      notePlaying(temp.db, { route: "speakers", nowMs: boot.wallMs(sec) });
    }
    const echo = boot.region(mic, PLAYED_SEC + 5, PLAYED_SEC + 12);
    const reference = new SelfReference();
    feed(reference, 0, 14);
    let committedTo = (PLAYED_SEC + 11) * RATE;
    let now = boot.wallMs(PLAYED_SEC + 13);
    const work = new SelfEchoWork({
      db: temp.db,
      // The spool has the region only up to `committedTo`.
      reader: () => (range) => {
        const audio = reader(range);
        const cut = Math.max(range.sampleStart, Math.min(range.sampleEnd, committedTo));
        audio.samples.fill(0, cut - range.sampleStart);
        return {
          samples: audio.samples,
          missing:
            cut < range.sampleEnd
              ? [{ sampleStart: cut, sampleEnd: range.sampleEnd, reason: "unrecorded" as const }]
              : [],
        };
      },
      reference,
      detector: createSelfEchoDetector(),
      log: { info: () => undefined, warn: () => undefined },
      now: () => now,
    });
    expect(work.run()).toMatchObject({ judged: [], waiting: 1 });
    // Past its end only the context is missing: judged.
    committedTo = (PLAYED_SEC + 12) * RATE;
    now = boot.wallMs(PLAYED_SEC + 14);
    expect(work.run().judged.map(({ regionId }) => regionId)).toEqual([echo]);
  });

  it("leaves regions alone when no audio can be read", () => {
    const mic = boot.run({ startSec: 0 });
    notePlaying(temp.db, { route: "speakers", nowMs: boot.wallMs(10) });
    boot.region(mic, 10, 14);
    const work = new SelfEchoWork({
      db: temp.db,
      reader: () => null,
      reference: new SelfReference(),
      detector: createSelfEchoDetector(),
      log: { info: () => undefined, warn: () => undefined },
      now: () => boot.wallMs(60),
    });
    expect(work.run()).toEqual({ judged: [], waiting: 0, costMs: 0 });
    expect(rows(temp.db, "SELECT * FROM self_echoes")).toEqual([]);
  });
});
