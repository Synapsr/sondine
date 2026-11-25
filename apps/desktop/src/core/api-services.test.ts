import type { EpisodeDetail } from "@sondine/api";
import { describe, expect, it } from "vitest";
import {
  dayRange,
  decodeCursor,
  encodeCursor,
  excerpt,
  firstWords,
  localHours,
} from "./api-services";

describe("episode list helpers", () => {
  it("cuts the first words at a word boundary", () => {
    expect(firstWords(null)).toBeNull();
    expect(firstWords("  Bonjour   à tous  ")).toBe("Bonjour à tous");
    const long = "mot ".repeat(60).trim();
    const cut = firstWords(long);
    expect(cut?.length).toBeLessThanOrEqual(120);
    expect(cut?.endsWith("mot…")).toBe(true);
  });

  it("gives a local calendar day, today by default", () => {
    const now = new Date(2026, 10, 5, 15, 30);
    expect(dayRange(undefined, now)).toEqual({
      day: "2026-11-05",
      fromMs: new Date(2026, 10, 5).getTime(),
      toMs: new Date(2026, 10, 6).getTime(),
    });
    expect(dayRange("2026-03-29", now)).toEqual({
      day: "2026-03-29",
      fromMs: new Date(2026, 2, 29).getTime(),
      toMs: new Date(2026, 2, 30).getTime(),
    });
  });

  it("gives the local hours of a day, each start as the clock shows it", () => {
    const hours = localHours("2026-11-05");
    expect(hours.map((hour) => hour.hour)).toEqual(Array.from({ length: 24 }, (_, hour) => hour));
    expect(hours[14]).toEqual({
      hour: 14,
      startMs: new Date(2026, 10, 5, 14).getTime(),
      endMs: new Date(2026, 10, 5, 15).getTime(),
    });
    expect(hours[0]?.startMs).toBe(dayRange("2026-11-05").fromMs);
    expect(hours.at(-1)?.endMs).toBe(dayRange("2026-11-05").toMs);
    // Hours tile the day whatever the zone, daylight saving days included.
    for (const day of ["2026-03-29", "2026-10-25", "2026-03-08", "2026-11-01"]) {
      const list = localHours(day);
      const { fromMs, toMs } = dayRange(day);
      expect(list[0]?.startMs, day).toBe(fromMs);
      expect(list.at(-1)?.endMs, day).toBe(toMs);
      for (const [index, hour] of list.entries()) {
        expect(new Date(hour.startMs).getHours(), day).toBe(hour.hour);
        if (index > 0) expect(hour.startMs, day).toBe(list[index - 1]?.endMs);
      }
    }
  });

  it("round-trips an episode cursor", () => {
    expect(encodeCursor(null)).toBeNull();
    const cursor = { startedAtMs: 1_793_610_000_000, id: 42 };
    expect(encodeCursor(cursor)).toBe("1793610000000:42");
    expect(decodeCursor(encodeCursor(cursor) ?? undefined)).toEqual(cursor);
    expect(decodeCursor(undefined)).toBeUndefined();
  });
});

describe("episode excerpts", () => {
  it("keeps the segments that overlap the window, cut ones included", () => {
    const segment = (id: number, startMs: number, endMs: number) => ({
      id,
      trackRunId: 1,
      startMs,
      endMs,
      speakerLabel: null,
      self: false,
      text: "",
      lang: null,
      highlights: [],
    });
    const detail = {
      segments: [segment(1, 0, 10), segment(2, 10, 20), segment(3, 20, 30), segment(4, 30, 40)],
    } as unknown as EpisodeDetail;
    expect(excerpt(detail, 15, 30).segments.map((s) => s.id)).toEqual([2, 3]);
  });
});
