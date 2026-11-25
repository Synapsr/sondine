// What the envelope detectors read of a 10 ms energy envelope: its level
// minus its local mean, so each microphone's own gain, distance and noise
// floor fall away and only the shape of the sound is compared (ADR 032).
// The same-moment detector (`envelope-xcorr/1`) and the self-playback echo
// detector (`envelope-echo/1`) share it.

/** How far a frame may stand from its local mean, dB: one loud click does not decide. */
export const CLAMP_DB = 20;

export interface Feature {
  /** Level minus its local mean, clamped; 0 in holes. */
  readonly x: Float64Array;
  /** 1 where heard. */
  readonly valid: Uint8Array;
}

/** Each level minus the mean of the heard levels within `half` frames each side. */
export function highPass(db: Float32Array, half: number): Feature {
  const n = db.length;
  const sum = new Float64Array(n + 1);
  const count = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const value = db[i] ?? Number.NaN;
    const heard = !Number.isNaN(value);
    sum[i + 1] = (sum[i] ?? 0) + (heard ? value : 0);
    count[i + 1] = (count[i] ?? 0) + (heard ? 1 : 0);
  }
  const x = new Float64Array(n);
  const valid = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const value = db[i] ?? Number.NaN;
    if (Number.isNaN(value)) continue;
    const lo = Math.max(0, i - half);
    const hi = Math.min(n, i + half + 1);
    const heard = (count[hi] ?? 0) - (count[lo] ?? 0);
    if (heard < half) continue;
    const local = ((sum[hi] ?? 0) - (sum[lo] ?? 0)) / heard;
    x[i] = Math.max(-CLAMP_DB, Math.min(CLAMP_DB, value - local));
    valid[i] = 1;
  }
  return { x, valid };
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function median(values: readonly number[]): number {
  return quantile(values, 0.5);
}

/** The `q` quantile (0 to 1) of `values`, between the two nearest ranks for the median; 0 when empty. */
export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((x, y) => x - y);
  if (q === 0.5) {
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
      ? (sorted[middle] ?? 0)
      : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  }
  const at = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[at] ?? 0;
}
