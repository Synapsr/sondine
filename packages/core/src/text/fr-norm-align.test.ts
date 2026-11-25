import { describe, expect, it } from "vitest";

import { frNormId, frNormTokens, type FrNormOptions } from "./fr-norm";
import { FR_NORM_ALIGN_VERSION, frNormAlign, frNormAlignId } from "./fr-norm-align";

const search = { fillers: "drop", numbers: "words", diacritics: "strip" } as const;

/** Each unit as [original text, tokens joined]. */
function units(text: string, options: FrNormOptions = search): [string, string][] {
  return frNormAlign(text, options).map((unit) => [
    text.slice(unit.start, unit.end),
    unit.tokens.join(" "),
  ]);
}

describe("frNormAlign", () => {
  it("gives each word its own unit, punctuation none", () => {
    expect(units("Bonjour à tous.")).toEqual([
      ["Bonjour", "bonjour"],
      ["à", "a"],
      ["tous", "tous"],
      [".", ""],
    ]);
    expect(units("Bonjour à tous.", {})).toContainEqual(["à", "à"]);
  });

  it("keeps an elided article apart from its word", () => {
    expect(units("l'école")).toEqual([
      ["l'", "l'"],
      ["école", "ecole"],
    ]);
    expect(units("Jusqu’à l’hôpital")).toEqual([
      ["Jusqu’", "jusqu'"],
      ["à", "a"],
      ["l’", "l'"],
      ["hôpital", "hopital"],
    ]);
    expect(units("aujourd'hui, presqu'île")).toEqual([
      ["aujourd'hui", "aujourd'hui"],
      [",", ""],
      ["presqu'île", "presqu'ile"],
    ]);
    expect(units("rendez-vous")).toEqual([
      ["rendez", "rendez"],
      ["-", ""],
      ["vous", "vous"],
    ]);
  });

  it("drops fillers to a unit with no token", () => {
    expect(units("euh, voilà")).toEqual([
      ["euh", ""],
      [",", ""],
      ["voilà", "voila"],
    ]);
  });

  it("maps digits to every word they become", () => {
    expect(units("22 personnes")).toEqual([
      ["22", "vingt deux"],
      ["personnes", "personnes"],
    ]);
    expect(units("vingt-deux")).toEqual([
      ["vingt", "vingt"],
      ["-", ""],
      ["deux", "deux"],
    ]);
  });

  it("merges a number with what it reads together", () => {
    expect(units("on perd 15 % de remise")).toEqual([
      ["on", "on"],
      ["perd", "perd"],
      ["15 %", "quinze pour cent"],
      ["de", "de"],
      ["remise", "remise"],
    ]);
    // "10 h" alone already reads "dix heures"; "05" needs its hour.
    expect(units("à 10 h 30 ou 10h05")).toEqual([
      ["à", "a"],
      ["10 h", "dix heures"],
      ["30", "trente"],
      ["ou", "ou"],
      ["10h05", "dix heures cinq"],
    ]);
    expect(units("à 10 h 05")).toEqual([
      ["à", "a"],
      ["10 h 05", "dix heures cinq"],
    ]);
    expect(units("1 000 personnes et 3,50 €")).toEqual([
      ["1 000", "mille"],
      ["personnes", "personnes"],
      ["et", "et"],
      ["3,50 €", "trois euros cinquante"],
    ]);
    expect(units("le 1er, le n° 5")).toEqual([
      ["le", "le"],
      ["1er", "premier"],
      [",", ""],
      ["le", "le"],
      ["n° 5", "numero cinq"],
    ]);
    expect(units("quatre vingts ans")).toEqual([
      ["quatre vingts", "quatre vingt"],
      ["ans", "ans"],
    ]);
  });

  it("follows the English path for English text", () => {
    const en = { ...search, language: "en" } as const;
    expect(units("Don't worry, it's 1,000 bucks, um, ok", en)).toEqual([
      ["Don't", "don't"],
      ["worry", "worry"],
      [",", ""],
      ["it's", "it's"],
      ["1,000", "1000"],
      ["bucks", "bucks"],
      [",", ""],
      ["um", ""],
      [",", ""],
      ["ok", "ok"],
    ]);
  });

  it("gives UTF-16 offsets over the original text", () => {
    const text = "Super 👍 école";
    const found = frNormAlign(text, search);
    expect(found.map((unit) => text.slice(unit.start, unit.end))).toEqual(["Super", "👍", "école"]);
    expect(found.at(-1)?.tokens).toEqual(["ecole"]);
  });

  it("falls back to one unit when no nearby grouping agrees", () => {
    // The annotation is removed as a whole, eight words wide.
    const text = "[bruit de fond très fort et continu ici] oui";
    expect(units(text)).toEqual([[text, "oui"]]);
    expect(units("[rire] oui")).toEqual([
      ["[rire]", ""],
      ["oui", "oui"],
    ]);
  });

  it("returns nothing for blank text", () => {
    expect(frNormAlign("")).toEqual([]);
    expect(frNormAlign("  \n ")).toEqual([]);
  });

  it("always reproduces the normalized tokens, in order, skipping only whitespace", () => {
    const corpus = [
      "Il faudrait renvoyer le devis, sinon on perd 15 % de remise, euh, voilà.",
      "Le rendez-vous chez le médecin est à 10 h 15, au 3e étage, porte n°12.",
      "Ça coûte 1 250,75 € ou $ 30, soit 2 000 000 € pour quatre-vingts personnes !",
      "« L'Œuvre » de Cœur, ex æquo : ben hein, mmh… ok d'accord",
      "On décale à 15 h ? Le client est en retard. Tu peux me renvoyer le lien du doc ?",
      "Les 2es et 1res années, le XXIe siècle, 45 min, 7:30, 0,5 %.",
      "We talked about the budget (12.5k) for next week & the 3rd quarter, uh, right?",
      "  espaces   multiples\tet\nretours  ",
    ];
    for (const text of corpus) {
      for (const language of ["fr", "en"] as const) {
        const options = { ...search, language };
        const found = frNormAlign(text, options);
        expect(
          found.flatMap((unit) => unit.tokens),
          text,
        ).toEqual(frNormTokens(text, options));
        let at = 0;
        for (const unit of found) {
          expect(unit.start).toBeGreaterThanOrEqual(at);
          expect(text.slice(at, unit.start).trim(), text).toBe("");
          expect(unit.end).toBeGreaterThan(unit.start);
          at = unit.end;
        }
        expect(text.slice(at).trim()).toBe("");
      }
    }
  });

  it("is identified by its version and the normalizer's id", () => {
    expect(frNormAlignId(search)).toBe(`${FR_NORM_ALIGN_VERSION};${frNormId(search)}`);
  });
});
