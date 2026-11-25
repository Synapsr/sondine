import { ENVELOPE_FRAME_MS, type Envelope } from "../same-moment/envelope.ts";
import { highPass, quantile, type Feature } from "../same-moment/features.ts";

// Whether the microphone heard Sondine's own playback or a person (ADR 035).
// When Sondine plays a recording on the speakers, the microphone hears it
// again. The helper captures what Sondine plays as a private reference
// (`self:playback`, a 10 ms energy envelope and nothing else), and this
// detector compares it with the microphone's envelope over a speech region:
//
// 1. Lag: in 3 s windows, the normalized correlation of both envelopes
//    (local mean removed, as for the same moment) over every lag from 0 to
//    2 s; a window's best lag counts when it is strong and stands out from
//    the others, then each lag is the median of its neighbours'. Each frame
//    takes the lag of the nearest window, so a lag that changes (another
//    output buffer, a device) is followed.
// 2. What the playback explains: the reference at that lag, held through
//    the room's reverberation, plus the coupling from speaker to microphone
//    (a low quantile of their difference where the playback is loud), over
//    the microphone's noise floor. Where the microphone is clearly louder
//    than that, someone in the room spoke (near-end speech, double-talk
//    included); where it is not, the frame is echo.
//
// The region is echo when the playback explains most of its speech and
// nobody spoke over it; a person who spoke keeps the region, and the echo
// stretches inside it are returned so their words can leave the transcript.
// Without a reference over most of its speech, nothing is decided here.

export interface SelfEchoInput {
  /** What the microphone heard, on the reference's clock; it may reach around the stretch judged. */
  readonly mic: Envelope;
  /** What Sondine played: NaN where it played digital silence or was not captured. */
  readonly reference: Envelope;
  /** Per reference frame, 1 where the reference was captured (its silence included). */
  readonly captured: Uint8Array;
  /** The stretch judged (a speech region), ms on the same clock, half-open. */
  readonly fromMs: number;
  readonly toMs: number;
}

/** A stretch of the judged region that is echo, ms on the input's clock, half-open. */
export interface SelfEchoSpan {
  readonly fromMs: number;
  readonly toMs: number;
}

export interface SelfEchoVerdict {
  /**
   * `echo`: the playback explains the region's speech; `near-end`: someone in
   * the room spoke; `no-reference`: the reference covers too little of it.
   */
  readonly kind: "echo" | "near-end" | "no-reference";
  /** The region's frames above the microphone's noise floor, ms. */
  readonly voicedMs: number;
  /** Of those, the ones the reference covers. */
  readonly coveredMs: number;
  readonly echoMs: number;
  readonly nearEndMs: number;
  /** The lag the microphone heard the playback at, over the region; null when none stood out. */
  readonly lagMs: number | null;
  /** The best window correlation over the region; 0 when none was measured. */
  readonly correlation: number;
  /** Echo stretches of a `near-end` region, at least half a second each; empty otherwise. */
  readonly spans: readonly SelfEchoSpan[];
}

/** A detector behind the engine contract (ADR 005): its id is stored with each verdict. */
export interface SelfEchoDetector {
  /** `<method>/<version>`: a verdict made by another version is computed again. */
  readonly id: string;
  detect(input: SelfEchoInput): SelfEchoVerdict;
}

/** The thresholds, set on synthetic rooms; the bench measures them (`self-echo synthetic`). */
export interface SelfEchoThresholds {
  /** Longest lag searched, ms (AirPlay adds about two seconds; it is taken for speakers). */
  readonly maxLagMs: number;
  /** A window's best lag counts from this correlation… */
  readonly minWindowCorrelation: number;
  /** …standing this many standard deviations above the window's other lags. */
  readonly minProminence: number;
  /** A frame this far above its noise floor is speech, dB. */
  readonly voicedDb: number;
  /** A frame this far above what the playback explains is someone speaking, dB. */
  readonly nearEndDb: number;
  /** Near-end speech within any 2 s keeps the region from this much… */
  readonly minDenseNearEndMs: number;
  /** …and anywhere in it from this much… */
  readonly minNearEndMs: number;
  /** …and this share of its speech. */
  readonly minNearEndShare: number;
  /** The reference must cover this share of the region's speech. */
  readonly minCoveredShare: number;
}

export const SELF_ECHO_THRESHOLDS: SelfEchoThresholds = {
  maxLagMs: 2_000,
  minWindowCorrelation: 0.5,
  minProminence: 2,
  voicedDb: 6,
  nearEndDb: 7,
  minDenseNearEndMs: 300,
  minNearEndMs: 200,
  minNearEndShare: 0.1,
  minCoveredShare: 0.5,
};

