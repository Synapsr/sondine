import { ENVELOPE_FRAME_MS, ENVELOPE_SILENT_DB, type Envelope } from "@sondine/engines";
import type { SelfEnvelopeEvent } from "@sondine/protocol";

// The private `self:playback` reference in core (ADR 035): the 10 ms energy
// of what Sondine played, as the helper sent it (`self.envelope`). It lives
// in memory only, never on disk, and only as long as a region it may judge
// can still close: `SELF_REFERENCE_RETENTION_MS` behind the newest frame.
// Nothing of it can be heard again.

/** How long frames are kept behind the newest one, on the capture clock. */
export const SELF_REFERENCE_RETENTION_MS = 15 * 60_000;
/** At most this many frames (the retention's worth): a clock jump never grows it. */
const MAX_FRAMES = SELF_REFERENCE_RETENTION_MS / ENVELOPE_FRAME_MS;

interface Segment {
  /** Continuous ms of the first frame. */
  readonly startMs: number;
  /** dBFS per frame. */
  readonly levels: Float32Array;
}

/** The reference over a stretch, for the detector. */
export interface ReferenceWindow {
  /** NaN where Sondine played digital silence or nothing was captured. */
  readonly reference: Envelope;
  /** 1 where a frame was captured. */
  readonly captured: Uint8Array;
}

export class SelfReference {
  #segments: Segment[] = [];
  #frames = 0;

  /** One `self.envelope`. */
  add(event: SelfEnvelopeEvent): void {
    const startMs = Number(event.start.continuousNs) / 1e6;
    const levels = Float32Array.from(event.levels, (tenths) => tenths / 10);
    this.#segments.push({ startMs, levels });
    this.#frames += levels.length;
    if (this.#segments.length > 1 && startMs < (this.#segments.at(-2)?.startMs ?? 0)) {
      this.#segments.sort((a, b) => a.startMs - b.startMs);
    }
    this.#prune();
  }

  /** Continuous ms where the newest frame ends; null while none is held. */
  get latestMs(): number | null {
    let latest: number | null = null;
    for (const segment of this.#segments) {
      const end = segment.startMs + segment.levels.length * ENVELOPE_FRAME_MS;
      if (latest === null || end > latest) latest = end;
    }
    return latest;
  }

  /** Frames held, for the logs and tests. */
  get frames(): number {
    return this.#frames;
  }

  /** The reference on a 10 ms grid from `fromMs` (continuous ms) for `frames` frames. */
  window(fromMs: number, frames: number): ReferenceWindow {
    const db = new Float32Array(Math.max(0, frames)).fill(Number.NaN);
    const captured = new Uint8Array(db.length);
    for (const segment of this.#segments) {
      const offset = Math.round((segment.startMs - fromMs) / ENVELOPE_FRAME_MS);
      if (offset >= db.length || offset + segment.levels.length <= 0) continue;
      for (let i = Math.max(0, -offset); i < segment.levels.length; i++) {
        const at = offset + i;
        if (at >= db.length) break;
        const level = segment.levels[i] ?? Number.NaN;
        captured[at] = 1;
        db[at] = level < ENVELOPE_SILENT_DB ? Number.NaN : level;
      }
    }
    return { reference: { startMs: fromMs, db }, captured };
  }

  /** Forgets everything (a new boot's clock, or core closing). */
  clear(): void {
    this.#segments = [];
    this.#frames = 0;
  }

  #prune(): void {
    const latest = this.latestMs;
    if (latest === null) return;
    const keepFrom = latest - SELF_REFERENCE_RETENTION_MS;
    while (this.#segments.length > 0) {
      const first = this.#segments[0];
      if (first === undefined) break;
      const end = first.startMs + first.levels.length * ENVELOPE_FRAME_MS;
      if (end > keepFrom && this.#frames <= MAX_FRAMES) break;
      this.#segments.shift();
      this.#frames -= first.levels.length;
    }
  }
}
