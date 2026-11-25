import { frenchCardinalWords, frenchDigitsToWords, frenchOrdinalWords } from "./french-numbers";

/**
 * Bump when any rule, list, or default below changes the output for some
 * input. Scores and search terms record the full `frNormId(options)`.
 */
export const FR_NORM_VERSION = "fr-norm/1";

export type NormLanguage = "fr" | "en";

export interface FrNormOptions {
  /** "fr" (default) or "en" for code-switched English spans. */
  readonly language?: NormLanguage;
  /** Hesitation fillers: dropped (default) or kept in a canonical spelling. */
  readonly fillers?: "drop" | "keep";
  /** French only: digits become words (default), or stay as written. */
  readonly numbers?: "words" | "keep";
  /** Kept (default), or stripped for diacritic-insensitive scoring and search. */
  readonly diacritics?: "keep" | "strip";
}

export interface NormSpan {
  readonly text: string;
  readonly language: NormLanguage;
}

interface ResolvedOptions {
  readonly language: NormLanguage;
  readonly fillers: "drop" | "keep";
  readonly numbers: "words" | "keep";
  readonly diacritics: "keep" | "strip";
}

/** Identifier stored next to anything normalized: version plus options. */
export function frNormId(options: Omit<FrNormOptions, "language"> = {}): string {
  const o = resolve(options);
  return `${FR_NORM_VERSION};fillers=${o.fillers};numbers=${o.numbers};diacritics=${o.diacritics}`;
}

export function frNorm(text: string, options: FrNormOptions = {}): string {
  return frNormTokens(text, options).join(" ");
}

export function frNormTokens(text: string, options: FrNormOptions = {}): string[] {
  const o = resolve(options);
  return o.language === "en" ? englishTokens(text, o) : frenchTokens(text, o);
}

/** Normalizes each span with its own language path and joins the tokens. */
export function frNormSpans(
  spans: readonly NormSpan[],
  options: Omit<FrNormOptions, "language"> = {},
): string {
  return spans
    .flatMap((span) => frNormTokens(span.text, { ...options, language: span.language }))
    .join(" ");
}

function resolve(options: FrNormOptions): ResolvedOptions {
  return {
    language: options.language ?? "fr",
    fillers: options.fillers ?? "drop",
    numbers: options.numbers ?? "words",
    diacritics: options.diacritics ?? "keep",
  };
}

