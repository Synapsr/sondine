import type { SearchEpisode } from "@sondine/api";
import { describe, expect, it } from "vitest";
import { groupByDay, isFiltered, nextOffset, periodRange, searchInput } from "./search-view";

const at = (day: number, hour: number) => new Date(2026, 10, day, hour).getTime();

const match = (id: number, startedAtMs: number): SearchEpisode => ({
  episode: {
    id,
    state: "closed",
    context: "call",
    size: "conversation",
    sizeProvisional: false,
    analysisState: "complete",
    startedAtMs,
    endedAtMs: startedAtMs + 600_000,
    voicedMs: 300_000,
    firstWords: null,
    speakerCount: 2,
    apps: [{ bundleId: "com.apple.FaceTime", name: "FaceTime" }],
    people: [],
    recognized: [],
    live: false,
    page: null,
    phone: null,
    alsoRecordedBy: null,
    keptAtMs: null,
    note: false,
    tags: [],
  },
  selfOrdinal: null,
  hitCount: 1,
  hits: [
    {
      segmentId: id,
      startMs: startedAtMs,
      endMs: startedAtMs + 2_000,
      text: "école",
      speakerLabel: null,
      speakerOrdinal: null,
      self: false,
      person: null,
      recognized: null,
      highlights: [{ start: 0, end: 5 }],
      app: null,
    },
  ],
  contextHits: [],
});

describe("search", () => {
  it("turns a period into days, today included", () => {
    expect(periodRange(undefined, "2026-11-06")).toEqual({});
    expect(periodRange("today", "2026-11-06")).toEqual({ from: "2026-11-06", to: "2026-11-06" });
    expect(periodRange("7d", "2026-11-06")).toEqual({ from: "2026-10-31", to: "2026-11-06" });
    expect(periodRange("30d", "2026-11-06")).toEqual({ from: "2026-10-08", to: "2026-11-06" });
  });

  it("builds the query from the URL, and waits for a second letter", () => {
    expect(searchInput({ q: "e" }, "2026-11-06", 0)).toBeNull();
    expect(searchInput({}, "2026-11-06", 0)).toBeNull();
    expect(
      searchInput(
        { q: "  ecole ", period: "today", sizes: ["conversation"], contexts: ["call", "mixed"] },
        "2026-11-06",
        20,
      ),
    ).toEqual({
      text: "ecole",
      from: "2026-11-06",
      to: "2026-11-06",
      sizes: ["conversation"],
      contexts: ["call", "mixed"],
      limit: 20,
      offset: 20,
    });
    expect(isFiltered({ q: "ecole" })).toBe(false);
    expect(isFiltered({ q: "ecole", contexts: ["media"] })).toBe(true);
  });

  it("searches what was said while one app was in front", () => {
    const params = { q: "ecole", app: "com.apple.dt.Xcode" };
    expect(searchInput(params, "2026-11-06", 0)).toEqual({
      text: "ecole",
      foregroundApp: "com.apple.dt.Xcode",
      limit: 20,
      offset: 0,
    });
    expect(isFiltered(params)).toBe(true);
  });

  it("lists a tag's recordings with no text, and narrows a search by tag (ADR 039)", () => {
    expect(searchInput({ tag: "idées" }, "2026-11-06", 0)).toEqual({
      tag: "idées",
      limit: 20,
      offset: 0,
    });
    // One letter with a tag still waits for the second.
    expect(searchInput({ q: "e", tag: "idées" }, "2026-11-06", 0)).toBeNull();
    expect(searchInput({ q: "ecole", tag: "idées" }, "2026-11-06", 0)).toEqual({
      text: "ecole",
      tag: "idées",
      limit: 20,
      offset: 0,
    });
    expect(isFiltered({ tag: "idées" })).toBe(true);
  });

  it("groups results by day then episode, across pages", () => {
    const days = groupByDay([
      match(5, at(6, 14)),
      match(4, at(6, 11)),
      match(3, at(5, 18)),
      // A second page starts with the same day.
      match(2, at(5, 9)),
      match(2, at(5, 9)),
      match(1, at(2, 9)),
    ]);
    expect(days.map((day) => [day.day, day.episodes.map((entry) => entry.episode.id)])).toEqual([
      ["2026-11-06", [5, 4]],
      ["2026-11-05", [3, 2]],
      ["2026-11-02", [1]],
    ]);
  });

  it("pages until every matching episode is loaded", () => {
    expect(nextOffset(20, 45)).toBe(20);
    expect(nextOffset(45, 45)).toBeUndefined();
  });
});
