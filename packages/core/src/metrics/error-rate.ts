/** Bump when the alignment costs or tie-breaking change any count. */
export const ERROR_RATE_VERSION = "error-rate/1";

/** Above this many DP cells, ask for counts only (`alignment: false`). */
export const MAX_ALIGNMENT_CELLS = 50_000_000;

export type EditOp = "match" | "substitution" | "insertion" | "deletion";

export interface AlignmentStep {
  readonly op: EditOp;
  readonly ref: string | null;
  readonly hyp: string | null;
  readonly refIndex: number | null;
  readonly hypIndex: number | null;
}

export interface ErrorCounts {
  readonly hits: number;
  readonly substitutions: number;
  readonly insertions: number;
  readonly deletions: number;
  /** substitutions + insertions + deletions: the Levenshtein distance. */
  readonly errors: number;
  readonly refLength: number;
  readonly hypLength: number;
}

export interface ErrorRateResult extends ErrorCounts {
  /** errors / refLength; 0 for two empty inputs; null for an empty reference with insertions. */
  readonly rate: number | null;
  /** Null when computed with `alignment: false`. */
  readonly alignment: readonly AlignmentStep[] | null;
}

export interface ErrorRateOptions {
  /** Return the alignment (default). Counts-only uses O(hyp) memory. */
  readonly alignment?: boolean;
}

/**
 * Word error rate on already normalized text. A string is split on
 * whitespace; an array is taken as the tokens.
 */
export function wordErrorRate(
  ref: string | readonly string[],
  hyp: string | readonly string[],
  options: ErrorRateOptions = {},
): ErrorRateResult {
  return errorRate(toWords(ref), toWords(hyp), options);
}

/** Character error rate over Unicode code points, spaces included (as jiwer does). */
export function charErrorRate(
  ref: string,
  hyp: string,
  options: ErrorRateOptions = {},
): ErrorRateResult {
  return errorRate(Array.from(ref), Array.from(hyp), options);
}

/** Corpus-level counts and rate: sums the counts, never averages the rates. */
export function sumErrorCounts(
  results: readonly ErrorCounts[],
): ErrorCounts & { readonly rate: number | null } {
  const total = results.reduce(
    (sum, r) => ({
      hits: sum.hits + r.hits,
      substitutions: sum.substitutions + r.substitutions,
      insertions: sum.insertions + r.insertions,
      deletions: sum.deletions + r.deletions,
      errors: sum.errors + r.errors,
      refLength: sum.refLength + r.refLength,
      hypLength: sum.hypLength + r.hypLength,
    }),
    {
      hits: 0,
      substitutions: 0,
      insertions: 0,
      deletions: 0,
      errors: 0,
      refLength: 0,
      hypLength: 0,
    },
  );
  return { ...total, rate: rateOf(total) };
}

export function rateOf(counts: Pick<ErrorCounts, "errors" | "refLength">): number | null {
  if (counts.refLength > 0) return counts.errors / counts.refLength;
  return counts.errors === 0 ? 0 : null;
}

function toWords(input: string | readonly string[]): readonly string[] {
  if (typeof input !== "string") return input;
  const trimmed = input.trim();
  return trimmed === "" ? [] : trimmed.split(/\s+/u);
}

/**
 * Levenshtein alignment with unit costs. Among the alignments with the fewest
 * errors it picks the one with the fewest substitutions (so the most hits),
 * which makes the S/I/D breakdown unique: "a b" vs "b c" is one deletion, one
 * hit, one insertion, not two substitutions. Costs are packed as
 * errors * K + substitutions with K above any substitution count.
 */
function errorRate(
  ref: readonly string[],
  hyp: readonly string[],
  options: ErrorRateOptions,
): ErrorRateResult {
  const counts = options.alignment === false ? countOnly(ref, hyp) : null;
  if (counts !== null) return { ...counts, rate: rateOf(counts), alignment: null };
  const { alignment, counts: aligned } = align(ref, hyp);
  return { ...aligned, rate: rateOf(aligned), alignment };
}

const DIAGONAL = 0;
const UP = 1;
const LEFT = 2;

