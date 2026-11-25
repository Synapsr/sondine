import { describe, expect, it } from "vitest";
import {
  heardMs,
  resumeSeconds,
  secondsAt,
  segmentAt,
  MAX_LANES,
  speechLanes,
  stepSegment,
  wallAt,
  type Timeline,
} from "./player-time";

const other = (number: number) => ({ kind: "other", number }) as const;

const T0 = 1_793_610_000_000;
const timeline: Timeline = { startedAtMs: T0, durationMs: 600_000, speech: [] };

const span = (startS: number, endS: number) => ({
  startMs: T0 + startS * 1000,
  endMs: T0 + endS * 1000,
});

describe("playback time", () => {
  it("maps wall-clock time to the timeline and back, gaps included", () => {
    // A segment after a silent gap plays from its distance to the first sample.
    expect(secondsAt(T0 + 374_000, timeline)).toBe(374);
    expect(wallAt(374, timeline)).toBe(T0 + 374_000);
    // Before the first sample and past the end stay within the timeline.
    expect(secondsAt(T0 - 5_000, timeline)).toBe(0);
    expect(secondsAt(T0 + 700_000, timeline)).toBe(600);
  });

  it("resumes at the same wall-clock time on a new plan", () => {
    // The new generation's timeline starts 2 s earlier (an earlier region joined).
    const next: Timeline = { startedAtMs: T0 - 2_000, durationMs: 602_000, speech: [] };
    expect(resumeSeconds(timeline, 100, next)).toBe(102);
  });

  it("finds the segment heard, the latest started when two tracks overlap", () => {
    const segments = [span(0, 4), span(5, 9), span(8, 12), span(20, 25)];
    expect(segmentAt(segments, T0 + 2_000)).toBe(0);
    expect(segmentAt(segments, T0 + 4_500)).toBe(-1);
    expect(segmentAt(segments, T0 + 8_500)).toBe(2);
    expect(segmentAt(segments, T0 + 10_000)).toBe(2);
    expect(segmentAt(segments, T0 + 15_000)).toBe(-1);
    expect(segmentAt(segments, T0 - 1_000)).toBe(-1);
    expect(segmentAt([], T0)).toBe(-1);
  });

  it("steps to the next segment, and back to the start of the one playing", () => {
    const segments = [span(0, 4), span(5, 9), span(20, 25)];
    expect(stepSegment(segments, T0 + 6_000, 1)).toBe(2);
    expect(stepSegment(segments, T0 + 21_000, 1)).toBe(-1);
    // Just before a segment starts, ↓ skips the one about to play.
    expect(stepSegment(segments, T0 + 4_900, 1)).toBe(2);
    // Well into a segment, ↑ restarts it; at its start, ↑ goes to the one before.
    expect(stepSegment(segments, T0 + 7_000, -1)).toBe(1);
    expect(stepSegment(segments, T0 + 5_500, -1)).toBe(0);
    expect(stepSegment(segments, T0 + 15_000, -1)).toBe(1);
    expect(stepSegment(segments, T0 + 500, -1)).toBe(-1);
  });

  it("draws one lane per voice, the user's first, with nearby spans merged", () => {
    const me = { kind: "self" } as const;
    const voice1 = { kind: "other", number: 1 } as const;
    const unknown = { kind: "unknown" } as const;
    const lanes = speechLanes(
      [
        { ...span(0, 60), voice: voice1 },
        { ...span(60.5, 120), voice: voice1 },
        { ...span(130, 190), voice: me },
        { ...span(300, 360), voice: voice1 },
        { ...span(590, 700), voice: unknown },
        { ...span(10, 10), voice: me },
      ],
      timeline,
    );
    expect(lanes).toEqual([
      { voice: me, spans: [{ start: 130 / 600, end: 190 / 600 }] },
      {
        voice: voice1,
        spans: [
          { start: 0, end: 0.2 },
          { start: 0.5, end: 0.6 },
        ],
      },
      { voice: unknown, spans: [{ start: 590 / 600, end: 1 }] },
    ]);
    expect(
      speechLanes([{ ...span(0, 1), voice: me }], { startedAtMs: T0, durationMs: 0, speech: [] }),
    ).toEqual([]);
  });

  it("draws the voices who speak most, and the others together in a last lane", () => {
    const voice = other;
    const lanes = speechLanes(
      [
        { ...span(0, 100), voice: voice(1) },
        { ...span(100, 110), voice: voice(2) },
        { ...span(110, 200), voice: voice(3) },
        { ...span(200, 220), voice: voice(4) },
        { ...span(220, 400), voice: voice(5) },
        { ...span(400, 401), voice: voice(6) },
      ],
      timeline,
    );
    expect(lanes.map((lane) => lane.voice)).toEqual([voice(1), voice(5), { kind: "unknown" }]);
    expect(lanes.length).toBe(MAX_LANES);
    expect(lanes.at(-1)).toEqual({
      voice: { kind: "unknown" },
      // Nearby spans of different voices merge too.
      spans: [
        { start: 100 / 600, end: 220 / 600 },
        { start: 400 / 600, end: 401 / 600 },
      ],
      others: true,
    });
  });

  it("puts the microphone above the Mac's sound before a transcript", () => {
    const computer = { kind: "track", track: "computer" } as const;
    const microphone = { kind: "track", track: "microphone" } as const;
    expect(
      speechLanes(
        [
          { ...span(0, 60), voice: computer },
          { ...span(120, 180), voice: microphone },
        ],
        timeline,
      ),
    ).toEqual([
      { voice: microphone, spans: [{ start: 0.2, end: 0.3 }] },
      { voice: computer, spans: [{ start: 0, end: 0.1 }] },
    ]);
  });

  it("counts overlapping speech once", () => {
    expect(heardMs([span(0, 10), span(5, 12), span(20, 21)])).toBe(13_000);
    expect(heardMs([])).toBe(0);
  });
});
