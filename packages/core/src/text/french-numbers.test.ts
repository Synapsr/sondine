import { describe, expect, it } from "vitest";

import {
  MAX_FRENCH_CARDINAL,
  frenchCardinalWords,
  frenchDigitsToWords,
  frenchOrdinalWords,
} from "./french-numbers";

const say = (n: number): string => frenchCardinalWords(n).join(" ");

describe("frenchCardinalWords", () => {
  it.each([
    [0, "zéro"],
    [1, "un"],
    [10, "dix"],
    [11, "onze"],
    [16, "seize"],
    [17, "dix sept"],
    [19, "dix neuf"],
    [20, "vingt"],
    [21, "vingt et un"],
    [29, "vingt neuf"],
    [41, "quarante et un"],
    [51, "cinquante et un"],
    [61, "soixante et un"],
    [69, "soixante neuf"],
    [70, "soixante dix"],
    [71, "soixante et onze"],
    [76, "soixante seize"],
    [79, "soixante dix neuf"],
    [80, "quatre vingts"],
    [81, "quatre vingt un"],
    [89, "quatre vingt neuf"],
    [90, "quatre vingt dix"],
    [91, "quatre vingt onze"],
    [97, "quatre vingt dix sept"],
    [100, "cent"],
    [101, "cent un"],
    [180, "cent quatre vingts"],
    [200, "deux cents"],
    [201, "deux cent un"],
    [280, "deux cent quatre vingts"],
    [1000, "mille"],
    [1001, "mille un"],
    [1100, "mille cent"],
    [2000, "deux mille"],
    [21000, "vingt et un mille"],
    [80000, "quatre vingt mille"],
    [80080, "quatre vingt mille quatre vingts"],
    [200000, "deux cent mille"],
    [200200, "deux cent mille deux cents"],
    [999999, "neuf cent quatre vingt dix neuf mille neuf cent quatre vingt dix neuf"],
    [1_000_000, "un million"],
    [2_000_000, "deux millions"],
    [80_000_000, "quatre vingts millions"],
    [200_000_000, "deux cents millions"],
    [1_000_000_000, "un milliard"],
    [3_000_000_001, "trois milliards un"],
  ])("%i → %s", (n, expected) => {
    expect(say(n)).toBe(expected);
  });

  it("makes a final un feminine on request", () => {
    expect(frenchCardinalWords(1, { feminine: true })).toEqual(["une"]);
    expect(frenchCardinalWords(21, { feminine: true })).toEqual(["vingt", "et", "une"]);
    expect(frenchCardinalWords(81, { feminine: true })).toEqual(["quatre", "vingt", "une"]);
    expect(frenchCardinalWords(2, { feminine: true })).toEqual(["deux"]);
  });

  it("rejects values outside 0..MAX_FRENCH_CARDINAL", () => {
    expect(() => frenchCardinalWords(-1)).toThrow(RangeError);
    expect(() => frenchCardinalWords(1.5)).toThrow(RangeError);
    expect(() => frenchCardinalWords(MAX_FRENCH_CARDINAL + 1)).toThrow(RangeError);
    expect(frenchCardinalWords(MAX_FRENCH_CARDINAL).at(-1)).toBe("neuf");
  });

  it("spells every value in 0..999999 with plain words", () => {
    const malformed: number[] = [];
    const seen = new Set<string>();
    for (let n = 0; n <= 999_999; n += 1) {
      const words = frenchCardinalWords(n);
      if (words.length === 0 || words.some((word) => !/^[a-zé]+$/u.test(word))) malformed.push(n);
      seen.add(words.join(" "));
    }
    expect(malformed).toEqual([]);
    // Every number has its own spelling.
    expect(seen.size).toBe(1_000_000);
  }, 30_000); // A million values: slow when the Mac is busy.
});

describe("frenchOrdinalWords", () => {
  it.each([
    [1, "premier"],
    [2, "deuxième"],
    [3, "troisième"],
    [4, "quatrième"],
    [5, "cinquième"],
    [9, "neuvième"],
    [10, "dixième"],
    [11, "onzième"],
    [21, "vingt et unième"],
    [80, "quatre vingtième"],
    [81, "quatre vingt unième"],
    [100, "centième"],
    [200, "deux centième"],
    [1000, "millième"],
    [1_000_000, "un millionième"],
  ])("%i → %s", (n, expected) => {
    expect(frenchOrdinalWords(n).join(" ")).toBe(expected);
  });

  it("handles feminine and plural forms", () => {
    expect(frenchOrdinalWords(1, { feminine: true })).toEqual(["première"]);
    expect(frenchOrdinalWords(1, { plural: true })).toEqual(["premiers"]);
    expect(frenchOrdinalWords(3, { plural: true })).toEqual(["troisièmes"]);
  });

  it("rejects zero", () => {
    expect(() => frenchOrdinalWords(0)).toThrow(RangeError);
  });
});

describe("frenchDigitsToWords", () => {
  it.each([
    ["0", "zéro"],
    ["00", "zéro zéro"],
    ["06", "zéro six"],
    ["007", "zéro zéro sept"],
    ["42", "quarante deux"],
    ["1234567890123", "un deux trois quatre cinq six sept huit neuf zéro un deux trois"],
  ])("%s → %s", (digits, expected) => {
    expect(frenchDigitsToWords(digits).join(" ")).toBe(expected);
  });

  it("rejects non-digit input", () => {
    expect(() => frenchDigitsToWords("12a")).toThrow(RangeError);
    expect(() => frenchDigitsToWords("")).toThrow(RangeError);
  });
});