function align(
  ref: readonly string[],
  hyp: readonly string[],
): { alignment: AlignmentStep[]; counts: ErrorCounts } {
  const n = ref.length;
  const m = hyp.length;
  const cells = (n + 1) * (m + 1);
  if (cells > MAX_ALIGNMENT_CELLS) {
    throw new RangeError(
      `alignment needs ${cells} cells; pass { alignment: false } for counts only`,
    );
  }
  const k = Math.min(n, m) + 1;
  const moves = new Uint8Array(cells);
  let previous = new Float64Array(m + 1);
  let current = new Float64Array(m + 1);
  for (let j = 0; j <= m; j += 1) {
    previous[j] = j * k;
    moves[j] = LEFT;
  }
  for (let i = 1; i <= n; i += 1) {
    current[0] = i * k;
    moves[i * (m + 1)] = UP;
    const r = ref[i - 1];
    for (let j = 1; j <= m; j += 1) {
      const diagonal = (previous[j - 1] ?? 0) + (r === hyp[j - 1] ? 0 : k + 1);
      const up = (previous[j] ?? 0) + k;
      const left = (current[j - 1] ?? 0) + k;
      let best = diagonal;
      let move = DIAGONAL;
      if (up < best) {
        best = up;
        move = UP;
      }
      if (left < best) {
        best = left;
        move = LEFT;
      }
      current[j] = best;
      moves[i * (m + 1) + j] = move;
    }
    [previous, current] = [current, previous];
  }

  const steps: AlignmentStep[] = [];
  let hits = 0;
  let substitutions = 0;
  let insertions = 0;
  let deletions = 0;
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const move = i === 0 ? LEFT : j === 0 ? UP : moves[i * (m + 1) + j];
    if (move === DIAGONAL) {
      const r = ref[i - 1] ?? null;
      const h = hyp[j - 1] ?? null;
      const op: EditOp = r === h ? "match" : "substitution";
      if (op === "match") hits += 1;
      else substitutions += 1;
      steps.push({ op, ref: r, hyp: h, refIndex: i - 1, hypIndex: j - 1 });
      i -= 1;
      j -= 1;
    } else if (move === UP) {
      deletions += 1;
      steps.push({
        op: "deletion",
        ref: ref[i - 1] ?? null,
        hyp: null,
        refIndex: i - 1,
        hypIndex: null,
      });
      i -= 1;
    } else {
      insertions += 1;
      steps.push({
        op: "insertion",
        ref: null,
        hyp: hyp[j - 1] ?? null,
        refIndex: null,
        hypIndex: j - 1,
      });
      j -= 1;
    }
  }
  steps.reverse();
  return {
    alignment: steps,
    counts: {
      hits,
      substitutions,
      insertions,
      deletions,
      errors: substitutions + insertions + deletions,
      refLength: n,
      hypLength: m,
    },
  };
}

/** Same costs as `align`, two rows only; the S/I/D split follows from the totals. */
function countOnly(ref: readonly string[], hyp: readonly string[]): ErrorCounts {
  const n = ref.length;
  const m = hyp.length;
  const k = Math.min(n, m) + 1;
  let previous = new Float64Array(m + 1);
  let current = new Float64Array(m + 1);
  for (let j = 0; j <= m; j += 1) previous[j] = j * k;
  for (let i = 1; i <= n; i += 1) {
    current[0] = i * k;
    const r = ref[i - 1];
    for (let j = 1; j <= m; j += 1) {
      const diagonal = (previous[j - 1] ?? 0) + (r === hyp[j - 1] ? 0 : k + 1);
      const up = (previous[j] ?? 0) + k;
      const left = (current[j - 1] ?? 0) + k;
      current[j] = Math.min(diagonal, up, left);
    }
    [previous, current] = [current, previous];
  }
  const cost = previous[m] ?? 0;
  const errors = Math.floor(cost / k);
  const substitutions = cost - errors * k;
  // errors = S + D + I and hyp - ref = I - D give D and I from S.
  const deletions = (errors - substitutions - (m - n)) / 2;
  const insertions = deletions + (m - n);
  return {
    hits: n - substitutions - deletions,
    substitutions,
    insertions,
    deletions,
    errors,
    refLength: n,
    hypLength: m,
  };
}