// Annotation tags in references: [rire], <bruit>.
const ANNOTATION = /\[[^\]]*\]|<[^>]*>/gu;
const APOSTROPHES = /[‘’‛ʼ`´′＇]/gu;
const DASHES = /[-‐-―−⁃﹘﹣－]/gu;
const LIGATURES: Readonly<Record<string, string>> = { œ: "oe", Œ: "OE", æ: "ae", Æ: "AE" };

/** Steps shared by both language paths, before language-specific rules. */
function prepare(text: string): string {
  return text
    .normalize("NFC")
    .replace(ANNOTATION, " ")
    .replace(APOSTROPHES, "'")
    .replace(DASHES, " ")
    .replace(/[œŒæÆ]/gu, (ch) => LIGATURES[ch] ?? ch)
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// French path

const SUPERSCRIPTS: Readonly<Record<string, string>> = { ᵉ: "e", ʳ: "r", ᵈ: "d", ˢ: "s" };
const GROUP_SEPARATOR = String.raw`[    .]`;
const AMOUNT = String.raw`(\d{1,3}(?:${GROUP_SEPARATOR}\d{3})+|\d+)(?:([,.])(\d+))?`;
const NOT_AFTER_WORD = String.raw`(?<![\p{L}\d])`;
const NOT_BEFORE_WORD = String.raw`(?![\p{L}\d])`;

const NUMERO = new RegExp(String.raw`${NOT_AFTER_WORD}n\s?[°º]\s?(?=\d)`, "gu");
const TIME_H = new RegExp(
  String.raw`${NOT_AFTER_WORD}(\d{1,2})\s?h(?:\s?(\d{2}))?${NOT_BEFORE_WORD}`,
  "gu",
);
const TIME_COLON = /(?<![\p{L}\d:])(\d{1,2}):(\d{2})(?![\d:])/gu;
const ORDINAL = new RegExp(
  String.raw`${NOT_AFTER_WORD}(\d+)(ères|ère|eres|ere|ers|er|res|re|èmes|ème|emes|eme|ndes|nde|nds|nd|des|de|es|e)${NOT_BEFORE_WORD}`,
  "gu",
);
const MONEY_AFTER = new RegExp(String.raw`${NOT_AFTER_WORD}${AMOUNT}\s?([€$])`, "gu");
const MONEY_BEFORE = new RegExp(String.raw`([€$])\s?${AMOUNT}(?!\d)`, "gu");
const PERCENT = new RegExp(String.raw`${NOT_AFTER_WORD}${AMOUNT}\s?%`, "gu");
const NUMBER = new RegExp(String.raw`${NOT_AFTER_WORD}${AMOUNT}(?!\d)`, "gu");

const ELISION = /^(jusqu|lorsqu|puisqu|quoiqu|qu|[cdjlmnst])'(?=.)/u;
const CLITIC = /^(jusqu|lorsqu|puisqu|quoiqu|qu|[cdjlmnst])'$/u;

const FRENCH_FILLERS: readonly (readonly [RegExp, string])[] = [
  [/^e+u+h+$/u, "euh"],
  [/^h+e+u+h*$/u, "heu"],
  [/^(?:m+h+|m{2,})$/u, "mmh"],
  [/^h+u*m+$/u, "hum"],
  [/^b+e+n+$/u, "ben"],
  [/^b+a+h+$/u, "bah"],
  [/^h+e+i+n+$/u, "hein"],
];

const ENGLISH_FILLERS: readonly (readonly [RegExp, string])[] = [
  [/^u+h+$/u, "uh"],
  [/^u+h*m+$/u, "um"],
  [/^e+r+m+$/u, "erm"],
  [/^h+m+$/u, "hmm"],
  [/^m{2,}$/u, "mm"],
  [/^m+h+m+$/u, "mhm"],
];

/** Number words after which "vingts"/"cents" are a number, not a noun. */
const NUMBER_WORDS = new Set([
  "un",
  "une",
  "deux",
  "trois",
  "quatre",
  "cinq",
  "six",
  "sept",
  "huit",
  "neuf",
  "dix",
  "onze",
  "douze",
  "treize",
  "quatorze",
  "quinze",
  "seize",
  "vingt",
  "trente",
  "quarante",
  "cinquante",
  "soixante",
  "cent",
  "mille",
]);

/** Spelling variants mapped to one form (1990 rectifications where they apply). */
const VARIANTS: ReadonlyMap<string, string> = new Map([
  ["événement", "évènement"],
  ["événements", "évènements"],
  ["clef", "clé"],
  ["clefs", "clés"],
  ["pourcent", "pour cent"],
]);

/** Words that keep their circumflex on u under the 1990 rectifications. */
const KEEPS_U_CIRCUMFLEX =
  /^(?:dû|mû|crû|crûe|crûs|crûes|fût|eût|fûmes|fûtes|eûmes|eûtes|sûr|mûr|jeûn)/u;

function frenchTokens(text: string, o: ResolvedOptions): string[] {
  let s = prepare(text)
    .replace(/[ᵉʳᵈˢ]/gu, (ch) => SUPERSCRIPTS[ch] ?? ch)
    .replace(/&/gu, " et ");
  if (o.numbers === "words") s = frenchNumbers(s);
  s =
    o.numbers === "words"
      ? s.replace(/[^\p{L}\p{M}\p{N}'\s]/gu, " ")
      : s.replace(/[^\p{L}\p{M}\p{N}'\s,.]|(?<!\d)[,.]|[,.](?!\d)/gu, " ");

  const tokens: string[] = [];
  for (const raw of s.split(/\s+/u)) {
    for (const piece of splitElisions(raw)) {
      const spelled = VARIANTS.get(piece) ?? foldCircumflex(piece);
      for (const token of spelled.split(" ")) {
        const filler = matchFiller(token, FRENCH_FILLERS);
        if (filler !== null && o.fillers === "drop") continue;
        tokens.push(filler ?? token);
      }
    }
  }
  return finish(foldNumberPlurals(tokens), o);
}

function frenchNumbers(text: string): string {
  return text
    .replace(NUMERO, " numéro ")
    .replace(
      TIME_H,
      (match, hours: string, minutes: string | undefined) =>
        timeWords(hours, minutes ?? "00", true) ?? match,
    )
    .replace(
      TIME_COLON,
      (match, hours: string, minutes: string) => timeWords(hours, minutes, false) ?? match,
    )
    .replace(
      ORDINAL,
      (match, digits: string, suffix: string) => ordinalWords(digits, suffix) ?? match,
    )
    .replace(
      MONEY_AFTER,
      (_match, int: string, sep: string | undefined, frac: string | undefined, unit: string) =>
        words(moneyWords(int, sep, frac, unit)),
    )
    .replace(
      MONEY_BEFORE,
      (_match, unit: string, int: string, sep: string | undefined, frac: string | undefined) =>
        words(moneyWords(int, sep, frac, unit)),
    )
    .replace(PERCENT, (_match, int: string, sep: string | undefined, frac: string | undefined) =>
      words([...amountWords(int, sep, frac), "pour", "cent"]),
    )
    .replace(/(\p{L})(?=\d)/gu, "$1 ")
    .replace(/(\d)(?=\p{L})/gu, "$1 ")
    .replace(NUMBER, (_match, int: string, sep: string | undefined, frac: string | undefined) =>
      words(amountWords(int, sep, frac)),
    );
}

function words(list: readonly string[]): string {
  return ` ${list.join(" ")} `;
}

/** Hours and minutes are feminine: une heure, vingt et une heures. */
function timeWords(hours: string, minutes: string, anyHour: boolean): string | null {
  const h = Number(hours);
  const m = Number(minutes);
  if (m > 59 || (!anyHour && h > 24)) return null;
  const list = [...frenchCardinalWords(h, { feminine: true }), h >= 2 ? "heures" : "heure"];
  if (m > 0) list.push(...frenchCardinalWords(m, { feminine: true }));
  return words(list);
}

function ordinalWords(digits: string, suffix: string): string | null {
  if (digits.length > 12) return null;
  const n = Number(digits);
  const plural = suffix.endsWith("s");
  const base = plural ? suffix.slice(0, -1) : suffix;
  let list: string[] | null = null;
  if (base === "er" && n === 1) list = ["premier"];
  else if ((base === "re" || base === "ère" || base === "ere") && n === 1) list = ["première"];
  else if (base === "nd" && n === 2) list = ["second"];
  else if ((base === "nde" || base === "de") && n === 2) list = ["seconde"];
  else if ((base === "e" || base === "ème" || base === "eme") && n >= 1)
    list = frenchOrdinalWords(n);
  if (list === null) return null;
  const last = list.at(-1);
  if (plural && last !== undefined) list[list.length - 1] = `${last}s`;
  return words(list);
}

function integerDigits(int: string): string {
  return int.replace(new RegExp(GROUP_SEPARATOR, "gu"), "");
}

function amountWords(int: string, sep: string | undefined, frac: string | undefined): string[] {
  const whole = frenchDigitsToWords(integerDigits(int));
  if (frac === undefined) return whole;
  return [...whole, sep === "," ? "virgule" : "point", ...frenchDigitsToWords(frac)];
}

/** "3,50 €" is read "trois euros cinquante"; "0,50 €" "cinquante centimes". */
function moneyWords(
  int: string,
  sep: string | undefined,
  frac: string | undefined,
  symbol: string,
): string[] {
  const euro = symbol === "€";
  const [singular, plural] = euro ? ["euro", "euros"] : ["dollar", "dollars"];
  const [subSingular, subPlural] = euro ? ["centime", "centimes"] : ["cent", "cents"];
  const digits = integerDigits(int);
  const value = Number(digits);
  if (frac !== undefined && frac.length > 2) {
    return [...amountWords(int, sep, frac), value >= 2 ? plural : singular];
  }
  const cents = frac === undefined ? 0 : Number(frac.padEnd(2, "0"));
  if (value === 0 && cents > 0)
    return [...frenchCardinalWords(cents), cents > 1 ? subPlural : subSingular];
  const list = frenchDigitsToWords(digits);
  const last = list.at(-1) ?? "";
  if (["million", "millions", "milliard", "milliards"].includes(last))
    list.push(euro ? "d'" : "de", plural);
  else list.push(value >= 2 ? plural : singular);
  if (cents > 0) list.push(...frenchCardinalWords(cents));
  return list;
}

/** "l'homme" → "l'", "homme"; "aujourd'hui" and "quelqu'un" stay whole. */
function splitElisions(raw: string): string[] {
  const out: string[] = [];
  let rest = raw.replace(/^'+/u, "");
  for (let match = ELISION.exec(rest); match !== null; match = ELISION.exec(rest)) {
    out.push(match[0]);
    rest = rest.slice(match[0].length).replace(/^'+/u, "");
  }
  if (CLITIC.test(rest)) {
    out.push(rest);
  } else {
    const word = rest.replace(/'+$/u, "").replace(/'{2,}/gu, "'");
    if (word !== "") out.push(word);
  }
  return out;
}

function foldCircumflex(token: string): string {
  const withoutI = token.replace(/î/gu, "i");
  return KEEPS_U_CIRCUMFLEX.test(withoutI) ? withoutI : withoutI.replace(/û/gu, "u");
}

/** "quatre vingts" → "quatre vingt", "deux cents" → "deux cent": same spoken form. */
function foldNumberPlurals(tokens: readonly string[]): string[] {
  return tokens.map((token, index) => {
    const previous = tokens[index - 1];
    if (
      (token === "vingts" || token === "cents") &&
      previous !== undefined &&
      NUMBER_WORDS.has(previous)
    ) {
      return token.slice(0, -1);
    }
    return token;
  });
}

// ---------------------------------------------------------------------------
// English path: lowercase, punctuation, contractions kept, digits kept.

function englishTokens(text: string, o: ResolvedOptions): string[] {
  const s = prepare(text)
    .replace(/&/gu, " and ")
    .replace(/(?<=\d),(?=\d{3}(?!\d))/gu, "")
    .replace(/[^\p{L}\p{M}\p{N}'\s.]|(?<!\d)\.|\.(?!\d)/gu, " ");
  const tokens: string[] = [];
  for (const raw of s.split(/\s+/u)) {
    const token = raw.replace(/^'+|'+$/gu, "").replace(/'{2,}/gu, "'");
    if (token === "") continue;
    const filler = matchFiller(token, ENGLISH_FILLERS);
    if (filler !== null && o.fillers === "drop") continue;
    tokens.push(filler ?? token);
  }
  return finish(tokens, o);
}

// ---------------------------------------------------------------------------

function matchFiller(
  token: string,
  fillers: readonly (readonly [RegExp, string])[],
): string | null {
  for (const [pattern, canonical] of fillers) {
    if (pattern.test(token)) return canonical;
  }
  return null;
}

function finish(tokens: readonly string[], o: ResolvedOptions): string[] {
  if (o.diacritics === "keep") return tokens.filter((token) => token !== "");
  return tokens
    .map((token) => token.normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC"))
    .filter((token) => token !== "");
}
