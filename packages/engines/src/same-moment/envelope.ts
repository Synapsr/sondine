// The feature the same-moment detector reads (ADR 032): a recording's
// energy every 10 ms, in dB below full scale. Built from 16 kHz mono PCM
// pushed at its offsets; what was never pushed, or was digital silence (a
// missing or deleted stretch reads as zeros), is a hole. The envelope holds
// no words: speech cannot be heard again from it.

export const ENVELOPE_SAMPLE_RATE = 16_000;
export const ENVELOPE_FRAME_MS = 10;
export const ENVELOPE_FRAME_SAMPLES = (ENVELOPE_SAMPLE_RATE * ENVELOPE_FRAME_MS) / 1000;
/** Below this a frame is digital silence: a hole, not a quiet room. */
export const ENVELOPE_SILENT_DB = -90;

export interface Envelope {
  /** Wall-clock ms of frame 0, on the recording's own clock. */
  readonly startMs: number;
  /** dBFS per 10 ms frame; NaN where nothing was heard. */
  readonly db: Float32Array;
}

/** Accumulates PCM pushed at any offset into 10 ms frames. */
export class EnvelopeBuilder {
  readonly #startMs: number;
  readonly #energy: Float64Array;
  readonly #count: Uint16Array;

  /** `samples`: the recording's length on its timeline. */
  constructor(startMs: number, samples: number) {
    const frames = Math.max(0, Math.ceil(samples / ENVELOPE_FRAME_SAMPLES));
    this.#startMs = startMs;
    this.#energy = new Float64Array(frames);
    this.#count = new Uint16Array(frames);
  }

  get frames(): number {
    return this.#energy.length;
  }

  /** Samples heard from `offset` (in samples from the start); outside the timeline they are dropped. */
  push(offset: number, samples: Int16Array): void {
    const limit = this.#energy.length * ENVELOPE_FRAME_SAMPLES;
    for (let i = 0; i < samples.length; i++) {
      const at = offset + i;
      if (at < 0 || at >= limit) continue;
      const frame = (at / ENVELOPE_FRAME_SAMPLES) | 0;
      const value = samples[i] ?? 0;
      this.#energy[frame] = (this.#energy[frame] ?? 0) + value * value;
      this.#count[frame] = (this.#count[frame] ?? 0) + 1;
    }
  }

  finish(): Envelope {
    const db = new Float32Array(this.#energy.length);
    const fullScale = 32_768 * 32_768;
    for (let frame = 0; frame < db.length; frame++) {
      const count = this.#count[frame] ?? 0;
      // A frame needs half its samples to say anything.
      if (count < ENVELOPE_FRAME_SAMPLES / 2) {
        db[frame] = Number.NaN;
        continue;
      }
      const power = (this.#energy[frame] ?? 0) / count / fullScale;
      const level = power > 0 ? 10 * Math.log10(power) : Number.NEGATIVE_INFINITY;
      db[frame] = level < ENVELOPE_SILENT_DB ? Number.NaN : level;
    }
    return { startMs: this.#startMs, db };
  }
}

/** The envelope of samples starting at `startMs`, all heard. */
export function envelopeOf(startMs: number, samples: Int16Array): Envelope {
  const builder = new EnvelopeBuilder(startMs, samples.length);
  builder.push(0, samples);
  return builder.finish();
}
