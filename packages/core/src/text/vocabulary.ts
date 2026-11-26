import { phoneticKey } from "./phonetic";

// Personal vocabulary (M4, ADR 046): the user's words put back in new
// transcripts. The engine takes no hints (no biasing), so Sondine corrects
// after it, from two sources:
// - what the user's corrections taught: a name once corrected to a
//   same-sounding spelling, or only its accents (« Kamille », « Anais » →
//   « Camille », « Anaïs »), is spelled their way from then on;
// - the user's names, their Vocabulary list and their People: a name the
//   engine wrote that sounds the same as one of them (« Théo » → « Téo »).
// Only names (a capital the user or the engine wrote, never at a sentence's
// start unless the word is known as a name), never a word that could be a
// common one in context (« verre » / « vert »). The engine's text is kept
// beside it (publish.ts), so « Rétablir l'original » still works. A name that
// only looks like one of the user's (« Sandrine », « Sondine ») is not
// changed here: the journal's model reads the sentence (vocabulary-check.ts).

export const VOCABULARY_VERSION = "vocabulary/3";

export interface Vocabulary {
  /** Lower-cased, unaccented spellings the user corrected, and the name they wrote. */
  readonly corrections: ReadonlyMap<string, string>;
  /** The user's names, word by word, by phonetic key: the spellings that share it. */
  readonly names: ReadonlyMap<string, readonly string[]>;
  /** Two words of one of the user's names in a row (« Marie-Anne Dupont »), as their two keys. */
  readonly fullNames: ReadonlySet<string>;
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

const capitalized = (word: string) => /^\p{Lu}/u.test(word);

/** Whether the text before a word ends a sentence (or is empty): a capital there proves nothing. */
const startsSentence = (before: string) => /^\s*$|[.!?…]\s*$/u.test(before);

const wordsOf = (text: string) => [...text.matchAll(WORD)].map((match) => match[0]);

/** Each word of the user's names, once: « Marie-Anne Dupont » gives « Marie-Anne » and « Dupont ». */
export function nameWords(names: Iterable<string>): string[] {
  const out = new Map<string, string>();
  for (const name of names) {
    for (const word of wordsOf(name.normalize("NFC"))) {
      if (keyOf(word) !== null && !out.has(word)) out.set(word, word);
    }
  }
  return [...out.values()];
}

interface Substitution {
  readonly wrong: string;
  readonly right: string;
  /** The user's word starts a sentence: its capital proves nothing. */
  readonly initial: boolean;
}

/** One-word substitutions between what the engine wrote and what the user wrote. */
function substitutions(original: string, corrected: string): Substitution[] {
  const a = wordsOf(original);
  const matches = [...corrected.matchAll(WORD)];
  const b = matches.map((match) => match[0]);
  const initial = matches.map((match) => startsSentence(corrected.slice(0, match.index)));
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
  const out: Substitution[] = [];
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
      at !== undefined
    ) {
      out.push({ wrong, right, initial: initial[at] === true });
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

/** A correction that teaches: a name, written the user's way, that sounds like what was heard. */
const teaches = ({ wrong, right }: Substitution) => {
  if (wrong === right || !capitalized(right)) return false;
  const key = keyOf(wrong);
  return key !== null && key === keyOf(right);
};

/**
 * The vocabulary from the user's corrections and names (their Vocabulary
 * list and their People). A correction at a sentence's start teaches only
 * when the name it wrote is already known: one of `names`, or taught by
 * another correction.
 */
export function buildVocabulary(input: {
  readonly corrections: readonly { readonly text: string; readonly original: string }[];
  readonly names?: readonly string[];
}): Vocabulary {
  const words = nameWords(input.names ?? []);
  const known = new Set(words.map(fold));
  const corrections = new Map<string, string>();
  const conflicting = new Set<string>();
  const learn = ({ wrong, right }: Substitution) => {
    const from = fold(wrong);
    const already = corrections.get(from);
    if (already !== undefined && already !== right) conflicting.add(from);
    corrections.set(from, right);
  };
  const all = input.corrections.flatMap(({ text, original }) =>
    substitutions(original, text).filter(teaches),
  );
  for (const substitution of all) if (!substitution.initial) learn(substitution);
  const taught = new Set([...corrections.values()].map(fold));
  for (const substitution of all) {
    const right = fold(substitution.right);
    if (substitution.initial && (known.has(right) || taught.has(right))) learn(substitution);
  }
  for (const from of conflicting) corrections.delete(from);
  const names = new Map<string, string[]>();
  for (const word of words) {
    const key = keyOf(word);
    if (key === null) continue;
    const spellings = names.get(key) ?? [];
    if (!spellings.includes(word)) spellings.push(word);
    names.set(key, spellings);
  }
  const fullNames = new Set<string>();
  for (const name of input.names ?? []) {
    const keys = wordsOf(name.normalize("NFC")).map(keyOf);
    for (let index = 1; index < keys.length; index += 1) {
      const [before, after] = [keys[index - 1], keys[index]];
      if (before !== null && before !== undefined && after !== null && after !== undefined) {
        fullNames.add(`${before} ${after}`);
      }
    }
  }
  return { corrections, names, fullNames };
}

/**
 * What one correction teaches, for the window to say it: the names Sondine
 * will now write the user's way, and the names they wrote that it cannot
 * learn, because they do not sound like what was heard (« Sandrine » →
 * « Sondine »): words to offer for their Vocabulary.
 */
export function correctionLessons(input: {
  readonly text: string;
  readonly original: string;
  /** The vocabulary with this correction counted. */
  readonly vocabulary: Vocabulary;
}): { readonly learned: readonly string[]; readonly unheard: readonly string[] } {
  const learned = new Set<string>();
  const unheard = new Set<string>();
  const listed = new Set([...input.vocabulary.names.values()].flat());
  for (const substitution of substitutions(input.original, input.text)) {
    const { wrong, right } = substitution;
    if (input.vocabulary.corrections.get(fold(wrong)) === right) {
      learned.add(right);
    } else if (
      !teaches(substitution) &&
      wrong !== right &&
      capitalized(right) &&
      !substitution.initial &&
      keyOf(right) !== null &&
      fold(wrong) !== fold(right) &&
      !listed.has(right)
    ) {
      unheard.add(right);
    }
  }
  return { learned: [...learned], unheard: [...unheard] };
}

/**
 * The words a transcript's engine wrote as names in the middle of a
 * sentence, folded: at a sentence's start, such a word is a name too.
 */
export function namesWrittenIn(texts: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(WORD)) {
      if (capitalized(match[0]) && !startsSentence(text.slice(0, match.index))) {
        out.add(fold(match[0]));
      }
    }
  }
  return out;
}

