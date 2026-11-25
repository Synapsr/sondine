import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteEpisode } from "./delete-episode";
import { splitEpisode } from "./episode-boundaries";
import { getEpisodeDetail } from "./episodes-store";
import { publishAnalysis, type SegmentInput } from "./publish";
import { searchEpisodes } from "./search";
import {
  count,
  seedEpisode,
  segment,
  startRun,
  t0,
  tempDatabase,
  type TempDatabase,
} from "./test-helpers";
import { editSegment, restoreSegment } from "./transcript-edits";

let temp: TempDatabase;
beforeEach(() => {
  temp = tempDatabase();
});
afterEach(() => temp.cleanup());

function publish(episodeId: number, segments: readonly SegmentInput[], generation = 1): number {
  const runId = startRun(temp.db, episodeId, "asr", generation);
  const result = publishAnalysis(temp.db, {
    episodeId,
    stage: "asr",
    runId,
    inputGeneration: generation,
    segments,
    turns: [],
  });
  expect(result.published).toBe(true);
  return runId;
}

/** A new transcript of the same audio: the episode's input moved on. */
function reanalyse(episodeId: number, segments: readonly SegmentInput[]): number {
  temp.db.client.prepare("UPDATE episodes SET input_generation = 2 WHERE id = ?").run(episodeId);
  return publish(episodeId, segments, 2);
}

const texts = (episodeId: number) =>
  getEpisodeDetail(temp.db, episodeId)?.segments.map((s) => [s.text, s.edited]) ?? [];

/** A segment whose words are spread evenly over [start, end] seconds. */
function timed(trackRunId: number, start: number, end: number, text: string, label = "S1") {
  const base = segment(trackRunId, start, end, text, label);
  const tokens = [...text.matchAll(/\S+/gu)];
  const step = ((end - start) * 1000) / tokens.length;
  return {
    ...base,
    words: tokens.map((token, index) => ({
      charStart: token.index,
      charEnd: token.index + token[0].length,
      startMs: Math.round(index * step),
      endMs: Math.round((index + 1) * step),
    })),
  };
}

const found = (text: string) => searchEpisodes(temp.db, text, { limit: 5, offset: 0 }).total;

