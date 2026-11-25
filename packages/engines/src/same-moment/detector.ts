import { ENVELOPE_FRAME_MS, type Envelope } from "./envelope.ts";
import { correlate, nextPowerOfTwo, spectrum } from "./fft.ts";
import { highPass, mean, median, type Feature } from "./features.ts";

// Whether a phone recording and a Mac recording heard the same meeting, and
// the offset between their clocks (ADR 032). The wall clocks only propose;
// the sound decides. Both energy envelopes lose their slow level (each
// microphone has its own gain, distance and noise), then:
//
// 1. Coarse: at 100 ms, the normalized cross-correlation over every lag the
//    clocks allow (FFT), holes left out of both the sums and the energies.
//    The best lag (a minute in both) must stand out from all the others
//    (20 s in both), each on Fisher's scale weighted by its overlap, so two
//    recordings of exactly a minute are judged against the lags around.
// 2. Fine: at 10 ms, each 20 s window of the phone's envelope finds its own
//    lag within ±500 ms of the coarse one. A line through the windows that
//    agree gives the offset and the drift between the two sample clocks
//    (tens of ppm, so up to a few hundred ms over three hours).
//
// Two rooms with speech at the same hour give no coarse peak above the
// others and windows that disagree: no link.

export interface SameMomentSearch {
  /** The offset the wall clocks propose (Mac wall − phone wall), ms. */
  readonly expectedOffsetMs: number;
  /** How far from it the true offset may be, ms. */
  readonly toleranceMs: number;
}

/** What one comparison found; the numbers are kept for the bench and the logs. */
export interface SameMomentMeasure {
  /** Normalized correlation of the best coarse lag. */
  readonly peak: number;
  /** How far it stands above the other lags, in standard deviations. */
  readonly prominence: number;
  /** Fine windows with enough sound in both, and those on the fitted line. */
  readonly windows: number;
  readonly agreeing: number;
  /** Median correlation of the agreeing windows; 0 when none. */
  readonly score: number;
}

export type SameMomentVerdict =
  | (SameMomentMeasure & {
      readonly linked: true;
      /** Mac wall − phone wall at `anchorMs`, ms. */
      readonly offsetMs: number;
      /** How the offset moves per second of the phone's clock, in millionths. */
      readonly driftPpm: number;
      /** Phone wall time where `offsetMs` was measured: the middle of the agreeing windows. */
      readonly anchorMs: number;
      /** The time both heard, on the Mac's clock. */
      readonly sharedFromMs: number;
      readonly sharedToMs: number;
      /** Speech above each one's own noise floor over the shared time, dB. */
      readonly clarity: { readonly phone: number; readonly mac: number };
    })
  | (SameMomentMeasure & {
      readonly linked: false;
      /** `too-short`: under a minute of sound in both at any lag. */
      readonly reason: "too-short" | "no-peak" | "disagree";
    });

/** A detector behind the engine contract (ADR 005): its id is stored with each link. */
export interface SameMomentDetector {
  /** `<method>/<version>`: a link made by another version is computed again. */
  readonly id: string;
  detect(phone: Envelope, mac: Envelope, search: SameMomentSearch): SameMomentVerdict;
}

/** The thresholds, set on synthetic pairs; the bench measures them on real ones. */
export interface SameMomentThresholds {
  readonly minSharedMs: number;
  readonly minPeak: number;
  readonly minProminence: number;
  readonly minWindowCorrelation: number;
  readonly minScore: number;
  readonly minAgreeing: number;
  readonly minAgreeingShare: number;
  readonly maxDriftPpm: number;
}

export const SAME_MOMENT_THRESHOLDS: SameMomentThresholds = {
  minSharedMs: 60_000,
  minPeak: 0.25,
  minProminence: 8,
  minWindowCorrelation: 0.3,
  minScore: 0.4,
  minAgreeing: 3,
  minAgreeingShare: 0.5,
  maxDriftPpm: 300,
};

