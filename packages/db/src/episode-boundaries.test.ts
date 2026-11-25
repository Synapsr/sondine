import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { episodeNeighbours, mergeEpisodes, splitEpisode } from "./episode-boundaries";
import { getEpisodeDetail } from "./episodes-store";
import { enqueueMissingAnalysis } from "./jobs";
import { publishAnalysis, type SegmentInput, type TurnInput } from "./publish";
import { searchEpisodes } from "./search";
import {
  count,
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

let temp: TempDatabase;
beforeEach(() => {
  temp = tempDatabase();
});
afterEach(() => temp.cleanup());

const s = (seconds: number) => t0 + seconds * 1000;

function close(episodeId: number) {
  temp.db.client
    .prepare("UPDATE episodes SET size = 'conversation', context = 'in_person' WHERE id = ?")
    .run(episodeId);
}

function publish(
  episodeId: number,
  segments: readonly SegmentInput[],
  turns: readonly TurnInput[] = [],
) {
  const runId = startRun(temp.db, episodeId, "asr");
  expect(
    publishAnalysis(temp.db, {
      episodeId,
      stage: "asr",
      runId,
      inputGeneration: 1,
      segments,
      turns,
    }).published,
  ).toBe(true);
  return runId;
}

/** A segment whose words are spread evenly over [start, end] seconds. */
function timed(trackRunId: number, start: number, end: number, text: string, label = "S1") {
  const tokens = [...text.matchAll(/\S+/gu)];
  const step = ((end - start) * 1000) / tokens.length;
  return {
    ...segment(trackRunId, start, end, text, label),
    words: tokens.map((token, index) => ({
      charStart: token.index,
      charEnd: token.index + token[0].length,
      startMs: Math.round(index * step),
      endMs: Math.round((index + 1) * step),
    })),
  };
}

const texts = (episodeId: number) =>
  getEpisodeDetail(temp.db, episodeId)?.segments.map((x) => x.text) ?? [];
const speakers = (episodeId: number) =>
  getEpisodeDetail(temp.db, episodeId)?.speakers.map((x) => x.label) ?? [];
const due = () => enqueueMissingAnalysis(temp.db, s(1_000));

describe("splitting an episode", () => {
  it("moves what starts after the cut to a new episode, with its transcript, current", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [
      [10, 20],
      [40, 50],
    ]);
    close(episodeId);
    publish(
      episodeId,
      [
        segment(trackRunId, 10, 20, "on parle du budget", "A"),
        segment(trackRunId, 40, 50, "et ensuite des vacances", "B"),
      ],
      [turn(trackRunId, 10, 20, "A"), turn(trackRunId, 40, 50, "B")],
    );

    const split = splitEpisode(temp.db, { episodeId, atMs: s(40), nowMs: s(100) });
    if (!split.ok) throw new Error(split.reason);
    const { newEpisodeId } = split.value;
    expect(texts(episodeId)).toEqual(["on parle du budget"]);
    expect(texts(newEpisodeId)).toEqual(["et ensuite des vacances"]);
    expect(speakers(episodeId)).toEqual(["A"]);
    expect(speakers(newEpisodeId)).toEqual(["B"]);
    const later = getEpisodeDetail(temp.db, newEpisodeId)?.episode;
    expect([later?.startedAtMs, later?.endedAtMs]).toEqual([s(40), s(50)]);
    expect(getEpisodeDetail(temp.db, episodeId)?.episode.endedAtMs).toBe(s(20));
    // Search finds the moved text in its new episode; nothing is re-transcribed.
    const hit = searchEpisodes(temp.db, "vacances", { limit: 5, offset: 0 });
    expect(hit.episodes.map((x) => x.episode.id)).toEqual([newEpisodeId]);
    expect(due()).toEqual([]);
    expect(episodeNeighbours(temp.db, episodeId)).toEqual({ previous: null, next: newEpisodeId });
  });

  it("cuts a region and a sentence across the cut between their words, and joins them back", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 30]]);
    close(episodeId);
    publish(
      episodeId,
      [timed(trackRunId, 10, 30, "un deux trois quatre", "A")],
      [turn(trackRunId, 10, 30, "A")],
    );
    const split = splitEpisode(temp.db, { episodeId, atMs: s(20), nowMs: s(100) });
    if (!split.ok) throw new Error(split.reason);
    expect(texts(episodeId)).toEqual(["un deux"]);
    expect(texts(split.value.newEpisodeId)).toEqual(["trois quatre"]);
    expect(count(temp.db, "episode_regions")).toBe(2);

    const merged = mergeEpisodes(temp.db, {
      episodeId: split.value.newEpisodeId,
      otherId: episodeId,
      nowMs: s(200),
    });
    if (!merged.ok) throw new Error(merged.reason);
    expect(merged.value.episodeId).toBe(episodeId);
    expect(texts(episodeId)).toEqual(["un deux", "trois quatre"]);
    // One lineage: the same voice, not two.
    expect(speakers(episodeId)).toEqual(["A"]);
    expect(count(temp.db, "episodes")).toBe(1);
    expect(temp.db.client.prepare("SELECT slice_sample_end FROM episode_regions").all()).toEqual([
      { slice_sample_end: null },
    ]);
    expect(due()).toEqual([]);
  });

  it("keeps a correction on its side, and the episode's « do not identify » on both", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 40]]);
    close(episodeId);
    const runId = publish(episodeId, [
      segment(trackRunId, 10, 22, "première partie", "A"),
      segment(trackRunId, 25, 35, "seconde partie", "A"),
    ]);
    temp.db.client
      .prepare(
        "INSERT INTO identity_rules (scope, episode_id, recognize, created_at_ms, updated_at_ms) VALUES ('episode', ?, 0, 0, 0)",
      )
      .run(episodeId);
    const [first] = getEpisodeDetail(temp.db, episodeId)?.segments ?? [];
    editSegment(temp.db, {
      episodeId,
      runId,
      segmentId: first?.id ?? 0,
      nowMs: s(60),
      text: "1re partie",
    });

    const split = splitEpisode(temp.db, { episodeId, atMs: s(21), nowMs: s(100) });
    if (!split.ok) throw new Error(split.reason);
    expect(texts(episodeId)).toEqual(["1re partie"]);
    expect(texts(split.value.newEpisodeId)).toEqual(["seconde partie"]);
    expect(
      temp.db.client
        .prepare("SELECT episode_id, recognize FROM identity_rules ORDER BY episode_id")
        .all(),
    ).toEqual([
      { episode_id: episodeId, recognize: 0 },
      { episode_id: split.value.newEpisodeId, recognize: 0 },
    ]);
  });

  it("refuses an open episode, a cut outside it, and a side without speech", () => {
    const { episodeId } = seedEpisode(temp.db, [[10, 20]]);
    temp.db.client.prepare("UPDATE episodes SET state = 'open' WHERE id = ?").run(episodeId);
    expect(splitEpisode(temp.db, { episodeId, atMs: s(15), nowMs: s(100) })).toEqual({
      ok: false,
      reason: "missing",
    });
    temp.db.client.prepare("UPDATE episodes SET state = 'closed' WHERE id = ?").run(episodeId);
    expect(splitEpisode(temp.db, { episodeId, atMs: s(25), nowMs: s(100) })).toEqual({
      ok: false,
      reason: "outside",
    });
  });

  it("leaves a stale transcript shown but due for analysis", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [
      [10, 20],
      [40, 50],
    ]);
    close(episodeId);
    publish(episodeId, [
      segment(trackRunId, 10, 20, "avant"),
      segment(trackRunId, 40, 50, "après"),
    ]);
    // A late region arrived: the transcript no longer covers everything.
    temp.db.client
      .prepare("UPDATE episodes SET input_generation = input_generation + 1 WHERE id = ?")
      .run(episodeId);
    const split = splitEpisode(temp.db, { episodeId, atMs: s(30), nowMs: s(100) });
    if (!split.ok) throw new Error(split.reason);
    expect(texts(split.value.newEpisodeId)).toEqual(["après"]);
    expect(due().length).toBe(2);
  });
});

