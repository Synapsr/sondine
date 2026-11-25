// A phonetic key per word (M4, phonetic search): two spellings that sound
// alike in French get the same key, so a name the engine misheard still
// matches ("Kamille" finds Camille, "Filip" finds Philippe). Rules follow
// French spelling (it is the main language heard); they hold for most
// English names too. The input is one index token: lower case, without
// diacritics (fr-norm with `diacritics: "strip"`). Bump the version when a
// rule changes.

export const PHONETIC_VERSION = "phonetic-fr/2";

const VOWELS = "aeiouy";
const isVowel = (character: string | undefined) =>
  character !== undefined && VOWELS.includes(character);

/** Rewrites applied in order, each over the whole word. */
const REWRITES: readonly (readonly [RegExp, string])[] = [
  // Consonant groups first, before single letters change.
  [/^h/gu, ""],
  [/ch(?=[rl])/gu, "k"],
  // The « ch » sound is `X`, apart from the x of « Xavier » (ks).
  [/sch|sh|ch/gu, "X"],
  [/ph/gu, "f"],
  [/th/gu, "t"],
  [/gh/gu, "g"],
  [/rh/gu, "r"],
  [/w/gu, "v"],
  [/qu|q|ck/gu, "k"],
  [/cc(?=[eiy])/gu, "ks"],
  [/c(?=[eiy])/gu, "s"],
  [/c/gu, "k"],
  // A hard « gu » stays hard (`G`) through the soft-g rule.
  [/gu(?=[eiy])/gu, "G"],
  [/g(?=[eiy])/gu, "j"],
  [/gn/gu, "ni"],
  [/(?<=[aeiouy])ill/gu, "iy"],
  // Vowel groups.
  [/eau|au/gu, "o"],
  [/oi/gu, "va"],
  [/ou/gu, "u"],
  // Nasals, before a consonant or at the end: « pain », « plein », then the others.
  [/[ae]i[nm](?=[^aeiouynm]|$)/gu, "in"],
  [/ai|ei/gu, "e"],
  [/[ae][nm](?=[^aeiouynm]|$)/gu, "an"],
  [/o[nm](?=[^aeiouynm]|$)/gu, "on"],
  [/[iuy][nm](?=[^aeiouynm]|$)/gu, "in"],
  // Endings that are not heard.
  [/(?<=..)e?[tdsz]$/gu, ""],
  [/(?<=..)(?:er|ez)$/gu, "e"],
  [/(?<=..)e$/gu, ""],
  [/x/gu, "ks"],
  [/z/gu, "s"],
  [/h/gu, ""],
  [/y/gu, "i"],
  [/G/gu, "g"],
];

/** The word's phonetic key; a word with digits, or under three letters, is its own key. */
export function phoneticKey(word: string): string {
  if (!/^[a-z]{3,}$/u.test(word)) return word;
  let key = word;
  for (const [pattern, replacement] of REWRITES) key = key.replace(pattern, replacement);
  // Doubled letters sound once.
  key = key.replace(/(.)\1+/gu, "$1");
  return key === "" ? word : key;
}

/** Letters a word may start with when its key starts as `key` does: where to look for it. */
export function phoneticInitials(key: string): readonly string[] {
  const first = key[0];
  if (first === undefined) return [];
  const table: Record<string, string> = {
    k: "ckqx",
    X: "cs",
    s: "scz",
    f: "fp",
    j: "jg",
    v: "vw",
    i: "iyh",
    a: "aeh",
    e: "aeh",
    o: "aeoh",
    u: "ouh",
  };
  const letters = table[first] ?? first;
  return [...new Set([...letters, ...(isVowel(first) ? "h" : "")])];
}
