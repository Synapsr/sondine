// A radix-2 complex FFT and the cross-correlation of two real sequences,
// for the same-moment detector's envelopes (ADR 032): a few hundred
// thousand points at most, so plain typed arrays are enough.

/** The smallest power of two at least `n`. */
export function nextPowerOfTwo(n: number): number {
  let size = 1;
  while (size < n) size *= 2;
  return size;
}

/** In place: `re`, `im` of a power-of-two length; `inverse` scales by 1/n. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if (n !== im.length || (n & (n - 1)) !== 0) throw new RangeError("FFT size must be a power of 2");
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; (j & bit) !== 0; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i] ?? 0;
      re[i] = re[j] ?? 0;
      re[j] = tr;
      const ti = im[i] ?? 0;
      im[i] = im[j] ?? 0;
      im[j] = ti;
    }
  }
  for (let length = 2; length <= n; length *= 2) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / length;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    const half = length / 2;
    for (let start = 0; start < n; start += length) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = start + k;
        const b = a + half;
        const br = re[b] ?? 0;
        const bi = im[b] ?? 0;
        const xr = br * cr - bi * ci;
        const xi = br * ci + bi * cr;
        const ar = re[a] ?? 0;
        const ai = im[a] ?? 0;
        re[a] = ar + xr;
        im[a] = ai + xi;
        re[b] = ar - xr;
        im[b] = ai - xi;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] = (re[i] ?? 0) / n;
      im[i] = (im[i] ?? 0) / n;
    }
  }
}

/** The spectrum of a real sequence zero-padded to `size`. */
export interface Spectrum {
  readonly re: Float64Array;
  readonly im: Float64Array;
}

export function spectrum(values: ArrayLike<number>, size: number): Spectrum {
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < values.length; i++) re[i] = values[i] ?? 0;
  fft(re, im);
  return { re, im };
}

/**
 * `c[k] = Σ a[i]·b[i + k]` from the spectra of `a` and `b` (same size, at
 * least `a.length + b.length`): `c[k]` is at index `k` for `k ≥ 0` and at
 * `size + k` for `k < 0`.
 */
export function correlate(a: Spectrum, b: Spectrum): Float64Array {
  const size = a.re.length;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    const ar = a.re[i] ?? 0;
    const ai = -(a.im[i] ?? 0);
    const br = b.re[i] ?? 0;
    const bi = b.im[i] ?? 0;
    re[i] = ar * br - ai * bi;
    im[i] = ar * bi + ai * br;
  }
  fft(re, im, true);
  return re;
}
