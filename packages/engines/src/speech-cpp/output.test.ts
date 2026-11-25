import { describe, expect, it } from "vitest";
import { EngineError } from "../contract.ts";
import { RecognitionEnd } from "./messages.ts";
import { assignTokens, recognitionFrom, segmentsMakeText } from "./output.ts";

const context = { durationSec: 10, timestamps: true, speakers: true };

const end = (fields: Record<string, unknown>) =>
  RecognitionEnd.parse({ type: "end", id: "r", stop: "complete", ...fields });

const codeOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    if (error instanceof EngineError) return `${error.code}: ${error.message}`;
    throw error;
  }
  return "ok";
};

describe("segment texts", () => {
  it("accept segments joined with or without spaces", () => {
    expect(
      segmentsMakeText(
        [
          { start: 0, end: 1, text: "Bonjour." },
          { start: 1, end: 2, text: "Ça va ?" },
        ],
        "Bonjour. Ça va ?",
      ),
    ).toBe(true);
    expect(
      segmentsMakeText(
        [
          { start: 0, end: 1, text: " Bonjour." },
          { start: 1, end: 2, text: " Ça va ?" },
        ],
        " Bonjour. Ça va ?",
      ),
    ).toBe(true);
    expect(segmentsMakeText([{ start: 0, end: 1, text: "Bonjour." }], "Bonjour. Ça va ?")).toBe(
      false,
    );
    expect(segmentsMakeText([], "")).toBe(true);
  });
});

describe("token assignment", () => {
  const segments = [
    { start: 0, end: 2, text: "Bonjour à tous." },
    { start: 2.5, end: 4, text: "On commence ?" },
  ];

  it("follows the text when the tokens spell the segments", () => {
    const tokens = [
      { start: 0, end: 0.5, text: " Bon" },
      { start: 0.5, end: 0.9, text: "jour" },
      { start: 1, end: 1.2, text: " à" },
      { start: 1.3, end: 2.6, text: " tous." },
      { start: 2.6, end: 3, text: " On" },
      { start: 3, end: 3.6, text: " commence" },
      { start: 3.6, end: 3.8, text: " ?" },
    ];
    expect(assignTokens(segments, tokens).map((group) => group.map((token) => token.text))).toEqual(
      [
        [" Bon", "jour", " à", " tous."],
        [" On", " commence", " ?"],
      ],
    );
  });

  it("falls back to time when the texts do not line up", () => {
    const tokens = [
      { start: 0, end: 0.5, text: " bonjour" },
      { start: 1, end: 1.9, text: " atous" },
      { start: 2.4, end: 2.45, text: " on" },
      { start: 3, end: 3.6, text: " commence" },
    ];
    expect(assignTokens(segments, tokens).map((group) => group.map((token) => token.text))).toEqual(
      [
        [" bonjour", " atous"],
        [" on", " commence"],
      ],
    );
  });
});

