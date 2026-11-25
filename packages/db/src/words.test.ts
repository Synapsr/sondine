import { describe, expect, it } from "vitest";
import { packWords, unpackWords, WordsFormatError, type WordTiming } from "./words";

const timing = (word: WordTiming) => [word.charStart, word.charEnd, word.startMs, word.endMs];

describe("packed word timings", () => {
  it("round-trips offsets, times, and confidence", () => {
    const words: WordTiming[] = [
      { charStart: 0, charEnd: 7, startMs: 0, endMs: 420, confidence: 1 },
      { charStart: 8, charEnd: 14, startMs: 380, endMs: 900, confidence: 0 },
      { charStart: 15, charEnd: 15, startMs: 900, endMs: 900, confidence: null },
      { charStart: 12, charEnd: 20, startMs: 120_000, endMs: 3_600_000, confidence: 0.5 },
    ];
    const decoded = unpackWords(packWords(words));
    expect(decoded.map(timing)).toEqual(words.map(timing));
    expect(decoded.map((word) => word.confidence)).toEqual([1, 0, null, 127 / 254]);
  });

  it("stores about six bytes per word", () => {
    const words = Array.from({ length: 1000 }, (_, index) => ({
      charStart: index * 7,
      charEnd: index * 7 + 6,
      startMs: index * 350,
      endMs: index * 350 + 300,
      confidence: 0.8,
    }));
    const blob = packWords(words);
    expect(blob.byteLength / words.length).toBeLessThanOrEqual(6.01);
    expect(unpackWords(blob)).toHaveLength(1000);
  });

  it("rejects invalid input and corrupt blobs", () => {
    expect(() => packWords([{ charStart: 5, charEnd: 2, startMs: 0, endMs: 1 }])).toThrow(
      RangeError,
    );
    expect(() =>
      packWords([{ charStart: 0, charEnd: 1, startMs: 0, endMs: 1, confidence: 2 }]),
    ).toThrow(RangeError);
    expect(() => packWords([{ charStart: 0.5, charEnd: 1, startMs: 0, endMs: 1 }])).toThrow(
      RangeError,
    );
    const blob = packWords([{ charStart: 0, charEnd: 3, startMs: 0, endMs: 100 }]);
    expect(() => unpackWords(blob.subarray(0, blob.length - 1))).toThrow(WordsFormatError);
    expect(() => unpackWords(Uint8Array.of(9, 0))).toThrow(WordsFormatError);
    expect(() => unpackWords(Uint8Array.of(...blob, 0))).toThrow(WordsFormatError);
  });
});
