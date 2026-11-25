import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteEpisode } from "./delete-episode";
import { deletePassage } from "./delete-passage";
import {
  JOURNAL_MAX_FAILURES,
  finishJournalRun,
  journalPending,
  loadJournalItems,
  nextJournalEpisode,
  publishJournalRun,
  recoverJournalRuns,
  setJournalMark,
  startJournalRun,
  type JournalItemInput,
} from "./journal";
import { loadJournalSource } from "./journal-input";
import { JOURNAL_TRIGGERS } from "./journal-triggers";
import { publishAnalysis } from "./publish";
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
import { editSegment } from "./transcript-edits";
import { nameSpeaker } from "./people";
import { storeVoicePass } from "./voices";

const canary = "zqxjvwplonk";
const markCanary = "vbnqzrtkwyx";
const zone = "Europe/Paris";
const key = "engine@1|model@1|journal-prompt/1";
const day = { fromMs: t0 - 3_600_000, toMs: t0 + 3_600_000 };
const s = (seconds: number) => t0 + seconds * 1000;

let temp: TempDatabase;
beforeEach(() => {
  temp = tempDatabase();
});
afterEach(() => temp.cleanup());

function fileContains(path: string, needle: string): boolean {
  return existsSync(path) && readFileSync(path).includes(Buffer.from(needle));
}

/** A closed in-person conversation, 10–40 s, with a promise in its middle sentence. */
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
        segment(trackRunId, 10, 15, "on parle du budget", "A"),
        segment(trackRunId, 20, 25, `je t'envoie le devis ${canary} demain`, "B"),
        segment(trackRunId, 30, 35, "parfait merci", "A"),
      ],
      turns: [
        turn(trackRunId, 10, 15, "A"),
        turn(trackRunId, 20, 25, "B"),
        turn(trackRunId, 30, 35, "A"),
      ],
    }).published,
  ).toBe(true);
  const ids = temp.db.client
    .prepare("SELECT id FROM segments WHERE episode_id = ? ORDER BY start_ms")
    .all(episodeId)
    .map((row) => Number(row["id"]));
  return { episodeId, trackRunId, runId, segmentIds: ids };
}

/** Starts a journal pass on the episode as the queue would. */
function start(episodeId: number) {
  const source = loadJournalSource(temp.db, episodeId, zone, s(100));
  if (source === null) throw new Error("no source");
  return startJournalRun(temp.db, {
    episodeId,
    asrRunId: source.asrRunId,
    inputHash: source.inputHash,
    configKey: key,
    engineId: "engine",
    modelSha256: "sha",
    speakerRefs: { P1: "A", P2: "B" },
    nowMs: s(100),
  });
}

function items(segmentIds: readonly number[]): JournalItemInput[] {
  const [first = 0, promise = 0] = segmentIds;
  return [
    {
      kind: "event",
      text: `On a parlé du budget ${canary}`,
      whoRef: null,
      toRef: null,
      due: null,
      dueText: null,
      segmentIds: [first],
    },
    {
      kind: "commitment",
      text: "envoyer le devis",
      whoRef: "P2",
      toRef: "P1",
      due: "2026-11-03",
      dueText: "demain",
      segmentIds: [promise],
    },
  ];
}

const publish = (runId: number, list: readonly JournalItemInput[]) =>
  publishJournalRun(temp.db, { runId, items: list, metrics: {}, timeZone: zone, nowMs: s(110) });

describe("journal triggers", () => {
  it("come back at the next open when a migration rebuilt a table and dropped them", () => {
    const names = () =>
      temp.db.client
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'journal_%'")
        .all()
        .map((row) => String(row["name"]))
        .toSorted();
    expect(names()).toHaveLength(JOURNAL_TRIGGERS.length);
    temp.db.client.exec("DROP TRIGGER journal_segment_deleted");
    expect(names()).toHaveLength(JOURNAL_TRIGGERS.length - 1);
    const again = temp.reopen();
    expect(
      again.client
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'journal_%'",
        )
        .get()?.["n"],
    ).toBe(JOURNAL_TRIGGERS.length);
  });
});

