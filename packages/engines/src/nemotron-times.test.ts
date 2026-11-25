import { describe, expect, it } from "vitest";
import type { AsrSegment } from "./contract.ts";
import { repairWordTimes } from "./nemotron-times.ts";

/** A segment whose words start at `starts` and last 0.3 s. */
const segment = (speaker: number, starts: readonly number[]): AsrSegment => ({
  startSec: Math.min(...starts),
  endSec: Math.max(...starts) + 0.3,
  text: starts.map(() => "mot").join(" "),
  speaker,
  tokens: starts.map((start) => ({ startSec: start, endSec: start + 0.3, text: " mot" })),
});

const round = (value: number) => Math.round(value * 100) / 100;
const starts = (item: AsrSegment | undefined) => item?.tokens.map((token) => round(token.startSec));

/** Voices talking in turn from `from`: `count` segments of three words, one a second. */
const talk = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) =>
    segment(index % 4, [from + index * 4, from + index * 4 + 1, from + index * 4 + 2]),
  );

describe("nemotron word times", () => {
  it("keeps times that stay within 2 s of the text order, as when voices talk over each other", () => {
    const segments = [
      segment(0, [0, 1, 2, 3, 4, 5, 6]),
      // « oui » at 5 s, written after the sentence it interrupts.
      segment(1, [5]),
      segment(0, [7, 8]),
    ];
    expect(repairWordTimes(segments, 10)).toEqual(segments);
  });

  it("puts back the words a sentence trails over a minute, and its end with them", () => {
    const segments = [segment(0, [0, 1]), segment(1, [2, 30, 60]), ...talk(3, 4)];
    const repaired = repairWordTimes(segments, 120);
    expect(starts(repaired[1])).toEqual([2, 2.3, 2.65]);
    expect([repaired[1]?.startSec, round(repaired[1]?.endSec ?? 0)]).toEqual([2, 3]);
    expect(repaired.slice(2)).toEqual(segments.slice(2));
  });

  it("puts the first words of a sentence placed on the voice's earlier speech before its other words", () => {
    const segments = [...talk(40, 3), segment(3, [2, 3, 53, 54]), ...talk(55, 2)];
    const repaired = repairWordTimes(segments, 120);
    expect(starts(repaired[3])).toEqual([52.2, 52.6, 53, 54]);
    expect(repaired[3]?.startSec).toBeCloseTo(52.2);
  });

  it("places a sentence that lost every word's time after what comes before it", () => {
    const segments = [...talk(40, 3), segment(1, [100, 101]), ...talk(52, 3)];
    expect(starts(repairWordTimes(segments, 120)[3])).toEqual([50.3, 50.7]);
  });

  it("gives a word put back 0.1 s where its neighbours leave no room", () => {
    const segments = [segment(0, [0, 1, 2, 3]), segment(1, [3.1, 90]), ...talk(3.2, 3)];
    const repaired = repairWordTimes(segments, 120);
    expect(
      repaired[1]?.tokens.map((token) => [round(token.startSec), round(token.endSec)]),
    ).toEqual([
      [3.1, 3.4],
      [3.4, 3.5],
    ]);
  });

  it("leaves segments without words as they are", () => {
    const silent: AsrSegment = { startSec: 1, endSec: 2, text: "", speaker: 0, tokens: [] };
    const repaired = repairWordTimes(
      [silent, segment(0, [3, 4, 5]), segment(1, [200]), segment(0, [6, 7])],
      400,
    );
    expect(repaired[0]).toBe(silent);
    expect(starts(repaired[2])).toEqual([5.3]);
    expect(repairWordTimes([silent], 10)).toEqual([silent]);
  });
});
