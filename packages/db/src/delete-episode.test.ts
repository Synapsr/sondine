import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeSpeechRegion,
  openSpeechRegion,
  recordSpoolCommit,
  recordSpoolFile,
} from "./capture-import";
import { deleteEpisode } from "./delete-episode";
import { getEpisodeDetail } from "./episodes-store";
import { currentRunId, publishAnalysis } from "./publish";
import { chunks, deletedRanges, episodeRegions, episodes, jobs, userAssertions } from "./schema";
import { checkSearchIndex, searchSegments } from "./search";
import {
  at,
  count,
  rate,
  seedEpisode,
  seedTrackRun,
  segment,
  startRun,
  t0,
  tempDatabase,
  turn,
  type TempDatabase,
} from "./test-helpers";
import { editSegment } from "./transcript-edits";

const canary = "zqxjvwplonk";

let temp: TempDatabase;
beforeEach(() => {
  temp = tempDatabase();
});
afterEach(() => temp.cleanup());

function fileContains(path: string, needle: string): boolean {
  return existsSync(path) && readFileSync(path).includes(Buffer.from(needle));
}

/** An episode at 10-20 s with published text, plus an unrelated episode at 100-110 s. */
function seedTwoEpisodes() {
  const target = seedEpisode(temp.db, [[10, 20]]);
  const keep = seedEpisode(temp.db, [[100, 110]], target.trackRunId);
  for (const [episode, text] of [
    [target, `Le code secret est ${canary}, ne le dis à personne.`],
    [keep, "Rendez-vous demain à la gare de Lyon."],
  ] as const) {
    const runId = startRun(temp.db, episode.episodeId, "asr");
    const start = episode === target ? 10 : 100;
    const result = publishAnalysis(temp.db, {
      episodeId: episode.episodeId,
      stage: "asr",
      runId,
      inputGeneration: 1,
      segments: [segment(target.trackRunId, start, start + 9, text)],
      turns: [turn(target.trackRunId, start, start + 9, "S1")],
    });
    expect(result.published).toBe(true);
  }
  return { target, keep };
}

