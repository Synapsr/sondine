import type { ChatReads } from "@sondine/db";
import { describe, expect, it } from "vitest";
import { toolAllowed, withinLimit, type EpisodeFacts, type LimitLookups } from "./chat-limit";

// Episode 1 and 2 on the 19th with Camille (person 2), episode 3 on the 18th
// with Jules (person 3); the user is person 1; context item 10 is on episode 1.
const facts: Record<number, EpisodeFacts> = {
  1: { day: "2026-11-19", people: [1, 2] },
  2: { day: "2026-11-19", people: [1] },
  3: { day: "2026-11-18", people: [1, 3] },
};
const lookups: LimitLookups = {
  episode: (id) => Promise.resolve(facts[id] ?? null),
  itemEpisode: (id) => (id === 10 ? 1 : null),
  selfId: () => 1,
};
const reads = (episodes: number[], people: number[] = [], items: number[] = []): ChatReads => ({
  episodes,
  people,
  items,
});

describe("a discussion's limit", () => {
  it("keeps a conversation's discussion to that conversation and its context", async () => {
    const limit = { kind: "episode", episodeId: 1 } as const;
    expect(await withinLimit(limit, reads([1], [1, 2], [10]), lookups)).toBe(true);
    expect(await withinLimit(limit, reads([1, 2]), lookups)).toBe(false);
  });

  it("keeps a day's discussion to that day", async () => {
    const limit = { kind: "day", day: "2026-11-19" } as const;
    expect(await withinLimit(limit, reads([1, 2]), lookups)).toBe(true);
    expect(await withinLimit(limit, reads([2, 3]), lookups)).toBe(false);
  });

  it("keeps a person's discussion to the conversations they are in", async () => {
    const limit = { kind: "person", personId: 2 } as const;
    expect(await withinLimit(limit, reads([1], [2]), lookups)).toBe(true);
    expect(await withinLimit(limit, reads([], [2]), lookups)).toBe(true);
    expect(await withinLimit(limit, reads([2]), lookups)).toBe(false);
  });

  it("withholds a list of people met elsewhere, a gone episode and an unknown item", async () => {
    const limit = { kind: "episode", episodeId: 1 } as const;
    expect(await withinLimit(limit, reads([], [3]), lookups)).toBe(false);
    expect(await withinLimit(limit, reads([9]), lookups)).toBe(false);
    expect(await withinLimit(limit, reads([1], [], [11]), lookups)).toBe(false);
  });
});

describe("the tools a limited discussion may call", () => {
  const today = "2026-11-19";
  it("refuses whatever ranges over everything, counts included", () => {
    for (const limit of [
      { kind: "episode", episodeId: 1 },
      { kind: "day", day: today },
      { kind: "person", personId: 2 },
    ] as const) {
      for (const tool of ["search_transcripts", "list_people", "list_commitments", "get_status"]) {
        expect(toolAllowed(limit, tool, {}, today), `${limit.kind} ${tool}`).toBe(false);
      }
      expect(toolAllowed(limit, "get_episode", { episodeId: 9 }, today)).toBe(true);
      expect(toolAllowed(limit, "a_future_tool", {}, today)).toBe(false);
    }
  });

  it("lets a day's discussion read that day only, and a person's that person", () => {
    const day = { kind: "day", day: today } as const;
    expect(toolAllowed(day, "get_day_overview", {}, today)).toBe(true);
    expect(toolAllowed(day, "get_journal", { day: "2026-11-18" }, today)).toBe(false);
    expect(toolAllowed(day, "get_person", { personId: 2 }, today)).toBe(false);
    const person = { kind: "person", personId: 2 } as const;
    expect(toolAllowed(person, "get_person", { personId: 2 }, today)).toBe(true);
    expect(toolAllowed(person, "get_person", { personId: 3 }, today)).toBe(false);
    expect(toolAllowed(person, "get_day_overview", {}, today)).toBe(false);
  });
});