describe("the journal's queue", () => {
  it("offers a transcribed conversation until its journal is published", () => {
    const { episodeId, segmentIds } = seedConversation();
    expect(nextJournalEpisode(temp.db, key)).toEqual({ episodeId, requested: false });
    expect(journalPending(temp.db, key, day)).toEqual({ pending: 1, failed: 0 });
    expect(publish(start(episodeId), items(segmentIds))).toEqual({ published: true, items: 2 });
    expect(nextJournalEpisode(temp.db, key)).toBeNull();
    // Another prompt writes it again.
    expect(nextJournalEpisode(temp.db, "other")).toEqual({ episodeId, requested: false });
  });

  it("takes a run keyed the older way, ending with the prompt's version, as current", () => {
    const { episodeId, segmentIds } = seedConversation();
    publish(start(episodeId), items(segmentIds));
    temp.db.statement("UPDATE journal_runs SET config_key = ?").run(`qwen@1|model@1|${key}`);
    expect(nextJournalEpisode(temp.db, key)).toBeNull();
    expect(nextJournalEpisode(temp.db, `other-${key}`)).toEqual({ episodeId, requested: false });
  });

  it("writes a day again when asked, whatever wrote it, until it is written after the request", () => {
    const { episodeId, segmentIds } = seedConversation();
    publish(start(episodeId), items(segmentIds));
    expect(nextJournalEpisode(temp.db, key)).toBeNull();
    // « Réécrire ce jour » after the pass started (s(100)).
    const rewrite = { ...day, rewriteBeforeMs: s(150) };
    expect(nextJournalEpisode(temp.db, key, [rewrite])).toEqual({ episodeId, requested: true });
    expect(journalPending(temp.db, key, rewrite)).toEqual({ pending: 1, failed: 0 });
    expect(journalPending(temp.db, key, day)).toEqual({ pending: 0, failed: 0 });
    // A rewrite asked before the pass started is already done.
    expect(nextJournalEpisode(temp.db, key, [{ ...day, rewriteBeforeMs: s(50) }])).toBeNull();
  });

  it("gives up on a transcript after its failures, never counting cancelled or abandoned passes", () => {
    const { episodeId } = seedConversation();
    finishJournalRun(temp.db, start(episodeId), {
      status: "cancelled",
      errorCode: "admission",
      metrics: {},
      nowMs: s(101),
    });
    start(episodeId);
    expect(recoverJournalRuns(temp.db, s(102))).toBe(1);
    for (let i = 0; i < JOURNAL_MAX_FAILURES; i += 1) {
      expect(nextJournalEpisode(temp.db, key)).not.toBeNull();
      finishJournalRun(temp.db, start(episodeId), {
        status: "failed",
        errorCode: "not-json",
        metrics: {},
        nowMs: s(103),
      });
    }
    expect(nextJournalEpisode(temp.db, key)).toBeNull();
    expect(journalPending(temp.db, key, day)).toEqual({ pending: 0, failed: 1 });
  });

  it("takes an empty journal for a transcript without words, and asks no more", () => {
    const { episodeId, runId } = seedConversation();
    temp.db.client.prepare("UPDATE segments SET text = ' ' WHERE run_id = ?").run(runId);
    const source = loadJournalSource(temp.db, episodeId, zone, s(100));
    expect(source?.input.lines).toEqual([]);
    expect(publish(start(episodeId), [])).toEqual({ published: true, items: 0 });
    expect(nextJournalEpisode(temp.db, key)).toBeNull();
  });

  it("leaves out a moment under 10 s of voice, and keeps a conversation of any length", () => {
    const { episodeId, segmentIds } = seedConversation();
    const setVoiced = (size: string, voicedMs: number) =>
      temp.db.client
        .prepare("UPDATE episodes SET size = ?, voiced_ms = ? WHERE id = ?")
        .run(size, voicedMs, episodeId);
    publish(start(episodeId), items(segmentIds));
    expect(loadJournalItems(temp.db, day)).toHaveLength(2);
    // What was written before it was left out shows no more, and is not kept up.
    setVoiced("moment", 9_999);
    expect(loadJournalItems(temp.db, day)).toEqual([]);
    expect(nextJournalEpisode(temp.db, "other")).toBeNull();
    expect(journalPending(temp.db, "other", day)).toEqual({ pending: 0, failed: 0 });
    expect(loadJournalSource(temp.db, episodeId, zone, s(100))).toBeNull();
    setVoiced("moment", 10_000);
    expect(nextJournalEpisode(temp.db, "other")?.episodeId).toBe(episodeId);
    setVoiced("conversation", 5_000);
    expect(nextJournalEpisode(temp.db, "other")?.episodeId).toBe(episodeId);
    expect(loadJournalItems(temp.db, day)).toHaveLength(2);
  });

  it("puts a day the user asked for first", () => {
    const older = seedConversation();
    const { episodeId: newer } = seedEpisode(temp.db, [[2_000, 2_030]]);
    temp.db.client
      .prepare(
        "UPDATE episodes SET size = 'moment', context = 'in_person', voiced_ms = 30000 WHERE id = ?",
      )
      .run(newer);
    const run = startRun(temp.db, newer, "asr");
    const track = Number(
      temp.db.client
        .prepare("SELECT track_run_id FROM speech_regions ORDER BY id DESC LIMIT 1")
        .get()?.["track_run_id"],
    );
    publishAnalysis(temp.db, {
      episodeId: newer,
      stage: "asr",
      runId: run,
      inputGeneration: 1,
      segments: [segment(track, 2_000, 2_010, "à plus tard", "A")],
      turns: [turn(track, 2_000, 2_010, "A")],
    });
    expect(nextJournalEpisode(temp.db, key)?.episodeId).toBe(newer);
    expect(nextJournalEpisode(temp.db, key, [{ fromMs: s(0), toMs: s(100) }])).toEqual({
      episodeId: older.episodeId,
      requested: true,
    });
  });
});

