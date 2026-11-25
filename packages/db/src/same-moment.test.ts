import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importRecording, type ImportedChunk } from "./audio-import";
import { deleteEpisode } from "./delete-episode";
import { getEpisodeDetail } from "./episodes-store";
import { deletePassage } from "./delete-passage";
import { setEpisodeKind } from "./episode-kind";
import { loadJournalItems, publishJournalRun, setJournalMark, startJournalRun } from "./journal";
import { loadJournalSource } from "./journal-input";
import { publishAnalysis } from "./publish";
import {
  nextSameMomentPair,
  pruneSameMoments,
  recordSameMoment,
  sameMomentsOf,
  setSameMomentSource,
  type SameMomentPair,
  type SameMomentResult,
} from "./same-moment";
import {
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

// A meeting both the Mac and the phone heard (ADR 032, M5.7): the pair the
// clocks propose, the link stored, one source for the journal, and what a
// deletion of either leaves.

let temp: TempDatabase;
beforeEach(() => {
  temp = tempDatabase();
});
afterEach(() => temp.cleanup());

const METHOD = "envelope-xcorr/1";
const zone = "Europe/Paris";
const key = "journal-prompt/2";
const day = { fromMs: t0 - 3_600_000, toMs: t0 + 3_600_000 };
const s = (seconds: number) => t0 + seconds * 1000;

/** The Mac's conversation: 10–70 s of its microphone, transcribed. */
function macConversation() {
  const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 70]]);
  temp.db.client
    .prepare("UPDATE episodes SET size = 'conversation', context = 'in_person' WHERE id = ?")
    .run(episodeId);
  publish(episodeId, trackRunId, [
    [12, 15, "on commence par le budget"],
    [40, 45, "je t'envoie le devis demain"],
    [65, 68, "merci à tous"],
  ]);
  return { episodeId, trackRunId };
}

/** The phone's recording of the same meeting: 0–90 s of its own clock (t0 + 5 s), transcribed. */
function phoneRecording(startSeconds = 5, seconds = 90) {
  const blocks: ImportedChunk[] = [];
  for (let start = 0; start < seconds * rate; start += 2 * rate) {
    blocks.push({
      sampleStart: start,
      sampleCount: Math.min(2 * rate, seconds * rate - start),
      byteOffset: start * 2,
      crc32: 0,
    });
  }
  const { episodeId, trackRunId } = importRecording(temp.db, {
    uid: "phone-file",
    fileName: "phone.m4a",
    sampleRate: rate,
    sampleCount: seconds * rate,
    startedWallMs: s(startSeconds),
    archiveRelPath: "archive/imports/phone-file/0001.pcm",
    spoolRelPath: "spool/imports/phone-file/0001.pcm",
    chunks: blocks,
    nowMs: s(3_600),
    phone: {
      recordingId: "7f9c2b1e-4d3a-4c8e-9b6f-1a2b3c4d5e6f",
      deviceId: "c3d4e5f6-0718-4293-a4b5-c6d7e8f90a1b",
      sha256: "a".repeat(64),
      timeUncertain: false,
    },
  });
  temp.db.client.prepare("UPDATE episodes SET size = 'conversation' WHERE id = ?").run(episodeId);
  // Its segments are on its own run, its sample 0 at t0 + 5 s.
  publish(
    episodeId,
    trackRunId,
    [
      [10, 13, "on commence par le budget"],
      [35, 40, "je t'envoie le devis demain"],
      [60, 63, "merci à tous"],
      [80, 85, "et on range la salle"],
    ],
    startSeconds,
  );
  return { episodeId, trackRunId };
}

function publish(
  episodeId: number,
  trackRunId: number,
  lines: readonly (readonly [number, number, string])[],
  wallShiftSeconds = 0,
) {
  const runId = startRun(temp.db, episodeId, "asr");
  const shift = <T extends { readonly startMs: number; readonly endMs: number }>(value: T): T => ({
    ...value,
    startMs: value.startMs + wallShiftSeconds * 1000,
    endMs: value.endMs + wallShiftSeconds * 1000,
  });
  expect(
    publishAnalysis(temp.db, {
      episodeId,
      stage: "asr",
      runId,
      inputGeneration: 1,
      segments: lines.map(([from, to, text]) => shift(segment(trackRunId, from, to, text, "A"))),
      turns: lines.map(([from, to]) => shift(turn(trackRunId, from, to, "A"))),
    }).published,
  ).toBe(true);
}