describe("transcript edits", () => {
  it("corrects a segment, for search too, and restores the engine's text", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 30]]);
    const runId = publish(episodeId, [
      segment(trackRunId, 10, 15, "On parle du budjet"),
      segment(trackRunId, 15, 20, "et de la suite"),
    ]);
    const first = getEpisodeDetail(temp.db, episodeId)?.segments[0]?.id ?? 0;
    const edit = { episodeId, runId, segmentId: first, nowMs: t0 + 1 };

    expect(editSegment(temp.db, { ...edit, text: "  On parle du budget " })).toBe("ok");
    expect(texts(episodeId)).toEqual([
      ["On parle du budget", true],
      ["et de la suite", false],
    ]);
    expect(found("budget")).toBe(1);
    // The engine's spelling is no longer in the index (search by sound still finds « budget »).
    expect(count(temp.db, "segments_vocab", "term = 'budjet'")).toBe(0);
    expect(count(temp.db, "user_assertions", "kind = 'transcript_edit'")).toBe(1);

    // A second correction replaces the first; the engine's text stays the original.
    expect(editSegment(temp.db, { ...edit, text: "On parle du budget 2027" })).toBe("ok");
    expect(count(temp.db, "user_assertions", "kind = 'transcript_edit'")).toBe(1);

    expect(restoreSegment(temp.db, edit)).toBe("ok");
    expect(texts(episodeId)[0]).toEqual(["On parle du budjet", false]);
    expect(found("budjet")).toBe(1);
    expect(count(temp.db, "user_assertions", "kind = 'transcript_edit'")).toBe(0);

    // Typing the engine's text back is a restore.
    editSegment(temp.db, { ...edit, text: "On parle du budget" });
    expect(editSegment(temp.db, { ...edit, text: "On parle du budjet" })).toBe("ok");
    expect(count(temp.db, "user_assertions", "kind = 'transcript_edit'")).toBe(0);

    expect(editSegment(temp.db, { ...edit, runId: runId + 1, text: "x" })).toBe("stale");
    expect(editSegment(temp.db, { ...edit, segmentId: 999, text: "x" })).toBe("missing");
  });

  it("outlives a new transcript that cuts the stretch differently", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 30]]);
    const runId = publish(episodeId, [
      segment(trackRunId, 10, 16, "Marie a dit oui"),
      segment(trackRunId, 16, 20, "puis non"),
    ]);
    const first = getEpisodeDetail(temp.db, episodeId)?.segments[0]?.id ?? 0;
    editSegment(temp.db, { episodeId, runId, segmentId: first, nowMs: t0, text: "Mari a dit oui" });

    reanalyse(episodeId, [
      segment(trackRunId, 10, 13, "Marie a"),
      segment(trackRunId, 13, 16.5, "dit oui"),
      segment(trackRunId, 16.5, 20, "puis non"),
    ]);
    expect(texts(episodeId)).toEqual([
      ["Mari a dit oui", true],
      ["puis non", false],
    ]);
    const merged = getEpisodeDetail(temp.db, episodeId)?.segments[0];
    expect([merged?.startMs, merged?.endMs]).toEqual([t0 + 10_000, t0 + 16_500]);
  });

  it("replaces only the words it corrected when a new segment reaches past it", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 40]]);
    const runId = publish(episodeId, [
      timed(trackRunId, 10, 14, "le budjet"),
      timed(trackRunId, 14, 18, "de Marie"),
      timed(trackRunId, 18, 22, "est prêt"),
    ]);
    const [first, second] = getEpisodeDetail(temp.db, episodeId)?.segments ?? [];
    const base = { episodeId, runId, nowMs: t0 };
    editSegment(temp.db, { ...base, segmentId: first?.id ?? 0, text: "le budget" });
    editSegment(temp.db, { ...base, segmentId: second?.id ?? 0, text: "de Mary" });
    // One segment now holds all three stretches.
    reanalyse(episodeId, [timed(trackRunId, 10, 22, "le budjet de Marie est prêt")]);
    expect(texts(episodeId)).toEqual([
      ["le budget", true],
      ["de Mary", true],
      ["est prêt", false],
    ]);
    expect(getEpisodeDetail(temp.db, episodeId)?.segments.map((s) => s.startMs - t0)).toEqual([
      10_000, 14_000, 18_000,
    ]);
  });

  it("stays with its voice where two voices overlap on one track", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 30]]);
    const runId = publish(episodeId, [
      segment(trackRunId, 10, 20, "je pense que le projet avance", "S1"),
      segment(trackRunId, 12, 18, "oui tout à fait", "S2"),
    ]);
    const [, second] = getEpisodeDetail(temp.db, episodeId)?.segments ?? [];
    editSegment(temp.db, {
      episodeId,
      runId,
      segmentId: second?.id ?? 0,
      nowMs: t0,
      text: "oui, tout à fait",
    });
    reanalyse(episodeId, [
      segment(trackRunId, 10, 20, "je pense que le projet avance", "S1"),
      segment(trackRunId, 12.5, 18, "oui tout a fait", "S2"),
    ]);
    expect(texts(episodeId)).toEqual([
      ["je pense que le projet avance", false],
      ["oui, tout à fait", true],
    ]);
  });

  it("leaves with the recording when it is deleted", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 30]]);
    const runId = publish(episodeId, [segment(trackRunId, 10, 15, "un secret")]);
    const id = getEpisodeDetail(temp.db, episodeId)?.segments[0]?.id ?? 0;
    editSegment(temp.db, { episodeId, runId, segmentId: id, nowMs: t0, text: "un vrai secret" });
    expect(deleteEpisode(temp.db, episodeId, { origin: "app" }).deleted).toBe(true);
    expect(count(temp.db, "user_assertions")).toBe(0);
    expect(count(temp.db, "segments")).toBe(0);
  });
});

