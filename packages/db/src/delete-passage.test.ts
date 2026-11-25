import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deletePassage } from "./delete-passage";
import { getEpisodeDetail } from "./episodes-store";
import { enqueueMissingAnalysis } from "./jobs";
import { nameSpeaker, resolveSpeakers } from "./people";
import { currentRunId, publishAnalysis } from "./publish";
import { checkSearchIndex, searchSegments } from "./search";
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
import { storeVoicePass } from "./voices";

const canary = "zqxjvwplonk";

let temp: TempDatabase;
beforeEach(() => {
  temp = tempDatabase();
});
afterEach(() => temp.cleanup());

const s = (seconds: number) => t0 + seconds * 1000;

function fileContains(path: string, needle: string): boolean {
  return existsSync(path) && readFileSync(path).includes(Buffer.from(needle));
}

/** A closed conversation at 10–40 s: A, then B with the canary, then A again. */
function seedConversation() {
  const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 40]]);
  temp.db.client
    .prepare("UPDATE episodes SET size = 'conversation', context = 'in_person' WHERE id = ?")
    .run(episodeId);
  const runId = startRun(temp.db, episodeId, "asr");
  expect(
    publishAnalysis(temp.db, {
      episodeId,
      stage: "asr",
      runId,
      inputGeneration: 1,
      segments: [
        segment(trackRunId, 10, 15, "bonjour à tous", "A"),
        segment(trackRunId, 20, 25, `le code est ${canary}`, "B"),
        segment(trackRunId, 30, 35, "on passe au budget", "A"),
      ],
      turns: [
        turn(trackRunId, 10, 15, "A"),
        turn(trackRunId, 20, 25, "B"),
        turn(trackRunId, 30, 35, "A"),
      ],
    }).published,
  ).toBe(true);
  return { episodeId, trackRunId, runId };
}

const texts = (episodeId: number) =>
  getEpisodeDetail(temp.db, episodeId)?.segments.map((x) => x.text) ?? [];
const passage = (episodeId: number, from: number, to: number) =>
  deletePassage(temp.db, { episodeId, fromMs: s(from), toMs: s(to), origin: "app", nowMs: s(100) });

