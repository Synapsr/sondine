import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bumpInputGeneration,
  currentRunId,
  publishAnalysis,
  PublishInputError,
  type PublishAnalysisInput,
} from "./publish";
import {
  analysisRuns,
  deletedRanges,
  episodeSpeakers,
  episodes,
  segments,
  speakerTurns,
} from "./schema";
import { checkSearchIndex, searchSegments } from "./search";
import {
  at,
  count,
  seedEpisode,
  segment,
  startRun,
  t0,
  tempDatabase,
  turn,
  type TempDatabase,
} from "./test-helpers";
import { unpackWords } from "./words";

let temp: TempDatabase;
let episodeId: number;
let trackRunId: number;

beforeEach(() => {
  temp = tempDatabase();
  ({ episodeId, trackRunId } = seedEpisode(temp.db, [[0, 60]]));
});
afterEach(() => temp.cleanup());

function asrInput(
  runId: number,
  texts: readonly string[],
  inputGeneration = 1,
): PublishAnalysisInput {
  return {
    episodeId,
    stage: "asr",
    runId,
    inputGeneration,
    segments: texts.map((text, index) =>
      segment(trackRunId, index * 5, index * 5 + 4, text, index % 2 === 0 ? "S1" : "S2"),
    ),
    turns: texts.map((_, index) =>
      turn(trackRunId, index * 5, index * 5 + 4, index % 2 === 0 ? "S1" : "S2"),
    ),
  };
}

const runStatus = (runId: number) =>
  temp.db.orm
    .select({ status: analysisRuns.status })
    .from(analysisRuns)
    .where(eq(analysisRuns.id, runId))
    .get()?.status;