describe("deleteEpisode", () => {
  it("removes the episode's text from the index, the database file, and the WAL", () => {
    const { target, keep } = seedTwoEpisodes();
    temp.db.client.exec("PRAGMA wal_checkpoint(PASSIVE)");
    expect(searchSegments(temp.db, canary)).toHaveLength(1);
    expect(fileContains(temp.path, canary) || fileContains(`${temp.path}-wal`, canary)).toBe(true);

    const result = deleteEpisode(temp.db, target.episodeId, {
      origin: "app",
      nowMs: t0 + 3_600_000,
    });
    expect(result).toMatchObject({ deleted: true, segmentCount: 1, checkpoint: { busy: 0 } });

    expect(searchSegments(temp.db, canary)).toEqual([]);
    expect(count(temp.db, "segments_fts")).toBe(1);
    expect(searchSegments(temp.db, "gare").map((hit) => hit.episodeId)).toEqual([keep.episodeId]);
    expect(() => checkSearchIndex(temp.db)).not.toThrow();
    expect(fileContains(temp.path, canary)).toBe(false);
    expect(fileContains(`${temp.path}-wal`, canary)).toBe(false);

    for (const table of [
      "episodes",
      "analysis_runs",
      "episode_analysis",
      "speaker_turns",
      "episode_speakers",
      "speech_regions",
    ]) {
      expect(count(temp.db, table), table).toBe(1);
    }
  });

  it("removes a correction of its text too: the assertion and the engine's text", () => {
    const { target } = seedTwoEpisodes();
    const detail = getEpisodeDetail(temp.db, target.episodeId);
    const runId = currentRunId(temp.db, target.episodeId, "asr") ?? 0;
    const corrected = "corrigez-moi xylophagewz";
    expect(
      editSegment(temp.db, {
        episodeId: target.episodeId,
        runId,
        segmentId: detail?.segments[0]?.id ?? 0,
        nowMs: t0 + 1_000,
        text: corrected,
      }),
    ).toBe("ok");
    temp.db.client.exec("PRAGMA wal_checkpoint(PASSIVE)");

    deleteEpisode(temp.db, target.episodeId, { origin: "app", nowMs: t0 + 3_600_000 });
    for (const needle of [canary, "xylophagewz"]) {
      expect(fileContains(temp.path, needle), needle).toBe(false);
      expect(fileContains(`${temp.path}-wal`, needle), needle).toBe(false);
    }
    expect(count(temp.db, "user_assertions")).toBe(0);
  });

  it("leaves tombstones that stop re-import and late publishes", () => {
    const { target } = seedTwoEpisodes();
    const lateRun = startRun(temp.db, target.episodeId, "asr");
    temp.db.orm
      .insert(jobs)
      .values({
        kind: "analysis",
        state: "queued",
        episodeId: target.episodeId,
        stage: "asr",
        createdAtMs: t0,
        updatedAtMs: t0,
      })
      .run();
    deleteEpisode(temp.db, target.episodeId, { origin: "app", nowMs: t0 + 60_000 });

    const tombstones = temp.db.orm.select().from(deletedRanges).all();
    expect(tombstones).toEqual([
      expect.objectContaining({
        scope: "track_run",
        trackRunId: target.trackRunId,
        sampleStart: at(10) - 1.5 * rate,
        sampleEnd: at(20) + 0.8 * rate,
        wallStartMs: t0 + 8500,
        wallEndMs: t0 + 20_800,
      }),
    ]);
    expect(
      openSpeechRegion(temp.db, {
        trackRunId: target.trackRunId,
        sampleStart: at(10),
        wallStartMs: t0 + 10_000,
        vadVersion: "v",
      }).status,
    ).toBe("skipped_deleted");
    expect(
      publishAnalysis(temp.db, {
        episodeId: target.episodeId,
        stage: "asr",
        runId: lateRun,
        inputGeneration: 1,
        segments: [segment(target.trackRunId, 10, 19, `toujours ${canary}`)],
        turns: [],
      }),
    ).toEqual({ published: false, reason: "episode_missing" });
    expect(searchSegments(temp.db, canary)).toEqual([]);
    expect(temp.db.orm.select().from(jobs).get()?.state).toBe("cancelled");
  });

  it("marks overlapping chunks deleted and returns them for scrubbing", () => {
    const { target } = seedTwoEpisodes();
    const { spoolFileId } = recordSpoolFile(temp.db, {
      trackRunId: target.trackRunId,
      seq: 0,
      relPath: "spool/mic/000000.pcm",
      sampleStart: 0,
      createdWallMs: t0,
    });
    const block = 2 * rate;
    for (let index = 0; index < 15; index++) {
      recordSpoolCommit(temp.db, {
        spoolFileId,
        byteOffset: index * block * 2,
        byteLength: block * 2,
        sampleStart: index * block,
        wallMs: t0 + index * 2000,
        crc32: index,
      });
    }
    const result = deleteEpisode(temp.db, target.episodeId, { origin: "app", nowMs: t0 + 60_000 });
    if (!result.deleted) throw new Error("not deleted");
    // Tombstone 8.5 s - 20.8 s covers the 2 s blocks starting at 8, 10, …, 20.
    expect(result.chunks.map((chunk) => chunk.byteOffset / (block * 2))).toEqual([
      4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(result.chunks[0]).toMatchObject({
      spoolRelPath: "spool/mic/000000.pcm",
      byteLength: block * 2,
    });
    const states = temp.db.orm
      .select({ state: chunks.audioState })
      .from(chunks)
      .all()
      .map((row) => row.state);
    expect(states.filter((state) => state === "deleted")).toHaveLength(7);
    expect(states.filter((state) => state === "present")).toHaveLength(8);
  });

  it("drops assertions anchored inside the deleted audio only", () => {
    const { target } = seedTwoEpisodes();
    const assertion = (from: number, to: number) =>
      temp.db.orm
        .insert(userAssertions)
        .values({
          kind: "transcript_edit",
          trackRunId: target.trackRunId,
          sampleStart: at(from),
          sampleEnd: at(to),
          payload: { text: "corrigé" },
          origin: "app",
          createdAtMs: t0,
        })
        .run();
    assertion(12, 14);
    assertion(15, 15);
    assertion(100, 102);
    deleteEpisode(temp.db, target.episodeId, { origin: "app" });
    expect(
      temp.db.orm.select({ start: userAssertions.sampleStart }).from(userAssertions).all(),
    ).toEqual([{ start: at(100) }]);
  });

  it("covers an ongoing episode up to now, so the helper's late close is dropped", () => {
    const trackRunId = seedTrackRun(temp.db);
    const opened = openSpeechRegion(temp.db, {
      trackRunId,
      sampleStart: at(30),
      wallStartMs: t0 + 30_000,
      vadVersion: "v",
    });
    const episode = temp.db.orm
      .insert(episodes)
      .values({
        startedAtMs: t0 + 30_000,
        groupingVersion: "g1",
        classifierVersion: "c1",
        createdAtMs: t0,
        updatedAtMs: t0,
      })
      .returning({ id: episodes.id })
      .get();
    if (opened.speechRegionId === null) throw new Error("region refused");
    temp.db.orm
      .insert(episodeRegions)
      .values({
        episodeId: episode.id,
        speechRegionId: opened.speechRegionId,
        groupingVersion: "g1",
        sliceSampleStart: at(30),
      })
      .run();

    deleteEpisode(temp.db, episode.id, { origin: "tray", nowMs: t0 + 45_000 });
    expect(temp.db.orm.select().from(deletedRanges).get()).toMatchObject({
      sampleStart: at(28.5),
      sampleEnd: at(45.8),
      wallEndMs: t0 + 45_800,
    });
    const close = (seconds: number) =>
      closeSpeechRegion(temp.db, {
        trackRunId,
        sampleStart: at(30),
        sampleEnd: at(seconds),
        wallEndMs: t0 + seconds * 1000,
        endReason: "silence",
      }).status;
    expect(close(50)).toBe("unknown");
    expect(
      openSpeechRegion(temp.db, {
        trackRunId,
        sampleStart: at(30),
        wallStartMs: t0 + 30_000,
        vadVersion: "v",
      }).status,
    ).toBe("skipped_deleted");
  });

  it("removes text another grouping version published over the same audio", () => {
    const { target, keep } = seedTwoEpisodes();
    const regrouped = temp.db.orm
      .insert(episodes)
      .values({
        state: "closed",
        startedAtMs: t0 + 10_000,
        endedAtMs: t0 + 20_000,
        groupingVersion: "g2",
        classifierVersion: "c1",
        createdAtMs: t0,
        updatedAtMs: t0,
      })
      .returning({ id: episodes.id })
      .get().id;
    for (const speechRegionId of target.regionIds) {
      temp.db.orm
        .insert(episodeRegions)
        .values({
          episodeId: regrouped,
          speechRegionId,
          groupingVersion: "g2",
          sliceSampleStart: at(10),
        })
        .run();
    }
    const runId = startRun(temp.db, regrouped, "asr");
    publishAnalysis(temp.db, {
      episodeId: regrouped,
      stage: "asr",
      runId,
      inputGeneration: 1,
      segments: [segment(target.trackRunId, 10, 19, `Le code est ${canary}.`, "S1")],
      turns: [turn(target.trackRunId, 10, 19, "S1")],
    });
    expect(searchSegments(temp.db, canary)).toHaveLength(2);

    const result = deleteEpisode(temp.db, target.episodeId, { origin: "app" });
    expect(result).toMatchObject({ deleted: true, segmentCount: 2 });
    expect(searchSegments(temp.db, canary)).toEqual([]);
    expect(count(temp.db, "segments", `episode_id = ${regrouped}`)).toBe(0);
    expect(count(temp.db, "speaker_turns", `episode_id = ${regrouped}`)).toBe(0);
    expect(searchSegments(temp.db, "gare").map((hit) => hit.episodeId)).toEqual([keep.episodeId]);
    expect(() => checkSearchIndex(temp.db)).not.toThrow();
    expect(fileContains(temp.path, canary)).toBe(false);
    expect(fileContains(`${temp.path}-wal`, canary)).toBe(false);
  });

  it("removes a neighbour's segments that reach into the tombstoned roll", () => {
    const { target } = seedTwoEpisodes();
    const neighbour = seedEpisode(temp.db, [[0, 9]], target.trackRunId);
    const runId = startRun(temp.db, neighbour.episodeId, "asr");
    publishAnalysis(temp.db, {
      episodeId: neighbour.episodeId,
      stage: "asr",
      runId,
      inputGeneration: 1,
      segments: [
        segment(target.trackRunId, 0, 8.5, "Bonjour à tous."),
        segment(target.trackRunId, 8.4, 9, `Alors ${canary}`),
      ],
      turns: [turn(target.trackRunId, 0, 8.5, "S1"), turn(target.trackRunId, 8.4, 9, "S1")],
    });

    const updatedAt = () =>
      temp.db.client
        .prepare("SELECT updated_at_ms FROM episodes WHERE id = ?")
        .get(neighbour.episodeId)?.["updated_at_ms"];
    const before = updatedAt();
    deleteEpisode(temp.db, target.episodeId, { origin: "app", nowMs: t0 + 3_600_000 });
    // The tombstone starts at 8.5 s: [0, 8.5) stays, [8.4, 9) is gone.
    expect(searchSegments(temp.db, canary)).toEqual([]);
    // Lost text shows as a change to readers comparing revisions.
    expect(updatedAt()).toBe(t0 + 3_600_000);
    expect(updatedAt()).not.toBe(before);
    expect(searchSegments(temp.db, "bonjour").map((hit) => hit.episodeId)).toEqual([
      neighbour.episodeId,
    ]);
    expect(count(temp.db, "speaker_turns", `episode_id = ${neighbour.episodeId}`)).toBe(1);
    expect(() => checkSearchIndex(temp.db)).not.toThrow();
  });

  it("stores a region cut in two episodes of one grouping version and deletes one slice", () => {
    // One region at 10-30 s, cut at 20 s by a split: `first` holds 10-20, `second` 20-30.
    const first = seedEpisode(temp.db, [[10, 30]]);
    const [regionId] = first.regionIds;
    if (regionId === undefined) throw new Error("no region");
    temp.db.client
      .prepare("UPDATE episode_regions SET slice_sample_end = ? WHERE episode_id = ?")
      .run(at(20), first.episodeId);
    const second = temp.db.orm
      .insert(episodes)
      .values({
        state: "closed",
        startedAtMs: t0 + 20_000,
        endedAtMs: t0 + 30_000,
        groupingVersion: "g1",
        classifierVersion: "c1",
        createdAtMs: t0,
        updatedAtMs: t0,
      })
      .returning({ id: episodes.id })
      .get().id;
    const sliceOf = (episodeId: number, sliceSampleStart: number) =>
      temp.db.orm
        .insert(episodeRegions)
        .values({ episodeId, speechRegionId: regionId, groupingVersion: "g1", sliceSampleStart })
        .run();
    sliceOf(second, at(20));
    // Two episodes may not claim the same slice of a region in one grouping version.
    const third = seedEpisode(temp.db, [[40, 41]], first.trackRunId).episodeId;
    expect(() => sliceOf(third, at(20))).toThrow(
      expect.objectContaining({ cause: expect.objectContaining({ errcode: 2067 }) }),
    );

    const slices = temp.db.client
      .prepare(
        `SELECT episode_id, slice_sample_start, slice_sample_end FROM episode_regions
         WHERE speech_region_id = ? ORDER BY slice_sample_start`,
      )
      .all(regionId);
    expect(slices).toEqual([
      { episode_id: first.episodeId, slice_sample_start: at(10), slice_sample_end: at(20) },
      { episode_id: second, slice_sample_start: at(20), slice_sample_end: null },
    ]);

    for (const [episodeId, start, text] of [
      [first.episodeId, 12, `Premier ${canary}`],
      [second, 22, "Seconde moitié du rendez-vous."],
    ] as const) {
      const runId = startRun(temp.db, episodeId, "asr");
      publishAnalysis(temp.db, {
        episodeId,
        stage: "asr",
        runId,
        inputGeneration: 1,
        segments: [segment(first.trackRunId, start, start + 6, text)],
        turns: [turn(first.trackRunId, start, start + 6, "S1")],
      });
    }

    deleteEpisode(temp.db, first.episodeId, { origin: "app" });
    // Pre-roll at the region's start, none at the cut.
    expect(
      temp.db.orm
        .select({ start: deletedRanges.sampleStart, end: deletedRanges.sampleEnd })
        .from(deletedRanges)
        .all(),
    ).toEqual([{ start: at(8.5), end: at(20) }]);
    expect(searchSegments(temp.db, canary)).toEqual([]);
    expect(searchSegments(temp.db, "moitié").map((hit) => hit.episodeId)).toEqual([second]);
    expect(count(temp.db, "speech_regions", `id = ${regionId}`)).toBe(1);
    expect(count(temp.db, "episode_regions", `episode_id = ${second}`)).toBe(1);

    deleteEpisode(temp.db, second, { origin: "app" });
    expect(count(temp.db, "deleted_ranges", `sample_start = ${at(20)}`)).toBe(1);
    expect(count(temp.db, "deleted_ranges", `sample_end = ${at(30.8)}`)).toBe(1);
    expect(count(temp.db, "speech_regions", `id = ${regionId}`)).toBe(0);
    expect(searchSegments(temp.db, "moitié")).toEqual([]);
    expect(() => checkSearchIndex(temp.db)).not.toThrow();
  });

  it("reports a missing episode", () => {
    expect(deleteEpisode(temp.db, 12345, { origin: "app" })).toEqual({ deleted: false });
  });
});
