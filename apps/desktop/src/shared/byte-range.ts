// HTTP byte ranges (RFC 9110 §14) for the `sondine-media:` scheme. Main
// parses the window's `Range` header; core resolves it against the WAV's
// length and reads one slice at a time. No Electron import.

/**
 * The most bytes core reads, mixes and sends for one media request: about
 * 32 s of 16 kHz mono PCM16. A longer range travels as several slices.
 */
export const MEDIA_SLICE_BYTES = 1024 * 1024;

export type ByteRangeSpec =
  /** `bytes=<start>-` (end null) or `bytes=<start>-<end>`, end inclusive. */
  | { readonly kind: "range"; readonly start: number; readonly end: number | null }
  /** `bytes=-<length>`: the last `length` bytes. */
  | { readonly kind: "suffix"; readonly length: number };

/** Inclusive byte bounds within the body. */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

const digits = (text: string) => Math.min(Number(text), Number.MAX_SAFE_INTEGER);

/**
 * The single byte range a `Range` header asks for, or null when the whole
 * body is to be sent: no header, another unit, several ranges, or a
 * malformed one (RFC 9110 lets a server ignore all three).
 */
export function parseRangeHeader(header: string | null): ByteRangeSpec | null {
  if (header === null) return null;
  const unit = /^\s*bytes\s*=\s*(.*?)\s*$/i.exec(header);
  const set = unit?.[1];
  if (set === undefined || set.includes(",")) return null;
  const suffix = /^-(\d+)$/.exec(set);
  if (suffix?.[1] !== undefined) return { kind: "suffix", length: digits(suffix[1]) };
  const range = /^(\d+)-(\d*)$/.exec(set);
  if (range?.[1] === undefined) return null;
  const start = digits(range[1]);
  const end = range[2] === undefined || range[2] === "" ? null : digits(range[2]);
  if (end !== null && end < start) return null;
  return { kind: "range", start, end };
}

/** The bytes a range covers in a body of `total` bytes, or null when none (`416`). */
export function resolveByteRange(spec: ByteRangeSpec, total: number): ByteRange | null {
  if (total <= 0) return null;
  if (spec.kind === "suffix") {
    if (spec.length === 0) return null;
    return { start: Math.max(0, total - spec.length), end: total - 1 };
  }
  if (spec.start >= total) return null;
  return { start: spec.start, end: Math.min(spec.end ?? total - 1, total - 1) };
}
