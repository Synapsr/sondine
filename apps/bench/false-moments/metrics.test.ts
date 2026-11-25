import { describe, expect, it } from "vitest";
import { perHour, scoreEvent, unionOverlap, validateRegions } from "./metrics.ts";

const event = {
  sourceId: "word",
  startSample: 16000,
  endSample: 24000,
  language: "fr",
  speaker: "one",
};
const region = {
  startSample: 0,
  endSample: 32000,
  speechStartSample: 8000,
  speechEndSample: 12000,
  voicedMs: 250,
  meanProbability: 0.8,
  maxProbability: 0.9,
};
describe("honest retention accounting", () => {
  it("unions roll padding instead of counting duplicate samples twice", () =>
    expect(
      unionOverlap(0, 100, [
        [0, 80],
        [20, 100],
        [80, 120],
      ]),
    ).toBe(100));
  it("separates captured padding from a speech decision at the labelled word", () => {
    const result = scoreEvent(event, [region]);
    expect(result.wholeClipRetained).toBe(true);
    expect(result.speechEnvelopeOverlap).toBe(false);
  });
  it("reports a miss for no region, without inventing a rejected transcript", () =>
    expect(scoreEvent(event, []).captureOverlap).toBe(false));
  it("does not count a one-sample incidental overlap as a retained utterance", () =>
    expect(scoreEvent(event, [{ ...region, startSample: 23999 }]).captureOverlap).toBe(false));
  it("rejects impossible native bounds and times", () => {
    expect(() => validateRegions([{ ...region, speechEndSample: 33000 }], 32000)).toThrow();
    expect(() => validateRegions([{ ...region, voicedMs: 3000 }], 32000)).toThrow();
  });
  it("uses actual audio duration, excluding logical grouping flush time", () =>
    expect(perHour(2, 60_000)).toBe(120));
  it("refuses empty-duration rates", () => expect(() => perHour(0, 0)).toThrow());
});
