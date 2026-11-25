import { envelopeOf, type Envelope } from "../same-moment/envelope.ts";
import { hear, speechLike, SYNTHETIC_RATE, type Microphone } from "../same-moment/synthetic.ts";
import type { SelfEchoInput } from "./detector.ts";

// Synthetic playbacks for the self-echo detector's tests and the bench
// (ADR 035): Sondine plays speech on the speakers, the microphone hears it
// across the room a moment later, and the user may speak over it. Nothing
// here is a recording, and nothing is written to the repository.

export interface EchoRoom {
  readonly seconds: number;
  /** The speech Sondine plays. */
  readonly playbackSeed: number;
  /** How late the microphone hears the playback, ms… */
  readonly lagMs: number;
  /** …and from `atS` seconds, at another lag (another output buffer). */
  readonly lagChange?: { readonly atS: number; readonly lagMs: number };
  /** Speaker to microphone, dB; null: headphones, the microphone hears none of it. */
  readonly echoGainDb: number | null;
  /** The microphone's place (reverberation, noise); FAR by default. */
  readonly room?: Omit<Microphone, "seed" | "gainDb">;
  /** The user speaking near the microphone over `[fromS, toS)`. */
  readonly user?: {
    readonly seed: number;
    readonly fromS: number;
    readonly toS: number;
    readonly gainDb: number;
  };
  /** Seconds of the playback the reference never captured, `[fromS, toS)`. */
  readonly missing?: { readonly fromS: number; readonly toS: number };
}

const START_MS = 1_000_000;

/** What Sondine played (the reference's PCM) and what the microphone heard, as 16 kHz PCM. */
export interface EchoSignals {
  readonly reference: Int16Array;
  readonly mic: Int16Array;
}

/** The two signals of `room`, both from sample 0 of the same clock. */
export function echoSignals(room: EchoRoom): EchoSignals {
  const samples = Math.round(room.seconds * SYNTHETIC_RATE);
  const played = speechLike(room.playbackSeed, room.seconds + 1);
  const reference = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    reference[i] = Math.max(-32_768, Math.min(32_767, Math.round((played[i] ?? 0) * 32_767)));
  }
  const delayed = new Float32Array(samples + SYNTHETIC_RATE);
  const lagAt = (i: number) =>
    room.lagChange !== undefined && i >= room.lagChange.atS * SYNTHETIC_RATE
      ? room.lagChange.lagMs
      : room.lagMs;
  for (let i = 0; i < delayed.length; i++) {
    const j = i - Math.round((lagAt(i) * SYNTHETIC_RATE) / 1000);
    delayed[i] = j >= 0 ? (played[j] ?? 0) : 0;
  }
  const place = room.room ?? { reverb: 0.6, noiseDb: -60 };
  const mic = new Float64Array(samples);
  if (room.echoGainDb !== null) {
    const echo = hear(delayed, 0, samples, {
      ...place,
      seed: room.playbackSeed + 1,
      gainDb: room.echoGainDb,
    });
    for (let i = 0; i < samples; i++) mic[i] = (mic[i] ?? 0) + (echo[i] ?? 0);
  } else {
    const quiet = hear(new Float32Array(samples), 0, samples, {
      ...place,
      seed: room.playbackSeed + 1,
      gainDb: 0,
    });
    for (let i = 0; i < samples; i++) mic[i] = (mic[i] ?? 0) + (quiet[i] ?? 0);
  }
  if (room.user !== undefined) {
    const said = speechLike(room.user.seed, room.seconds + 1);
    const from = Math.round(room.user.fromS * SYNTHETIC_RATE);
    const to = Math.round(room.user.toS * SYNTHETIC_RATE);
    // The user starts speaking at `fromS`: their speech from its first sound.
    const onset = Math.max(
      0,
      said.findIndex((value) => value !== 0),
    );
    const voice = new Float32Array(samples);
    for (let i = from; i < Math.min(to, samples); i++) voice[i] = said[onset + i - from] ?? 0;
    const near = hear(voice, 0, samples, {
      seed: room.user.seed + 1,
      gainDb: room.user.gainDb,
      reverb: 0.2,
      noiseDb: -90,
    });
    for (let i = 0; i < samples; i++) mic[i] = (mic[i] ?? 0) + (near[i] ?? 0);
  }
  const heard = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    heard[i] = Math.max(-32_768, Math.min(32_767, Math.round(mic[i] ?? 0)));
  }
  return { reference, mic: heard };
}

