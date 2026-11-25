/**
 * French number words, as space-separated words without hyphens, so the
 * output does not depend on the traditional or the 1990 hyphenation rule.
 * Plural agreement follows standard French: "quatre-vingts" and "deux cents"
 * take an s when they end the number or precede "million(s)"/"milliard(s)",
 * never before "mille".
 */

export const MAX_FRENCH_CARDINAL = 999_999_999_999;

const UNITS = [
  "zéro",
  "un",
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
] as const;

const TENS: Readonly<Record<number, string>> = {
  2: "vingt",
  3: "trente",
  4: "quarante",
  5: "cinquante",
  6: "soixante",
};

export interface FrenchNumberOptions {
  /** "une" instead of a final "un" (une heure, vingt et une minutes). */
  readonly feminine?: boolean;
}

export function frenchCardinalWords(n: number, options: FrenchNumberOptions = {}): string[] {
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_FRENCH_CARDINAL) {
    throw new RangeError(`cardinal out of range: ${n}`);
  }
  if (n === 0) return ["zéro"];
  const milliards = Math.floor(n / 1_000_000_000);
  const millions = Math.floor(n / 1_000_000) % 1000;
  const thousands = Math.floor(n / 1000) % 1000;
  const rest = n % 1000;
  const words: string[] = [];
  if (milliards > 0)
    words.push(...below1000(milliards, true), milliards > 1 ? "milliards" : "milliard");
  if (millions > 0) words.push(...below1000(millions, true), millions > 1 ? "millions" : "million");
  if (thousands > 0) {
    if (thousands > 1) words.push(...below1000(thousands, false));
    words.push("mille");
  }
  if (rest > 0) words.push(...below1000(rest, true));
  if (options.feminine === true && words.at(-1) === "un") words[words.length - 1] = "une";
  return words;
}

export interface FrenchOrdinalOptions {
  readonly feminine?: boolean;
  readonly plural?: boolean;
}

/** 1 → premier/première, 2 → deuxième, 21 → vingt et unième, 80 → quatre vingtième. */
export function frenchOrdinalWords(n: number, options: FrenchOrdinalOptions = {}): string[] {
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_FRENCH_CARDINAL) {
    throw new RangeError(`ordinal out of range: ${n}`);
  }
  const words =
    n === 1 ? [options.feminine === true ? "première" : "premier"] : frenchCardinalWords(n);
  const last = words.at(-1);
  if (last === undefined) throw new RangeError(`ordinal out of range: ${n}`);
  const ordinal = n === 1 ? last : ordinalize(last);
  words[words.length - 1] = options.plural === true ? `${ordinal}s` : ordinal;
  return words;
}

/**
 * A digit string read the way it is written: each leading zero is "zéro"
 * (phone numbers, "007"), the rest as a cardinal, and digit by digit beyond
 * the cardinal range.
 */
export function frenchDigitsToWords(digits: string, options: FrenchNumberOptions = {}): string[] {
  if (!/^\d+$/.test(digits)) throw new RangeError(`not a digit string: ${digits}`);
  const significant = digits.replace(/^0+/, "");
  const words = Array.from({ length: digits.length - significant.length }, () => "zéro");
  if (significant === "") return words;
  if (significant.length > String(MAX_FRENCH_CARDINAL).length) {
    return [...words, ...Array.from(significant, (digit) => unitWord(Number(digit)))];
  }
  return [...words, ...frenchCardinalWords(Number(significant), options)];
}

function below1000(n: number, pluralFinal: boolean): string[] {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const words: string[] = [];
  if (hundreds === 1) words.push("cent");
  else if (hundreds > 1)
    words.push(unitWord(hundreds), rest === 0 && pluralFinal ? "cents" : "cent");
  if (rest > 0) words.push(...below100(rest, pluralFinal));
  return words;
}

function below100(n: number, pluralFinal: boolean): string[] {
  if (n < 17) return [unitWord(n)];
  if (n < 20) return ["dix", unitWord(n - 10)];
  const tens = Math.floor(n / 10);
  const units = n % 10;
  if (tens < 7) {
    const tensWord = TENS[tens];
    if (tensWord === undefined) throw new RangeError(`no tens word for ${n}`);
    if (units === 0) return [tensWord];
    return units === 1 ? [tensWord, "et", "un"] : [tensWord, unitWord(units)];
  }
  if (tens === 7)
    return units === 1
      ? ["soixante", "et", "onze"]
      : ["soixante", ...below100(n - 60, pluralFinal)];
  if (n === 80) return ["quatre", pluralFinal ? "vingts" : "vingt"];
  return ["quatre", "vingt", ...below100(n - 80, pluralFinal)];
}

function ordinalize(word: string): string {
  switch (word) {
    case "un":
      return "unième";
    case "cinq":
      return "cinquième";
    case "neuf":
      return "neuvième";
    case "vingts":
      return "vingtième";
    case "cents":
      return "centième";
    case "millions":
      return "millionième";
    case "milliards":
      return "milliardième";
    default:
      return word.endsWith("e") ? `${word.slice(0, -1)}ième` : `${word}ième`;
  }
}

function unitWord(n: number): string {
  const word = UNITS[n];
  if (word === undefined) throw new RangeError(`no unit word for ${n}`);
  return word;
}
