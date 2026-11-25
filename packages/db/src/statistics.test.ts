import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nameSpeaker } from "./people";
import { publishAnalysis } from "./publish";
import { loadStatistics } from "./statistics";
import {
  seedEpisode,
  segment,
  startRun,
  t0,
  tempDatabase,
  turn,
  type TempDatabase,
} from "./test-helpers";

let temp: TempDatabase;
beforeEach(() => {
  temp = tempDatabase();
});
afterEach(() => temp.cleanup());

const DAY = 86_400_000;

/** A transcribed episode at `startS` seconds after t0, with « Moi » (A) and Camille (B). */
function seed(startS: number, size: string, context: string, voicedMs: number) {
  const { episodeId, trackRunId } = seedEpisode(temp.db, [[startS, startS + 30]]);
  temp.db.client
    .prepare("UPDATE episodes SET size = ?, context = ?, voiced_ms = ? WHERE id = ?")
    .run(size, context, voicedMs, episodeId);
  const runId = startRun(temp.db, episodeId, "asr");
  const lines = [
    segment(trackRunId, startS, startS + 10, "on parle du budget", "A"),
    segment(trackRunId, startS + 10, startS + 30, "je t'envoie le devis demain", "B"),
  ];
  expect(
    publishAnalysis(temp.db, {
      episodeId,
      stage: "asr",
      runId,
      inputGeneration: 1,
      segments: lines,
      turns: [
        turn(trackRunId, startS, startS + 10, "A"),
        turn(trackRunId, startS + 10, startS + 30, "B"),
      ],
    }).published,
  ).toBe(true);
  return { episodeId, runId };
}

describe("statistics", () => {
  it("counts each day's speech and conversations, contexts, people, words and agent reads", () => {
    const first = seed(10, "conversation", "call", 60_000);
    seed(100, "moment", "in_person", 5_000);
    seed(200, "conversation", "media", 30_000);
    for (const [label, person] of [
      ["A", { kind: "self", name: "Alex" }],
      ["B", { kind: "new", name: "Camille" }],
    ] as const) {
      expect(
        nameSpeaker(temp.db, {
          episodeId: first.episodeId,
          runId: first.runId,
          label,
          person,
          nowMs: t0,
        }).ok,
      ).toBe(true);
    }
    const stats = loadStatistics(temp.db, {
      days: [
        { day: "2026-11-01", startMs: t0 - DAY, endMs: t0 - 60_000 },
        { day: "2026-11-02", startMs: t0 - 60_000, endMs: t0 + DAY },
      ],
      sinceMs: t0 - DAY,
      untilMs: t0 + DAY,
    });
    expect(stats.days).toEqual([
      { day: "2026-11-01", voicedMs: 0, conversations: 0 },
      { day: "2026-11-02", voicedMs: 95_000, conversations: 2 },
    ]);
    expect(stats.contexts).toEqual([
      { context: "call", voicedMs: 60_000 },
      { context: "media", voicedMs: 30_000 },
      { context: "in_person", voicedMs: 5_000 },
    ]);
    // Camille's 20 s in the call; the user and media are left out.
    expect(stats.people).toEqual([
      { personId: expect.any(Number), name: "Camille", talkMs: 20_000 },
    ]);
    // Four words and five words, three times.
    expect(stats.words).toBe(27);
    expect(stats.agentReads).toBe(0);
  });

  it("is empty on an empty database", () => {
    const stats = loadStatistics(temp.db, { days: [], sinceMs: 0, untilMs: t0 });
    expect(stats).toEqual({ days: [], contexts: [], people: [], words: 0, agentReads: 0 });
  });
});