/** What the detector receives for `room`, judged over all of it. */
export function echoInput(room: EchoRoom): SelfEchoInput {
  const signals = echoSignals(room);
  const ref = envelopeOf(START_MS, signals.reference);
  const captured = new Uint8Array(ref.db.length).fill(1);
  if (room.missing !== undefined) {
    captured.fill(0, Math.round(room.missing.fromS * 100), Math.round(room.missing.toS * 100));
  }
  const db = Float32Array.from(ref.db, (value, i) => (captured[i] === 1 ? value : Number.NaN));
  const referenceEnvelope: Envelope = { startMs: START_MS, db };
  return {
    mic: envelopeOf(START_MS, signals.mic),
    reference: referenceEnvelope,
    captured,
    fromMs: START_MS,
    toMs: START_MS + room.seconds * 1000,
  };
}

/** The same input, judged over `[fromS, toS)` only (one speech region in its context). */
export function within(input: SelfEchoInput, fromS: number, toS: number): SelfEchoInput {
  return { ...input, fromMs: START_MS + fromS * 1000, toMs: START_MS + toS * 1000 };
}

/** One kind of playback, made again for each seed, with the verdict it must get. */
export interface EchoCase {
  readonly id: string;
  readonly want: "echo" | "near-end" | "no-reference";
  readonly room: (seed: number) => EchoRoom;
  /** The speech region judged, seconds; all of the room when absent. */
  readonly region?: (seed: number) => readonly [number, number];
}

/**
 * The cases the detector's thresholds were set on (ADR 035): echo at three
 * levels, in a short region, through a change of lag and AirPlay's delay;
 * the user speaking over it, louder and softer than the echo, a short reply;
 * the user alone through headphones; no reference at all.
 */
export const SELF_ECHO_CASES: readonly EchoCase[] = [
  {
    id: "echo",
    want: "echo",
    room: (s) => ({ seconds: 20, playbackSeed: s, lagMs: 40 + (s % 7) * 40, echoGainDb: -12 }),
  },
  {
    id: "quiet echo",
    want: "echo",
    room: (s) => ({ seconds: 20, playbackSeed: s, lagMs: 60, echoGainDb: -26 }),
  },
  {
    id: "noisy room",
    want: "echo",
    room: (s) => ({
      seconds: 20,
      playbackSeed: s,
      lagMs: 150,
      echoGainDb: -18,
      room: { reverb: 0.7, noiseDb: -45 },
    }),
  },
  {
    id: "short echo region",
    want: "echo",
    room: (s) => ({ seconds: 20, playbackSeed: s, lagMs: 100, echoGainDb: -14 }),
    region: (s) => [8 + (s % 5), 9.5 + (s % 5)],
  },
  {
    id: "lag change",
    want: "echo",
    room: (s) => ({
      seconds: 30,
      playbackSeed: s,
      lagMs: 60,
      lagChange: { atS: 15, lagMs: 300 },
      echoGainDb: -14,
    }),
  },
  {
    id: "airplay delay",
    want: "echo",
    room: (s) => ({ seconds: 20, playbackSeed: s, lagMs: 1_800, echoGainDb: -14 }),
  },
  {
    id: "double-talk",
    want: "near-end",
    room: (s) => ({
      seconds: 20,
      playbackSeed: s,
      lagMs: 120,
      echoGainDb: -14,
      user: { seed: s + 500, fromS: 5, toS: 15, gainDb: 0 },
    }),
    region: () => [5, 15],
  },
  {
    id: "soft double-talk",
    want: "near-end",
    room: (s) => ({
      seconds: 20,
      playbackSeed: s,
      lagMs: 120,
      echoGainDb: -14,
      user: { seed: s + 500, fromS: 5, toS: 15, gainDb: -10 },
    }),
    region: () => [5, 15],
  },
  {
    id: "short reply",
    want: "near-end",
    room: (s) => ({
      seconds: 20,
      playbackSeed: s,
      lagMs: 100,
      echoGainDb: -16,
      user: { seed: s + 700, fromS: 10, toS: 10.6, gainDb: -2 },
    }),
    region: () => [9.9, 10.8],
  },
  {
    id: "headphones",
    want: "near-end",
    room: (s) => ({
      seconds: 20,
      playbackSeed: s,
      lagMs: 0,
      echoGainDb: null,
      user: { seed: s + 900, fromS: 4, toS: 16, gainDb: -6 },
    }),
    region: () => [4, 16],
  },
  {
    id: "no reference",
    want: "no-reference",
    room: (s) => ({
      seconds: 20,
      playbackSeed: s,
      lagMs: 100,
      echoGainDb: -14,
      missing: { fromS: 0, toS: 20 },
    }),
  },
];

/** The input of `test` for `seed`. */
export function caseInput(test: EchoCase, seed: number): SelfEchoInput {
  const input = echoInput(test.room(seed));
  const region = test.region?.(seed);
  return region === undefined ? input : within(input, region[0], region[1]);
}
