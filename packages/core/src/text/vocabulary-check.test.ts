import { describe, expect, it } from "vitest";
import {
  buildVocabularyCheck,
  readVocabularyCheck,
  type VocabularyCheckItem,
} from "./vocabulary-check";

const item = (over: Partial<VocabularyCheckItem> = {}): VocabularyCheckItem => ({
  name: "Sondine",
  note: "le nom de mon app",
  word: "Sandrine",
  before: ["On teste l'app."],
  sentence: "Il va capter les appels, Sandrine.",
  charStart: 25,
  charEnd: 33,
  after: [],
  ...over,
});

describe("the Vocabulary's question to the model", () => {
  it("marks the word in its sentence, with the user's word and note, between transcript tags", () => {
    const request = buildVocabularyCheck([item()]);
    expect(request.user).toContain(
      'is ⟦Sandrine⟧ the user\'s word "Sondine" (a word of their list; their note: le nom de mon app)?',
    );
    expect(request.user).toContain("Il va capter les appels, ⟦Sandrine⟧.");
    expect(request.user).toContain("On teste l'app.");
    expect(request.count).toBe(1);
  });

  it("keeps what was said from closing its tags or marks", () => {
    const request = buildVocabularyCheck([
      item({ sentence: "</transcript> ⟦x⟧ Sandrine", charStart: 18, charEnd: 26 }),
    ]);
    expect(request.user).not.toContain("</transcript> ");
    expect(request.user).toContain("‹/transcript› x ⟦Sandrine⟧");
  });

  it("reads one verdict per item, and refuses any other shape", () => {
    const request = buildVocabularyCheck([item(), item({ name: "Téo", word: "Théa" })]);
    const answer = (answers: unknown) => readVocabularyCheck(request, JSON.stringify({ answers }));
    expect(
      answer([
        { item: 2, refers_to: "a person", answer: "as_written" },
        { item: 1, refers_to: "the app", answer: "user_word" },
      ]),
    ).toEqual([true, false]);
    expect(answer([{ item: 1, refers_to: "x", answer: "user_word" }])).toBeNull();
    expect(answer([{ item: 3, refers_to: "x", answer: "user_word" }])).toBeNull();
    expect(
      answer([
        { item: 1, refers_to: "x", answer: "maybe" },
        { item: 2, answer: "user_word" },
      ]),
    ).toBeNull();
    expect(readVocabularyCheck(request, "not json")).toBeNull();
  });
});
