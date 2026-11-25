import { describe, expect, it } from "vitest";
import type { ReadTrackAudio } from "../audio/track-audio";
import { readPieces } from "./voice-tool";

const samples = (base64: string) => new Int16Array(Buffer.from(base64, "base64").buffer.slice(0));

// 3 s of audio whose samples count up, with 0.5 s missing in the middle of the second second.
const read: ReadTrackAudio = (range) => ({
  samples: Int16Array.from(
    { length: range.sampleEnd - range.sampleStart },
    (_, i) => (i % 30_000) + 1,
  ),
  missing: [
    {
      sampleStart: range.sampleStart + 20_000,
      sampleEnd: range.sampleStart + 28_000,
      reason: "expired",
    },
  ],
});

describe("voice pass", () => {
  it("sends each piece without what the spool no longer holds, in stretches of 1 s or more", () => {
    const pieces = readPieces(read, [
      { trackRunId: 1, sampleStart: 160_000, sampleEnd: 208_000 },
    ]).map(samples);
    expect(pieces.map((piece) => piece.length)).toEqual([20_000, 20_000]);
    expect(pieces[1]?.[0]).toBe(28_001);
  });
});
