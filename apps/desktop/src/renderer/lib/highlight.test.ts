import { describe, expect, it } from "vitest";
import { highlightParts } from "./highlight";

describe("highlightParts", () => {
  it("cuts the text into plain and matched parts", () => {
    expect(highlightParts("Je vais à l'école.", [{ start: 12, end: 17 }])).toEqual([
      { text: "Je vais à l'", match: false },
      { text: "école", match: true },
      { text: ".", match: false },
    ]);
    expect(highlightParts("budget", [{ start: 0, end: 6 }])).toEqual([
      { text: "budget", match: true },
    ]);
    expect(highlightParts("rien", [])).toEqual([{ text: "rien", match: false }]);
  });

  it("clamps ranges that overlap or run past the text", () => {
    expect(
      highlightParts("abcdef", [
        { start: 1, end: 3 },
        { start: 2, end: 4 },
        { start: 5, end: 9 },
      ]),
    ).toEqual([
      { text: "a", match: false },
      { text: "bc", match: true },
      { text: "d", match: true },
      { text: "e", match: false },
      { text: "f", match: true },
    ]);
  });
});
