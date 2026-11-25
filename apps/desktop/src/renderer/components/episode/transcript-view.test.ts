import { describe, expect, it } from "vitest";
import type { Voice } from "../../lib/voices";
import {
  groupTurns,
  inSpan,
  matchingSegments,
  mayFollow,
  passageSpan,
  stepMatch,
} from "./transcript-view";

const voices = new Map<string, Voice>([
  ["mic/0/1", { kind: "self" }],
  ["sys/0/1", { kind: "other", number: 1 }],
  ["sys/0/2", { kind: "other", number: 2 }],
]);

const segment = (
  id: number,
  speakerLabel: string | null,
  highlights: number[] = [],
  startMs = id * 1_000,
) => ({
  id,
  startMs,
  endMs: startMs + 900,
  speakerLabel,
  highlights,
});

describe("transcript", () => {
  it("groups consecutive segments of one voice into a turn", () => {
    const segments = [
      segment(1, "mic/0/1"),
      segment(2, "mic/0/1"),
      segment(3, "sys/0/1"),
      segment(4, "sys/0/2"),
      segment(5, "sys/0/2"),
      segment(6, "mic/0/1"),
      segment(7, null),
      segment(8, "unknown/0/9"),
    ];
    expect(groupTurns(segments, voices)).toEqual([
      { key: 1, voice: { kind: "self" }, startMs: 1_000, segments: [0, 1], app: null },
      { key: 3, voice: { kind: "other", number: 1 }, startMs: 3_000, segments: [2], app: null },
      { key: 4, voice: { kind: "other", number: 2 }, startMs: 4_000, segments: [3, 4], app: null },
      { key: 6, voice: { kind: "self" }, startMs: 6_000, segments: [5], app: null },
      // A segment without a known speaker joins the unknown voice's turn.
      { key: 7, voice: { kind: "unknown" }, startMs: 7_000, segments: [6, 7], app: null },
    ]);
    expect(groupTurns([], voices)).toEqual([]);
  });

  it("keeps a recognized voice's turns apart from another voice of the same person", () => {
    const marie = { kind: "person", personId: 4, name: "Marie", number: 1 } as const;
    const named = new Map<string, Voice>([
      ["mic/0/1", marie],
      ["mic/0/2", { ...marie, number: 2, recognized: true }],
      ["mic/0/3", { ...marie, number: 3 }],
    ]);
    const segments = [
      segment(1, "mic/0/1"),
      segment(2, "mic/0/2"),
      segment(3, "mic/0/2"),
      segment(4, "mic/0/3"),
      segment(5, "mic/0/1"),
    ];
    expect(groupTurns(segments, named).map((turn) => turn.segments)).toEqual([
      [0],
      [1, 2],
      // Two voices the user named as one person still read as one turn.
      [3, 4],
    ]);
  });

  it("shows the app something was said in only where it changes", () => {
    const xcode = { bundleId: "com.apple.dt.Xcode", name: "Xcode" };
    const sondine = { bundleId: "app.sondine", name: "Sondine" };
    const inApp = (id: number, label: string, app: typeof xcode | null) => ({
      ...segment(id, label),
      app,
    });
    const segments = [
      inApp(1, "mic/0/1", xcode),
      inApp(2, "mic/0/1", xcode),
      inApp(3, "sys/0/1", xcode),
      // No app known here: the turn goes on, and Xcode is not shown again after it.
      inApp(4, "sys/0/1", null),
      inApp(5, "mic/0/1", xcode),
      // Sondine comes to the front in the middle of a turn: a new turn shows it.
      inApp(6, "mic/0/1", sondine),
      inApp(7, "mic/0/1", sondine),
    ];
    expect(
      groupTurns(segments, voices, { byApp: true }).map((turn) => [turn.segments, turn.app]),
    ).toEqual([
      [[0, 1], xcode],
      [[2, 3], null],
      [[4], null],
      [[5, 6], sondine],
    ]);
    // Without it (exports), turns are the voices' alone.
    expect(groupTurns(segments, voices).map((turn) => turn.segments)).toEqual([
      [0, 1],
      [2, 3],
      [4, 5, 6],
    ]);
  });

  it("starts a new turn after a long silence, even for the same voice", () => {
    const segments = [
      segment(1, "mic/0/1", [], 0),
      segment(2, "mic/0/1", [], 20_000),
      segment(3, "mic/0/1", [], 60_000),
    ];
    expect(groupTurns(segments, voices).map((turn) => turn.segments)).toEqual([[0, 1], [2]]);
  });

  it("steps through the matching segments, wrapping around", () => {
    const segments = [
      segment(1, null),
      segment(2, null, [0]),
      segment(3, null),
      segment(4, null, [1]),
    ];
    expect(matchingSegments(segments)).toEqual([1, 3]);
    expect(stepMatch(-1, 2, 1)).toBe(0);
    expect(stepMatch(-1, 2, -1)).toBe(1);
    expect(stepMatch(0, 2, 1)).toBe(1);
    expect(stepMatch(1, 2, 1)).toBe(0);
    expect(stepMatch(0, 2, -1)).toBe(1);
    expect(stepMatch(-1, 0, 1)).toBe(-1);
  });

  it("follows playback only once the user has not scrolled for a while", () => {
    expect(mayFollow(10_000, null)).toBe(true);
    expect(mayFollow(10_000, 8_000)).toBe(false);
    expect(mayFollow(12_000, 8_000)).toBe(true);
  });
  it("erases a passage from its first start to its latest end", () => {
    // The second sentence overlaps the third and ends after it.
    const segments = [
      segment(1, null, [], 0),
      { ...segment(2, null, [], 1_000), endMs: 5_000 },
      segment(3, null, [], 2_000),
      segment(4, null, [], 6_000),
    ];
    expect(passageSpan(segments, { from: 1, to: 2 })).toEqual({ startMs: 1_000, endMs: 5_000 });
    expect(passageSpan(segments, { from: 3, to: 3 })).toEqual({ startMs: 6_000, endMs: 6_900 });
    // An instant still erases a millisecond.
    expect(passageSpan([{ ...segment(5, null), endMs: 5_000 }], { from: 0, to: 0 })).toEqual({
      startMs: 5_000,
      endMs: 5_001,
    });
    expect(passageSpan(segments, { from: 4, to: 4 })).toBeNull();
    expect(passageSpan(segments, { from: 2, to: 1 })).toBeNull();
  });

  it("takes every sentence said during the span, other voices included", () => {
    const span = { startMs: 1_000, endMs: 5_000 };
    // Before, overlapping its start, inside, overlapping its end, after.
    expect(inSpan({ ...segment(1, null, [], 0), endMs: 1_000 }, span)).toBe(false);
    expect(inSpan({ ...segment(2, null, [], 0), endMs: 1_001 }, span)).toBe(true);
    expect(inSpan(segment(3, null, [], 2_000), span)).toBe(true);
    expect(inSpan(segment(4, null, [], 4_999), span)).toBe(true);
    expect(inSpan(segment(5, null, [], 5_000), span)).toBe(false);
    // An instant inside the span counts.
    expect(inSpan({ ...segment(6, null, [], 3_000), endMs: 3_000 }, span)).toBe(true);
  });
});