const WINDOW = 300; // frames: 3 s
const HOP = 100; // frames: 1 s
const HALF = 50; // high-pass: ±500 ms
const MIN_JOINT = 100; // frames heard in both for a window lag: 1 s
const EXCLUDE = 5; // frames around the best lag left out of its background
/** How fast the room's echo dies away, dB per 10 ms frame (60 dB in half a second). */
const REVERB_DB_PER_FRAME = 1.2;
/** The coupling: this quantile of mic − reference where the playback is loud. */
const COUPLING_QUANTILE = 0.4;
/** Near-end frames count in runs of at least this many (a syllable). */
const MIN_NEAR_RUN = 8;
/** Echo stretches returned are at least this long, frames, and join over this much quiet. */
const MIN_SPAN = 50;
const SPAN_JOIN = 20;
/** Window lags each side in the running median. */
const LAG_MEDIAN = 2;
/** Reference frames each side of the lag that may explain a microphone frame: 50 ms. */
const SLACK = 5;
const ms = (frames: number) => frames * ENVELOPE_FRAME_MS;
/** Frames over which near-end speech is counted together: 2 s. */
const DENSE = 200;

export function createSelfEchoDetector(
  thresholds: SelfEchoThresholds = SELF_ECHO_THRESHOLDS,
): SelfEchoDetector {
  return { id: "envelope-echo/1", detect: (input) => detect(input, thresholds) };
}

interface WindowLag {
  readonly from: number;
  readonly to: number;
  readonly lag: number;
  readonly r: number;
}