/** Writes an episode's journal as a model would: one line per sentence it reads. */
function writeJournal(episodeId: number, commitment?: string): number {
  const source = loadJournalSource(temp.db, episodeId, zone, s(4_000));
  if (source === null) throw new Error("not journaled");
  const runId = startJournalRun(temp.db, {
    episodeId,
    asrRunId: source.asrRunId,
    inputHash: source.inputHash,
    configKey: key,
    engineId: "qwen",
    modelSha256: null,
    speakerRefs: {},
    nowMs: s(4_000),
  });
  const result = publishJournalRun(temp.db, {
    runId,
    items: source.input.lines.map((line) => ({
      kind: commitment !== undefined && line.text.includes(commitment) ? "commitment" : "event",
      text: line.text,
      whoRef: null,
      toRef: null,
      due: null,
      dueText: null,
      segmentIds: [line.segmentId],
    })),
    metrics: {},
    timeZone: zone,
    nowMs: s(4_000),
  });
  expect(result.published).toBe(true);
  return source.input.lines.length;
}

const journalTexts = () =>
  loadJournalItems(temp.db, day)
    .map((item) => item.text)
    .toSorted();

/** What the detector found for the pair: the phone's clock 2.3 s behind the Mac's. */
const linked = (
  pair: SameMomentPair,
  clarity = { phone: 30, mac: 20 },
): Extract<SameMomentResult, { linked: true }> => ({
  linked: true,
  offsetMs: -2_300,
  driftPpm: 12,
  anchorMs: s(50),
  score: 0.8,
  sharedFromMs: Math.max(pair.mac.startedAtMs, pair.phone.startedAtMs - 2_300),
  sharedToMs: Math.min(pair.mac.endedAtMs, pair.phone.endedAtMs - 2_300),
  clarity,
  measure: { peak: 0.85 },
});

function pairOf(): SameMomentPair {
  const pair = nextSameMomentPair(temp.db, METHOD);
  if (pair === null) throw new Error("no pair proposed");
  return pair;
}

describe("the pair the clocks propose", () => {
  it("proposes a Mac conversation overlapping a phone recording, once per generation", () => {
    const mac = macConversation();
    const phone = phoneRecording();
    const pair = pairOf();
    expect(pair).toMatchObject({
      phone: { episodeId: phone.episodeId, generation: 1 },
      mac: { episodeId: mac.episodeId, generation: 1 },
      searchMs: 120_000,
    });
    expect(
      recordSameMoment(temp.db, {
        pair,
        method: METHOD,
        result: { linked: false, measure: { peak: 0.1 } },
        nowMs: s(4_000),
      }),
    ).toBe(true);
    expect(nextSameMomentPair(temp.db, METHOD)).toBeNull();
    // Another method, or a changed episode, compares again.
    expect(nextSameMomentPair(temp.db, "envelope-xcorr/2")).not.toBeNull();
    temp.db.client
      .prepare("UPDATE episodes SET input_generation = 2 WHERE id = ?")
      .run(mac.episodeId);
    expect(pairOf().mac.generation).toBe(2);
  });

  it("refuses a comparison made on generations that changed meanwhile", () => {
    const mac = macConversation();
    phoneRecording();
    const pair = pairOf();
    temp.db.client
      .prepare("UPDATE episodes SET input_generation = 2 WHERE id = ?")
      .run(mac.episodeId);
    expect(
      recordSameMoment(temp.db, { pair, method: METHOD, result: linked(pair), nowMs: s(4_000) }),
    ).toBe(false);
    expect(count(temp.db, "same_moment_links")).toBe(0);
  });

  it("proposes nothing beyond the search, nor media", () => {
    const mac = macConversation();
    phoneRecording(400);
    expect(nextSameMomentPair(temp.db, METHOD)).toBeNull();
    // Media the Mac played is not a conversation of the day.
    const media = seedEpisode(temp.db, [[330, 420]]);
    temp.db.client
      .prepare("UPDATE episodes SET context = 'media' WHERE id = ?")
      .run(media.episodeId);
    expect(nextSameMomentPair(temp.db, METHOD)).toBeNull();
    expect(mac.episodeId).toBeGreaterThan(0);
  });

  it("forgets the comparison of a pair the clocks no longer propose", () => {
    const mac = macConversation();
    phoneRecording();
    const pair = pairOf();
    recordSameMoment(temp.db, { pair, method: METHOD, result: linked(pair), nowMs: s(4_000) });
    expect(pruneSameMoments(temp.db)).toBe(0);
    // Retention taking the audio keeps the link: the text, and the journal, stay.
    temp.db.client
      .prepare("UPDATE episodes SET audio_gone_at_ms = ? WHERE id = ?")
      .run(s(5_000), mac.episodeId);
    expect(pruneSameMoments(temp.db)).toBe(0);
    expect(nextSameMomentPair(temp.db, METHOD)).toBeNull();
    temp.db.client.prepare("UPDATE episodes SET context = 'media' WHERE id = ?").run(mac.episodeId);
    expect(pruneSameMoments(temp.db)).toBe(1);
    expect(count(temp.db, "same_moment_links")).toBe(0);
  });
});

