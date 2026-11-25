import { SearchJsonV2, type SearchEpisode } from "@sondine/api";
import { describe, expect, it } from "vitest";
import { searchDocument } from "./search-export";

// Messages resolve to English in tests.

const START = Date.UTC(2026, 10, 6, 13, 5, 0);

const result: SearchEpisode = {
  episode: {
    id: 7,
    state: "closed",
    context: "call",
    size: "conversation",
    sizeProvisional: false,
    analysisState: "complete",
    startedAtMs: START,
    endedAtMs: START + 600_000,
    voicedMs: 300_000,
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
  },
  selfOrdinal: 1,
  hitCount: 3,
  hits: [
    {
      segmentId: 1,
      startMs: START + 60_000,
      endMs: START + 64_000,
      text: "le *budget*  2027",
      speakerLabel: "mic/0/1",
      speakerOrdinal: 1,
      self: true,
      person: null,
      recognized: null,
      highlights: [{ start: 4, end: 10 }],
      app: null,
    },
    {
      segmentId: 2,
      startMs: START + 90_000,
      endMs: START + 92_000,
      text: "le budget",
      speakerLabel: "sys/0/1",
      speakerOrdinal: 2,
      self: false,
      person: { id: 4, name: "Marie", self: false },
      recognized: null,
      highlights: [],
      app: { bundleId: "com.apple.Safari", name: "Safari" },
    },
  ],
  contextHits: [{ itemId: 5, kind: "note", text: "budget  validé", highlights: [] }],
};

describe("search export", () => {
  it("lists each episode's best matches with their voice, in Markdown or JSON", () => {
    const md = searchDocument({ text: "budget" }, [result], 12, "md") ?? "";
    expect(md).toContain("# Search “budget”");
    expect(md).toContain("**Me** · ");
    expect(md).toContain("le \\*budget\\* 2027");
    expect(md).toContain("**Marie** · ");
    expect(md).toContain("**Context**\nbudget validé");

    const json = SearchJsonV2.parse(
      JSON.parse(
        searchDocument({ text: "budget", from: "2026-11-01" }, [result], 12, "json") ?? "",
      ),
    );
    expect(json).toMatchObject({ query: "budget", from: "2026-11-01", to: null, total: 12 });
    expect(json.episodes[0]?.hits.map((hit) => hit.speaker)).toEqual(["Me", "Marie"]);
    expect(json.episodes[0]?.contextHits).toEqual([{ kind: "note", text: "budget validé" }]);
    expect(searchDocument({ text: "budget" }, [], 0, "md")).toBeNull();
  });
});