function detect(input: SelfEchoInput, t: SelfEchoThresholds): SelfEchoVerdict {
  const { mic, reference, captured } = input;
  const n = mic.db.length;
  const base = Math.round((mic.startMs - reference.startMs) / ENVELOPE_FRAME_MS);
  const first = Math.max(0, Math.ceil((input.fromMs - mic.startMs) / ENVELOPE_FRAME_MS));
  const last = Math.min(n, Math.ceil((input.toMs - mic.startMs) / ENVELOPE_FRAME_MS));
  const maxLag = Math.round(t.maxLagMs / ENVELOPE_FRAME_MS);
  const refAt = (k: number) =>
    k >= 0 && k < reference.db.length ? (reference.db[k] ?? Number.NaN) : Number.NaN;
  const capturedAt = (k: number) => k >= 0 && k < captured.length && captured[k] === 1;

  const heard: number[] = [];
  for (let i = 0; i < n; i++) {
    const value = mic.db[i] ?? Number.NaN;
    if (!Number.isNaN(value)) heard.push(value);
  }
  const floor = quantile(heard, 0.1);
  const voiced = (i: number) => {
    const value = mic.db[i] ?? Number.NaN;
    return !Number.isNaN(value) && value >= floor + t.voicedDb;
  };

  // 1. Lags, window by window, over the whole microphone envelope (the context helps).
  const a = highPass(mic.db, HALF);
  const shifted = new Float32Array(n + maxLag);
  // shifted[i + maxLag] is the reference frame aligned with mic frame i at lag 0.
  for (let i = -maxLag; i < n; i++) {
    const k = base + i;
    shifted[i + maxLag] = capturedAt(k) ? refAt(k) : Number.NaN;
  }
  const b = highPass(shifted, HALF);
  const windows: WindowLag[] = [];
  for (let from = 0; from < n; from += HOP) {
    const to = Math.min(n, from + WINDOW);
    if (to - from < MIN_JOINT) break;
    const found = bestLag(a, b, from, to, maxLag, t);
    if (found !== null) windows.push({ from, to, ...found });
    if (to === n) break;
  }
  // A window may pick a syllable's echo of itself: each lag is the median
  // of its neighbours' (a change of lag stays a step).
  const smoothed = windows.map((window) => {
    const near = windows
      .filter((other) => Math.abs(other.from - window.from) <= LAG_MEDIAN * HOP)
      .map((other) => other.lag);
    return { ...window, lag: Math.round(quantile(near, 0.5)) };
  });
  // Each frame's lag is that of the strongest window over it (else the
  // nearest); near a change of lag, every lag of the windows over it may
  // explain it.
  const lagOf = new Int32Array(n).fill(-1);
  const rOf = new Float64Array(n);
  const candidates: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    let best: WindowLag | null = null;
    let distance = Number.POSITIVE_INFINITY;
    const over = candidates[i] ?? [];
    for (const window of smoothed) {
      const away = i < window.from ? window.from - i : i >= window.to ? i - window.to + 1 : 0;
      if (away === 0 && !over.includes(window.lag)) over.push(window.lag);
      if (away < distance || (away === distance && window.r > (best?.r ?? -1))) {
        best = window;
        distance = away;
      }
    }
    if (best === null) continue;
    lagOf[i] = best.lag;
    rOf[i] = best.r;
    if (over.length === 0) over.push(best.lag);
  }

  // 2. What the playback explains, frame by frame: at each lag, the loudest
  // reference frame within `SLACK` of it (reverberation smears the envelope,
  // so the lag found is a little late for onsets), held as the room's echo
  // dies away; the loudest of a frame's lags.
  const heldAt = new Map<number, Float64Array>();
  for (const lag of new Set(smoothed.map((window) => window.lag))) {
    const held = new Float64Array(n);
    let level = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < n; i++) {
      let top = Number.NaN;
      for (let d = -SLACK; d <= SLACK; d++) {
        const value = refAt(base + i - lag + d);
        if (!Number.isNaN(value) && !(value <= top)) top = value;
      }
      level = Number.isNaN(top)
        ? level - REVERB_DB_PER_FRAME
        : Math.max(top, level - REVERB_DB_PER_FRAME);
      held[i] = level;
    }
    heldAt.set(lag, held);
  }
  const level = new Float64Array(n).fill(Number.NEGATIVE_INFINITY);
  for (let i = 0; i < n; i++) {
    for (const lag of candidates[i] ?? []) {
      level[i] = Math.max(level[i] ?? 0, heldAt.get(lag)?.[i] ?? Number.NEGATIVE_INFINITY);
    }
  }
  // The coupling, read at each frame's own lag where the playback is loud.
  const exact = Float64Array.from({ length: n }, (_, i) =>
    (lagOf[i] ?? -1) < 0 ? Number.NaN : refAt(base + i - (lagOf[i] ?? 0)),
  );
  const refMedian = quantile(
    [...exact].filter((value) => !Number.isNaN(value)),
    0.5,
  );
  const loud: number[] = [];
  for (let i = 0; i < n; i++) {
    const value = exact[i] ?? Number.NaN;
    const heardHere = mic.db[i] ?? Number.NaN;
    if (!Number.isNaN(value) && value >= refMedian && !Number.isNaN(heardHere)) {
      loud.push(heardHere - value);
    }
  }
  const coupling = loud.length === 0 ? null : quantile(loud, COUPLING_QUANTILE);
  const floorPower = 10 ** (floor / 10);

  // 3. The region's frames.
  // 0 quiet, 1 uncovered, 2 echo, 3 near-end (above what the playback explains), 4 near-end
  // (no lag or coupling: nothing of the playback is recognizable).
  const kinds = new Uint8Array(Math.max(0, last - first));
  let voicedFrames = 0;
  let coveredFrames = 0;
  let correlation = 0;
  let lagSum = 0;
  let lagCount = 0;
  for (let i = first; i < last; i++) {
    if (!voiced(i)) continue;
    voicedFrames += 1;
    const lag = lagOf[i] ?? -1;
    if (!capturedAt(base + i - Math.max(0, lag))) {
      kinds[i - first] = 1;
      continue;
    }
    coveredFrames += 1;
    if (lag < 0 || coupling === null) {
      // The microphone does not hear the playback in any recognizable way.
      kinds[i - first] = 4;
      continue;
    }
    correlation = Math.max(correlation, rOf[i] ?? 0);
    lagSum += lag;
    lagCount += 1;
    const explained = 10 * Math.log10(10 ** (((level[i] ?? 0) + coupling) / 10) + floorPower);
    kinds[i - first] = (mic.db[i] ?? 0) - explained >= t.nearEndDb ? 3 : 2;
  }
  // A near-end blip shorter than a syllable is the playback's own unevenness;
  // without a lag there is no playback to blame it on, and it stays.
  for (let start = 0; start < kinds.length;) {
    if (kinds[start] !== 3) {
      start += 1;
      continue;
    }
    let end = start;
    while (end < kinds.length && kinds[end] === 3) end += 1;
    if (end - start < MIN_NEAR_RUN) kinds.fill(2, start, end);
    start = end;
  }
  let echoFrames = 0;
  let nearFrames = 0;
  for (const kind of kinds) {
    if (kind === 2) echoFrames += 1;
    else if (kind >= 3) nearFrames += 1;
  }
  const near = (kind: number) => kind >= 3;
  const densest = densestWithin(kinds, near);
  const measure = {
    voicedMs: ms(voicedFrames),
    coveredMs: ms(coveredFrames),
    echoMs: ms(echoFrames),
    nearEndMs: ms(nearFrames),
    lagMs: lagCount === 0 ? null : Math.round(ms(lagSum / lagCount)),
    correlation: Math.round(correlation * 1000) / 1000,
  };
  if (voicedFrames === 0 || coveredFrames < t.minCoveredShare * voicedFrames) {
    return { kind: "no-reference", ...measure, spans: [] };
  }
  // Speech the reference missed is not explained by it: a sentence's worth
  // of it keeps the region from being called echo.
  const unjudged = ms(densestWithin(kinds, (kind) => kind === 1)) >= t.minDenseNearEndMs;
  // Someone spoke: a sentence's worth somewhere, or a short reply that is a
  // fair share of a short region.
  const spoke =
    ms(densest) >= t.minDenseNearEndMs ||
    (ms(nearFrames) >= t.minNearEndMs && nearFrames >= t.minNearEndShare * coveredFrames);
  // Speech the playback does not explain stays: when unsure, the user's words stay.
  if (!spoke && unjudged) return { kind: "no-reference", ...measure, spans: [] };
  if (!spoke && echoFrames >= 0.5 * coveredFrames) {
    return { kind: "echo", ...measure, spans: [] };
  }
  return { kind: "near-end", ...measure, spans: echoSpans(kinds, mic.startMs, first) };
}

