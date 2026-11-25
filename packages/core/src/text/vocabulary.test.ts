import { describe, expect, it } from "vitest";
import { applyVocabulary, buildVocabulary } from "./vocabulary";

const words = (text: string) =>
  [...text.matchAll(/\S+/gu)].map((match) => ({
    charStart: match.index,
    charEnd: match.index + match[0].length,
    startMs: match.index * 10,
    endMs: match.index * 10 + 5,
  }));

const segmentOf = (text: string) => ({ text, words: words(text) });
const taught = (...pairs: [string, string][]) =>
  buildVocabulary({ corrections: pairs.map(([original, text]) => ({ original, text })) });

describe("personal vocabulary", () => {
  it("spells a name as the user once corrected it, and keeps the word timings in step", () => {
    const vocabulary = taught(["je crois que Kamille arrive", "je crois que Camille arrive"]);
    const { segment, replaced } = applyVocabulary(
      segmentOf("Je crois que Kamille a appelé"),
      vocabulary,
    );
    expect(segment.text).toBe("Je crois que Camille a appelé");
    expect(replaced).toBe(1);
    expect(segment.words.map((word) => segment.text.slice(word.charStart, word.charEnd))).toEqual([
      "Je",
      "crois",
      "que",
      "Camille",
      "a",
      "appelé",
    ]);
  });

  it("learns a name's accents too", () => {
    const vocabulary = taught(["avec Anais ce soir", "avec Anaïs ce soir"]);
    expect(applyVocabulary(segmentOf("avec Anais"), vocabulary).segment.text).toBe("avec Anaïs");
  });

  it("learns no common word, and no fix that sounds different", () => {
    expect(taught(["le verre est plein", "le vert est plein"]).corrections.size).toBe(0);
    expect(taught(["on parle du Budget", "on parle du Planning"]).corrections.size).toBe(0);
    expect(taught(["Москва", "Мадрид"]).corrections.size).toBe(0);
    // A capital at a sentence's start proves nothing.
    expect(taught(["Verre sombre", "Vert sombre"]).corrections.size).toBe(0);
  });

  it("forgets a fix the user made two ways", () => {
    const vocabulary = taught(
      ["et Kamille arrive", "et Camille arrive"],
      ["et Kamille part", "et Kamil part"],
    );
    expect(vocabulary.corrections.has("kamille")).toBe(false);
  });
});