describe("deletePassage", () => {
  it("erases the sentences, their voice and their text from the file and the WAL, and keeps the rest current", () => {
    const { episodeId } = seedConversation();
    temp.db.client.exec("PRAGMA wal_checkpoint(PASSIVE)");
    expect(fileContains(temp.path, canary) || fileContains(`${temp.path}-wal`, canary)).toBe(true);

    expect(passage(episodeId, 20, 25)).toMatchObject({
      deleted: true,
      episodeDeleted: false,
      segmentCount: 1,
    });
    expect(texts(episodeId)).toEqual(["bonjour à tous", "on passe au budget"]);
    // B spoke only there: one voice left.
    expect(getEpisodeDetail(temp.db, episodeId)?.speakers.map((x) => x.label)).toEqual(["A"]);
    expect(searchSegments(temp.db, canary)).toEqual([]);
    expect(() => checkSearchIndex(temp.db)).not.toThrow();
    expect(fileContains(temp.path, canary)).toBe(false);
    expect(fileContains(`${temp.path}-wal`, canary)).toBe(false);
    // Nothing waits for a new transcription.
    expect(enqueueMissingAnalysis(temp.db, s(200))).toEqual([]);
    expect(count(temp.db, "deleted_ranges")).toBe(1);
  });

  it("refuses a late transcript that brings the passage back", () => {
    const { episodeId, trackRunId } = seedConversation();
    passage(episodeId, 20, 25);
    const late = startRun(temp.db, episodeId, "asr");
    const result = publishAnalysis(temp.db, {
      episodeId,
      stage: "asr",
      runId: late,
      inputGeneration: 1,
      segments: [segment(trackRunId, 20, 25, `le code est ${canary}`, "B")],
      turns: [],
    });
    expect(result.published).toBe(false);
  });

  it("takes the corrections of the sentences it erases, and keeps the others and the names", () => {
    const { episodeId } = seedConversation();
    const runId = currentRunId(temp.db, episodeId, "asr") ?? 0;
    const [first, second] = getEpisodeDetail(temp.db, episodeId)?.segments ?? [];
    const edit = (segmentId: number, text: string) =>
      editSegment(temp.db, { episodeId, runId, segmentId, nowMs: s(50), text });
    expect(edit(first?.id ?? 0, "bonjour à toutes")).toBe("ok");
    expect(edit(second?.id ?? 0, `secret ${canary}`)).toBe("ok");
    const named = nameSpeaker(temp.db, {
      episodeId,
      runId,
      label: "A",
      person: { kind: "new", name: "Marie" },
      nowMs: s(60),
    });
    if (!named.ok) throw new Error(named.reason);

    passage(episodeId, 20, 25);
    expect(texts(episodeId)).toEqual(["bonjour à toutes", "on passe au budget"]);
    expect(count(temp.db, "user_assertions", "kind = 'transcript_edit'")).toBe(1);
    const current = currentRunId(temp.db, episodeId, "asr") ?? 0;
    expect(resolveSpeakers(temp.db, current).get("A")?.name).toBe("Marie");
  });

  it("moves the start when the passage opens the episode", () => {
    const { episodeId } = seedConversation();
    passage(episodeId, 10, 15);
    const detail = getEpisodeDetail(temp.db, episodeId);
    expect(detail?.episode.startedAtMs).toBe(s(15));
    expect(texts(episodeId)).toEqual([`le code est ${canary}`, "on passe au budget"]);
  });

  it("deletes the episode whole when nothing said is left", () => {
    const { episodeId } = seedConversation();
    expect(passage(episodeId, 10, 35)).toMatchObject({ deleted: true, episodeDeleted: true });
    expect(getEpisodeDetail(temp.db, episodeId)).toBeNull();
    expect(searchSegments(temp.db, "budget")).toEqual([]);
  });

  it("erases what was said between two regions, and the roll at their edges", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [
      [10, 15],
      [25, 30],
    ]);
    const runId = startRun(temp.db, episodeId, "asr");
    publishAnalysis(temp.db, {
      episodeId,
      stage: "asr",
      runId,
      inputGeneration: 1,
      segments: [
        segment(trackRunId, 10, 12, "avant", "A"),
        segment(trackRunId, 20, 21, `entre ${canary}`, "A"),
        segment(trackRunId, 28, 30, "après", "A"),
      ],
      turns: [],
    });
    expect(passage(episodeId, 12, 27)).toMatchObject({ deleted: true, episodeDeleted: false });
    expect(texts(episodeId)).toEqual(["avant", "après"]);
    expect(searchSegments(temp.db, canary)).toEqual([]);
  });

  it("deletes a sentence heard in a region's roll", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 20]]);
    const runId = startRun(temp.db, episodeId, "asr");
    publishAnalysis(temp.db, {
      episodeId,
      stage: "asr",
      runId,
      inputGeneration: 1,
      segments: [
        segment(trackRunId, 8.8, 9.5, "euh", "A"),
        segment(trackRunId, 10, 20, "bonjour", "A"),
      ],
      turns: [],
    });
    expect(passage(episodeId, 8.8, 9.5)).toMatchObject({ deleted: true, episodeDeleted: false });
    expect(texts(episodeId)).toEqual(["bonjour"]);
  });

  it("refuses a job that read the audio before the deletion, even for the text left", () => {
    const { episodeId, trackRunId } = seedConversation();
    const late = startRun(temp.db, episodeId, "asr");
    passage(episodeId, 20, 25);
    const result = publishAnalysis(temp.db, {
      episodeId,
      stage: "asr",
      runId: late,
      inputGeneration: 1,
      segments: [segment(trackRunId, 10, 15, "bonjour à tous", "A")],
      turns: [],
    });
    expect(result.published).toBe(false);
    expect(texts(episodeId)).toEqual(["bonjour à tous", "on passe au budget"]);
  });

  it("takes the passage out of another episode that heard it, voices included", () => {
    const track = seedTrackRun(temp.db);
    const first = seedEpisode(temp.db, [[10, 30]], track);
    const second = seedEpisode(temp.db, [[31, 40]], track);
    const publishOne = (episodeId: number, segments: ReturnType<typeof segment>[]) => {
      const runId = startRun(temp.db, episodeId, "asr");
      publishAnalysis(temp.db, {
        episodeId,
        stage: "asr",
        runId,
        inputGeneration: 1,
        segments,
        turns: [],
      });
      return runId;
    };
    publishOne(first.episodeId, [
      segment(track, 10, 20, "début", "A"),
      segment(track, 22, 30, "fin", "A"),
    ]);
    // The later episode's transcript reaches back into the first one's audio.
    const otherRun = publishOne(second.episodeId, [
      segment(track, 28, 33, `retour ${canary}`, "B"),
      segment(track, 34, 40, "suite", "B"),
    ]);
    storeVoicePass(temp.db, {
      episodeId: second.episodeId,
      runId: otherRun,
      embedderVersion: "v",
      voices: [
        {
          label: "B",
          vector: Array.from({ length: 256 }, (_, i) => (i === 0 ? 1 : 0)),
          speechMs: 9_000,
        },
      ],
      nowMs: t0,
    });
    expect(count(temp.db, "speaker_embeddings")).toBe(1);

    passage(first.episodeId, 22, 30);
    expect(texts(first.episodeId)).toEqual(["début"]);
    expect(texts(second.episodeId)).toEqual(["suite"]);
    expect(count(temp.db, "speaker_embeddings")).toBe(0);
    expect(currentRunId(temp.db, second.episodeId, "asr")).not.toBe(otherRun);
  });

  it("keeps the rest of a live transcript", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 40]]);
    const runId = startRun(temp.db, episodeId, "asr_live");
    publishAnalysis(temp.db, {
      episodeId,
      stage: "asr_live",
      runId,
      inputGeneration: 1,
      segments: [
        segment(trackRunId, 10, 15, "un", "A"),
        segment(trackRunId, 20, 25, "deux", "A"),
        segment(trackRunId, 30, 35, "trois", "A"),
      ],
      turns: [],
    });
    expect(passage(episodeId, 20, 25)).toMatchObject({ deleted: true, episodeDeleted: false });
    expect(texts(episodeId)).toEqual(["un", "trois"]);
  });

  it("counts no erased speech in the voiced time", () => {
    const { episodeId } = seedConversation();
    passage(episodeId, 20, 25);
    // 30 s of speech, 5 s of it erased.
    expect(
      temp.db.client.prepare("SELECT voiced_ms FROM episodes WHERE id = ?").get(episodeId),
    ).toEqual({ voiced_ms: 25_000 });
  });

  it("keeps a recording whose live transcript has not heard the rest yet", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 600]]);
    const runId = startRun(temp.db, episodeId, "asr_live");
    publishAnalysis(temp.db, {
      episodeId,
      stage: "asr_live",
      runId,
      inputGeneration: 1,
      segments: [segment(trackRunId, 10, 15, "seule phrase", "A")],
      turns: [],
    });
    expect(passage(episodeId, 10, 15)).toMatchObject({ deleted: true, episodeDeleted: false });
    expect(getEpisodeDetail(temp.db, episodeId)?.episode.startedAtMs).toBe(s(15));
  });

  it("counts every passage deleted out of the voiced time", () => {
    const { episodeId } = seedConversation();
    passage(episodeId, 15, 20);
    passage(episodeId, 25, 30);
    expect(
      temp.db.client.prepare("SELECT voiced_ms FROM episodes WHERE id = ?").get(episodeId),
    ).toEqual({ voiced_ms: 20_000 });
  });

  it("moves on a neighbour whose roll held the passage, so nothing reads its old audio", () => {
    const track = seedTrackRun(temp.db);
    const first = seedEpisode(temp.db, [[10, 20]], track);
    const second = seedEpisode(temp.db, [[21, 30]], track);
    const runId = startRun(temp.db, first.episodeId, "asr");
    publishAnalysis(temp.db, {
      episodeId: first.episodeId,
      stage: "asr",
      runId,
      inputGeneration: 1,
      segments: [segment(track, 10, 17, "début", "A"), segment(track, 18, 20, "fin", "A")],
      turns: [],
    });
    passage(first.episodeId, 18, 20);
    expect(
      temp.db.client
        .prepare("SELECT input_generation FROM episodes WHERE id = ?")
        .get(second.episodeId),
    ).toEqual({ input_generation: 2 });
  });

  it("refuses an open episode and a passage outside it", () => {
    const { episodeId } = seedConversation();
    expect(passage(episodeId, 50, 60)).toEqual({ deleted: false, reason: "outside" });
    temp.db.client.prepare("UPDATE episodes SET state = 'open' WHERE id = ?").run(episodeId);
    expect(passage(episodeId, 20, 25)).toEqual({ deleted: false, reason: "missing" });
  });
});
