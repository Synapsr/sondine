import { randomUUID } from "node:crypto";
import { currentSpeakerRun, phoneDevice, storeVoicePass } from "@sondine/db";
import {
  MemoryCommitmentsAnswer,
  MemoryConversationAnswer,
  MemoryDayAnswer,
  MemoryJournalAnswer,
  MemorySearchAnswer,
  phoneAudioPath,
} from "@sondine/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { localDay } from "../src/core/phone/phone-results";
import {
  analysis,
  api,
  cleanups,
  database,
  pairPhone,
  readyRecording,
  send,
  setup,
  writeJournal,
  type Phone,
  type Setup,
} from "./phone-support";

// The phone's live reads of the Mac's memory through the real core (ADR 008,
// plan § M5.4): search, a day, its journal, the open commitments and a
// conversation's text. A reading session is recorded as the phone receives
// it: nothing deleted is in it, and no voice data (every answer parses with
// its strict schema, which has no field for any, and no likeness score).

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** One request; its answer's body, kept in `capture` when given. */
async function ask(
  s: Setup,
  phone: Phone,
  path: string,
  body: unknown,
  capture?: string[],
): Promise<unknown> {
  const answer = await send(s.socketPath, { path, credential: phone.credential, body });
  expect([path, answer.status]).toEqual([path, 200]);
  capture?.push(JSON.stringify(answer.body));
  return answer.body;
}

const vector = (seed: number) => Array.from({ length: 256 }, (_, i) => Math.sin(i * seed));

