import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeSpeechRegion,
  openSpeechRegion,
  recordSpoolCommit,
  recordSpoolFile,
} from "./capture-import";
import { intersectsDeletedRange } from "./deleted-ranges";
import { episodesInRange, forgetRange } from "./forget-range";
import { publishAnalysis } from "./publish";
import { checkSearchIndex, searchSegments } from "./search";
import {
  at,
  count,
  rate,
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

const s = (seconds: number) => t0 + seconds * 1000;

/** Episodes at 10-20 s and 100-130 s with text, a lone region at 200-201 s, 2 s blocks over 0-240 s. */
function seed() {
  const early = seedEpisode(temp.db, [[10, 20]]);
  const late = seedEpisode(temp.db, [[100, 130]], early.trackRunId);
  for (const [episode, start, text] of [
    [early, 10, "Rendez-vous demain à la gare."],
    [late, 100, "Le code de la porte est quatre deux un."],
  ] as const) {
    const runId = startRun(temp.db, episode.episodeId, "asr");
    publishAnalysis(temp.db, {
      episodeId: episode.episodeId,
      stage: "asr",
      runId,
      inputGeneration: 1,
      segments: [segment(early.trackRunId, start, start + 9, text)],
      turns: [turn(early.trackRunId, start, start + 9, "S1")],
    });
  }
  openSpeechRegion(temp.db, {
    trackRunId: early.trackRunId,
    sampleStart: at(200),
    wallStartMs: s(200),
    vadVersion: "v",
  });
  closeSpeechRegion(temp.db, {
    trackRunId: early.trackRunId,
    sampleStart: at(200),
    sampleEnd: at(201),
    wallEndMs: s(201),
    endReason: "silence",
  });
  const { spoolFileId } = recordSpoolFile(temp.db, {
    trackRunId: early.trackRunId,
    seq: 0,
    relPath: "spool/mic/000000.pcm",
    sampleStart: 0,
    createdWallMs: t0,
  });
  const block = 2 * rate;
  for (let index = 0; index < 120; index++) {
    recordSpoolCommit(temp.db, {
      spoolFileId,
      byteOffset: index * block * 2,
      byteLength: block * 2,
      sampleStart: index * block,
      wallMs: t0 + index * 2000,
      crc32: index,
    });
  }
  return { early, late, trackRunId: early.trackRunId };
}

describe("forget a range", () => {
  it("lists every episode the range touches, an earlier start included", () => {
    const { early, late } = seed();
    expect(episodesInRange(temp.db, s(120), s(240)).map((episode) => episode.id)).toEqual([
      late.episodeId,
    ]);
    expect(episodesInRange(temp.db, s(15), s(240)).map((episode) => episode.id)).toEqual([
      early.episodeId,
      late.episodeId,
    ]);
    expect(episodesInRange(temp.db, s(30), s(90))).toEqual([]);
  });

  it("deletes what it touches whole, every block heard in it, and nothing before", () => {
    const { early, late, trackRunId } = seed();
    const result = forgetRange(temp.db, {
      fromWallMs: s(120),
      toWallMs: s(240),
      origin: "app",
      nowMs: s(240),
    });
    expect(result.episodeIds).toEqual([late.episodeId]);
    // The late episode went whole, its start before the range included.
    expect(count(temp.db, "episodes")).toBe(1);
    expect(searchSegments(temp.db, "porte")).toEqual([]);
    expect(searchSegments(temp.db, "gare")).toHaveLength(1);
    expect(() => checkSearchIndex(temp.db)).not.toThrow();
    // Blocks 120-240 s, and the late episode's own (with roll), are deleted; 0-96 s stay.
    expect(count(temp.db, "chunks", "audio_state = 'deleted' AND wall_ms < " + s(96))).toBe(0);
    expect(count(temp.db, "chunks", "audio_state = 'deleted' AND wall_ms >= " + s(120))).toBe(60);
    expect(result.chunks.length).toBe(count(temp.db, "chunks", "audio_state = 'deleted'"));
    // The lone region inside the range is gone; the early episode's stays.
    expect(count(temp.db, "speech_regions")).toBe(early.regionIds.length);
    // Nothing captured in the range can come back.
    expect(
      intersectsDeletedRange(temp.db, {
        trackRunId,
        sampleStart: at(230),
        sampleEnd: at(231),
        wallStartMs: s(230),
        wallEndMs: s(231),
      }),
    ).toBe(true);
  });

  it("refuses an empty range", () => {
    expect(() =>
      forgetRange(temp.db, { fromWallMs: s(10), toWallMs: s(10), origin: "app" }),
    ).toThrow(RangeError);
  });
});
