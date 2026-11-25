import { phoneticKey } from "./phonetic";

// Personal vocabulary (M4): the names the user taught, put back in new
// transcripts. The engine takes no hints (no biasing), so Sondine corrects
// after it: a name the user once corrected to a same-sounding spelling, or
// only its accents (« Kamille », « Anais » → « Camille », « Anaïs »),
// is spelled their way from then on. Only names (the user wrote a capital),
// never a word that could be a common one in context (« verre » / « vert »).
// The engine's text is kept beside it (publish.ts), so « Rétablir
// l'original » still works.

export const VOCABULARY_VERSION = "vocabulary/2";

export interface Vocabulary {
  /** Lower-cased, unaccented spellings the user corrected, and the name they wrote. */
  readonly corrections: ReadonlyMap<string, string>;
}

export interface VocabularyWord {
  readonly charStart: number;
  readonly charEnd: number;
}

const WORD = /\p{L}[\p{L}\p{M}'’-]*/gu;

const fold = (word: string) =>
  word.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[’']/gu, "'");

/** The phonetic key of a word as written: folded, letters only; null outside Latin letters. */
const keyOf = (word: string) => {
  const letters = fold(word).replace(/[^a-z]/gu, "");
  return letters.length < 3 || letters.length < fold(word).replace(/['-]/gu, "").length
    ? null
    : phoneticKey(letters);
};

const wordsOf = (text: string) => [...text.matchAll(WORD)].map((match) => match[0]);

/**
 * One-word substitutions between what the engine wrote and what the user
 * wrote, but none at the start of a sentence, where a capital proves nothing.
 */
function substitutions(original: string, corrected: string): [string, string][] {
  const a = wordsOf(original);
  const matches = [...corrected.matchAll(WORD)];
  const b = matches.map((match) => match[0]);
  const initial = matches.map((match) => /^\s*$|[.!?…]\s*$/u.test(corrected.slice(0, match.index)));
  const rows = a.length;
  const cols = b.length;
  if (rows === 0 || cols === 0 || rows * cols > 2_500) return [];
  // Exactly the same word: an accent or a capital put right is a substitution too.
  const same = (i: number, j: number) => a[i] === b[j];
  const table = Array.from({ length: rows + 1 }, () => new Uint16Array(cols + 1));
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      const row = table[i];
      const below = table[i + 1];
      if (row === undefined || below === undefined) continue;
      row[j] = same(i, j) ? (below[j + 1] ?? 0) + 1 : Math.max(below[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  // Walk the alignment; a gap of exactly one word on each side is a substitution.
  const out: [string, string][] = [];
  let i = 0;
  let j = 0;
  let gapA: string[] = [];
  let gapB: number[] = [];
  const close = () => {
    const [wrong] = gapA;
    const [at] = gapB;
    const right = at === undefined ? undefined : b[at];
    if (
      gapA.length === 1 &&
      gapB.length === 1 &&
      wrong !== undefined &&
      right !== undefined &&
      at !== undefined &&
      initial[at] !== true
    ) {
      out.push([wrong, right]);
    }
    gapA = [];
    gapB = [];
  };
  while (i < rows || j < cols) {
    if (i < rows && j < cols && same(i, j)) {
      close();
      i += 1;
      j += 1;
    } else if (j >= cols || (i < rows && (table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0))) {
      gapA.push(a[i] ?? "");
      i += 1;
    } else {
      gapB.push(j);
      j += 1;
    }
  }
  close();
  return out;
}

/** The vocabulary from the user's corrections. */
export function buildVocabulary(input: {
  readonly corrections: readonly { readonly text: string; readonly original: string }[];
}): Vocabulary {
  const corrections = new Map<string, string>();
  const conflicting = new Set<string>();
  for (const { text, original } of input.corrections) {
    for (const [wrong, right] of substitutions(original, text)) {
      // A name: the user wrote a capital, and it sounds like what was heard.
      if (wrong === right || !/^\p{Lu}/u.test(right)) continue;
      const key = keyOf(wrong);
      if (key === null || key !== keyOf(right)) continue;
      const from = fold(wrong);
      const already = corrections.get(from);
      if (already !== undefined && already !== right) conflicting.add(from);
      corrections.set(from, right);
    }
  }
  for (const from of conflicting) corrections.delete(from);
  return { corrections };
}

/**
 * A segment's text with the user's spellings; its word timings follow the
 * characters that moved. `replaced` counts the words rewritten.
 */
export function applyVocabulary<
  T extends { readonly text: string; readonly words?: readonly VocabularyWord[] | null },
>(segment: T, vocabulary: Vocabulary): { readonly segment: T; readonly replaced: number } {
  if (vocabulary.corrections.size === 0) return { segment, replaced: 0 };
  const edits: { start: number; end: number; text: string }[] = [];
  for (const match of segment.text.matchAll(WORD)) {
    const word = match[0];
    const next = vocabulary.corrections.get(fold(word));
    if (next === undefined || next === word) continue;
    edits.push({ start: match.index, end: match.index + word.length, text: next });
  }
  if (edits.length === 0) return { segment, replaced: 0 };
  let text = "";
  let cursor = 0;
  for (const edit of edits) {
    text += segment.text.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  text += segment.text.slice(cursor);
  // Where an offset of the old text lands in the new one; inside a rewritten
  // word, at its new start or end.
  const moved = (offset: number, side: "start" | "end") => {
    let shift = 0;
    for (const edit of edits) {
      if (offset <= edit.start) break;
      if (offset < edit.end) return edit.start + shift + (side === "end" ? edit.text.length : 0);
      shift += edit.text.length - (edit.end - edit.start);
    }
    return offset + shift;
  };
  const words = segment.words?.map((word) => ({
    ...word,
    charStart: moved(word.charStart, "start"),
    charEnd: Math.max(moved(word.charStart, "start"), moved(word.charEnd, "end")),
  }));
  return {
    segment: { ...segment, text, ...(words === undefined ? {} : { words }) },
    replaced: edits.length,
  };
}
