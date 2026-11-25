import { describe, expect, it } from "vitest";
import {
  createEnvelopeDetector,
  SAME_MOMENT_THRESHOLDS,
  type SameMomentVerdict,
} from "./detector.ts";
import { envelopeOf } from "./envelope.ts";
import {
  FAR,
  hear,
  NEAR,
  NOISY,
  speechLike,
  SYNTHETIC_RATE,
  type Microphone,
} from "./synthetic.ts";

// Synthetic pairs (ADR 032, M5.7): the same room heard by the Mac and the
// phone, near, far, noisy, with a short overlap, the phone's clock off by
// a minute and its sample clock drifting; and two rooms at the same hour.

const detector = createEnvelopeDetector();
const MAC_START_MS = Date.UTC(2026, 10, 13, 9, 0, 0);
const minutes = (n: number) => Math.round(n * 60 * SYNTHETIC_RATE);

interface Pair {
  readonly room: number;
  /** Room minutes the Mac records, from 0. */
  readonly macMinutes: number;
  /** Where the phone starts in the room, and how long, in minutes. */
  readonly phoneFrom: number;
  readonly phoneMinutes: number;
  readonly mac: Microphone;
  readonly phone: Microphone;
  /** How wrong the phone's clock is, ms (positive: ahead). */
  readonly clockErrorMs: number;
  /** Another room for the phone: no link expected. */
  readonly otherRoom?: number;
}

function run(pair: Pair): { verdict: SameMomentVerdict; errorMs: number | null } {
  const total = Math.max(pair.macMinutes, pair.phoneFrom + pair.phoneMinutes) * 60 + 2;
  const room = speechLike(pair.room, total);
  const phoneRoom = pair.otherRoom === undefined ? room : speechLike(pair.otherRoom, total);
  const macPcm = hear(room, 0, minutes(pair.macMinutes), pair.mac);
  const phonePcm = hear(phoneRoom, minutes(pair.phoneFrom), minutes(pair.phoneMinutes), pair.phone);
  const phoneStartMs = MAC_START_MS + pair.phoneFrom * 60_000 + pair.clockErrorMs;
  const verdict = detector.detect(
    envelopeOf(phoneStartMs, phonePcm),
    envelopeOf(MAC_START_MS, macPcm),
    {
      expectedOffsetMs: 0,
      toleranceMs: 120_000,
    },
  );
  if (!verdict.linked) return { verdict, errorMs: null };
  // The truth at a phone time t: the room sample it heard, placed on the Mac's clock.
  const ratio = 1 + (pair.phone.driftPpm ?? 0) / 1e6;
  const truthAt = (t: number) => {
    const j = ((t - phoneStartMs) * SYNTHETIC_RATE) / 1000;
    const s = minutes(pair.phoneFrom) + j * ratio;
    return MAC_START_MS + (s * 1000) / SYNTHETIC_RATE - t;
  };
  const predictedAt = (t: number) =>
    verdict.offsetMs + (verdict.driftPpm * (t - verdict.anchorMs)) / 1e6;
  const ends = [phoneStartMs + 5_000, phoneStartMs + pair.phoneMinutes * 60_000 - 5_000];
  const errorMs = Math.max(...ends.map((t) => Math.abs(predictedAt(t) - truthAt(t))));
  return { verdict, errorMs };
}

const mic = (seed: number, place: Omit<Microphone, "seed">, driftPpm = 0): Microphone => ({
  seed,
  ...place,
  driftPpm,
});