const COARSE = 10; // 10 ms frames per coarse frame
const COARSE_MS = ENVELOPE_FRAME_MS * COARSE;
const WINDOW = 2_000; // fine frames: 20 s
const SEARCH = 50; // fine frames each side: ±500 ms
const AGREE = 3; // fine frames: 30 ms from the line
/** Coarse frames in both for a lag to count in the background: 20 s. */
const BACKGROUND_FRAMES = 200;
/** Without a background to judge the peak, every window must agree this well. */
const UNJUDGED_MIN_SCORE = 0.5;

export function createEnvelopeDetector(
  thresholds: SameMomentThresholds = SAME_MOMENT_THRESHOLDS,
): SameMomentDetector {
  return {
    id: "envelope-xcorr/1",
    detect: (phone, mac, search) => detect(phone, mac, search, thresholds),
  };
}

function detect(
  phone: Envelope,
  mac: Envelope,
  search: SameMomentSearch,
  t: SameMomentThresholds,
): SameMomentVerdict {
  const base = mac.startMs - phone.startMs;
  // Coarse: phone frame i against Mac frame i + k; offset = base + k·100 ms.
  const a = highPass(decimate(phone.db), 10);
  const b = highPass(decimate(mac.db), 10);
  const n = a.x.length;
  const m = b.x.length;
  const none = { peak: 0, prominence: 0, windows: 0, agreeing: 0, score: 0 };
  if (n === 0 || m === 0) return { linked: false, reason: "too-short", ...none };
  const size = nextPowerOfTwo(n + m);
  const sa = spectrum(a.x, size);
  const sb = spectrum(b.x, size);
  const ma = spectrum(a.valid, size);
  const mb = spectrum(b.valid, size);
  const num = correlate(sa, sb);
  const energyA = correlate(spectrum(square(a.x), size), mb);
  const energyB = correlate(ma, spectrum(square(b.x), size));
  const joint = correlate(ma, mb);
  const k0 = Math.round((search.expectedOffsetMs - base) / COARSE_MS);
  const span = Math.ceil(search.toleranceMs / COARSE_MS);
  const minJoint = t.minSharedMs / COARSE_MS;
  // Every lag with 20 s in both is background; only those with a minute may be the peak.
  const lags: { k: number; r: number; joint: number }[] = [];
  for (let k = Math.max(k0 - span, -(n - 1)); k <= Math.min(k0 + span, m - 1); k++) {
    const at = k >= 0 ? k : size + k;
    const shared = Math.round(joint[at] ?? 0);
    if (shared < BACKGROUND_FRAMES) continue;
    const denominator = Math.sqrt(Math.max(energyA[at] ?? 0, 0) * Math.max(energyB[at] ?? 0, 0));
    lags.push({ k, r: denominator > 0 ? (num[at] ?? 0) / denominator : 0, joint: shared });
  }
  let best = -1;
  for (const [i, lag] of lags.entries()) {
    if (lag.joint < minJoint) continue;
    if (best < 0 || lag.r > (lags[best]?.r ?? 0)) best = i;
  }
  const top = lags[best];
  if (top === undefined) return { linked: false, reason: "too-short", ...none };
  const peak = top.r;
  // Each lag's correlation on one scale whatever its overlap: Fisher's z times
  // the square root of the frames it holds, so a short overlap's noisier
  // lags are not taken for a peak, nor make a real one look small.
  const scaled = (lag: { r: number; joint: number }) =>
    Math.atanh(Math.max(-0.999, Math.min(0.999, lag.r))) * Math.sqrt(lag.joint);
  const others = lags.filter((lag) => Math.abs(lag.k - top.k) > 5).map(scaled);
  // Too few other lags to judge the peak against (both recordings about a
  // minute, searched a few seconds): the windows decide alone, all agreeing.
  const judged = others.length >= 10;
  const prominence = judged ? (scaled(top) - mean(others)) / (deviation(others) || 1e-9) : 0;
  const coarse = { peak, prominence };
  if (peak < t.minPeak || (judged && prominence < t.minProminence)) {
    return { linked: false, reason: "no-peak", ...coarse, windows: 0, agreeing: 0, score: 0 };
  }

  // Fine: 10 ms, window by window around the coarse lag.
  const fa = highPass(phone.db, 100);
  const fb = highPass(mac.db, 100);
  const center = top.k * COARSE;
  const points: { t: number; lag: number; r: number }[] = [];
  let windows = 0;
  for (let start = 0; start + WINDOW / 2 <= fa.x.length; start += WINDOW) {
    const end = Math.min(start + WINDOW, fa.x.length);
    const found = bestWindowLag(fa, fb, start, end, center);
    if (found === null) continue;
    windows += 1;
    if (found.r >= t.minWindowCorrelation) points.push({ t: (start + end) / 2, ...found });
  }
  const line = fitLine(points);
  const agreeing =
    line === null ? [] : points.filter((p) => Math.abs(p.lag - lineAt(line, p.t)) <= AGREE);
  const score = median(agreeing.map((p) => p.r));
  const measure = { ...coarse, windows, agreeing: agreeing.length, score };
  const refined = agreeing.length >= 2 ? leastSquares(agreeing) : line;
  if (
    refined === null ||
    agreeing.length < t.minAgreeing ||
    agreeing.length < t.minAgreeingShare * windows ||
    (!judged && (agreeing.length < windows || score < UNJUDGED_MIN_SCORE)) ||
    score < t.minScore ||
    Math.abs(refined.slope) * 1e6 > t.maxDriftPpm
  ) {
    return { linked: false, reason: "disagree", ...measure };
  }
  const anchorFrame = mean(agreeing.map((p) => p.t));
  const offsetMs = base + lineAt(refined, anchorFrame) * ENVELOPE_FRAME_MS;
  const phoneEndMs = phone.startMs + phone.db.length * ENVELOPE_FRAME_MS;
  const macEndMs = mac.startMs + mac.db.length * ENVELOPE_FRAME_MS;
  const sharedFromMs = Math.max(mac.startMs, phone.startMs + offsetMs);
  const sharedToMs = Math.min(macEndMs, phoneEndMs + offsetMs);
  return {
    linked: true,
    ...measure,
    offsetMs: Math.round(offsetMs),
    driftPpm: Math.round(refined.slope * 1e6 * 10) / 10,
    anchorMs: Math.round(phone.startMs + anchorFrame * ENVELOPE_FRAME_MS),
    sharedFromMs: Math.round(sharedFromMs),
    sharedToMs: Math.round(Math.max(sharedFromMs, sharedToMs)),
    clarity: {
      phone: clarity(phone, sharedFromMs - offsetMs, sharedToMs - offsetMs),
      mac: clarity(mac, sharedFromMs, sharedToMs),
    },
  };
}