describe("publishing a journal", () => {
  it("refuses once a sentence it read was corrected, and marks a published one stale", () => {
    const { episodeId, segmentIds, runId: asrRunId } = seedConversation();
    const runId = start(episodeId);
    const [, promise = 0] = segmentIds;
    const edit = (text: string, at: number) =>
      editSegment(temp.db, { episodeId, runId: asrRunId, segmentId: promise, text, nowMs: s(at) });
    expect(edit("je ne t'envoie rien", 105)).toBe("ok");
    expect(publish(runId, items(segmentIds))).toEqual({ published: false, reason: "stale_input" });

    const second = start(episodeId);
    expect(publish(second, items(segmentIds)).published).toBe(true);
    expect(edit("je t'envoie le devis lundi", 120)).toBe("ok");
    const shown = loadJournalItems(temp.db, day);
    expect(shown).toHaveLength(2);
    expect(shown.every((item) => item.stale)).toBe(true);
    expect(nextJournalEpisode(temp.db, key)).toEqual({ episodeId, requested: false });
  });

  it("refuses a citation outside the transcript it read", () => {
    const { episodeId, segmentIds } = seedConversation();
    const list = items(segmentIds).map((item) => ({ ...item, segmentIds: [9_999] }));
    expect(publish(start(episodeId), list)).toEqual({ published: false, reason: "bad_citation" });
  });
});

/** A unit vector along `axis`, leaning a little on `lean`. */
function unit(axis: number, lean = axis + 1, amount = 0): number[] {
  const vector = Array.from({ length: 256 }, () => 0);
  vector[axis] = Math.sqrt(1 - amount * amount);
  vector[lean] = amount;
  return vector;
}

describe("the journal's voices", () => {
  it("give an unnamed voice whom Sondine takes it for, to confirm, never as its name", () => {
    const { episodeId, runId: asrRunId, segmentIds } = seedConversation();
    expect(publish(start(episodeId), items(segmentIds)).published).toBe(true);
    // Marie, named in an earlier conversation.
    const earlier = seedEpisode(temp.db, [[200, 220]]);
    temp.db.client
      .prepare("UPDATE episodes SET context = 'in_person' WHERE id = ?")
      .run(earlier.episodeId);
    const earlierRun = startRun(temp.db, earlier.episodeId, "asr");
    publishAnalysis(temp.db, {
      episodeId: earlier.episodeId,
      stage: "asr",
      runId: earlierRun,
      inputGeneration: 1,
      segments: [segment(earlier.trackRunId, 200, 220, "bonjour", "M")],
      turns: [turn(earlier.trackRunId, 200, 220, "M")],
    });
    for (const [episode, run, voices] of [
      [earlier.episodeId, earlierRun, [{ label: "M", vector: unit(0) }]],
      [
        episodeId,
        asrRunId,
        [
          { label: "A", vector: unit(0, 1, 0.3) },
          { label: "B", vector: unit(50) },
        ],
      ],
    ] as const) {
      storeVoicePass(temp.db, {
        episodeId: episode,
        runId: run,
        embedderVersion: "v",
        voices: voices.map((voice) => ({ ...voice, speechMs: 9_000 })),
        nowMs: t0,
      });
    }
    nameSpeaker(temp.db, {
      episodeId: earlier.episodeId,
      runId: earlierRun,
      label: "M",
      person: { kind: "new", name: "Marie" },
      nowMs: t0,
    });
    const [line] = loadJournalItems(temp.db, day);
    expect(line?.voices["P1"]).toMatchObject({
      name: null,
      guess: { person: { name: "Marie" }, recognized: true },
    });
    expect(line?.voices["P2"]?.guess).toBeNull();
    // In a call, the microphone voice that speaks most is « Moi », unless it reads as Marie.
    temp.db.client.prepare("UPDATE episodes SET context = 'call' WHERE id = ?").run(episodeId);
    expect(loadJournalItems(temp.db, day)[0]?.voices["P1"]).toMatchObject({
      self: false,
      guess: { person: { name: "Marie" }, recognized: true },
    });
  });
});

