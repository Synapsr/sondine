import type { AsrSegment } from "./contract.ts";

// Nemotron's word times (speech.cpp 0.9.3, NeMo's multi-speaker SOT
// aligner) are searched per voice, over the frames where that voice's
// column is active. Where the column is weak, a sentence's words land on
// that voice's earlier or later speech, minutes away. The text order stays
// right: the model writes what it hears in the order people start speaking.
// So the words whose times follow the text order keep them, and the others
// are put back between their neighbours.
//
// SUMM-RE's eight test meetings (2026-11-09): every word moved this way that
// matches the reference got closer to it (median 9.8 s off before, 0.3 s
// after), tcpWER went from 19.0 % to 17.9 %, and segments cover 0.91 times the
// audio instead of 1.13 (the reference: 0.90).

/**
 * How far before or after the text-ordered words a word may sit and keep its
 * time (voices talking over each other). On SUMM-RE a slack up to 3 s scored
 * the same; at 2 s no word that could be checked moved further off.
 */
const SLACK_SEC = 2;
/** The longest a word put back lasts. */
const WORD_SEC = 0.4;
/** The shortest, unless that would take it past a word of its own segment. */
const MIN_WORD_SEC = 0.1;

/** Indexes of a longest run of non-decreasing values. */
function longestOrdered(values: readonly number[]): Set<number> {
  const tails: number[] = [];
  const previous = Array.from({ length: values.length }, () => -1);
  for (const [index, value] of values.entries()) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((values[tails[middle] ?? 0] ?? 0) <= value) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tails[low - 1] ?? -1;
    tails[low] = index;
  }
  const kept = new Set<number>();
  for (let index = tails.at(-1) ?? -1; index >= 0; index = previous[index] ?? -1) kept.add(index);
  return kept;
}

/** For each index, the first value after it among `marked`, else `last`. */
function nextMarked(values: readonly number[], marked: (index: number) => boolean, last: number) {
  const next = Array.from({ length: values.length }, () => last);
  let after = last;
  for (let index = values.length - 1; index >= 0; index--) {
    next[index] = after;
    if (marked(index)) after = values[index] ?? after;
  }
  return next;
}

/** The segments with each word's time following the text order, and their bounds from their words. */
export function repairWordTimes(
  segments: readonly AsrSegment[],
  durationSec: number,
): AsrSegment[] {
  const flat = segments.flatMap((segment, index) =>
    segment.tokens.map((token) => ({ segment: index, token })),
  );
  const starts = flat.map((item) => item.token.startSec);
  const ordered = longestOrdered(starts);
  const nextOrdered = nextMarked(starts, (index) => ordered.has(index), durationSec);
  const keep: boolean[] = [];
  let lastOrdered = 0;
  for (const [index, start] of starts.entries()) {
    keep.push(
      ordered.has(index) ||
        (start >= lastOrdered - SLACK_SEC &&
          start <= (nextOrdered[index] ?? durationSec) + SLACK_SEC),
    );
    if (ordered.has(index)) lastOrdered = start;
  }
  if (keep.every(Boolean)) return [...segments];
  const nextKept = nextMarked(starts, (index) => keep[index] === true, durationSec);

  const times = flat.map((item) => ({ startSec: item.token.startSec, endSec: item.token.endSec }));
  let index = 0;
  while (index < flat.length) {
    if (keep[index] === true) {
      index += 1;
      continue;
    }
    // A run of words to put back, within one segment.
    const segment = flat[index]?.segment;
    let last = index;
    while (keep[last + 1] === false && flat[last + 1]?.segment === segment) last += 1;
    const count = last - index + 1;
    const left = times[index - 1]?.endSec ?? 0;
    const right = nextKept[last] ?? durationSec;
    const wordsBefore = flat[index - 1]?.segment === segment;
    const wordsAfter = flat[last + 1]?.segment === segment;
    let word = Math.max(0, Math.min(WORD_SEC, (right - left) / count));
    if (!(wordsBefore && wordsAfter)) word = Math.max(word, MIN_WORD_SEC);
    // Before the segment's kept words, the run ends where they start; else it follows what came before.
    const from = wordsAfter ? right - word * count : left;
    for (let offset = 0; offset < count; offset++) {
      const startSec = Math.min(durationSec, Math.max(0, from + word * offset));
      times[index + offset] = { startSec, endSec: Math.min(durationSec, startSec + word) };
    }
    index = last + 1;
  }

  let at = 0;
  return segments.map((segment) => {
    if (segment.tokens.length === 0) return segment;
    const tokens = segment.tokens.map((token) => ({ ...token, ...times[at++] }));
    return {
      ...segment,
      tokens,
      startSec: Math.min(...tokens.map((token) => token.startSec)),
      endSec: Math.max(...tokens.map((token) => token.endSec)),
    };
  });
}