/** 100 ms frames: the mean of the heard 10 ms ones, a hole when fewer than half were heard. */
function decimate(db: Float32Array): Float32Array {
  const out = new Float32Array(Math.ceil(db.length / COARSE));
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = i * COARSE; j < Math.min((i + 1) * COARSE, db.length); j++) {
      const value = db[j] ?? Number.NaN;
      if (Number.isNaN(value)) continue;
      sum += value;
      count += 1;
    }
    out[i] = count >= COARSE / 2 ? sum / count : Number.NaN;
  }
  return out;
}

/** The best fine lag of phone frames `[start, end)`, within ±`SEARCH` of `center`. */
function bestWindowLag(
  a: Feature,
  b: Feature,
  start: number,
  end: number,
  center: number,
): { lag: number; r: number } | null {
  const minJoint = (end - start) / 2;
  const scores = new Float64Array(2 * SEARCH + 1).fill(Number.NaN);
  for (let d = -SEARCH; d <= SEARCH; d++) {
    const lag = center + d;
    let product = 0;
    let ea = 0;
    let eb = 0;
    let joint = 0;
    const from = Math.max(start, -lag);
    const to = Math.min(end, b.x.length - lag);
    for (let i = from; i < to; i++) {
      if (a.valid[i] === 0 || b.valid[i + lag] === 0) continue;
      const x = a.x[i] ?? 0;
      const y = b.x[i + lag] ?? 0;
      product += x * y;
      ea += x * x;
      eb += y * y;
      joint += 1;
    }
    if (joint < minJoint || ea === 0 || eb === 0) continue;
    scores[d + SEARCH] = product / Math.sqrt(ea * eb);
  }
  let best = -1;
  for (let i = 0; i < scores.length; i++) {
    const value = scores[i] ?? Number.NaN;
    if (Number.isNaN(value)) continue;
    if (best < 0 || value > (scores[best] ?? 0)) best = i;
  }
  if (best < 0) return null;
  const r = scores[best] ?? 0;
  // A parabola through the peak and its neighbours places it between frames.
  const left = scores[best - 1] ?? Number.NaN;
  const right = scores[best + 1] ?? Number.NaN;
  let shift = 0;
  if (!Number.isNaN(left) && !Number.isNaN(right)) {
    const curvature = left - 2 * r + right;
    if (curvature < 0) shift = Math.max(-0.5, Math.min(0.5, (0.5 * (left - right)) / curvature));
  }
  return { lag: center + best - SEARCH + shift, r };
}

