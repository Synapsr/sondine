import { describe, expect, it } from "vitest";
import { phoneticInitials, phoneticKey } from "./phonetic";

describe("phoneticKey", () => {
  it("gives two spellings of a name that sound alike the same key", () => {
    const pairs = [
      ["camille", "kamille"],
      ["philippe", "filip"],
      ["thomas", "tomas"],
      ["sophie", "sofie"],
      ["mathieu", "matthieu"],
      ["celine", "seline"],
      ["nicolas", "nikolas"],
      ["christophe", "kristof"],
      ["jerome", "gerome"],
      ["laurent", "lorant"],
      ["vincent", "vinsan"],
      ["gwenaelle", "gwenael"],
      ["arnaud", "arno"],
      ["bernard", "bernar"],
      ["charles", "sharl"],
      ["xavier", "ksavier"],
    ];
    for (const [a, b] of pairs)
      expect(phoneticKey(a ?? ""), `${a} / ${b}`).toBe(phoneticKey(b ?? ""));
  });

  it("keeps words that sound different apart", () => {
    const pairs = [
      ["camille", "camion"],
      ["pierre", "paul"],
      ["jerome", "jeremy"],
      ["marie", "mario"],
      ["budget", "bouger"],
      ["guerre", "gere"],
      ["charles", "karl"],
    ];
    for (const [a, b] of pairs) {
      expect(phoneticKey(a ?? ""), `${a} / ${b}`).not.toBe(phoneticKey(b ?? ""));
    }
  });

  it("leaves short words and numbers as they are", () => {
    expect(phoneticKey("le")).toBe("le");
    expect(phoneticKey("2026")).toBe("2026");
  });

  it("says where to look for words of a key", () => {
    expect(phoneticInitials(phoneticKey("kamille"))).toEqual(expect.arrayContaining(["c", "k"]));
    expect(phoneticInitials(phoneticKey("filip"))).toEqual(expect.arrayContaining(["f", "p"]));
    expect(phoneticInitials(phoneticKey("arnaud"))).toEqual(expect.arrayContaining(["a", "h"]));
  });
});
