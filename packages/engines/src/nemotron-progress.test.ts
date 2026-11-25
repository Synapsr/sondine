import { describe, expect, it } from "vitest";
import { DEFAULT_TOKENS_PER_SECOND, nemotronProgress } from "./nemotron-progress.ts";

// What speech.cpp reports while it writes: (2 + positions used / 65 536) / 3.
const writing = (positions: number) => (2 + positions / 65_536) / 3;
/** 55 min of audio fill 41 250 positions, plus the prompt. */
const audioPositions = 41_280;

describe("nemotron progress", () => {
  it("gives encoding and reading the first 15 %, writing the rest", () => {
    const request = nemotronProgress().start(3_300);
    expect(request.report(0)).toBe(0);
    expect(request.report(1 / 3)).toBeCloseTo(0.075);
    expect(request.report(2 / 3)).toBeCloseTo(0.15);
    // Writing starts where speech.cpp says 0.88: here it is still 15 %.
    expect(request.report(writing(audioPositions))).toBeCloseTo(0.15);
    const half = (DEFAULT_TOKENS_PER_SECOND * 3_300) / 2;
    expect(request.report(writing(audioPositions + half))).toBeCloseTo(0.575);
    expect(request.report(1)).toBe(1);
  });

  it("stays below the end while writing outlasts the estimate", () => {
    const request = nemotronProgress().start(600);
    request.report(writing(7_530));
    expect(request.report(writing(7_530 + 10 * DEFAULT_TOKENS_PER_SECOND * 600))).toBeCloseTo(
      0.15 + 0.85 * 0.95,
    );
  });

  it("learns how much text a second of audio gives from the request that ended", () => {
    const shape = nemotronProgress();
    const first = shape.start(3_300);
    first.report(writing(audioPositions));
    first.report(writing(audioPositions + 6.0 * 3_300));
    first.report(1);
    first.end();
    const next = shape.start(3_300);
    next.report(writing(audioPositions));
    expect(next.report(writing(audioPositions + 3.0 * 3_300))).toBeCloseTo(0.575);
  });

  it("learns nothing from a short request", () => {
    const shape = nemotronProgress();
    const short = shape.start(30);
    short.report(writing(400));
    short.report(writing(400 + 1_000));
    short.end();
    const next = shape.start(3_300);
    next.report(writing(audioPositions));
    const half = (DEFAULT_TOKENS_PER_SECOND * 3_300) / 2;
    expect(next.report(writing(audioPositions + half))).toBeCloseTo(0.575);
  });
});
