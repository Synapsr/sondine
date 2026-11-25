import { frNormAlign, frNormAlignId, type NormLanguage } from "@sondine/core";
import { searchLanguageOf, searchNormOptions } from "./search-text";

// How a query becomes an FTS5 expression, and where it matched in a
// segment's original text. Both read the query the same way, so a segment
// FTS5 returns gets highlights and one it does not gets none.

/**
 * What highlights depend on: the alignment and the normalizer the index uses
 * (ADR 016, Search). A change to either changes this id.
 */
export const searchHighlightsId = frNormAlignId(searchNormOptions);

/** UTF-16 offsets into a segment's original text, end exclusive. */
export interface TextRange {
  readonly start: number;
  readonly end: number;
}

/** One quoted FTS5 phrase: index tokens in a row; the last one may be a prefix. */
export interface SearchPhrase {
  readonly tokens: readonly string[];
  readonly prefix: boolean;
  /**
   * Words that sound like a one-word phrase (phonetic search): any of them
   * matches too, whole.
   */
  readonly alternatives?: readonly string[];
}

/**
 * A query as FTS5 runs it: each form is the query normalized in one
 * language (a query's language is unknown), its phrases ANDed; the forms are
 * ORed.
 */
export interface SearchQuery {
  readonly forms: readonly (readonly SearchPhrase[])[];
  /** The MATCH expression; null when nothing in the query is searchable. */
  readonly match: string | null;
}

/**
 * Normalizes the query in French and in English, as the index was. Each
 * word the user typed becomes one quoted phrase of the tokens it normalizes
 * to ("l'école" → `"l ecole"`, "22" → `"vingt deux"`, "10 h 30" → one
 * phrase), so FTS5 syntax in the input is inert. The last word is a prefix
 * when it has two letters or more (`prefix`, default true).
 */
export function compileSearchQuery(
  input: string,
  options: { readonly prefix?: boolean } = {},
): SearchQuery {
  const forms: SearchPhrase[][] = [];
  for (const language of ["fr", "en"] as const) {
    const phrases = queryPhrases(input, language, options.prefix ?? true);
    if (phrases.length === 0) continue;
    forms.push(phrases);
  }
  return queryOf(forms);
}

/** The query with forms deduplicated and its MATCH expression. */
function queryOf(candidates: readonly (readonly SearchPhrase[])[]): SearchQuery {
  const forms: (readonly SearchPhrase[])[] = [];
  const expressions: string[] = [];
  for (const phrases of candidates) {
    // Explicit AND: FTS5 does not join a parenthesized group to its neighbours.
    const expression = phrases.map(phraseExpression).join(" AND ");
    if (expressions.includes(expression)) continue;
    forms.push(phrases);
    expressions.push(expression);
  }
  const [only] = expressions;
  return {
    forms,
    match:
      only === undefined
        ? null
        : expressions.length === 1
          ? only
          : expressions.map((expression) => `(${expression})`).join(" OR "),
  };
}

/**
 * The query with words that sound like its one-word phrases (by their
 * token): each phrase also matches any of them.
 */
export function widenSearchQuery(
  query: SearchQuery,
  alternatives: ReadonlyMap<string, readonly string[]>,
): SearchQuery {
  if (alternatives.size === 0) return query;
  return queryOf(
    query.forms.map((phrases) =>
      phrases.map((phrase) => {
        const [only] = phrase.tokens;
        const found =
          phrase.tokens.length === 1 && only !== undefined ? alternatives.get(only) : undefined;
        return found === undefined || found.length === 0
          ? phrase
          : { ...phrase, alternatives: found };
      }),
    ),
  );
}

function queryPhrases(input: string, language: NormLanguage, prefix: boolean): SearchPhrase[] {
  const units = frNormAlign(input, { ...searchNormOptions, language });
  const words: string[][] = [];
  let previousEnd = -1;
  for (const unit of units) {
    if (previousEnd < 0 || /\s/u.test(input.slice(previousEnd, unit.start))) words.push([]);
    previousEnd = unit.end;
    words.at(-1)?.push(...unit.tokens.flatMap(indexTokens));
  }
  const phrases = words.filter((tokens) => tokens.length > 0);
  return phrases.map((tokens, index) => ({
    tokens,
    prefix: prefix && index === phrases.length - 1 && wordLength(tokens.at(-1) ?? "") >= 2,
  }));
}

const quote = (text: string) => `"${text.replaceAll('"', '""')}"`;

function phraseExpression(phrase: SearchPhrase): string {
  const own = `${quote(phrase.tokens.join(" "))}${phrase.prefix ? "*" : ""}`;
  const others = phrase.alternatives ?? [];
  return others.length === 0 ? own : `(${[own, ...others.map(quote)].join(" OR ")})`;
}

// FTS5's unicode61 tokenizer keeps letters, numbers and private-use
// characters, and splits on everything else ("l'" → "l", "3.5" → "3", "5").
// Normalized text is already lower case without diacritics.
const INDEX_TOKEN = /[\p{L}\p{N}\p{Co}]+/gu;

function indexTokens(normalized: string): string[] {
  return normalized.match(INDEX_TOKEN) ?? [];
}

function wordLength(token: string): number {
  return [...token].filter((character) => /[\p{L}\p{N}]/u.test(character)).length;
}

/**
 * Where the query matched in `text`, as FTS5 matched it: a form counts only
 * when all its phrases occur, a phrase is its tokens in a row, a prefix
 * matches the start of a token. The ranges cover the original words a match
 * came from ("22" for "vingt deux", "l'école" for the phrase `l ecole`),
 * sorted, with touching ranges merged. Empty when FTS5 would not return the
 * segment.
 */
export function highlightRanges(
  text: string,
  lang: string | null | undefined,
  query: SearchQuery,
): TextRange[] {
  if (query.forms.length === 0) return [];
  const units = frNormAlign(text, { ...searchNormOptions, language: searchLanguageOf(lang) });
  const stream = units.flatMap((unit, index) =>
    unit.tokens.flatMap(indexTokens).map((token) => ({ token, unit: index })),
  );
  const ranges: TextRange[] = [];
  for (const phrases of query.forms) {
    const found = phrases.map((phrase) => occurrences(stream, phrase));
    if (found.some((list) => list.length === 0)) continue;
    for (const [first, last] of found.flat()) {
      const from = units[first];
      const to = units[last];
      if (from !== undefined && to !== undefined) ranges.push({ start: from.start, end: to.end });
    }
  }
  return mergeRanges(ranges);
}

/** Each occurrence of the phrase in the stream, as its first and last unit. */
function occurrences(
  stream: readonly { readonly token: string; readonly unit: number }[],
  phrase: SearchPhrase,
): [number, number][] {
  const found: [number, number][] = [];
  const length = phrase.tokens.length;
  for (let at = 0; at + length <= stream.length; at++) {
    const matches =
      phrase.tokens.every((token, index) => {
        const candidate = stream[at + index]?.token ?? "";
        return phrase.prefix && index === length - 1
          ? candidate.startsWith(token)
          : candidate === token;
      }) ||
      (length === 1 && (phrase.alternatives ?? []).includes(stream[at]?.token ?? ""));
    const first = stream[at];
    const last = stream[at + length - 1];
    if (matches && first !== undefined && last !== undefined) found.push([first.unit, last.unit]);
  }
  return found;
}

function mergeRanges(ranges: readonly TextRange[]): TextRange[] {
  const merged: { start: number; end: number }[] = [];
  for (const range of ranges.toSorted((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ start: range.start, end: range.end });
    }
  }
  return merged;
}