describe("deleting what a journal cites", () => {
  it("a passage deleted takes every line of its conversation, from the file and the WAL", () => {
    const { episodeId, segmentIds } = seedConversation();
    const runId = start(episodeId);
    expect(publish(runId, items(segmentIds)).published).toBe(true);
    temp.db.client.exec("PRAGMA wal_checkpoint(PASSIVE)");
    expect(fileContains(temp.path, canary) || fileContains(`${temp.path}-wal`, canary)).toBe(true);
    const result = deletePassage(temp.db, {
      episodeId,
      fromMs: s(20),
      toMs: s(25),
      origin: "app",
      nowMs: s(130),
    });
    expect(result.deleted).toBe(true);
    expect(count(temp.db, "journal_items")).toBe(0);
    expect(count(temp.db, "journal_citations")).toBe(0);
    expect(count(temp.db, "journal_runs")).toBe(0);
    temp.db.client.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(fileContains(temp.path, canary)).toBe(false);
    expect(fileContains(`${temp.path}-wal`, canary)).toBe(false);
    // What is left is written again.
    expect(nextJournalEpisode(temp.db, key)?.episodeId).toBe(episodeId);
  });

  it("a pass that read a sentence deleted meanwhile cannot publish", () => {
    const { episodeId, segmentIds } = seedConversation();
    const runId = start(episodeId);
    deletePassage(temp.db, { episodeId, fromMs: s(20), toMs: s(25), origin: "app", nowMs: s(105) });
    expect(publish(runId, items(segmentIds))).toEqual({ published: false, reason: "run_missing" });
  });

  it("deleting the recording deletes its journal", () => {
    const { episodeId, segmentIds } = seedConversation();
    publish(start(episodeId), items(segmentIds));
    expect(deleteEpisode(temp.db, episodeId, { origin: "app", nowMs: s(140) }).deleted).toBe(true);
    expect(count(temp.db, "journal_items")).toBe(0);
    expect(loadJournalItems(temp.db, day)).toEqual([]);
  });
});

