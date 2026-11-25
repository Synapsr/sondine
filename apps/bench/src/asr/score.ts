import { rateOf, sumErrorCounts, type ErrorCounts } from "@sondine/core";

// Pooled error rates with a 95 % interval: items resampled with replacement
// (FLEURS utterances are independent readings); the rate always pools counts,
// never averages per-item rates. Seeded, so a result is reproducible.

const RESAMPLES = 1_000;

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function bootstrapRate(
  counts: readonly ErrorCounts[],
  seed = 20261106,
): { readonly rate: number | null; readonly ci95: readonly [number, number] | null } {
  const rate = sumErrorCounts(counts).rate;
  if (counts.length < 2 || rate === null) return { rate, ci95: null };
  const random = seeded(seed);
  const rates: number[] = [];
  for (let round = 0; round < RESAMPLES; round += 1) {
    let errors = 0;
    let refLength = 0;
    for (let index = 0; index < counts.length; index += 1) {
      const picked = counts[Math.floor(random() * counts.length)];
      if (picked === undefined) continue;
      errors += picked.errors;
      refLength += picked.refLength;
    }
    const resampled = rateOf({ errors, refLength });
    if (resampled !== null) rates.push(resampled);
  }
  rates.sort((a, b) => a - b);
  const at = (share: number) =>
    rates[Math.min(rates.length - 1, Math.floor(share * rates.length))] ?? 0;
  return { rate, ci95: [at(0.025), at(0.975)] };
}
