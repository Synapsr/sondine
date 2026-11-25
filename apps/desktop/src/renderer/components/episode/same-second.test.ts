import { describe, expect, it } from "vitest";
import { sameSecond } from "./same-second";

// The jump to the other recording of the same meeting (ADR 032): this
// one's second, kept within the time both heard, on the other's clock.

const moment = {
  episodeId: 2,
  by: "mac" as const,
  offsetMs: -2_300,
  driftPpm: 20,
  anchorMs: 1_000_000,
  sharedFromMs: 900_000,
  sharedToMs: 1_200_000,
  feedsJournal: true,
};

describe("sameSecond", () => {
  it("adds the offset, and the drift away from where it was measured", () => {
    expect(sameSecond(moment, 1_000_000)).toBe(997_700);
    // 100 s after the anchor, 20 ppm is 2 ms more.
    expect(sameSecond(moment, 1_100_000)).toBe(1_097_702);
  });

  it("keeps within the time both heard", () => {
    expect(sameSecond(moment, 0)).toBe(sameSecond(moment, 900_000));
    expect(sameSecond(moment, 5_000_000)).toBe(sameSecond(moment, 1_200_000));
  });
});
