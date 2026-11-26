import { describe, expect, it } from "vitest";
import {
  applyVocabulary,
  buildVocabulary,
  correctionLessons,
  looksLike,
  nameWords,
  namesWrittenIn,
  vocabularyCandidates,
} from "./vocabulary";

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

describe("the user's names (vocabulary/3)", () => {
  const named = (names: string[], ...pairs: [string, string][]) =>
    buildVocabulary({
      corrections: pairs.map(([original, text]) => ({ original, text })),
      names,
    });
  const spell = (text: string, vocabulary: ReturnType<typeof named>, written?: Set<string>) =>
    applyVocabulary({ text }, vocabulary, written).segment.text;

  it("spells a name that sounds like one of the user's their way, mid-sentence", () => {
    const vocabulary = named(["Téo", "Marie-Anne Dupont"]);
    expect(spell("Ouais Théo t'as vu", vocabulary)).toBe("Ouais Téo t'as vu");
    expect(spell("avec Dupond hier", vocabulary)).toBe("avec Dupont hier");
    // Not a name the engine wrote: a common word stays.
    expect(spell("en théorie oui", vocabulary)).toBe("en théorie oui");
    expect(spell("le théo du coin", vocabulary)).toBe("le théo du coin");
  });

  it("spells one at a sentence's start only when the transcript writes it as a name elsewhere", () => {
    const vocabulary = named(["Téo"]);
    expect(spell("Théo, on y va.", vocabulary)).toBe("Théo, on y va.");
    expect(spell("Théo, on y va.", vocabulary, namesWrittenIn(["merci Théo"]))).toBe(
      "Téo, on y va.",
    );
  });

  it("leaves a name followed by a surname, unless the full name is the user's", () => {
    expect(spell("il y avait Théo Martin hier", named(["Téo"]))).toBe(
      "il y avait Théo Martin hier",
    );
    expect(spell("mais Théo GG.", named(["Téo"]))).toBe("mais Théo GG.");
    // Not a surname: a comma, or a word without a capital.
    expect(spell("merci Théo, Martin arrive", named(["Téo"]))).toBe("merci Téo, Martin arrive");
    expect(spell("vas-y Théo tu valides", named(["Téo"]))).toBe("vas-y Téo tu valides");
    // The user's own full name.
    expect(spell("avec Théo Martin hier", named(["Téo Martin"]))).toBe("avec Téo Martin hier");
    expect(vocabularyCandidates("allez Sandrine Dupont", named(["Sondine"]))).toEqual([]);
  });

  it("leaves a name two of the user's sound like", () => {
    const vocabulary = named(["Téo", "Théo"]);
    expect(spell("salut Teo", vocabulary)).toBe("salut Teo");
    expect(spell("salut Théo", vocabulary)).toBe("salut Théo");
  });

  it("learns at a sentence's start when the name is already known", () => {
    const pair: [string, string] = ["Théo t'as passé Sandrine", "Téo t'as passé Sondine"];
    // Unknown: a capital at the start proves nothing.
    expect(named([], pair).corrections.size).toBe(0);
    // One of the user's names, or one another correction taught.
    expect(named(["Téo"], pair).corrections.get("theo")).toBe("Téo");
    expect(named([], ["ouais Théo", "ouais Téo"], pair).corrections.get("theo")).toBe("Téo");
    // A fix that does not sound like what was heard is still not learned.
    expect(named(["Téo", "Sondine"], pair).corrections.has("sandrine")).toBe(false);
  });

  it("says what a correction taught, and what it could not", () => {
    const original = "Théo t'as passé Sandrine hem attends c'est Sandrine";
    const text = "Téo t'as passé Sondine hem attends c'est Sondine";
    const lessons = (names: string[]) =>
      correctionLessons({
        original,
        text,
        vocabulary: named(names, [original, text]),
      });
    expect(lessons(["Téo"])).toEqual({ learned: ["Téo"], unheard: ["Sondine"] });
    // Already in the list: nothing to offer.
    expect(lessons(["Téo", "Sondine"])).toEqual({ learned: ["Téo"], unheard: [] });
    expect(lessons([])).toEqual({ learned: [], unheard: ["Sondine"] });
  });

  it("finds a name that only looks like one of the user's, for the model", () => {
    const vocabulary = named(["Sondine", "Téo"]);
    expect(vocabularyCandidates("Il va capter les appels, Sandrine.", vocabulary)).toEqual([
      { charStart: 25, charEnd: 33, word: "Sandrine", name: "Sondine" },
    ]);
    // Sounds the same: the rule spells it, no question; a common word, no name.
    expect(vocabularyCandidates("salut Théo", vocabulary)).toEqual([]);
    expect(vocabularyCandidates("une sandrine", vocabulary)).toEqual([]);
    expect(vocabularyCandidates("Sandrine arrive.", vocabulary)).toEqual([]);
    // One of the user's own names is never asked about.
    expect(vocabularyCandidates("avec Sandrine", named(["Sondine", "Sandrine"]))).toEqual([]);
  });

  it("tells near keys from far ones", () => {
    expect(looksLike("sandrin", "sondin")).toBe(true);
    expect(looksLike("sondin", "sondin")).toBe(false);
    expect(looksLike("marc", "mari")).toBe(true);
    expect(looksLike("budget", "sondin")).toBe(false);
    // Another first sound, or too short to judge.
    expect(looksLike("tondin", "sondin")).toBe(false);
    expect(looksLike("teo", "leo")).toBe(false);
  });

  it("lists every word of the user's names once", () => {
    expect(nameWords(["Marie-Anne Dupont", "Dupont", "Al", "Москва"])).toEqual([
      "Marie-Anne",
      "Dupont",
    ]);
  });
});
