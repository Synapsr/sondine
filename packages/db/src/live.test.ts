import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyEpisodePlan, getEpisodeDetail } from "./episodes-store";
import { liveEnabled, publishLive, setLiveEnabled } from "./live";
import { bumpInputGeneration, currentRunId, publishAnalysis } from "./publish";
import { episodes } from "./schema";
import { checkSearchIndex, searchSegments } from "./search";
import {
  count,
  seedEpisode,
  segment,
  startRun,
  t0,
  tempDatabase,
  turn,
  type TempDatabase,
} from "./test-helpers";

let temp: TempDatabase;
let episodeId: number;
let trackRunId: number;

const engine = {
  engineId: "parakeet-tdt-0.6b-v3",
  engineVersion: "1",
  engineRuntime: "speech.cpp 0.9.3",
  adapterClass: "product",
  modelSha256: null,
};

beforeEach(() => {
  temp = tempDatabase();
  ({ episodeId, trackRunId } = seedEpisode(temp.db, [[0, 60]]));
  temp.db.orm.update(episodes).set({ state: "open" }).where(eq(episodes.id, episodeId)).run();
});
afterEach(() => temp.cleanup());

const live = (texts: readonly string[], inputGeneration = 1) =>
  publishLive(temp.db, {
    episodeId,
    inputGeneration,
    engine,
    inputHash: texts.join("|"),
    segments: texts.map((text, index) =>
      segment(trackRunId, index * 5, index * 5 + 4, text, "input:mic/live/1"),
    ),
    turns:
      texts.length === 0 ? [] : [turn(trackRunId, 0, texts.length * 5 - 1, "input:mic/live/1")],
    nowMs: t0,
  });

const liveRuns = () => count(temp.db, "analysis_runs", "stage = 'asr_live'");

describe("near-live text", () => {
  it("is off until the user turns it on", () => {
    expect(liveEnabled(temp.db)).toBe(false);
    setLiveEnabled(temp.db, true, t0);
    expect(liveEnabled(temp.db)).toBe(true);
    setLiveEnabled(temp.db, false, t0 + 1);
    expect(liveEnabled(temp.db)).toBe(false);
  });

  it("replaces the episode's live text whole, and keeps one live run", () => {
    expect(live(["bonjour"])).toMatchObject({ published: true });
    expect(live(["bonjour", "on commence"])).toMatchObject({ published: true });
    expect(searchSegments(temp.db, "bonjour")).toHaveLength(1);
    expect(searchSegments(temp.db, "commence")).toHaveLength(1);
    expect(liveRuns()).toBe(1);
    expect(getEpisodeDetail(temp.db, episodeId)?.episode.live).toBe(true);
    // Not a finished transcript.
    expect(
      temp.db.orm.select().from(episodes).where(eq(episodes.id, episodeId)).get()?.analysisState,
    ).not.toBe("complete");
    checkSearchIndex(temp.db);
  });

  it("drops a publish made for an older generation, and its run", () => {
    live(["bonjour"]);
    bumpInputGeneration(temp.db, episodeId, t0);
    expect(live(["périmé"], 1)).toEqual({ published: false, reason: "stale_generation" });
    expect(searchSegments(temp.db, "périmé")).toEqual([]);
    expect(searchSegments(temp.db, "bonjour")).toHaveLength(1);
    expect(liveRuns()).toBe(1);
  });

  it("gives way to the final transcript", () => {
    live(["provisoire"]);
    const final = startRun(temp.db, episodeId, "asr");
    publishAnalysis(temp.db, {
      episodeId,
      stage: "asr",
      runId: final,
      inputGeneration: 1,
      segments: [segment(trackRunId, 0, 4, "définitif")],
      turns: [turn(trackRunId, 0, 4, "S1")],
    });
    expect(getEpisodeDetail(temp.db, episodeId)?.episode.live).toBe(false);
    expect(live(["en retard"])).toEqual({ published: false, reason: "final_exists" });
    // The superseded live run stays as history, as any run the final replaces; the late one goes.
    expect(liveRuns()).toBe(1);
    expect(count(temp.db, "analysis_runs", "stage = 'asr_live' AND status = 'superseded'")).toBe(1);
    expect(searchSegments(temp.db, "retard")).toEqual([]);
  });

  it("lets regrouping delete an open episode that holds live text", () => {
    live(["bonjour"]);
    const report = applyEpisodePlan(
      temp.db,
      {
        groupingVersion: "g1",
        classifierVersion: "c1",
        writes: [],
        deletes: [episodeId],
        repairs: [],
      },
      t0,
    );
    expect(report.deleted).toEqual([episodeId]);
    expect(currentRunId(temp.db, episodeId, "asr_live")).toBeUndefined();
    expect(searchSegments(temp.db, "bonjour")).toEqual([]);
    expect(count(temp.db, "segments")).toBe(0);
    checkSearchIndex(temp.db);
  });
});