/** The best lag of mic frames `[from, to)`, when it stands out from the window's other lags. */
function bestLag(
  a: Feature,
  b: Feature,
  from: number,
  to: number,
  maxLag: number,
  t: SelfEchoThresholds,
): { lag: number; r: number } | null {
  const scores = new Float64Array(maxLag + 1).fill(Number.NaN);
  for (let lag = 0; lag <= maxLag; lag++) {
    let product = 0;
    let ea = 0;
    let eb = 0;
    let joint = 0;
    for (let i = from; i < to; i++) {
      const k = i + maxLag - lag;
      if (a.valid[i] === 0 || b.valid[k] === 0) continue;
      const x = a.x[i] ?? 0;
      const y = b.x[k] ?? 0;
      product += x * y;
      ea += x * x;
      eb += y * y;
      joint += 1;
    }
    if (joint < MIN_JOINT || ea === 0 || eb === 0) continue;
    scores[lag] = product / Math.sqrt(ea * eb);
  }
  let best = -1;
  for (let lag = 0; lag <= maxLag; lag++) {
    const value = scores[lag] ?? Number.NaN;
    if (!Number.isNaN(value) && (best < 0 || value > (scores[best] ?? 0))) best = lag;
  }
  if (best < 0) return null;
  const r = scores[best] ?? 0;
  if (r < t.minWindowCorrelation) return null;
  const others: number[] = [];
  for (let lag = 0; lag <= maxLag; lag++) {
    const value = scores[lag] ?? Number.NaN;
    if (!Number.isNaN(value) && Math.abs(lag - best) > EXCLUDE) others.push(value);
  }
  // A search of a few lags only has no background to judge against.
  if (others.length >= 20) {
    const average = others.reduce((sum, value) => sum + value, 0) / others.length;
    const spread = Math.sqrt(
      others.reduce((sum, value) => sum + (value - average) ** 2, 0) / others.length,
    );
    if ((r - average) / (spread || 1e-9) < t.minProminence) return null;
  }
  return { lag: best, r };
}

/** The most frames of a kind within any `DENSE` frames. */
function densestWithin(kinds: Uint8Array, counted: (kind: number) => boolean): number {
  let densest = 0;
  let count = 0;
  for (let i = 0; i < kinds.length; i++) {
    if (counted(kinds[i] ?? 0)) count += 1;
    if (i >= DENSE && counted(kinds[i - DENSE] ?? 0)) count -= 1;
    densest = Math.max(densest, count);
  }
  return densest;
}

/** Runs of echo frames, joined over short quiet stretches, at least `MIN_SPAN` long. */
function echoSpans(kinds: Uint8Array, startMs: number, first: number): SelfEchoSpan[] {
  const spans: SelfEchoSpan[] = [];
  let start = -1;
  let end = -1;
  const flush = () => {
    if (start >= 0 && end - start >= MIN_SPAN) {
      spans.push({
        fromMs: startMs + (first + start) * ENVELOPE_FRAME_MS,
        toMs: startMs + (first + end) * ENVELOPE_FRAME_MS,
      });
    }
    start = -1;
  };
  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i] ?? 0;
    if (kind === 2) {
      if (start < 0) start = i;
      end = i + 1;
    } else if (kind !== 0 || (start >= 0 && i - end >= SPAN_JOIN)) {
      flush();
    }
  }
  flush();
  return spans;
}
