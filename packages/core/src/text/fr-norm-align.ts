import { frNormId, frNormTokens, type FrNormOptions } from "./fr-norm";

/**
 * Bump when the piece rules or the search below change which stretch of the
 * original text a normalized token is attributed to. Highlights record
 * `frNormAlignId(options)`, which also carries the normalizer's own id.
 */
export const FR_NORM_ALIGN_VERSION = "fr-norm-align/1";

export function frNormAlignId(options: Omit<FrNormOptions, "language"> = {}): string {
  return `${FR_NORM_ALIGN_VERSION};${frNormId(options)}`;
}

/** A stretch of the original text and the normalized tokens it produces. */
export interface NormUnit {
  /** UTF-16 offset of the first character in the original text. */
  readonly start: number;
  /** UTF-16 offset just past the last character (exclusive). */
  readonly end: number;
  /** Empty for punctuation and dropped fillers; several for "22" or "15 %". */
  readonly tokens: readonly string[];
}

/**
 * Maps the original text to its fr-norm tokens: the units are in order, never
 * overlap, skip only whitespace, and their tokens joined are exactly
 * `frNormTokens(text, options)`.
 *
 * The text is cut into small pieces (a word, an elided article with its
 * apostrophe, a run of digits, one punctuation mark), and each piece is
 * normalized alone. Where that differs from normalizing the whole text (a
 * number with its unit, "10 h 30", "1 000", "quatre vingts", an annotation),
 * neighbouring pieces are merged until the tokens agree, finest grouping
 * first. When no grouping within a few words agrees, the whole text is one
 * unit, which is coarse but never wrong.
 */
export function frNormAlign(text: string, options: FrNormOptions = {}): NormUnit[] {
  const pieces = splitPieces(text);
  const first = pieces[0];
  const last = pieces.at(-1);
  if (first === undefined || last === undefined) return [];
  const target = frNormTokens(text, options);
  const whole: NormUnit[] = [{ start: first.start, end: last.end, tokens: target }];
  const optionsKey = `${options.language ?? "fr"};${frNormId(options)}`;

  // Depth-first over (piece, target token), without recursion: a segment can
  // hold hundreds of pieces. Failed states are remembered, and a budget of
  // normalizations bounds pathological text.
  let budget = 64 + 16 * pieces.length;
  const failed = new Set<number>();
  const frameKey = (frame: Frame) => frame.piece * (target.length + 1) + frame.token;
  const frameAt = (piece: number, token: number): Frame => ({
    piece,
    token,
    next: piece + 1,
    limit: groupLimit(pieces, piece),
  });
  const stack: Frame[] = [frameAt(0, 0)];
  // units[k] leads from stack[k] to stack[k + 1].
  const units: NormUnit[] = [];
  for (;;) {
    const frame = stack.at(-1);
    if (frame === undefined) return whole;
    if (frame.piece === pieces.length && frame.token === target.length) return units;
    const start = pieces[frame.piece];
    const open = start !== undefined && !failed.has(frameKey(frame));
    let advanced = false;
    while (open && frame.next <= frame.limit) {
      const end = pieces[frame.next - 1];
      frame.next += 1;
      if (end === undefined) break;
      budget -= 1;
      if (budget < 0) return whole;
      const tokens = cachedTokens(optionsKey, text.slice(start.start, end.end), options);
      if (!startsAt(target, frame.token, tokens)) continue;
      units.push({ start: start.start, end: end.end, tokens });
      stack.push(frameAt(frame.next - 1, frame.token + tokens.length));
      advanced = true;
      break;
    }
    if (!advanced) {
      failed.add(frameKey(frame));
      stack.pop();
      units.pop();
    }
  }
}

interface Frame {
  /** Index of the first piece not yet attributed. */
  readonly piece: number;
  /** Index of the first target token not yet attributed. */
  readonly token: number;
  /** Exclusive end piece of the next group to try. */
  next: number;
  /** Exclusive end piece of the widest group to try. */
  readonly limit: number;
}

function startsAt(target: readonly string[], at: number, tokens: readonly string[]): boolean {
  if (at + tokens.length > target.length) return false;
  return tokens.every((token, index) => target[at + index] === token);
}

interface Piece {
  readonly start: number;
  readonly end: number;
  /** Whitespace gaps before this piece, so a group's width in words is a difference. */
  readonly word: number;
}

/** A group of pieces spans at most this many whitespace gaps ("1 000 000 000 €"). */
const MAX_GROUP_GAPS = 6;
const MAX_GROUP_PIECES = 32;

/** The exclusive end of the widest group that may start at piece `from`. */
function groupLimit(pieces: readonly Piece[], from: number): number {
  const word = pieces[from]?.word ?? 0;
  let end = from + 1;
  while (end < pieces.length && end - from < MAX_GROUP_PIECES) {
    const next = pieces[end];
    if (next === undefined || next.word - word > MAX_GROUP_GAPS) break;
    end += 1;
  }
  return end;
}

type CharClass = "space" | "apostrophe" | "digit" | "letter" | "other";

// The apostrophes fr-norm folds to "'" (its APOSTROPHES list and the ASCII one).
const APOSTROPHE = /^[‘’‛ʼ`´′＇']$/u;
const SPACE = /^\s$/u;
const DIGIT = /^[0-9]$/u;
const LETTER = /^[\p{L}\p{M}\p{N}]$/u;

function classOf(character: string): CharClass {
  if (SPACE.test(character)) return "space";
  if (APOSTROPHE.test(character)) return "apostrophe";
  if (DIGIT.test(character)) return "digit";
  if (LETTER.test(character)) return "letter";
  return "other";
}

/**
 * Pieces: runs of letters (an apostrophe right after letters ends the run, so
 * "l'" is one piece), runs of digits, and every other character alone.
 */
function splitPieces(text: string): Piece[] {
  const pieces: Piece[] = [];
  let word = 0;
  let gap = false;
  let runStart = -1;
  let runKind: CharClass = "other";
  let offset = 0;
  for (const character of text) {
    const kind = classOf(character);
    const next = offset + character.length;
    const continues = runStart >= 0 && (kind === "letter" || kind === "digit") && kind === runKind;
    const endsRun = runStart >= 0 && kind === "apostrophe" && runKind === "letter";
    if (runStart >= 0 && !continues) {
      pieces.push({ start: runStart, end: endsRun ? next : offset, word });
      runStart = -1;
    }
    if (kind === "space") {
      gap = true;
    } else if (!continues && !endsRun) {
      if (gap && pieces.length > 0) word += 1;
      gap = false;
      if (kind === "letter" || kind === "digit") {
        runStart = offset;
        runKind = kind;
      } else {
        pieces.push({ start: offset, end: next, word });
      }
    }
    offset = next;
  }
  if (runStart >= 0) pieces.push({ start: runStart, end: offset, word });
  return pieces;
}

// Normalizing a piece alone does not depend on its context, so results are
// shared across calls. Bounded: cleared when full.
const CACHE_LIMIT = 20_000;
const cache = new Map<string, readonly string[]>();

function cachedTokens(optionsKey: string, text: string, options: FrNormOptions): readonly string[] {
  const key = `${optionsKey}\u0000${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const tokens = frNormTokens(text, options);
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, tokens);
  return tokens;
}