describe("recognition output", () => {
  const valid = {
    text: "Bonjour. Salut.",
    segments: [
      { start: 0, end: 1.5, text: "Bonjour.", speaker: 0 },
      { start: 2, end: 10.4, text: "Salut.", speaker: 1 },
    ],
    tokens: [
      { start: 0, end: 1.5, text: " Bonjour." },
      { start: 2, end: 10.4, text: " Salut." },
    ],
  };

  const bad = (fields: Record<string, unknown>) =>
    codeOf(() => recognitionFrom(end({ ...valid, ...fields }), context));
  const reasonOf = (fields: Record<string, unknown>) => {
    try {
      recognitionFrom(end({ ...valid, ...fields }), context);
      return null;
    } catch (error) {
      return error instanceof EngineError ? error.reason : null;
    }
  };

  it("maps segments, speakers and tokens, clamping times within the tolerance", () => {
    const result = recognitionFrom(end(valid), context);
    expect(result).toEqual({
      text: "Bonjour. Salut.",
      stop: "complete",
      languages: [],
      segments: [
        {
          startSec: 0,
          endSec: 1.5,
          text: "Bonjour.",
          speaker: 0,
          tokens: [{ startSec: 0, endSec: 1.5, text: " Bonjour." }],
        },
        {
          startSec: 2,
          endSec: 10,
          text: "Salut.",
          speaker: 1,
          tokens: [{ startSec: 2, endSec: 10, text: " Salut." }],
        },
      ],
    });
  });

  it("keeps speakers out when they were not asked for", () => {
    const result = recognitionFrom(end(valid), { ...context, speakers: false });
    expect(result.segments.map((segment) => segment.speaker)).toEqual([null, null]);
  });

  it("returns the text alone when neither timestamps nor speakers were asked for", () => {
    expect(
      recognitionFrom(end({ text: "Bonjour." }), {
        ...context,
        timestamps: false,
        speakers: false,
      }),
    ).toEqual({
      text: "Bonjour.",
      stop: "complete",
      languages: [],
      segments: [],
    });
  });

  it("refuses output the host could not map back", () => {
    expect(bad({ stop: "max_seconds" })).toMatch(/^invalid_output: unknown stop/);
    expect(bad({ segments: undefined })).toMatch(/^invalid_output: .*no segments/);
    expect(bad({ tokens: undefined })).toMatch(/^invalid_output: .*no tokens/);
    expect(bad({ untimed: "no timestamp head" })).toMatch(/^invalid_output: .*could not time/);
    expect(
      bad({ segments: [{ start: -0.1, end: 1, text: "Bonjour. Salut.", speaker: 0 }] }),
    ).toMatch(/^invalid_output: segment 0 runs/);
    expect(bad({ segments: [{ start: 2, end: 1, text: "Bonjour. Salut.", speaker: 0 }] })).toMatch(
      /^invalid_output: segment 0 runs/,
    );
    expect(
      bad({ segments: [{ start: 0, end: 11.5, text: "Bonjour. Salut.", speaker: 0 }] }),
    ).toMatch(/past the 10 s/);
    expect(bad({ tokens: [{ start: 0, end: 12, text: " Bonjour." }] })).toMatch(
      /^invalid_output: token 0 ends/,
    );
    expect(bad({ segments: [{ start: 0, end: 1, text: "Bonjour.", speaker: 0 }] })).toMatch(
      /do not make the request's text/,
    );
  });

  it("gives each refusal a fixed reason that never quotes the output", () => {
    expect(reasonOf({ stop: "max_seconds" })).toBe("unknown-stop");
    expect(reasonOf({ segments: undefined })).toBe("no-segments");
    expect(reasonOf({ tokens: undefined })).toBe("no-tokens");
    expect(reasonOf({ untimed: "no timestamp head" })).toBe("untimed");
    expect(
      reasonOf({ segments: [{ start: 2, end: 1, text: "Bonjour. Salut.", speaker: 0 }] }),
    ).toBe("time-reversed");
    expect(
      reasonOf({ segments: [{ start: 0, end: 11.5, text: "Bonjour. Salut.", speaker: 0 }] }),
    ).toBe("time-past-audio");
    expect(reasonOf({ segments: [{ start: 0, end: 1, text: "Bonjour.", speaker: 0 }] })).toBe(
      "text-mismatch",
    );
  });

  it("never reads a time that JSON turns into infinity", () => {
    const line =
      '{"type":"end","id":"r","stop":"complete","text":"a","segments":[{"start":0,"end":1e400,"text":"a","speaker":0}],"tokens":[]}';
    expect(RecognitionEnd.safeParse(JSON.parse(line)).success).toBe(false);
  });

  it("passes the languages the engine reported", () => {
    expect(recognitionFrom(end({ ...valid, languages: ["fr"] }), context).languages).toEqual([
      "fr",
    ]);
  });
});
