import { describe, expect, it } from "vitest";
import { createSelfEchoDetector } from "./detector.ts";
import { caseInput, echoInput, SELF_ECHO_CASES, within } from "./synthetic.ts";

// Synthetic playbacks (ADR 035): Sondine's own sound heard again by the
// microphone, the user speaking over it, through headphones, at a lag that
// changes, without a reference. The bench runs 40 seeds of each
// (`pnpm bench self-echo synthetic`); here five, so a change of threshold
// that breaks one shows.

const detector = createSelfEchoDetector();
const SEEDS = [1, 2, 3, 4, 5];

describe("envelope-echo/1", () => {
  for (const test of SELF_ECHO_CASES) {
    it(`${test.id}: ${test.want}`, () => {
      const wrong = SEEDS.flatMap((seed) => {
        const kind = detector.detect(caseInput(test, seed)).kind;
        return kind === test.want ? [] : [`${seed}:${kind}`];
      });
      // The bench holds every case to 85 %: one seed of five may miss.
      expect(wrong.length, wrong.join(" ")).toBeLessThanOrEqual(1);
    });
  }

  it("finds the lag the microphone heard the playback at", () => {
    const verdict = detector.detect(
      echoInput({ seconds: 20, playbackSeed: 3, lagMs: 160, echoGainDb: -12 }),
    );
    expect(verdict.kind).toBe("echo");
    // Reverberation smears the envelope: the lag found is a little late.
    expect(verdict.lagMs).toBeGreaterThanOrEqual(150);
    expect(verdict.lagMs).toBeLessThanOrEqual(200);
    expect(verdict.correlation).toBeGreaterThan(0.6);
  });

  it("returns the echo stretches around the user's words", () => {
    const input = echoInput({
      seconds: 30,
      playbackSeed: 4,
      lagMs: 120,
      echoGainDb: -12,
      user: { seed: 40, fromS: 14, toS: 18, gainDb: 0 },
    });
    const verdict = detector.detect(within(input, 4, 28));
    expect(verdict.kind).toBe("near-end");
    expect(verdict.spans.length).toBeGreaterThan(0);
    const userFrom = input.mic.startMs + 14_000;
    const userTo = input.mic.startMs + 18_000;
    const overlap = (from: number, to: number) =>
      verdict.spans.reduce(
        (sum, span) => sum + Math.max(0, Math.min(span.toMs, to) - Math.max(span.fromMs, from)),
        0,
      );
    for (const span of verdict.spans) expect(span.toMs - span.fromMs).toBeGreaterThanOrEqual(500);
    // Echo heard in the user's pauses is echo, but most of what they said is not.
    expect(overlap(userFrom, userTo)).toBeLessThan(2_000);
    // Most of the echo before they spoke is covered.
    expect(overlap(input.mic.startMs + 4_000, userFrom)).toBeGreaterThan(5_000);
  });

  it("needs the reference over most of the region's speech", () => {
    const half = echoInput({
      seconds: 20,
      playbackSeed: 9,
      lagMs: 100,
      echoGainDb: -14,
      missing: { fromS: 0, toS: 14 },
    });
    expect(detector.detect(half).kind).toBe("no-reference");
    // The part it covers is judged.
    expect(detector.detect(within(half, 15, 20)).kind).toBe("echo");
  });

  it("never calls echo what the user said where the reference was missing", () => {
    const input = echoInput({
      seconds: 10,
      playbackSeed: 21,
      lagMs: 100,
      echoGainDb: -14,
      user: { seed: 210, fromS: 7, toS: 10, gainDb: 0 },
      missing: { fromS: 7, toS: 10 },
    });
    expect(detector.detect(input).kind).not.toBe("echo");
  });

  it("keeps short bursts the playback cannot explain: no lag, no echo", () => {
    // Sondine plays digital silence (a quiet passage); the user taps out short syllables.
    const frames = 1_000;
    const mic = Float32Array.from({ length: frames }, (_, i) => (i % 20 < 7 ? -30 : -70));
    const verdict = detector.detect({
      mic: { startMs: 0, db: mic },
      reference: { startMs: -2_000, db: new Float32Array(frames + 200).fill(Number.NaN) },
      captured: new Uint8Array(frames + 200).fill(1),
      fromMs: 0,
      toMs: frames * 10,
    });
    expect(verdict.kind).toBe("near-end");
    expect(verdict.echoMs).toBe(0);
  });

  it("is cheap: a minute judged in a few tens of milliseconds", () => {
    const input = echoInput({ seconds: 60, playbackSeed: 6, lagMs: 90, echoGainDb: -14 });
    const started = performance.now();
    detector.detect(input);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