describe("publishAnalysis", () => {
  it("publishes segments, turns, speakers, and search rows in one step", () => {
    const runId = startRun(temp.db, episodeId, "asr");
    const input = asrInput(runId, ["Bonjour Claire", "Salut, ça va ?", "Très bien merci"]);
    const words = [
      { charStart: 0, charEnd: 7, startMs: 0, endMs: 450, confidence: 0.9 },
      { charStart: 8, charEnd: 14, startMs: 500, endMs: 900 },
    ];
    const result = publishAnalysis(temp.db, {
      ...input,
      segments: input.segments.map((s, index) =>
        index === 0 ? { ...s, words, lang: "fr", confidence: 0.92 } : s,
      ),
      analysisState: "complete",
      nowMs: t0 + 1000,
    });
    expect(result).toEqual({
      published: true,
      supersededRunIds: [],
      segmentCount: 3,
      turnCount: 3,
      speakerCount: 2,
    });
    expect(currentRunId(temp.db, episodeId, "asr")).toBe(runId);
    expect(runStatus(runId)).toBe("published");
    expect(temp.db.orm.select().from(episodes).get()?.analysisState).toBe("complete");

    const speakers = temp.db.orm.select().from(episodeSpeakers).all();
    expect(speakers.map((s) => [s.label, s.ordinal, s.voicedMs])).toEqual([
      ["S1", 1, 8000],
      ["S2", 2, 4000],
    ]);
    const stored = temp.db.orm.select().from(segments).all();
    expect(stored.every((s) => s.episodeSpeakerId !== null)).toBe(true);
    const first = stored[0]?.words;
    expect(first === null || first === undefined ? [] : unpackWords(first)).toHaveLength(2);
    expect(searchSegments(temp.db, "claire").map((hit) => hit.runId)).toEqual([runId]);
  });

  it("replaces the superseded run's outputs and search rows", () => {
    const first = startRun(temp.db, episodeId, "asr");
    publishAnalysis(temp.db, asrInput(first, ["premier passage ancien"]));
    const second = startRun(temp.db, episodeId, "asr");
    const result = publishAnalysis(
      temp.db,
      asrInput(second, ["second passage nouveau", "deuxième phrase"]),
    );
    expect(result).toMatchObject({ published: true, supersededRunIds: [first], segmentCount: 2 });
    expect(runStatus(first)).toBe("superseded");
    expect(searchSegments(temp.db, "ancien")).toEqual([]);
    expect(searchSegments(temp.db, "passage").map((hit) => hit.runId)).toEqual([second]);
    expect(count(temp.db, "segments", `run_id = ${first}`)).toBe(0);
    expect(count(temp.db, "speaker_turns", `run_id = ${first}`)).toBe(0);
    expect(count(temp.db, "episode_speakers", `run_id = ${first}`)).toBe(0);
    expect(count(temp.db, "segments_fts")).toBe(2);
    expect(() => checkSearchIndex(temp.db)).not.toThrow();
  });

  it("rejects a stale input generation and discards the run", () => {
    const runId = startRun(temp.db, episodeId, "asr", 1);
    expect(bumpInputGeneration(temp.db, episodeId)).toBe(2);
    expect(publishAnalysis(temp.db, asrInput(runId, ["trop tard"], 1))).toEqual({
      published: false,
      reason: "stale_generation",
    });
    expect(runStatus(runId)).toBe("discarded");
    expect(count(temp.db, "segments")).toBe(0);
    expect(searchSegments(temp.db, "tard")).toEqual([]);

    const fresh = startRun(temp.db, episodeId, "asr", 2);
    expect(publishAnalysis(temp.db, asrInput(fresh, ["à l'heure"], 1))).toEqual({
      published: false,
      reason: "stale_generation",
    });
    const current = startRun(temp.db, episodeId, "asr", 2);
    expect(publishAnalysis(temp.db, asrInput(current, ["à l'heure"], 2)).published).toBe(true);
  });

  it("rejects output that intersects a deleted range", () => {
    const runId = startRun(temp.db, episodeId, "asr");
    temp.db.orm
      .insert(deletedRanges)
      .values({
        scope: "track_run",
        trackRunId,
        sampleStart: at(12),
        sampleEnd: at(13),
        wallStartMs: t0 + 12_000,
        wallEndMs: t0 + 13_000,
        origin: "app",
        createdAtMs: t0,
      })
      .run();
    const result = publishAnalysis(
      temp.db,
      asrInput(runId, ["un", "deux", "trois effacé", "quatre"]),
    );
    expect(result).toEqual({ published: false, reason: "deleted_range" });
    expect(runStatus(runId)).toBe("discarded");
    expect(count(temp.db, "segments")).toBe(0);
    expect(currentRunId(temp.db, episodeId, "asr")).toBeUndefined();
  });

  it("also refuses a turn-only run that touches a wall-clock deletion", () => {
    temp.db.orm
      .insert(deletedRanges)
      .values({
        scope: "all",
        wallStartMs: t0 + 3000,
        wallEndMs: t0 + 3500,
        origin: "tray",
        createdAtMs: t0,
      })
      .run();
    const runId = startRun(temp.db, episodeId, "diarize");
    const result = publishAnalysis(temp.db, {
      episodeId,
      stage: "diarize",
      runId,
      inputGeneration: 1,
      segments: [],
      turns: [turn(trackRunId, 0, 4, "A")],
    });
    expect(result).toEqual({ published: false, reason: "deleted_range" });
  });

  it("treats a repeated publish as a no-op", () => {
    const runId = startRun(temp.db, episodeId, "asr");
    publishAnalysis(temp.db, asrInput(runId, ["une fois"]));
    expect(publishAnalysis(temp.db, asrInput(runId, ["une fois"]))).toEqual({
      published: false,
      reason: "already_published",
    });
    expect(count(temp.db, "segments")).toBe(1);
  });

  it("checks that the run belongs to the episode and stage", () => {
    const other = seedEpisode(temp.db, [[100, 110]], trackRunId);
    const foreign = startRun(temp.db, other.episodeId, "asr");
    expect(publishAnalysis(temp.db, asrInput(foreign, ["x"]))).toEqual({
      published: false,
      reason: "run_mismatch",
    });
    const diarize = startRun(temp.db, episodeId, "diarize");
    expect(publishAnalysis(temp.db, asrInput(diarize, ["x"]))).toEqual({
      published: false,
      reason: "run_mismatch",
    });
    expect(publishAnalysis(temp.db, asrInput(424242, ["x"]))).toEqual({
      published: false,
      reason: "run_missing",
    });
    expect(publishAnalysis(temp.db, { ...asrInput(foreign, ["x"]), episodeId: 999 })).toEqual({
      published: false,
      reason: "episode_missing",
    });
    const failed = startRun(temp.db, episodeId, "asr");
    temp.db.orm
      .update(analysisRuns)
      .set({ status: "failed" })
      .where(eq(analysisRuns.id, failed))
      .run();
    expect(publishAnalysis(temp.db, asrInput(failed, ["x"]))).toEqual({
      published: false,
      reason: "run_not_publishable",
    });
    expect(() =>
      publishAnalysis(temp.db, { ...asrInput(diarize, ["x"]), stage: "diarize" }),
    ).toThrow(PublishInputError);
  });

  it("lets the final transcript replace near-live text, never the reverse", () => {
    const live = startRun(temp.db, episodeId, "asr_live");
    publishAnalysis(temp.db, { ...asrInput(live, ["texte provisoire"]), stage: "asr_live" });
    expect(searchSegments(temp.db, "provisoire")).toHaveLength(1);

    const final = startRun(temp.db, episodeId, "asr");
    expect(publishAnalysis(temp.db, asrInput(final, ["texte définitif"]))).toMatchObject({
      published: true,
      supersededRunIds: [live],
    });
    expect(searchSegments(temp.db, "provisoire")).toEqual([]);
    expect(currentRunId(temp.db, episodeId, "asr_live")).toBeUndefined();

    const lateLive = startRun(temp.db, episodeId, "asr_live");
    expect(
      publishAnalysis(temp.db, { ...asrInput(lateLive, ["retard"]), stage: "asr_live" }),
    ).toEqual({
      published: false,
      reason: "final_exists",
    });
    expect(searchSegments(temp.db, "texte").map((hit) => hit.runId)).toEqual([final]);
  });

  it("keeps the diarization pointer separate from the transcript", () => {
    const asr = startRun(temp.db, episodeId, "asr");
    publishAnalysis(temp.db, asrInput(asr, ["bonjour", "salut"]));
    const diarize = startRun(temp.db, episodeId, "diarize");
    publishAnalysis(temp.db, {
      episodeId,
      stage: "diarize",
      runId: diarize,
      inputGeneration: 1,
      segments: [],
      turns: [turn(trackRunId, 0, 9, "A")],
    });
    expect(currentRunId(temp.db, episodeId, "asr")).toBe(asr);
    expect(currentRunId(temp.db, episodeId, "diarize")).toBe(diarize);
    expect(count(temp.db, "segments")).toBe(2);
    expect(
      temp.db.orm
        .select()
        .from(speakerTurns)
        .all()
        .map((t) => t.runId)
        .toSorted(),
    ).toEqual([asr, asr, diarize]);
  });

  it("rolls back everything when an insert fails mid-publish", () => {
    const runId = startRun(temp.db, episodeId, "asr");
    const bad = asrInput(runId, ["ok", "pas ok"]);
    expect(() =>
      publishAnalysis(temp.db, {
        ...bad,
        segments: bad.segments.map((s, index) => (index === 1 ? { ...s, trackRunId: 9999 } : s)),
      }),
    ).toThrow(/FOREIGN KEY/);
    expect(count(temp.db, "segments")).toBe(0);
    expect(count(temp.db, "segments_fts")).toBe(0);
    expect(runStatus(runId)).toBe("succeeded");
  });

  it("blocks deleting an episode around the index (segments restrict)", () => {
    const runId = startRun(temp.db, episodeId, "asr");
    publishAnalysis(temp.db, asrInput(runId, ["protégé"]));
    expect(() =>
      temp.db.client.prepare("DELETE FROM episodes WHERE id = ?").run(episodeId),
    ).toThrow(/FOREIGN KEY/);
  });
});