describe("the Mac's memory on the phone", () => {
  it(
    "reads search, a day, the journal, commitments and a conversation, never what was deleted or a voice's data",
    { timeout: 90_000 },
    async () => {
      const s = setup({}, analysis);
      const phone = await pairPhone(s);
      const kept = await readyRecording(s, phone);
      const gone = await readyRecording(s, phone);
      const cut = await readyRecording(s, phone);
      const services = await api(s);
      const db = await database(s);

      // Words of their own: « Bonjour Sondine » is all the fake engine hears.
      const detail = await services.episodes.get({ episodeId: kept.episodeId });
      const runId = detail.analysis?.runId ?? 0;
      const [first] = detail.segments;
      const [voice] = detail.speakers;
      if (first === undefined || voice === undefined) throw new Error("no text");
      await services.transcript.edit({
        episodeId: kept.episodeId,
        runId,
        segmentId: first.id,
        text: "Le budget de mars",
      });
      // Two stretches of sound, three seconds each: the second of `cut` is deleted below.
      const cutDetail = await services.episodes.get({ episodeId: cut.episodeId });
      const [cutFirst] = cutDetail.segments;
      const later = cutDetail.segments.filter(
        (segment) => cutFirst !== undefined && segment.startMs > cutFirst.endMs + 5_000,
      );
      const [second] = later;
      const last = later.at(-1);
      if (second === undefined || last === undefined || cutDetail.analysis === null) {
        throw new Error("two stretches");
      }
      await services.transcript.edit({
        episodeId: cut.episodeId,
        runId: cutDetail.analysis.runId,
        segmentId: second.id,
        text: "Un passage effacé",
      });
      const goneDetail = await services.episodes.get({ episodeId: gone.episodeId });
      const goneSentence = goneDetail.segments[0];
      if (goneSentence === undefined || goneDetail.analysis === null) throw new Error("no text");
      await services.transcript.edit({
        episodeId: gone.episodeId,
        runId: goneDetail.analysis.runId,
        segmentId: goneSentence.id,
        text: "Le budget secret",
      });
      // A voice named, with what the Mac keeps of voices (embeddings) beside it.
      await services.speakers.name({
        episodeId: kept.episodeId,
        runId,
        label: voice.label,
        person: { kind: "new", name: "Marie" },
      });
      storeVoicePass(db, {
        episodeId: kept.episodeId,
        runId: currentSpeakerRun(db, kept.episodeId) ?? 0,
        embedderVersion: "test",
        voices: detail.speakers.map((speaker, index) => ({
          label: speaker.label,
          vector: vector(index + 3),
          speechMs: 9_000,
        })),
        nowMs: Date.now(),
      });
      writeJournal(
        db,
        kept.episodeId,
        "{P1} parle du budget",
        [first.id],
        detail.speakers.map((speaker) => speaker.label),
      );
      // Deleted on the Mac: a whole recording, and a passage of another.
      await services.episodes.delete({ episodeId: gone.episodeId });
      await services.episodes.deletePassage({
        episodeId: cut.episodeId,
        fromMs: second.startMs,
        toMs: last.endMs,
      });

      // The reading session, as the phone receives it.
      const capture: string[] = [];
      const readsBefore = phoneDevice(db, phone.deviceId)?.reads ?? 0;
      const day = localDay(detail.episode.startedAtMs);

      const found = MemorySearchAnswer.parse(
        await ask(s, phone, "/v1/memory/search", { text: "budget", offset: 0 }, capture),
      );
      if (found.status !== "results") throw new Error("withheld");
      expect(found).toMatchObject({ total: 1, nextOffset: null });
      const [hit] = found.episodes;
      expect(hit?.episode).toMatchObject({
        episodeId: kept.episodeId,
        context: "in_person",
        people: ["Marie"],
        phone: { name: null, recordingId: kept.recordingId },
      });
      expect(hit?.hits[0]).toMatchObject({
        sentenceId: first.id,
        text: "Le budget de mars",
        highlights: [{ start: 3, end: 9 }],
        speaker: { name: "Marie", guess: null, self: false },
      });
      expect(
        MemorySearchAnswer.parse(
          await ask(s, phone, "/v1/memory/search", { text: "effacé", offset: 0 }, capture),
        ),
      ).toMatchObject({ status: "results", total: 0, episodes: [] });

      const overview = MemoryDayAnswer.parse(
        await ask(s, phone, "/v1/memory/day", { day }, capture),
      );
      if (overview.status !== "day") throw new Error("withheld");
      expect(overview.day).toBe(day);
      // Two recordings of a few seconds of speech: moments, counted (the deleted one is not).
      expect(overview.conversations.length + overview.moments).toBe(2);
      expect(JSON.stringify(overview)).not.toContain(`"episodeId":${gone.episodeId},`);

      const journal = MemoryJournalAnswer.parse(
        await ask(s, phone, "/v1/memory/journal", { day }, capture),
      );
      expect(journal).toMatchObject({
        status: "journal",
        day,
        lines: [
          {
            kind: "line",
            episodeId: kept.episodeId,
            text: "{P1} parle du budget",
            sentenceIds: [first.id],
            startMs: first.startMs,
            voices: expect.arrayContaining([
              expect.objectContaining({ ref: "P1", name: "Marie", guess: null }),
            ]),
          },
        ],
        commitments: [{ kind: "commitment", episodeId: kept.episodeId, due: "2026-11-20" }],
      });

      const open = MemoryCommitmentsAnswer.parse(
        await ask(s, phone, "/v1/memory/commitments", { beforeMs: null }, capture),
      );
      expect(open).toMatchObject({
        status: "commitments",
        today: localDay(Date.now()),
        commitments: [{ episodeId: kept.episodeId, done: false, due: "2026-11-20" }],
      });

      const conversation = MemoryConversationAnswer.parse(
        await ask(s, phone, "/v1/memory/conversation", { episodeId: kept.episodeId }, capture),
      );
      if (conversation.status !== "conversation") throw new Error("not read");
      expect(conversation.sentences.map((sentence) => sentence.text)).toEqual(
        detail.segments.map((segment) =>
          segment.id === first.id ? "Le budget de mars" : segment.text,
        ),
      );
      expect(conversation.speakers[0]).toEqual({
        ordinal: 1,
        name: "Marie",
        guess: null,
        self: false,
      });
      expect(conversation.truncated).toBe(false);
      const shortened = MemoryConversationAnswer.parse(
        await ask(s, phone, "/v1/memory/conversation", { episodeId: cut.episodeId }, capture),
      );
      if (shortened.status !== "conversation") throw new Error("not read");
      expect(shortened.sentences.length).toBeGreaterThan(0);
      expect(shortened.sentences.every((sentence) => sentence.endMs < second.startMs)).toBe(true);
      expect(
        await ask(s, phone, "/v1/memory/conversation", { episodeId: gone.episodeId }, capture),
      ).toEqual({ status: "gone" });

      // Each read counted, never its words.
      expect(phoneDevice(db, phone.deviceId)?.reads).toBe(readsBefore + capture.length);

      // The capture: nothing deleted, no voice's data, no likeness score, no audio.
      const session = capture.join("\n");
      for (const deleted of [
        "secret",
        "effacé",
        `"sentenceId":${second.id},`,
        `"id":${second.id},`,
      ]) {
        expect(session).not.toContain(deleted);
      }
      expect(session).not.toContain(`"episodeId":${gone.episodeId},`);
      for (const field of ["vector", "embedding", "similarity", "confidence", "label", "audio"]) {
        expect(session).not.toContain(`"${field}"`);
      }
      expect(session).not.toMatch(/\d\.\d{3,}/);
    },
  );

  it(
    "withholds a read during a deletion, hides another phone's ids, and offers nothing else",
    { timeout: 60_000 },
    async () => {
      let deleteMeanwhile: (() => Promise<void>) | null = null;
      const s = setup(
        {
          whileReading: async () => {
            const pending = deleteMeanwhile;
            deleteMeanwhile = null;
            await pending?.();
          },
        },
        analysis,
      );
      const phone = await pairPhone(s);
      const mine = await readyRecording(s, phone);
      const other = await readyRecording(s, phone);
      const services = await api(s);

      // Something deleted while it is read: withheld, and read again.
      deleteMeanwhile = async () => {
        await services.episodes.delete({ episodeId: other.episodeId });
      };
      const search = { text: "Bonjour", offset: 0 };
      expect(await ask(s, phone, "/v1/memory/search", search)).toEqual({ status: "withheld" });
      const again = MemorySearchAnswer.parse(await ask(s, phone, "/v1/memory/search", search));
      if (again.status !== "results") throw new Error("withheld");
      expect(again.episodes.map((entry) => entry.episode.episodeId)).toEqual([mine.episodeId]);
      // A correction moves the same generation as a deletion: each read is withheld then.
      const detail = await services.episodes.get({ episodeId: mine.episodeId });
      const [sentence] = detail.segments;
      if (sentence === undefined || detail.analysis === null) throw new Error("no text");
      const runId = detail.analysis.runId;
      const reads: readonly (readonly [string, unknown])[] = [
        ["/v1/memory/day", { day: localDay(Date.now()) }],
        ["/v1/memory/journal", { day: localDay(Date.now()) }],
        ["/v1/memory/commitments", { beforeMs: null }],
        ["/v1/memory/conversation", { episodeId: mine.episodeId }],
      ];
      for (const [index, [path, body]] of reads.entries()) {
        deleteMeanwhile = async () => {
          await services.transcript.edit({
            episodeId: mine.episodeId,
            runId,
            segmentId: sentence.id,
            text: `Bonjour Sondine ${index}`,
          });
        };
        expect([path, await ask(s, phone, path, body)]).toEqual([path, { status: "withheld" }]);
        expect(await ask(s, phone, path, body)).not.toEqual({ status: "withheld" });
      }

      // Another phone reads the memory, not this phone's recording ids, nor its audio.
      const tablet = await pairPhone(s, randomUUID(), "iPad");
      const seen = MemorySearchAnswer.parse(await ask(s, tablet, "/v1/memory/search", search));
      if (seen.status !== "results") throw new Error("withheld");
      expect(seen.episodes[0]?.episode.phone).toEqual({ name: null, recordingId: null });
      const play = await send(s.socketPath, {
        method: "GET",
        path: `${phoneAudioPath(mine.recordingId)}?g=1`,
        credential: tablet.credential,
      });
      expect([play.status, play.body]).toEqual([403, { error: "not-yours" }]);

      // Nothing but the listed reads: no people, settings, zones or diagnostics; a bad body is refused.
      for (const path of [
        "/v1/memory/people",
        "/v1/privacy/status",
        "/v1/settings",
        "/v1/diagnostics",
        "/v1/episodes/get",
      ]) {
        const refused = await send(s.socketPath, { path, credential: phone.credential, body: {} });
        expect([path, refused.status, refused.body]).toEqual([path, 400, { error: "bad-request" }]);
      }
      const bad = await send(s.socketPath, {
        path: "/v1/memory/search",
        credential: phone.credential,
        body: { text: "budget", offset: 0, limit: 500 },
      });
      expect([bad.status, bad.body]).toEqual([400, { error: "bad-request" }]);
      // Without a credential, nothing.
      const anonymous = await send(s.socketPath, { path: "/v1/memory/search", body: search });
      expect([anonymous.status, anonymous.body]).toEqual([401, { error: "unauthorized" }]);
    },
  );

  it(
    "keeps a long conversation under the answer's limit, and pages commitments without skipping one",
    { timeout: 60_000 },
    async () => {
      const limit = 24 * 1024;
      const s = setup({ memoryAnswerBytes: limit }, analysis);
      const phone = await pairPhone(s);
      const oldest = await readyRecording(s, phone);
      const middle = await readyRecording(s, phone);
      const newest = await readyRecording(s, phone);
      const services = await api(s);
      const db = await database(s);

      // Notes far over the limit on their own: the sentences come first, the notes in what is left.
      for (let index = 0; index < 6; index += 1) {
        await services.context.add({
          episodeId: oldest.episodeId,
          text: `Note ${index} ${"x".repeat(8_000)}`,
        });
      }
      const detail = await services.episodes.get({ episodeId: oldest.episodeId });
      const answer = await ask(s, phone, "/v1/memory/conversation", {
        episodeId: oldest.episodeId,
      });
      expect(Buffer.byteLength(JSON.stringify(answer))).toBeLessThanOrEqual(limit);
      const read = MemoryConversationAnswer.parse(answer);
      if (read.status !== "conversation") throw new Error("not read");
      expect(read.truncated).toBe(true);
      expect(read.sentences.map((sentence) => sentence.id)).toEqual(
        detail.segments.map((segment) => segment.id),
      );
      expect(read.notes.length).toBeGreaterThan(0);
      expect(read.notes.length).toBeLessThan(6);

      // Three conversations with a commitment each, the two newest starting in the same millisecond.
      for (const recording of [oldest, middle, newest]) {
        const episode = await services.episodes.get({ episodeId: recording.episodeId });
        writeJournal(
          db,
          recording.episodeId,
          "{P1} parle",
          episode.segments.map((segment) => segment.id),
          episode.speakers.map((speaker) => speaker.label),
        );
      }
      const tie = (await services.episodes.get({ episodeId: middle.episodeId })).episode
        .startedAtMs;
      db.statement("UPDATE episodes SET started_at_ms = ? WHERE id = ?").run(tie, newest.episodeId);
      // A page of one keeps both conversations of that millisecond, and the next starts before it.
      const first = await services.journal.commitments({ status: "open", days: 90, limit: 1 });
      expect(first.commitments.map((line) => line.episodeId).toSorted()).toEqual(
        [middle.episodeId, newest.episodeId].toSorted(),
      );
      expect(first.nextBeforeMs).toBe(tie);
      const second = await services.journal.commitments({
        status: "open",
        days: 90,
        limit: 1,
        beforeMs: first.nextBeforeMs,
      });
      expect(second.commitments.map((line) => line.episodeId)).toEqual([oldest.episodeId]);
      expect(second.nextBeforeMs).toBe(first.nextBeforeMs - 90 * 86_400_000);
      // The phone's page holds all three, newest conversation first, and its cursor is the window's start.
      const open = MemoryCommitmentsAnswer.parse(
        await ask(s, phone, "/v1/memory/commitments", { beforeMs: null }),
      );
      if (open.status !== "commitments") throw new Error("withheld");
      expect(open.commitments.map((line) => line.episodeId).slice(2)).toEqual([oldest.episodeId]);
      expect(open.commitments).toHaveLength(3);
      expect(open.nextBeforeMs).toBeLessThan(tie - 89 * 86_400_000);
    },
  );
});