describe("the user's marks", () => {
  it("survive a new pass that writes the same commitment again", () => {
    const { episodeId, segmentIds } = seedConversation();
    publish(start(episodeId), items(segmentIds));
    const commitment = loadJournalItems(temp.db, day).find((item) => item.kind === "commitment");
    expect(
      setJournalMark(
        temp.db,
        { itemId: commitment?.itemId ?? null, markId: null },
        { status: "done" },
        s(150),
      ),
    ).toMatchObject({ ok: true });
    // A model or prompt change writes the episode again: the mark finds the new line.
    publish(start(episodeId), items(segmentIds));
    const again = loadJournalItems(temp.db, day).find((item) => item.kind === "commitment");
    // Ids are never reused: a window holding the old one cannot mark the new one by mistake.
    expect(again?.itemId).toBeGreaterThan(commitment?.itemId ?? Infinity);
    expect(again).toMatchObject({ status: "done", text: "envoyer le devis" });
  });

  it("stand alone when the model no longer writes their line, and go back to the model's when reset", () => {
    const { episodeId, segmentIds } = seedConversation();
    publish(start(episodeId), items(segmentIds));
    const commitment = loadJournalItems(temp.db, day).find((item) => item.kind === "commitment");
    const mark = setJournalMark(
      temp.db,
      { itemId: commitment?.itemId ?? null, markId: null },
      { text: "envoyer le devis signé" },
      s(150),
    );
    expect(mark).toMatchObject({ ok: true });
    publish(
      start(episodeId),
      items(segmentIds).filter((item) => item.kind === "event"),
    );
    const alone = loadJournalItems(temp.db, day).find((item) => item.kind === "commitment");
    expect(alone).toMatchObject({ itemId: null, text: "envoyer le devis signé", edited: true });
    expect(alone?.citations.map((citation) => citation.segmentId)).toEqual([segmentIds[1]]);
    const markId = mark.ok ? mark.markId : null;
    expect(setJournalMark(temp.db, { itemId: null, markId }, { text: null }, s(160))).toEqual({
      ok: true,
      markId: null,
    });
    expect(count(temp.db, "journal_marks")).toBe(0);
  });

  it("go with a tombstone over the audio they cite, their text from the file", () => {
    const { episodeId, segmentIds } = seedConversation();
    publish(start(episodeId), items(segmentIds));
    const event = loadJournalItems(temp.db, day).find((item) => item.kind === "event");
    setJournalMark(
      temp.db,
      { itemId: event?.itemId ?? null, markId: null },
      { text: `budget ${markCanary} validé` },
      s(150),
    );
    expect(count(temp.db, "journal_marks")).toBe(1);
    deletePassage(temp.db, { episodeId, fromMs: s(10), toMs: s(15), origin: "app", nowMs: s(160) });
    expect(count(temp.db, "journal_marks")).toBe(0);
    expect(count(temp.db, "journal_mark_spans")).toBe(0);
    temp.db.client.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(fileContains(temp.path, markCanary)).toBe(false);
    expect(fileContains(`${temp.path}-wal`, markCanary)).toBe(false);
  });

  it("lose the model's words they kept when any sentence of the conversation goes, and keep the user's word", () => {
    const { episodeId, segmentIds } = seedConversation();
    const withCanary = items(segmentIds).map((item) =>
      item.kind === "commitment" ? { ...item, text: `envoyer le devis ${markCanary}` } : item,
    );
    publish(start(episodeId), withCanary);
    const commitment = loadJournalItems(temp.db, day).find((item) => item.kind === "commitment");
    setJournalMark(
      temp.db,
      { itemId: commitment?.itemId ?? null, markId: null },
      { status: "done" },
      s(150),
    );
    // The last sentence, which the commitment does not cite.
    deletePassage(temp.db, { episodeId, fromMs: s(30), toMs: s(35), origin: "app", nowMs: s(160) });
    expect(count(temp.db, "journal_marks")).toBe(1);
    temp.db.client.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(fileContains(temp.path, markCanary)).toBe(false);
    expect(fileContains(`${temp.path}-wal`, markCanary)).toBe(false);
    // Nothing to show until the journal is written again; then the one commitment there takes it.
    expect(loadJournalItems(temp.db, day)).toEqual([]);
    publish(start(episodeId), items(segmentIds));
    expect(loadJournalItems(temp.db, day).find((item) => item.kind === "commitment")).toMatchObject(
      {
        status: "done",
      },
    );
  });

  it("go to the line's mark on a second word, and refuse a mark the line no longer holds", () => {
    const { episodeId, segmentIds } = seedConversation();
    publish(start(episodeId), items(segmentIds));
    const commitment = loadJournalItems(temp.db, day).find((item) => item.kind === "commitment");
    const target = { itemId: commitment?.itemId ?? null, markId: null };
    const first = setJournalMark(temp.db, target, { status: "done" }, s(150));
    // A second window still holding the line without its mark.
    const second = setJournalMark(temp.db, target, { text: "envoyer le devis signé" }, s(151));
    expect(second).toEqual(first);
    expect(count(temp.db, "journal_marks")).toBe(1);
    // Written again without that commitment: the old line and its mark no longer go together.
    publish(
      start(episodeId),
      items(segmentIds).filter((item) => item.kind === "event"),
    );
    const markId = first.ok ? first.markId : null;
    expect(
      setJournalMark(
        temp.db,
        { itemId: commitment?.itemId ?? null, markId },
        { status: "open" },
        s(160),
      ),
    ).toEqual({ ok: false, reason: "item_missing" });
  });

  it("refuse an item deleted since the window showed it", () => {
    const { episodeId, segmentIds } = seedConversation();
    publish(start(episodeId), items(segmentIds));
    const [item] = loadJournalItems(temp.db, day);
    deletePassage(temp.db, { episodeId, fromMs: s(10), toMs: s(25), origin: "app", nowMs: s(160) });
    expect(
      setJournalMark(
        temp.db,
        { itemId: item?.itemId ?? null, markId: null },
        { status: "dismissed" },
        s(170),
      ),
    ).toEqual({ ok: false, reason: "item_missing" });
  });
});