interface Line {
  readonly intercept: number;
  readonly slope: number;
}

const lineAt = (line: Line, t: number) => line.intercept + line.slope * t;

/** A robust line (Theil–Sen): the median slope of pairs, then the median intercept. */
function fitLine(points: readonly { t: number; lag: number }[]): Line | null {
  if (points.length === 0) return null;
  if (points.length === 1) return { intercept: points[0]?.lag ?? 0, slope: 0 };
  const stride = Math.max(1, Math.floor(points.length / 150));
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i += stride) {
    for (let j = i + stride; j < points.length; j += stride) {
      const p = points[i];
      const q = points[j];
      if (p === undefined || q === undefined || q.t === p.t) continue;
      slopes.push((q.lag - p.lag) / (q.t - p.t));
    }
  }
  const slope = median(slopes);
  return { slope, intercept: median(points.map((p) => p.lag - slope * p.t)) };
}

function leastSquares(points: readonly { t: number; lag: number }[]): Line {
  const mt = mean(points.map((p) => p.t));
  const ml = mean(points.map((p) => p.lag));
  let sxy = 0;
  let sxx = 0;
  for (const p of points) {
    sxy += (p.t - mt) * (p.lag - ml);
    sxx += (p.t - mt) ** 2;
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  return { slope, intercept: ml - slope * mt };
}

/**
 * Speech above the noise floor over `[fromMs, toMs)` of an envelope's own
 * clock: the mean of its loudest 30 % of frames minus its 10th percentile.
 */
function clarity(envelope: Envelope, fromMs: number, toMs: number): number {
  const first = Math.max(0, Math.floor((fromMs - envelope.startMs) / ENVELOPE_FRAME_MS));
  const last = Math.min(
    envelope.db.length,
    Math.ceil((toMs - envelope.startMs) / ENVELOPE_FRAME_MS),
  );
  const levels: number[] = [];
  for (let i = first; i < last; i++) {
    const value = envelope.db[i] ?? Number.NaN;
    if (!Number.isNaN(value)) levels.push(value);
  }
  if (levels.length === 0) return 0;
  levels.sort((x, y) => x - y);
  const floor = levels[Math.floor(levels.length * 0.1)] ?? 0;
  const loud = levels.slice(Math.floor(levels.length * 0.7));
  return Math.round((mean(loud) - floor) * 10) / 10;
}

function square(values: Float64Array): Float64Array {
  return values.map((value) => value * value);
}

function deviation(values: readonly number[]): number {
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}
