import { createEnvelopeDetector, envelopeOf } from "@sondine/engines";
import {
  FAR,
  hear,
  NEAR,
  NOISY,
  speechLike,
  SYNTHETIC_RATE,
  type Microphone,
} from "@sondine/engines/synthetic";
import { offsetAt } from "./run.ts";

// The detector on synthetic pairs made here (nothing recorded, nothing
// written but numbers): the cases of M5.7's exit, and one long pair for the
// cost per hour of audio.

export interface SyntheticCase {
  readonly id: string;
  readonly same: boolean;
  readonly macMinutes: number;
  readonly phoneFromMinutes: number;
  readonly phoneMinutes: number;
  readonly mac: Omit<Microphone, "seed">;
  readonly phone: Omit<Microphone, "seed">;
  readonly clockErrorMs: number;
}

export const SYNTHETIC_CASES: readonly SyntheticCase[] = [
  {
    id: "near",
    same: true,
    macMinutes: 20,
    phoneFromMinutes: 2,
    phoneMinutes: 15,
    mac: FAR,
    phone: { ...NEAR, driftPpm: 40 },
    clockErrorMs: 73_400,
  },
  {
    id: "far",
    same: true,
    macMinutes: 20,
    phoneFromMinutes: 1,
    phoneMinutes: 18,
    mac: NEAR,
    phone: { ...FAR, driftPpm: -25 },
    clockErrorMs: -2_150,
  },
  {
    id: "noisy",
    same: true,
    macMinutes: 20,
    phoneFromMinutes: 0.5,
    phoneMinutes: 19,
    mac: NOISY,
    phone: { ...NOISY, driftPpm: 15 },
    clockErrorMs: 900,
  },
  {
    id: "overlap-3min",
    same: true,
    macMinutes: 10,
    phoneFromMinutes: 7,
    phoneMinutes: 10,
    mac: NEAR,
    phone: { ...FAR, driftPpm: 30 },
    clockErrorMs: 31_000,
  },
  {
    id: "rooms-1",
    same: false,
    macMinutes: 20,
    phoneFromMinutes: 1,
    phoneMinutes: 18,
    mac: NEAR,
    phone: NEAR,
    clockErrorMs: 0,
  },
  {
    id: "rooms-2",
    same: false,
    macMinutes: 20,
    phoneFromMinutes: 1,
    phoneMinutes: 18,
    mac: NOISY,
    phone: FAR,
    clockErrorMs: 0,
  },
  {
    id: "rooms-3",
    same: false,
    macMinutes: 10,
    phoneFromMinutes: 7,
    phoneMinutes: 10,
    mac: NEAR,
    phone: NEAR,
    clockErrorMs: 0,
  },
];

export interface SyntheticResult {
  readonly id: string;
  readonly same: boolean;
  readonly linked: boolean;
  readonly errorMs: number | null;
  readonly peak: number;
  readonly score: number;
  readonly audioMinutes: number;
  readonly envelopeMs: number;
  readonly detectMs: number;
  /** CPU of envelope and detection per hour of audio compared (both sides), ms. */
  readonly cpuMsPerHour: number;
  readonly pass: boolean;
}

export function runSynthetic(test: SyntheticCase, seed: number): SyntheticResult {
  const start = Date.UTC(2026, 10, 13, 9, 0, 0);
  const total = Math.max(test.macMinutes, test.phoneFromMinutes + test.phoneMinutes) * 60 + 2;
  const room = speechLike(seed, total);
  const phoneRoom = test.same ? room : speechLike(seed + 1, total);
  const samples = (minutes: number) => Math.round(minutes * 60 * SYNTHETIC_RATE);
  const macPcm = hear(room, 0, samples(test.macMinutes), { seed: seed + 2, ...test.mac });
  const phonePcm = hear(phoneRoom, samples(test.phoneFromMinutes), samples(test.phoneMinutes), {
    seed: seed + 3,
    ...test.phone,
  });
  const phoneStart = start + test.phoneFromMinutes * 60_000 + test.clockErrorMs;
  const cpu = process.cpuUsage();
  const envelopeStart = performance.now();
  const phone = envelopeOf(phoneStart, phonePcm);
  const mac = envelopeOf(start, macPcm);
  const envelopeMs = performance.now() - envelopeStart;
  const detectStart = performance.now();
  const verdict = createEnvelopeDetector().detect(phone, mac, {
    expectedOffsetMs: 0,
    toleranceMs: 120_000,
  });
  const detectMs = performance.now() - detectStart;
  const used = process.cpuUsage(cpu);
  const ratio = 1 + (test.phone.driftPpm ?? 0) / 1e6;
  // The truth at a phone time: the room sample it heard, on the Mac's clock.
  const truthAt = (t: number) =>
    start +
    ((samples(test.phoneFromMinutes) + ((t - phoneStart) * SYNTHETIC_RATE * ratio) / 1000) * 1000) /
      SYNTHETIC_RATE -
    t;
  const errorMs = verdict.linked
    ? Math.max(
        ...[phoneStart + 5_000, phoneStart + test.phoneMinutes * 60_000 - 5_000].map((t) =>
          Math.abs(offsetAt(verdict, t) - truthAt(t)),
        ),
      )
    : null;
  const audioMinutes = test.macMinutes + test.phoneMinutes;
  return {
    id: test.id,
    same: test.same,
    linked: verdict.linked,
    errorMs: errorMs === null ? null : Math.round(errorMs),
    peak: Math.round(verdict.peak * 1000) / 1000,
    score: Math.round(verdict.score * 1000) / 1000,
    audioMinutes,
    envelopeMs: Math.round(envelopeMs),
    detectMs: Math.round(detectMs),
    cpuMsPerHour: Math.round(((used.user + used.system) / 1000) * (60 / audioMinutes)),
    pass: test.same ? verdict.linked && errorMs !== null && errorMs < 100 : !verdict.linked,
  };
}

/** A long pair: an hour on each side, for what one comparison costs. */
export const LONG_CASE: SyntheticCase = {
  id: "long-60min",
  same: true,
  macMinutes: 62,
  phoneFromMinutes: 1,
  phoneMinutes: 60,
  mac: NEAR,
  phone: { ...FAR, driftPpm: 20 },
  clockErrorMs: 45_000,
};