describe("one source for the journal", () => {
  it("writes the shared time once, from the clearer recording", () => {
    const mac = macConversation();
    const phone = phoneRecording();
    // Both written before the phone arrived: every line twice.
    writeJournal(mac.episodeId);
    writeJournal(phone.episodeId);
    expect(journalTexts()).toHaveLength(7);

    const pair = pairOf();
    recordSameMoment(temp.db, { pair, method: METHOD, result: linked(pair), nowMs: s(4_000) });
    // The phone is clearer: the Mac's journal goes, and is written again without the shared time.
    expect(count(temp.db, "journal_runs", `episode_id = ${mac.episodeId}`)).toBe(0);
    expect(count(temp.db, "journal_runs", `episode_id = ${phone.episodeId}`)).toBe(1);
    expect(writeJournal(mac.episodeId)).toBe(0);
    const texts = journalTexts();
    expect(texts).toEqual(
      [
        "on commence par le budget",
        "je t'envoie le devis demain",
        "merci à tous",
        "et on range la salle",
      ].toSorted(),
    );
    expect(new Set(texts).size).toBe(texts.length);

    // Each says the other recorded it too, on its own clock.
    const [fromPhone] = sameMomentsOf(temp.db, phone.episodeId);
    const [fromMac] = sameMomentsOf(temp.db, mac.episodeId);
    expect(fromPhone).toMatchObject({
      otherEpisodeId: mac.episodeId,
      by: "mac",
      offsetMs: -2_300,
      feedsJournal: true,
    });
    expect(fromMac).toMatchObject({
      otherEpisodeId: phone.episodeId,
      by: "phone",
      offsetMs: 2_300,
      feedsJournal: false,
    });
    expect(fromPhone?.sharedFromMs).toBe((fromMac?.sharedFromMs ?? 0) + 2_300);
    expect(getEpisodeDetail(temp.db, mac.episodeId)?.episode.alsoRecordedBy).toBe("phone");
    expect(getEpisodeDetail(temp.db, phone.episodeId)?.episode.alsoRecordedBy).toBe("mac");
  });

  it("keeps the lines outside the shared time, and switches source when the user asks", () => {
    const mac = macConversation();
    const phone = phoneRecording();
    const pair = pairOf();
    // The Mac is clearer this time.
    recordSameMoment(temp.db, {
      pair,
      method: METHOD,
      result: linked(pair, { phone: 10, mac: 25 }),
      nowMs: s(4_000),
    });
    expect(writeJournal(mac.episodeId)).toBe(3);
    // Only the phone's line after the Mac stopped (80 s on its clock, 82.7 s on the Mac's).
    expect(writeJournal(phone.episodeId)).toBe(1);
    expect(journalTexts()).toHaveLength(4);

    expect(
      setSameMomentSource(temp.db, { episodeId: phone.episodeId, otherEpisodeId: mac.episodeId }),
    ).toBe(true);
    expect(count(temp.db, "journal_runs", `episode_id = ${phone.episodeId}`)).toBe(0);
    expect(count(temp.db, "journal_runs", `episode_id = ${mac.episodeId}`)).toBe(0);
    expect(writeJournal(phone.episodeId)).toBe(4);
    expect(writeJournal(mac.episodeId)).toBe(0);
    expect(journalTexts()).toHaveLength(4);

    // Compared again (a new generation), the user's choice holds.
    temp.db.client
      .prepare("UPDATE episodes SET input_generation = 2 WHERE id = ?")
      .run(mac.episodeId);
    const again = pairOf();
    recordSameMoment(temp.db, {
      pair: again,
      method: METHOD,
      result: linked(again, { phone: 10, mac: 25 }),
      nowMs: s(4_100),
    });
    expect(sameMomentsOf(temp.db, phone.episodeId)[0]).toMatchObject({
      feedsJournal: true,
      sourceChosen: true,
    });
    expect(count(temp.db, "journal_runs", `episode_id = ${phone.episodeId}`)).toBe(1);
  });

  it.each(["mac", "phone"] as const)(
    "deleting the %s recording removes the link; the other is written again in full, its bytes' rows untouched",
    (deleted) => {
      const mac = macConversation();
      const phone = phoneRecording();
      const pair = pairOf();
      // The deleted one feeds the journal, so the other has to be written again.
      recordSameMoment(temp.db, {
        pair,
        method: METHOD,
        result: linked(pair, deleted === "mac" ? { phone: 10, mac: 25 } : { phone: 30, mac: 20 }),
        nowMs: s(4_000),
      });
      writeJournal(mac.episodeId);
      writeJournal(phone.episodeId);
      const kept = deleted === "mac" ? phone : mac;
      const gone = deleted === "mac" ? mac : phone;
      const chunksBefore = temp.db.client
        .prepare("SELECT * FROM chunks WHERE track_run_id = ? ORDER BY id")
        .all(kept.trackRunId);

      expect(
        deleteEpisode(temp.db, gone.episodeId, { origin: "app", checkpoint: false }),
      ).toMatchObject({ deleted: true });
      expect(count(temp.db, "same_moment_links")).toBe(0);
      expect(sameMomentsOf(temp.db, kept.episodeId)).toEqual([]);
      // Its shortened journal went; written again, it reads every line it heard.
      expect(count(temp.db, "journal_runs", `episode_id = ${kept.episodeId}`)).toBe(0);
      expect(writeJournal(kept.episodeId)).toBe(deleted === "mac" ? 4 : 3);
      expect(new Set(journalTexts()).size).toBe(journalTexts().length);
      expect(
        temp.db.client
          .prepare("SELECT * FROM chunks WHERE track_run_id = ? ORDER BY id")
          .all(kept.trackRunId),
      ).toEqual(chunksBefore);
      expect(count(temp.db, "deleted_ranges", `track_run_id = ${kept.trackRunId}`)).toBe(0);
    },
  );
});