describe("merging episodes", () => {
  it("joins two neighbours, keeping independent voices apart", () => {
    const track = seedTrackRun(temp.db);
    const first = seedEpisode(temp.db, [[10, 20]], track);
    const second = seedEpisode(temp.db, [[60, 70]], track);
    const other = seedEpisode(temp.db, [[200, 210]], track);
    for (const id of [first.episodeId, second.episodeId, other.episodeId]) close(id);
    publish(
      first.episodeId,
      [segment(track, 10, 20, "bonjour", "S1")],
      [turn(track, 10, 20, "S1")],
    );
    publish(
      second.episodeId,
      [segment(track, 60, 70, "au revoir", "S1")],
      [turn(track, 60, 70, "S1")],
    );

    expect(
      mergeEpisodes(temp.db, {
        episodeId: first.episodeId,
        otherId: other.episodeId,
        nowMs: s(300),
      }),
    ).toEqual({ ok: false, reason: "apart" });
    const merged = mergeEpisodes(temp.db, {
      episodeId: first.episodeId,
      otherId: second.episodeId,
      nowMs: s(300),
    });
    if (!merged.ok) throw new Error(merged.reason);
    expect(texts(first.episodeId)).toEqual(["bonjour", "au revoir"]);
    expect(speakers(first.episodeId)).toHaveLength(2);
    expect(getEpisodeDetail(temp.db, second.episodeId)).toBeNull();
    expect(searchEpisodes(temp.db, "revoir", { limit: 5, offset: 0 }).episodes[0]?.episode.id).toBe(
      first.episodeId,
    );
    expect(count(temp.db, "segments_fts")).toBe(2);
  });

  it("leaves a merge with an untranscribed part due for analysis, its text shown", () => {
    const track = seedTrackRun(temp.db);
    const first = seedEpisode(temp.db, [[10, 20]], track);
    const second = seedEpisode(temp.db, [[60, 70]], track);
    for (const id of [first.episodeId, second.episodeId]) close(id);
    publish(first.episodeId, [segment(track, 10, 20, "bonjour")]);
    const merged = mergeEpisodes(temp.db, {
      episodeId: second.episodeId,
      otherId: first.episodeId,
      nowMs: s(300),
    });
    if (!merged.ok) throw new Error(merged.reason);
    expect(texts(first.episodeId)).toEqual(["bonjour"]);
    expect(due()).toEqual([expect.any(Number)]);
  });
});