/** A word the engine wrote as a name: a capital mid-sentence, or one known as a name. */
function asName(text: string, word: string, index: number, written: ReadonlySet<string>): boolean {
  if (!capitalized(word)) return false;
  return !startsSentence(text.slice(0, index)) || written.has(fold(word));
}

/**
 * A name followed by a surname (« Théo Martin »): someone else of that first
 * name, unless the two words are one of the user's names.
 */
function surnamed(text: string, word: string, index: number, vocabulary: Vocabulary): boolean {
  const following = /^\s+(\p{Lu}[\p{L}\p{M}'’-]*)/u.exec(text.slice(index + word.length));
  const surname = following?.[1];
  if (surname === undefined) return false;
  return !vocabulary.fullNames.has(`${keyOf(word)} ${keyOf(surname)}`);
}

/** The one spelling of the user's names that sounds like `word`; null for none, or for two. */
function soundsLike(word: string, vocabulary: Vocabulary): string | null {
  const key = keyOf(word);
  if (key === null) return null;
  const spellings = vocabulary.names.get(key);
  return spellings?.length === 1 ? (spellings[0] ?? null) : null;
}

/**
 * A segment's text with the user's spellings; its word timings follow the
 * characters that moved. `replaced` counts the words rewritten. `written`
 * holds the names the transcript's engine wrote mid-sentence
 * (`namesWrittenIn`), so one at a sentence's start is spelled too.
 */
export function applyVocabulary<
  T extends { readonly text: string; readonly words?: readonly VocabularyWord[] | null },
>(
  segment: T,
  vocabulary: Vocabulary,
  written: ReadonlySet<string> = new Set(),
): { readonly segment: T; readonly replaced: number } {
  if (vocabulary.corrections.size === 0 && vocabulary.names.size === 0) {
    return { segment, replaced: 0 };
  }
  const edits: { start: number; end: number; text: string }[] = [];
  for (const match of segment.text.matchAll(WORD)) {
    const word = match[0];
    const next =
      vocabulary.corrections.get(fold(word)) ??
      (asName(segment.text, word, match.index, written) &&
      !surnamed(segment.text, word, match.index, vocabulary)
        ? soundsLike(word, vocabulary)
        : null);
    if (next === undefined || next === null || next === word) continue;
    edits.push({ start: match.index, end: match.index + word.length, text: next });
  }
  if (edits.length === 0) return { segment, replaced: 0 };
  return { segment: respell(segment, edits), replaced: edits.length };
}

/**
 * A segment with words rewritten (sorted, not overlapping); its word timings
 * follow the characters that moved, inside a rewritten word at its new start
 * or end.
 */
export function respell<
  T extends { readonly text: string; readonly words?: readonly VocabularyWord[] | null },
>(segment: T, edits: readonly { start: number; end: number; text: string }[]): T {
  let text = "";
  let cursor = 0;
  for (const edit of edits) {
    text += segment.text.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  text += segment.text.slice(cursor);
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
  return { ...segment, text, ...(words === undefined || words === null ? {} : { words }) };
}

/** Edits between two phonetic keys, at most `limit` (more returns `limit + 1`). */
function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      current.push(value);
      best = Math.min(best, value);
    }
    if (best > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length] ?? limit + 1;
}

/**
 * Whether a key is near a name's without being it: the same first sound,
 * and one edit apart (two from six sounds up): « Sandrine » (sandrin) and
 * « Sondine » (sondin).
 */
export function looksLike(key: string, nameKey: string): boolean {
  if (key === nameKey || key.length < 4 || nameKey.length < 4 || key[0] !== nameKey[0]) {
    return false;
  }
  const limit = Math.min(key.length, nameKey.length) >= 6 ? 2 : 1;
  return distance(key, nameKey, limit) <= limit;
}

/** A word that looks like one of the user's names without sounding like it: the model decides. */
export interface VocabularyCandidate {
  readonly charStart: number;
  readonly charEnd: number;
  /** As the transcript writes it. */
  readonly word: string;
  /** The user's name it may be. */
  readonly name: string;
}

/**
 * The names a segment's engine wrote that look like one of the user's
 * without sounding the same, nor being one of theirs: one candidate each,
 * for the name nearest it (none when two are as near).
 */
export function vocabularyCandidates(
  text: string,
  vocabulary: Vocabulary,
  written: ReadonlySet<string> = new Set(),
): VocabularyCandidate[] {
  if (vocabulary.names.size === 0) return [];
  const listed = new Set([...vocabulary.names.values()].flat().map(fold));
  const out: VocabularyCandidate[] = [];
  for (const match of text.matchAll(WORD)) {
    const word = match[0];
    if (!asName(text, word, match.index, written) || listed.has(fold(word))) continue;
    if (surnamed(text, word, match.index, vocabulary)) continue;
    if (vocabulary.corrections.has(fold(word))) continue;
    const key = keyOf(word);
    if (key === null || vocabulary.names.has(key)) continue;
    const near = [...vocabulary.names.entries()].filter(([nameKey]) => looksLike(key, nameKey));
    const [first] = near;
    if (near.length !== 1 || first === undefined) continue;
    const [, spellings] = first;
    const [name] = spellings;
    if (spellings.length !== 1 || name === undefined) continue;
    out.push({ charStart: match.index, charEnd: match.index + word.length, word, name });
  }
  return out;
}
