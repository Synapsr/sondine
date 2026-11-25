import { DAY_MS } from "@sondine/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeSpeechRegion,
  closeSpoolFile,
  openSpeechRegion,
  recordSpoolCommit,
  recordSpoolFile,
} from "./capture-import";
import { mergeEpisodes, splitEpisode } from "./episode-boundaries";
import { forgetRange } from "./forget-range";
import { getEpisodeDetail, loadEpisodeSummaries } from "./episodes-store";
import { KEEP_RECENT_MS, keepRecentAudio } from "./keep-recent";
import {
  audioExpiryDue,
  dropRecordingsKeepingNothing,
  episodePrivacy,
  recordingsToDelete,
  takeAudioAfterText,
} from "./privacy-policy";
import {
  addZone,
  durationsSince,
  episodeAudioKept,
  releaseEpisodeAudio,
  setDuration,
  updateZone,
} from "./privacy-zones";
import { expireSpoolFile, planArchive, recordArchive } from "./retention";
import { episodeRegions, episodes } from "./schema/episodes";
import { at, count, rate, seedEpisode, seedTrackRun, t0, tempDatabase } from "./test-helpers";
import type { TempDatabase } from "./test-helpers";

// « Garder les 2 dernières minutes » over a run of 2 s blocks that starts at
// t0: the gesture at 300 s keeps 180–300 s, whatever of it is speech.

let temp: TempDatabase;
beforeEach(() => {
  temp = tempDatabase();
});
afterEach(() => temp.cleanup());

const s = (seconds: number) => t0 + seconds * 1000;
const BLOCK_SECONDS = 2;

/**
 * 2 s blocks over [fromSeconds, toSeconds) of the wall clock, in one spool
 * file, for a run that started at `runStartSeconds`.
 */
function spool(
  trackRunId: number,
  fromSeconds: number,
  toSeconds: number,
  runStartSeconds = 0,
): number {
  const sample = (second: number) => at(second - runStartSeconds);
  const { spoolFileId } = recordSpoolFile(temp.db, {
    trackRunId,
    seq: 0,
    relPath: `spool/input/run-${trackRunId}/0000.pcm`,
    sampleStart: sample(fromSeconds),
    createdWallMs: s(fromSeconds),
  });
  const block = BLOCK_SECONDS * rate;
  for (let second = fromSeconds; second < toSeconds; second += BLOCK_SECONDS) {
    recordSpoolCommit(temp.db, {
      spoolFileId,
      byteOffset: (sample(second) - sample(fromSeconds)) * 2,
      byteLength: block * 2,
      sampleStart: sample(second),
      wallMs: s(second),
      crc32: second,
    });
  }
  return spoolFileId;
}

const keep = (nowSeconds: number) =>
  keepRecentAudio(temp.db, {
    fromWallMs: s(nowSeconds) - KEEP_RECENT_MS,
    toWallMs: s(nowSeconds),
    nowMs: s(nowSeconds),
  });

const keptRanges = () =>
  temp.db
    .statement("SELECT track_run_id, sample_start, sample_end, origin FROM kept_audio ORDER BY id")
    .all();

const closeRun = (trackRunId: number, endSeconds: number) =>
  temp.db
    .statement(
      `UPDATE track_runs SET state = 'closed', end_reason = 'paused', ended_wall_ms = ?,
         sample_end = ? WHERE id = ?`,
    )
    .run(s(endSeconds), at(endSeconds), trackRunId);

/** The first second of each block a spool file keeps when it leaves the spool. */
const selectedSeconds = (spoolFileId: number) =>
  planArchive(temp.db, spoolFileId)?.selected.map((chunk) => chunk.sampleStart / rate);

/** Archives what the plan selects, as the archiver does, then expires the file. */
function evict(spoolFileId: number): void {
  closeSpoolFile(temp.db, { spoolFileId, closedWallMs: s(600) });
  const plan = planArchive(temp.db, spoolFileId);
  recordArchive(temp.db, {
    spoolFileId,
    archiveRelPath: `archive/${spoolFileId}.pcm`,
    placements: (plan?.selected ?? []).map((chunk, index) => ({
      chunkId: chunk.id,
      crc32: chunk.crc32,
      archiveByteOffset: index * chunk.byteLength,
    })),
  });
  expireSpoolFile(temp.db, spoolFileId);
}