/** A closed in-person conversation of 30 s. */
const conversation = (start: number, trackRunId?: number) => {
  const seeded = seedEpisode(temp.db, [[start, start + 30]], trackRunId);
  temp.db.client
    .prepare("UPDATE episodes SET context = 'in_person' WHERE id = ?")
    .run(seeded.episodeId);
  return seeded;
};

const plain = (episodeId: number) => texts(episodeId).map(([text]) => text);

/** The user corrects « Kamille » to « Camille » in the middle of a sentence. */
function teach(wrong: string, right: string) {
  const { episodeId, trackRunId } = conversation(10);
  const runId = publish(episodeId, [segment(trackRunId, 10, 15, `je crois que ${wrong} arrive`)]);
  const first = getEpisodeDetail(temp.db, episodeId)?.segments[0]?.id ?? 0;
  editSegment(temp.db, {
    episodeId,
    runId,
    segmentId: first,
    nowMs: t0 + 1,
    text: `je crois que ${right} arrive`,
  });
  return trackRunId;
}

describe("personal vocabulary at publish", () => {
  it("spells a corrected name in a new transcript, and keeps what was heard once restored", () => {
    const trackRunId = teach("Kamille", "Camille");
    const later = conversation(100, trackRunId);
    const laterRun = publish(later.episodeId, [segment(trackRunId, 100, 105, "Kamille a appelé")]);
    expect(texts(later.episodeId)).toEqual([["Camille a appelé", true]]);
    const segmentId = getEpisodeDetail(temp.db, later.episodeId)?.segments[0]?.id ?? 0;
    expect(
      restoreSegment(temp.db, {
        episodeId: later.episodeId,
        runId: laterRun,
        segmentId,
        nowMs: t0 + 2,
      }),
    ).toBe("ok");
    expect(plain(later.episodeId)).toEqual(["Kamille a appelé"]);
    // The same audio transcribed again is not respelled.
    publish(later.episodeId, [segment(trackRunId, 100, 105, "Kamille a appelé")]);
    expect(plain(later.episodeId)).toEqual(["Kamille a appelé"]);
  });

  it("keeps word timings on the engine's text, so a split cuts a respelled sentence right", () => {
    const trackRunId = teach("Filip", "Philippe");
    const later = conversation(100, trackRunId);
    temp.db.client
      .prepare("UPDATE episodes SET state = 'closed' WHERE id = ?")
      .run(later.episodeId);
    const text = "Filip arrive demain";
    const tokens = [...text.matchAll(/\S+/gu)];
    publish(later.episodeId, [
      {
        ...segment(trackRunId, 100, 112, text),
        words: tokens.map((token, index) => ({
          charStart: token.index,
          charEnd: token.index + token[0].length,
          startMs: index * 4_000,
          endMs: (index + 1) * 4_000,
        })),
      },
    ]);
    expect(plain(later.episodeId)).toEqual(["Philippe arrive demain"]);
    const split = splitEpisode(temp.db, {
      episodeId: later.episodeId,
      atMs: t0 + 104_000,
      nowMs: t0 + 5,
    });
    if (!split.ok) throw new Error(split.reason);
    expect(plain(later.episodeId)).toEqual(["Philippe"]);
    expect(plain(split.value.newEpisodeId)).toEqual(["arrive demain"]);
  });

  it("leaves media alone", () => {
    const trackRunId = teach("Kamille", "Camille");
    const video = seedEpisode(temp.db, [[100, 110]], trackRunId);
    temp.db.client
      .prepare("UPDATE episodes SET context = 'media' WHERE id = ?")
      .run(video.episodeId);
    publish(video.episodeId, [segment(trackRunId, 100, 105, "Kamille chante")]);
    expect(texts(video.episodeId)).toEqual([["Kamille chante", false]]);
  });
});
