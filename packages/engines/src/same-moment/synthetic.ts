// Synthetic rooms for the same-moment detector's tests and the bench's self
// check (ADR 032): speech-like sound made from noise and tones, heard by
// two microphones at their own distance, gain, reverberation, noise, clock
// and drift. Nothing here is a recording, and nothing is written to the
// repository.

export const SYNTHETIC_RATE = 16_000;

/** A small deterministic generator (mulberry32). */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * A conversation as it is said in the room, before any microphone: two to
 * four voices taking turns, in phrases of syllables (voiced tone and
 * filtered noise under a syllable's envelope), pauses between them.
 */
export function speechLike(seed: number, seconds: number): Float32Array {
  const rand = random(seed);
  const out = new Float32Array(Math.round(seconds * SYNTHETIC_RATE));
  const voices = Array.from({ length: 2 + Math.floor(rand() * 3) }, () => ({
    pitch: 90 + rand() * 160,
    level: 10 ** ((-18 - rand() * 12) / 20),
    tone: 0.3 + rand() * 0.5,
  }));
  let at = Math.round(rand() * SYNTHETIC_RATE);
  let lowpass = 0;
  let phase = 0;
  while (at < out.length) {
    const voice = voices[Math.floor(rand() * voices.length)] ?? voices[0];
    if (voice === undefined) break;
    const phrases = 1 + Math.floor(rand() * 4);
    for (let p = 0; p < phrases && at < out.length; p++) {
      const syllables = 3 + Math.floor(rand() * 12);
      for (let s = 0; s < syllables && at < out.length; s++) {
        const length = Math.round((0.08 + rand() * 0.22) * SYNTHETIC_RATE);
        const loud = voice.level * (0.5 + rand());
        const pitch = voice.pitch * (0.85 + rand() * 0.3);
        for (let i = 0; i < length && at + i < out.length; i++) {
          const shape = Math.sin((Math.PI * i) / length) ** 2;
          lowpass += 0.3 * (rand() * 2 - 1 - lowpass);
          phase += (2 * Math.PI * pitch) / SYNTHETIC_RATE;
          const tone = Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.25 * Math.sin(3 * phase);
          out[at + i] =
            (out[at + i] ?? 0) +
            loud * shape * (voice.tone * tone + (1 - voice.tone) * 3 * lowpass);
        }
        at += length + Math.round((0.02 + rand() * 0.1) * SYNTHETIC_RATE);
      }
      at += Math.round((0.2 + rand() * 1.2) * SYNTHETIC_RATE);
    }
    at += Math.round((0.1 + rand() * 1.5) * SYNTHETIC_RATE);
  }
  return out;
}

/** Where a microphone is and what it adds. */
export interface Microphone {
  readonly seed: number;
  /** Gain on the room's sound, dB. */
  readonly gainDb: number;
  /** How much of what it hears is the room's echo, 0 (close) to 1 (far). */
  readonly reverb: number;
  /** Its noise (the room's and its own), dBFS. */
  readonly noiseDb: number;
  /** A second conversation far off in the room (a café), dB under the first; null for none. */
  readonly babbleDb?: number | null;
  /** Its sample clock against the room's, in millionths (positive: it runs fast). */
  readonly driftPpm?: number;
}

/**
 * What a microphone records of `room` from room sample `from` for `samples`
 * samples, as 16-bit PCM.
 */
export function hear(
  room: Float32Array,
  from: number,
  samples: number,
  mic: Microphone,
): Int16Array {
  const rand = random(mic.seed);
  const gain = 10 ** (mic.gainDb / 20);
  const noise = 10 ** (mic.noiseDb / 20);
  const ratio = 1 + (mic.driftPpm ?? 0) / 1e6;
  const babble =
    mic.babbleDb === null || mic.babbleDb === undefined
      ? null
      : {
          sound: speechLike(mic.seed + 7, samples / SYNTHETIC_RATE + 2),
          level: 10 ** (-mic.babbleDb / 20),
        };
  // Early reflections (walls and table, 3 to 20 ms), then four comb filters
  // (Schroeder's 30 to 45 ms): a room whose echo lasts about half a second,
  // a little different at each place.
  const early = Array.from({ length: 3 }, () => ({
    delay: 48 + Math.floor(rand() * 272),
    gain: 0.3 + rand() * 0.3,
  }));
  const history = new Float32Array(512);
  const combs = [475, 594, 658, 699].map((delay) => ({
    delay: delay + Math.floor(rand() * 40),
    buffer: new Float32Array(800),
    at: 0,
  }));
  const out = new Int16Array(samples);
  let pink = 0;
  for (let i = 0; i < samples; i++) {
    const position = from + i * ratio;
    const k = Math.floor(position);
    const frac = position - k;
    const dry =
      k >= 0 && k + 1 < room.length ? (room[k] ?? 0) * (1 - frac) + (room[k + 1] ?? 0) * frac : 0;
    history[i % history.length] = dry;
    let reflected = 0;
    for (const tap of early) {
      reflected += tap.gain * (history[(i - tap.delay + history.length * 4) % history.length] ?? 0);
    }
    let wet = 0;
    for (const comb of combs) {
      const read =
        comb.buffer[(comb.at - comb.delay + comb.buffer.length) % comb.buffer.length] ?? 0;
      comb.buffer[comb.at] = dry + 0.6 * read;
      comb.at = (comb.at + 1) % comb.buffer.length;
      wet += read;
    }
    pink += 0.05 * (rand() * 2 - 1 - pink);
    const crowd = babble === null ? 0 : (babble.sound[i] ?? 0) * babble.level;
    const value =
      gain * ((1 - mic.reverb) * (dry + reflected) + mic.reverb * 0.2 * wet + crowd) +
      noise * (pink * 4 + 0.3 * (rand() * 2 - 1));
    out[i] = Math.max(-32_768, Math.min(32_767, Math.round(value * 32_767)));
  }
  return out;
}

export const NEAR: Omit<Microphone, "seed"> = { gainDb: 0, reverb: 0.2, noiseDb: -60 };
export const FAR: Omit<Microphone, "seed"> = { gainDb: -14, reverb: 0.7, noiseDb: -58 };
export const NOISY: Omit<Microphone, "seed"> = {
  gainDb: -6,
  reverb: 0.5,
  noiseDb: -40,
  babbleDb: 8,
};