const states = () =>
  temp.db
    .statement("SELECT audio_state, count(*) AS n FROM chunks GROUP BY audio_state ORDER BY 1")
    .all();

/** An episode still open over a region still open, from `startSeconds`. */
function openEpisode(trackRunId: number, startSeconds: number): number {
  const region = openSpeechRegion(temp.db, {
    trackRunId,
    sampleStart: at(startSeconds),
    wallStartMs: s(startSeconds),
    vadVersion: "silero-6.2",
  });
  if (region.speechRegionId === null) throw new Error("region refused");
  const episode = temp.db.orm
    .insert(episodes)
    .values({
      state: "open",
      startedAtMs: s(startSeconds),
      groupingVersion: "g1",
      classifierVersion: "c1",
      createdAtMs: s(startSeconds),
      updatedAtMs: s(startSeconds),
    })
    .returning({ id: episodes.id })
    .get();
  temp.db.orm
    .insert(episodeRegions)
    .values({
      episodeId: episode.id,
      speechRegionId: region.speechRegionId,
      groupingVersion: "g1",
      sliceSampleStart: at(startSeconds),
    })
    .run();
  return episode.id;
}

describe("keeping the last 2 minutes", () => {
  it("keeps audio still in the spool, silence included, when the spool lets it go", () => {
    const run = seedTrackRun(temp.db);
    const file = spool(run, 0, 300);
    // Before: nothing is speech, nothing would leave the spool.
    expect(selectedSeconds(file)).toEqual([]);

    expect(keep(300)).toEqual({ outcome: "kept", keptMs: KEEP_RECENT_MS, episodeIds: [] });
    expect(keptRanges()).toEqual([
      { track_run_id: run, sample_start: at(180), sample_end: at(300), origin: "moment" },
    ]);
    const kept = Array.from({ length: 60 }, (_, index) => 180 + index * BLOCK_SECONDS);
    expect(selectedSeconds(file)).toEqual(kept);
    // The spool refuses to drop it before it is archived, then keeps exactly that.
    closeSpoolFile(temp.db, { spoolFileId: file, closedWallMs: s(600) });
    expect(() => expireSpoolFile(temp.db, file)).toThrow(/not archived/);
    evict(file);
    expect(states()).toEqual([
      { audio_state: "archived", n: 60 },
      { audio_state: "expired", n: 90 },
    ]);
  });

  it("keeps an episode still open, and its audio not committed yet, through its close", () => {
    const run = seedTrackRun(temp.db);
    // Committed up to 296 s: the last 4 s are still in the helper's buffers.
    const file = spool(run, 0, 296);
    const episodeId = openEpisode(run, 250);
    expect(keep(300)).toEqual({ outcome: "kept", keptMs: KEEP_RECENT_MS, episodeIds: [episodeId] });
    expect(keptRanges()).toEqual([
      { track_run_id: run, sample_start: at(180), sample_end: at(300), origin: "moment" },
    ]);
    // Shown at once, while it is open.
    expect(loadEpisodeSummaries(temp.db, [episodeId]).get(episodeId)?.keptAtMs).toBe(s(300));

    // The rest arrives, the talk goes on past the gesture and ends.
    recordSpoolCommit(temp.db, {
      spoolFileId: file,
      byteOffset: at(296) * 2,
      byteLength: 2 * rate * 2,
      sampleStart: at(296),
      wallMs: s(296),
      crc32: 296,
    });
    closeSpeechRegion(temp.db, {
      trackRunId: run,
      sampleStart: at(250),
      sampleEnd: at(400),
      wallEndMs: s(400),
      endReason: "silence",
    });
    temp.db
      .statement("UPDATE episodes SET state = 'closed', ended_at_ms = ? WHERE id = ?")
      .run(s(400), episodeId);
    expect(episodeAudioKept(temp.db, episodeId)).toBe(true);
    expect(selectedSeconds(file)).toContain(296);
    expect(getEpisodeDetail(temp.db, episodeId)?.episode.keptAtMs).toBe(s(300));
  });

  it("survives every duration, the disk cap and « Effacé après » run afterwards", () => {
    durationsSince(temp.db, t0);
    const trace = seedEpisode(temp.db, [[200, 201]]);
    temp.db.statement("UPDATE episodes SET size = 'trace' WHERE id = ?").run(trace.episodeId);
    const file = spool(trace.trackRunId, 0, 300);
    setDuration(temp.db, "traces", { deleteDays: 7 }, t0);
    keep(300);
    evict(file);
    const archived = states();
    const later = s(300) + 400 * DAY_MS;
    expect(audioExpiryDue(temp.db, { nowMs: later, capBytes: 0 }).episodeIds).toEqual([]);
    expect(recordingsToDelete(temp.db, later).ids).toEqual([]);
    expect(states()).toEqual(archived);
    expect(count(temp.db, "chunks", "audio_state = 'archived'")).toBe(60);
  });

  it("follows the audio through a split and a merge", () => {
    // Before the window (100–120 s) and in it (200–220 s, 260–280 s).
    const { episodeId, trackRunId } = seedEpisode(temp.db, [
      [100, 120],
      [200, 220],
      [260, 280],
    ]);
    temp.db
      .statement("UPDATE episodes SET size = 'conversation', context = 'in_person' WHERE id = ?")
      .run(episodeId);
    spool(trackRunId, 0, 300);
    keep(300);
    const split = splitEpisode(temp.db, { episodeId, atMs: s(200), nowMs: s(310) });
    if (!split.ok) throw new Error(split.reason);
    const { newEpisodeId } = split.value;
    expect(episodeAudioKept(temp.db, episodeId)).toBe(false);
    expect(episodeAudioKept(temp.db, newEpisodeId)).toBe(true);
    const summaries = loadEpisodeSummaries(temp.db, [episodeId, newEpisodeId]);
    expect(summaries.get(episodeId)?.keptAtMs).toBeNull();
    expect(summaries.get(newEpisodeId)?.keptAtMs).toBe(s(300));

    const merged = mergeEpisodes(temp.db, { episodeId, otherId: newEpisodeId, nowMs: s(320) });
    if (!merged.ok) throw new Error(merged.reason);
    expect(episodeAudioKept(temp.db, merged.value.episodeId)).toBe(true);
    expect(
      loadEpisodeSummaries(temp.db, [merged.value.episodeId]).get(merged.value.episodeId)?.keptAtMs,
    ).toBe(s(300));
    expect(count(temp.db, "kept_audio", `track_run_id = ${trackRunId}`)).toBe(1);
  });

  it("comes before a zone that takes the audio or deletes, like « Garder l'audio »", () => {
    // A site at « Rien » deletes at close; « La nuit » at « Texte seul » takes the audio.
    const site = addZone(temp.db, { kind: "site", site: "example.com" }, t0);
    expect(site.outcome).toBe("nothing");
    updateZone(
      temp.db,
      "night",
      {
        on: true,
        outcome: "text_only",
        windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 0, endMinute: 1440 }],
      },
      t0,
    );
    const film = seedEpisode(temp.db, [[200, 280]]);
    temp.db
      .statement("UPDATE episodes SET page_key = 'example.com/a', context = 'media' WHERE id = ?")
      .run(film.episodeId);
    spool(film.trackRunId, 0, 300);
    keep(300);
    const privacy = episodePrivacy(temp.db, [film.episodeId], s(300)).get(film.episodeId);
    expect(privacy?.kept).toBe(true);
    // The zones still say what they take: no text is made.
    expect(privacy?.keeping.text).toBe(false);
    expect(dropRecordingsKeepingNothing(temp.db, [film.episodeId], s(300)).episodeIds).toEqual([]);
    expect(takeAudioAfterText(temp.db, film.episodeId, s(300))).toEqual([]);
    expect(count(temp.db, "chunks", "audio_state = 'deleted'")).toBe(0);
  });

  it("keeps nothing when nothing was captured: paused, held, or a phone recording", () => {
    const run = seedTrackRun(temp.db);
    spool(run, 0, 100);
    closeRun(run, 100);
    temp.db
      .statement("UPDATE track_runs SET source_kind = 'phone' WHERE id = ?")
      .run(seedTrackRun(temp.db, s(250)));
    expect(keep(300)).toEqual({ outcome: "nothing" });
    expect(count(temp.db, "kept_audio")).toBe(0);
  });

  it("keeps what exists when listening stopped or started part-way", () => {
    // Paused at 210 s, listening again from 270 s, committed to 296 s: 30 s and 30 s.
    const before = seedTrackRun(temp.db);
    spool(before, 0, 210);
    closeRun(before, 210);
    const after = seedTrackRun(temp.db, s(270));
    spool(after, 270, 296, 270);
    const result = keep(300);
    expect(result).toEqual({ outcome: "kept", keptMs: 60_000, episodeIds: [] });
    expect(keptRanges()).toEqual([
      { track_run_id: before, sample_start: at(180), sample_end: at(210), origin: "moment" },
      { track_run_id: after, sample_start: 0, sample_end: at(30), origin: "moment" },
    ]);
  });

  it("counts on an open run's uncommitted audio only while its blocks keep coming", () => {
    // Listening for 6 s, no block imported yet.
    const fresh = seedTrackRun(temp.db, s(294));
    expect(keep(300)).toEqual({ outcome: "kept", keptMs: 6_000, episodeIds: [] });
    expect(keptRanges()).toEqual([
      { track_run_id: fresh, sample_start: 0, sample_end: at(6), origin: "moment" },
    ]);
    // Its blocks stopped 200 s ago (a gap, the disk full): nothing since is counted on.
    const stalled = seedTrackRun(temp.db, s(1_000));
    spool(stalled, 1_000, 1_100, 1_000);
    expect(keep(1_300)).toEqual({ outcome: "nothing" });
  });

  it("keeps nothing of what was erased or never written", () => {
    const run = seedTrackRun(temp.db);
    spool(run, 0, 300);
    forgetRange(temp.db, { fromWallMs: s(100), toWallMs: s(300), origin: "app", nowMs: s(300) });
    closeRun(run, 300);
    expect(keep(300)).toEqual({ outcome: "nothing" });
    expect(count(temp.db, "kept_audio")).toBe(0);
  });

  it("never keeps audio still to come when the clock was set forward since the run started", () => {
    // Blocks to 300 s on the run's clock; the Mac's clock now reads 600 s.
    const run = seedTrackRun(temp.db);
    const file = spool(run, 0, 300);
    expect(keep(600)).toEqual({ outcome: "nothing" });
    expect(count(temp.db, "kept_audio")).toBe(0);
    expect(selectedSeconds(file)).toEqual([]);
  });

  it("« Ne plus garder » on a recording still open holds once its speech ends", () => {
    const run = seedTrackRun(temp.db);
    spool(run, 0, 300);
    const episodeId = openEpisode(run, 290);
    keep(300);
    releaseEpisodeAudio(temp.db, episodeId, s(305));
    expect(episodeAudioKept(temp.db, episodeId)).toBe(false);
    closeSpeechRegion(temp.db, {
      trackRunId: run,
      sampleStart: at(290),
      sampleEnd: at(320),
      wallEndMs: s(320),
      endReason: "silence",
    });
    temp.db
      .statement("UPDATE episodes SET state = 'closed', ended_at_ms = ? WHERE id = ?")
      .run(s(320), episodeId);
    expect(episodeAudioKept(temp.db, episodeId)).toBe(false);
    expect(loadEpisodeSummaries(temp.db, [episodeId]).get(episodeId)?.keptAtMs).toBeNull();
  });

  it("« Ne plus garder » lets the moment go with the recording's speech", () => {
    const talk = seedEpisode(temp.db, [[200, 280]]);
    spool(talk.trackRunId, 0, 300);
    keep(300);
    releaseEpisodeAudio(temp.db, talk.episodeId, s(310));
    expect(episodeAudioKept(temp.db, talk.episodeId)).toBe(false);
    expect(loadEpisodeSummaries(temp.db, [talk.episodeId]).get(talk.episodeId)?.keptAtMs).toBe(
      null,
    );
    // What is left around the speech is still the moment's.
    expect(keptRanges()).toEqual([
      {
        track_run_id: talk.trackRunId,
        sample_start: at(180),
        sample_end: at(200),
        origin: "moment",
      },
      {
        track_run_id: talk.trackRunId,
        sample_start: at(280),
        sample_end: at(300),
        origin: "moment",
      },
    ]);
  });
});