// Half a second each alone, several when every suite runs at once.
describe("same-moment detector on synthetic pairs", { timeout: 30_000 }, () => {
  const same: [string, Pair][] = [
    [
      "phone near, clock a minute ahead, drifting",
      {
        room: 1,
        macMinutes: 6,
        phoneFrom: 0.75,
        phoneMinutes: 4,
        mac: mic(11, FAR),
        phone: mic(12, NEAR, 40),
        clockErrorMs: 73_400,
      },
    ],
    [
      "phone far",
      {
        room: 2,
        macMinutes: 6,
        phoneFrom: 0.5,
        phoneMinutes: 5,
        mac: mic(21, NEAR),
        phone: mic(22, FAR, -25),
        clockErrorMs: -2_150,
      },
    ],
    [
      "noisy room",
      {
        room: 3,
        macMinutes: 5,
        phoneFrom: 0.2,
        phoneMinutes: 4.5,
        mac: mic(31, NOISY),
        phone: mic(32, NOISY, 15),
        clockErrorMs: 900,
      },
    ],
    [
      "an overlap of three minutes",
      {
        room: 4,
        macMinutes: 5,
        phoneFrom: 2,
        phoneMinutes: 6,
        mac: mic(41, NEAR),
        phone: mic(42, FAR, 30),
        clockErrorMs: 31_000,
      },
    ],
  ];
  it.each(same)("%s: linked, the offset within 100 ms", (_name, pair) => {
    const { verdict, errorMs } = run(pair);
    expect(verdict).toMatchObject({ linked: true });
    expect(errorMs).not.toBeNull();
    expect(errorMs).toBeLessThan(100);
  });

  it.each([5, 6, 7])("two rooms at the same hour (seed %i): no link", (seed) => {
    const { verdict } = run({
      room: seed * 10,
      otherRoom: seed * 10 + 1,
      macMinutes: 6,
      phoneFrom: 0.5,
      phoneMinutes: 5,
      mac: mic(seed * 10 + 2, NEAR),
      phone: mic(seed * 10 + 3, NEAR),
      clockErrorMs: 0,
    });
    expect(verdict.linked).toBe(false);
  });

  it("two rooms with no coarse threshold: the windows disagree", () => {
    const room = speechLike(70, 302);
    const other = speechLike(71, 302);
    const loose = createEnvelopeDetector({
      ...SAME_MOMENT_THRESHOLDS,
      minPeak: 0,
      minProminence: 0,
    });
    const verdict = loose.detect(
      envelopeOf(MAC_START_MS, hear(other, 0, minutes(5), mic(72, NEAR))),
      envelopeOf(MAC_START_MS, hear(room, 0, minutes(5), mic(73, NEAR))),
      { expectedOffsetMs: 0, toleranceMs: 120_000 },
    );
    expect(verdict).toMatchObject({ linked: false, reason: "disagree" });
  });

  it.each([120_000, 3_000])(
    "links two recordings of exactly the minimum, a minute each (search ±%i ms)",
    (toleranceMs) => {
      const room = speechLike(81, 62);
      const mac = envelopeOf(MAC_START_MS, hear(room, 0, minutes(1), mic(82, FAR)));
      const phone = envelopeOf(MAC_START_MS + 1_200, hear(room, 0, minutes(1), mic(83, NEAR)));
      const verdict = detector.detect(phone, mac, { expectedOffsetMs: 0, toleranceMs });
      expect(verdict).toMatchObject({ linked: true });
      if (verdict.linked) expect(Math.abs(verdict.offsetMs + 1_200)).toBeLessThan(100);
    },
  );

  it.each([120_000, 3_000])(
    "does not link a minute each of two rooms (search ±%i ms)",
    (toleranceMs) => {
      const mac = envelopeOf(MAC_START_MS, hear(speechLike(84, 62), 0, minutes(1), mic(85, NEAR)));
      const phone = envelopeOf(
        MAC_START_MS,
        hear(speechLike(86, 62), 0, minutes(1), mic(87, NEAR)),
      );
      expect(detector.detect(phone, mac, { expectedOffsetMs: 0, toleranceMs }).linked).toBe(false);
    },
  );

  it("finds nothing under a minute heard by both", () => {
    const room = speechLike(9, 70);
    const mac = envelopeOf(MAC_START_MS, hear(room, 0, minutes(0.5), mic(91, NEAR)));
    const phone = envelopeOf(MAC_START_MS, hear(room, 0, minutes(0.5), mic(92, NEAR)));
    expect(
      detector.detect(phone, mac, { expectedOffsetMs: 0, toleranceMs: 120_000 }),
    ).toMatchObject({
      linked: false,
      reason: "too-short",
    });
  });
});
