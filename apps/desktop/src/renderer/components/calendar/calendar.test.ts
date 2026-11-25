import type { EpisodeSummary } from "@sondine/api";
import { describe, expect, it } from "vitest";
import {
  gestureAxis,
  monthStart,
  placeDay,
  rubberBand,
  settled,
  springStep,
  weekStart,
  zoomedIn,
  zoomedOut,
  zoomTransition,
} from "./calendar-view";

const H = 3_600_000;
const DAY = "2026-11-19";
const base = new Date(2026, 10, 19).getTime();

const episode = (id: number, startH: number, minutes: number | null): EpisodeSummary => ({
  id,
  state: minutes === null ? "open" : "closed",
  context: "call",
  size: "conversation",
  sizeProvisional: false,
  analysisState: "complete",
  startedAtMs: base + startH * H,
  endedAtMs: minutes === null ? null : base + startH * H + minutes * 60_000,
  voicedMs: 60_000,
  firstWords: null,
  speakerCount: 2,
  apps: [],
  people: [],
  recognized: [],
  live: false,
  page: null,
  phone: null,
  alsoRecordedBy: null,
  keptAtMs: null,
  note: false,
  tags: [],
});

describe("the calendar", () => {
  it("starts a week on Monday and a month on its first day", () => {
    expect(weekStart("2026-11-19")).toBe("2026-11-16");
    expect(weekStart("2026-11-16")).toBe("2026-11-16");
    expect(weekStart("2026-11-22")).toBe("2026-11-16");
    expect(monthStart("2026-11-19")).toBe("2026-11-01");
  });

  it("places a day's conversations at their hour, overlapping ones side by side", () => {
    const placed = placeDay(
      [episode(2, 10.5, 60), episode(1, 10, 45), episode(3, 14, 1)],
      DAY,
      8,
      base + 20 * H,
    );
    expect(placed.map((item) => [item.episode.id, item.top, item.lane, item.lanes])).toEqual([
      [1, 96, 0, 2],
      [2, 120, 1, 2],
      [3, 288, 0, 2],
    ]);
    // A one-minute call keeps a readable height; an open one runs to now.
    expect(placed[2]?.height).toBe(22);
    const open = placeDay([episode(4, 19, null)], DAY, 8, base + 20 * H);
    expect(open[0]?.height).toBe(48);
  });

  it("zooms one step at a time between a day, a week and a month", () => {
    expect(zoomedOut("day")).toBe("week");
    expect(zoomedOut("week")).toBe("month");
    expect(zoomedOut("month")).toBeNull();
    expect(zoomedIn("month")).toBe("week");
    expect(zoomedIn("day")).toBeNull();
    expect(zoomTransition("month", "week")).toEqual({ types: ["zoom-in"] });
    expect(zoomTransition("day", "month")).toEqual({ types: ["zoom-out"] });
    expect(zoomTransition("week", "week")).toBe(false);
  });

  it("follows a swipe with a rubber band that never passes its limit", () => {
    expect(rubberBand(0, 56)).toBe(0);
    expect(rubberBand(10, 56)).toBeGreaterThan(8);
    expect(rubberBand(60, 56)).toBeLessThan(56);
    expect(rubberBand(10_000, 56)).toBeLessThan(56);
    expect(rubberBand(100, 22)).toBeLessThan(rubberBand(100, 56));
  });

  it("springs back to rest, a little past the target first", () => {
    let [value, velocity] = [40, 0];
    let lowest = value;
    let frames = 0;
    while (!settled(value, velocity, 0) && frames < 600) {
      [value, velocity] = springStep(value, velocity, 0, 1 / 60);
      lowest = Math.min(lowest, value);
      frames += 1;
    }
    expect(frames).toBeLessThan(90);
    expect(lowest).toBeLessThan(0);
    expect(lowest).toBeGreaterThan(-10);
  });

  it("tells a swipe from a scroll by the gesture's first movement", () => {
    expect(gestureAxis(4, 2)).toBeNull();
    expect(gestureAxis(-30, 4)).toBe("x");
    expect(gestureAxis(20, 10)).toBe("y");
    expect(gestureAxis(3, -40)).toBe("y");
    expect(gestureAxis(12, 6)).toBe("y");
  });
});