describe("what the journal leaves out follows the source", () => {
  it("writes the other again in full while the journal does not read the source", () => {
    const mac = macConversation();
    const phone = phoneRecording();
    const pair = pairOf();
    recordSameMoment(temp.db, { pair, method: METHOD, result: linked(pair), nowMs: s(4_000) });
    expect(writeJournal(phone.episodeId)).toBe(4);
    expect(writeJournal(mac.episodeId)).toBe(0);

    // The phone recording, the source, is now media: the journal no longer reads it.
    expect(
      setEpisodeKind(temp.db, { episodeId: phone.episodeId, kind: "media", nowMs: s(4_100) }),
    ).toBe(true);
    expect(count(temp.db, "journal_runs", `episode_id = ${mac.episodeId}`)).toBe(0);
    expect(writeJournal(mac.episodeId)).toBe(3);
    expect(sameMomentsOf(temp.db, mac.episodeId)[0]?.feedsJournal).toBe(true);
    expect(journalTexts()).toHaveLength(3);

    // Back to a conversation: the Mac's shared time goes again.
    setEpisodeKind(temp.db, { episodeId: phone.episodeId, kind: null, nowMs: s(4_200) });
    expect(count(temp.db, "journal_runs", `episode_id = ${mac.episodeId}`)).toBe(0);
    expect(writeJournal(mac.episodeId)).toBe(0);
    expect(sameMomentsOf(temp.db, mac.episodeId)[0]?.feedsJournal).toBe(false);
  });

  it("leaves to the other what was deleted from the source", () => {
    const mac = macConversation();
    const phone = phoneRecording();
    const pair = pairOf();
    recordSameMoment(temp.db, { pair, method: METHOD, result: linked(pair), nowMs: s(4_000) });
    writeJournal(phone.episodeId);
    expect(writeJournal(mac.episodeId)).toBe(0);

    // The phone's « devis » sentence (40–45 s on its clock) is deleted.
    expect(
      deletePassage(temp.db, {
        episodeId: phone.episodeId,
        fromMs: s(39),
        toMs: s(46),
        origin: "app",
        nowMs: s(4_100),
      }),
    ).toMatchObject({ deleted: true });
    // The Mac's journal goes, and is written again with its own sentence there, only that one.
    expect(count(temp.db, "journal_runs", `episode_id = ${mac.episodeId}`)).toBe(0);
    expect(writeJournal(mac.episodeId)).toBe(1);
    writeJournal(phone.episodeId);
    const texts = journalTexts();
    expect(texts.filter((text) => text === "je t'envoie le devis demain")).toHaveLength(1);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it("writes the other again when the offset moves, by any amount", () => {
    const mac = macConversation();
    phoneRecording();
    const pair = pairOf();
    recordSameMoment(temp.db, { pair, method: METHOD, result: linked(pair), nowMs: s(4_000) });
    writeJournal(mac.episodeId);
    temp.db.client
      .prepare("UPDATE episodes SET input_generation = 2 WHERE id = ?")
      .run(mac.episodeId);
    const again = pairOf();
    // Compared again: the same shared time, an offset 300 ms away.
    recordSameMoment(temp.db, {
      pair: again,
      method: METHOD,
      result: { ...linked(pair), offsetMs: -2_000 },
      nowMs: s(4_100),
    });
    expect(count(temp.db, "journal_runs", `episode_id = ${mac.episodeId}`)).toBe(0);
    // The same values again change nothing.
    writeJournal(mac.episodeId);
    temp.db.client
      .prepare("UPDATE episodes SET input_generation = 3 WHERE id = ?")
      .run(mac.episodeId);
    recordSameMoment(temp.db, {
      pair: pairOf(),
      method: METHOD,
      result: { ...linked(pair), offsetMs: -2_000 },
      nowMs: s(4_200),
    });
    expect(count(temp.db, "journal_runs", `episode_id = ${mac.episodeId}`)).toBe(1);
  });

  it("keeps the user's word on one commitment when the source switches", () => {
    const mac = macConversation();
    const phone = phoneRecording();
    const pair = pairOf();
    // The Mac is clearer: its commitment is the one shown, and marked done.
    recordSameMoment(temp.db, {
      pair,
      method: METHOD,
      result: linked(pair, { phone: 10, mac: 25 }),
      nowMs: s(4_000),
    });
    writeJournal(mac.episodeId, "devis");
    writeJournal(phone.episodeId, "devis");
    const commitments = () => loadJournalItems(temp.db, { ...day, kind: "commitment" });
    const [shown] = commitments();
    expect(commitments()).toHaveLength(1);
    expect(shown?.episodeId).toBe(mac.episodeId);
    const done = setJournalMark(
      temp.db,
      { itemId: shown?.itemId ?? null, markId: null },
      { status: "done" },
      s(4_100),
    );
    expect(done.ok).toBe(true);

    // The phone feeds it now: the same commitment, written from the phone, keeps « Fait ».
    setSameMomentSource(temp.db, { episodeId: phone.episodeId, otherEpisodeId: mac.episodeId });
    writeJournal(phone.episodeId, "devis");
    writeJournal(mac.episodeId, "devis");
    const after = commitments();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      episodeId: phone.episodeId,
      status: "done",
      markId: done.ok ? done.markId : -1,
    });
    // A word on it goes to that same mark.
    expect(
      setJournalMark(
        temp.db,
        { itemId: after[0]?.itemId ?? null, markId: after[0]?.markId ?? null },
        { status: "open" },
        s(4_200),
      ),
    ).toEqual({ ok: true, markId: null });
    expect(count(temp.db, "journal_marks")).toBe(0);
  });
});
