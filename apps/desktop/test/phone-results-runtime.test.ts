import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { currentSpeakerRun, openDatabase, phoneDevice, storeVoicePass } from "@sondine/db";
import { GetAnswer, OperationAnswer, phoneAudioPath, type PhoneResult } from "@sondine/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { DATA_LAYOUT } from "../src/shared/data-layout";
import {
  api,
  cleanups,
  database,
  pairPhone,
  send,
  setup,
  sha,
  analysis,
  readyRecording,
  states,
  writeJournal,
  type Phone,
  type Setup,
} from "./phone-support";
import { migrationsDir } from "./support";

// A recording's results on the phone through the real core (ADR 008, plan
// § M5.3): `get` and its revision, `rename` and `note` from the outbox, and
// playback by byte ranges. The analysis reads the file's real audio and runs
// the fake engine, which hears « Bonjour Sondine » in each stretch of sound,
// its voices taking turns.

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const get = async (s: Setup, phone: Phone, recordingId: string, revision: string | null) => {
  const answer = await send(s.socketPath, {
    path: "/v1/recordings/get",
    credential: phone.credential,
    body: { recordingId, revision },
  });
  expect(answer.status).toBe(200);
  return GetAnswer.parse(answer.body);
};

/** The result and its revision; fails on any other answer. */
const result = async (s: Setup, phone: Phone, recordingId: string, revision: string | null) => {
  const answer = await get(s, phone, recordingId, revision);
  if (answer.status !== "result") throw new Error(`no result: ${JSON.stringify(answer)}`);
  expect(answer.revision).toBe(sha(Buffer.from(JSON.stringify(answer.result))));
  return answer;
};

const operation = async (
  s: Setup,
  phone: Phone,
  path:
    | "/v1/recordings/rename"
    | "/v1/recordings/note"
    | "/v1/recordings/tag"
    | "/v1/recordings/voice",
  body: Record<string, unknown>,
) => {
  const answer = await send(s.socketPath, { path, credential: phone.credential, body });
  if (answer.status !== 200) return answer.body;
  return OperationAnswer.parse(answer.body).status;
};

describe("a recording's result on the phone", () => {
  it("is fetched when its revision moved, and only then", { timeout: 60_000 }, async () => {
    const s = setup({}, analysis);
    const phone = await pairPhone(s);
    const { recordingId, episodeId } = await readyRecording(s, phone);
    const services = await api(s);
    const db = await database(s);

    // First fetch: the transcript by sentences, its voices numbered, no name yet; a read counted.
    const readsBefore = phoneDevice(db, phone.deviceId)?.reads ?? 0;
    const first = await result(s, phone, recordingId, null);
    const { result: shown } = first;
    expect(shown).toMatchObject({ recordingId, name: null, timeUncertain: false, journal: [] });
    expect(shown.sentences.length).toBeGreaterThanOrEqual(2);
    expect(shown.sentences.map((sentence) => sentence.text.trim())).toContain("Bonjour Sondine");
    expect(shown.speakers.map((speaker) => speaker.ordinal)).toEqual([1, 2]);
    expect(shown.audio).toMatchObject({ generation: expect.any(Number) });
    expect(phoneDevice(db, phone.deviceId)?.reads).toBe(readsBefore + 1);

    // Nothing it shows moved: unchanged, also after reading states and another recording's correction.
    expect(await get(s, phone, recordingId, first.revision)).toEqual({ status: "unchanged" });
    await states(s, phone, [recordingId]);
    const other = await readyRecording(s, phone);
    const otherDetail = await services.episodes.get({ episodeId: other.episodeId });
    const otherSegment = otherDetail.segments[0];
    if (otherSegment === undefined || otherDetail.analysis === null) throw new Error("no text");
    await services.transcript.edit({
      episodeId: other.episodeId,
      runId: otherDetail.analysis.runId,
      segmentId: otherSegment.id,
      text: "Ailleurs",
    });
    expect(await get(s, phone, recordingId, first.revision)).toEqual({ status: "unchanged" });

    // A correction moves it, its undo moves it back.
    const detail = await services.episodes.get({ episodeId });
    const runId = detail.analysis?.runId ?? 0;
    const [sentence] = detail.segments;
    if (sentence === undefined) throw new Error("no sentence");
    await services.transcript.edit({ episodeId, runId, segmentId: sentence.id, text: "Corrigé" });
    const corrected = await result(s, phone, recordingId, first.revision);
    expect(corrected.result.sentences[0]?.text).toBe("Corrigé");
    await services.history.undo();
    const undone = await result(s, phone, recordingId, corrected.revision);
    expect(undone.revision).toBe(first.revision);

    const [voiceA, voiceB] = detail.speakers;
    if (voiceA === undefined || voiceB === undefined) throw new Error("two voices");

    // A guess moved by a name given elsewhere: voice B sounds like the voice named Paul in the other recording.
    const vector = (seed: number) => Array.from({ length: 256 }, (_, i) => Math.sin(i * seed));
    const ownRun = currentSpeakerRun(db, episodeId) ?? 0;
    const otherRun = currentSpeakerRun(db, other.episodeId) ?? 0;
    storeVoicePass(db, {
      episodeId,
      runId: ownRun,
      embedderVersion: "test",
      voices: [
        { label: voiceA.label, vector: vector(3), speechMs: 9_000 },
        { label: voiceB.label, vector: vector(7), speechMs: 9_000 },
      ],
      nowMs: Date.now(),
    });
    const [otherVoice] = otherDetail.speakers;
    if (otherVoice === undefined) throw new Error("a voice");
    storeVoicePass(db, {
      episodeId: other.episodeId,
      runId: otherRun,
      embedderVersion: "test",
      voices: [{ label: otherVoice.label, vector: vector(7), speechMs: 9_000 }],
      nowMs: Date.now(),
    });
    expect(await get(s, phone, recordingId, undone.revision)).toEqual({ status: "unchanged" });
    await services.speakers.name({
      episodeId: other.episodeId,
      runId: otherRun,
      label: otherVoice.label,
      person: { kind: "new", name: "Paul" },
    });
    const guessed = await result(s, phone, recordingId, undone.revision);
    expect(guessed.result.speakers[1]).toMatchObject({ ordinal: 2, name: null, guess: "Paul" });

    // A voice named, as the user's.
    await services.speakers.name({
      episodeId,
      runId,
      label: voiceA.label,
      person: { kind: "new", name: "Marie" },
    });
    const named = await result(s, phone, recordingId, guessed.revision);
    expect(named.result.speakers[0]).toEqual({
      ordinal: 1,
      name: "Marie",
      guess: null,
      self: false,
    });

    // The journal written, then written again.
    const ids = named.result.sentences.map((entry) => entry.id);
    const labels = detail.speakers.map((speaker) => speaker.label);
    writeJournal(db, episodeId, "{P1} et {P2} se saluent", ids, labels);
    const journaled = await result(s, phone, recordingId, named.revision);
    expect(journaled.result.journal).toMatchObject([
      { kind: "line", text: "{P1} et {P2} se saluent", sentenceIds: [ids[0]], done: false },
      { kind: "commitment", sentenceIds: [ids.at(-1)], due: "2026-11-20", done: false },
    ]);
    expect(journaled.result.journal[0]?.voices[0]).toMatchObject({ ref: "P1", name: "Marie" });
    writeJournal(db, episodeId, "{P1} salue {P2}", ids, labels);
    const rewritten = await result(s, phone, recordingId, journaled.revision);
    expect(rewritten.result.journal[0]?.text).toBe("{P1} salue {P2}");

    // A passage deleted on the Mac is absent at the next contact.
    const [, last] = rewritten.result.sentences;
    if (last === undefined) throw new Error("two sentences");
    await services.episodes.deletePassage({ episodeId, fromMs: last.startMs, toMs: last.endMs });
    const cut = await result(s, phone, recordingId, rewritten.revision);
    expect(cut.result.sentences.map((entry) => entry.id)).not.toContain(last.id);
    expect(JSON.stringify(cut.result)).not.toContain(`"id":${last.id},`);

    // A restart of core: the same answer gives the same revision (nothing stored made it)…
    await s.restart();
    expect(await get(s, phone, recordingId, cut.revision)).toEqual({ status: "unchanged" });
    // …and a change written while core was down is seen, where a counter would have restarted.
    await s.restart(() => {
      const offline = openDatabase(join(s.data.dir, DATA_LAYOUT.database), {
        migrationsFolder: migrationsDir,
      });
      offline.client
        .prepare("UPDATE segments SET text = 'Hors ligne' WHERE id = ?")
        .run(cut.result.sentences[0]?.id ?? 0);
      offline.close();
    });
    const after = await result(s, phone, recordingId, cut.revision);
    expect(after.result.sentences[0]?.text).toBe("Hors ligne");
  });

  it("withholds an answer read while a deletion commits, and refuses another phone's", async () => {
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
    const { recordingId } = await readyRecording(s, phone);
    const other = await readyRecording(s, phone);
    const services = await api(s);
    deleteMeanwhile = async () => {
      await services.episodes.delete({ episodeId: other.episodeId });
    };
    expect(await get(s, phone, recordingId, null)).toEqual({ status: "withheld" });
    expect((await get(s, phone, recordingId, null)).status).toBe("result");
    expect(await get(s, phone, other.recordingId, null)).toEqual({
      status: "unavailable",
      state: "deleted",
    });

    const intruder = await pairPhone(s, randomUUID(), "Autre");
    for (const path of ["/v1/recordings/get", "/v1/recordings/rename", "/v1/recordings/note"]) {
      const answer = await send(s.socketPath, {
        path,
        credential: intruder.credential,
        body:
          path === "/v1/recordings/get"
            ? { recordingId, revision: null }
            : path === "/v1/recordings/rename"
              ? { operationId: randomUUID(), recordingId, name: "x", typedAtMs: 1 }
              : { operationId: randomUUID(), recordingId, text: "x" },
      });
      expect([path, answer.status, answer.body]).toEqual([path, 403, { error: "not-yours" }]);
    }
    const play = await send(s.socketPath, {
      method: "GET",
      path: `${phoneAudioPath(recordingId)}?g=1`,
      credential: intruder.credential,
    });
    expect([play.status, play.body]).toEqual([403, { error: "not-yours" }]);
  });

  it(
    "takes tags and « C'est moi » from a version 2 phone (ADR 039)",
    { timeout: 60_000 },
    async () => {
      const s = setup({}, analysis);
      const phone = await pairPhone(s);
      const services = await api(s);
      // Tagged before the Mac holds it: later, kept by the phone.
      const early = {
        operationId: randomUUID(),
        recordingId: randomUUID(),
        name: "idées",
        on: true,
      };
      expect(await operation(s, phone, "/v1/recordings/tag", early)).toBe("later");
      const { recordingId, episodeId } = await readyRecording(s, phone);
      // A version 1 phone reads neither tags nor `guessSelf`.
      const v1 = await result(s, phone, recordingId, null);
      expect("tags" in v1.result).toBe(false);
      expect(v1.result.speakers.every((speaker) => !("guessSelf" in speaker))).toBe(true);
      const hello = await send(s.socketPath, {
        path: "/v1/hello",
        credential: phone.credential,
        body: { v: 2, clockMs: Date.now(), recordingIds: [recordingId] },
      });
      expect(hello.body).toMatchObject({ v: 2 });
      const v2 = await result(s, phone, recordingId, v1.revision);
      expect(v2.result.tags).toEqual([]);

      const tag = { operationId: randomUUID(), recordingId, name: " #Idées", on: true };
      expect(await operation(s, phone, "/v1/recordings/tag", tag)).toBe("done");
      expect(await operation(s, phone, "/v1/recordings/tag", tag)).toBe("done");
      const tagged = await result(s, phone, recordingId, v2.revision);
      expect(tagged.result.tags).toEqual(["Idées"]);
      expect((await services.episodes.get({ episodeId })).episode.tags).toEqual(["Idées"]);
      const list = await send(s.socketPath, {
        path: "/v1/tags",
        credential: phone.credential,
        body: {},
      });
      expect(list.body).toEqual({ tags: ["Idées"] });
      // Taken off by its key; a name the Mac refuses leaves the outbox all the same.
      const off = { operationId: randomUUID(), recordingId, name: "idees", on: false };
      expect(await operation(s, phone, "/v1/recordings/tag", off)).toBe("done");
      const bad = { operationId: randomUUID(), recordingId, name: "#", on: true };
      expect(await operation(s, phone, "/v1/recordings/tag", bad)).toBe("done");
      expect((await result(s, phone, recordingId, tagged.revision)).result.tags).toEqual([]);

      // « C'est moi »: voice 1 named as the user, the user named on another recording.
      const other = await readyRecording(s, phone);
      const otherDetail = await services.episodes.get({ episodeId: other.episodeId });
      const [otherVoice] = otherDetail.speakers;
      if (otherVoice === undefined || otherDetail.analysis === null) throw new Error("a voice");
      await services.speakers.name({
        episodeId: other.episodeId,
        runId: otherDetail.analysis.runId,
        label: otherVoice.label,
        person: { kind: "self", name: "Moi" },
      });
      const detail = await services.episodes.get({ episodeId });
      const voiceA = detail.speakers.find((speaker) => speaker.ordinal === 1);
      const firstSentence = detail.segments.find(
        (segment) => segment.speakerLabel === voiceA?.label,
      );
      const personOfA = async () =>
        (await services.episodes.get({ episodeId })).speakers.find(
          (speaker) => speaker.label === voiceA?.label,
        )?.person ?? null;
      expect(await personOfA()).toBeNull();
      // A sentence of another transcript (made again since the phone read it): nothing is named.
      const stale = { operationId: randomUUID(), recordingId, ordinal: 1, sentenceId: 999_999 };
      expect(await operation(s, phone, "/v1/recordings/voice", stale)).toBe("done");
      expect(await personOfA()).toBeNull();
      const me = {
        operationId: randomUUID(),
        recordingId,
        ordinal: 1,
        sentenceId: firstSentence?.id ?? 0,
      };
      expect(await operation(s, phone, "/v1/recordings/voice", me)).toBe("done");
      expect(await operation(s, phone, "/v1/recordings/voice", me)).toBe("done");
      expect(await personOfA()).toMatchObject({ name: "Moi", self: true });
    },
  );

  it("takes a name and a note from the outbox once, the later name typed winning", async () => {
    // Holds the tries of one note until both are past the early check, then lets them go together.
    let holding: { count: number; release: () => void; all: Promise<void> } | null = null;
    const s = setup(
      {
        addNote: async (episodeId, text, claim, added) => {
          const hold = holding;
          if (hold !== null) {
            hold.count += 1;
            if (hold.count === 2) hold.release();
            await hold.all;
          }
          return added(episodeId, text, claim);
        },
      },
      analysis,
    );
    const phone = await pairPhone(s);
    const services = await api(s);

    // Named and noted before the Mac holds it: later, and kept by the phone.
    const early = randomUUID();
    const renameEarly = {
      operationId: randomUUID(),
      recordingId: early,
      name: "Avant",
      typedAtMs: 10,
    };
    expect(await operation(s, phone, "/v1/recordings/rename", renameEarly)).toBe("later");
    const { recordingId, episodeId } = await readyRecording(s, phone);
    const first = await result(s, phone, recordingId, null);

    const later = { operationId: randomUUID(), recordingId, name: "Budget", typedAtMs: 2_000 };
    const earlier = { operationId: randomUUID(), recordingId, name: "Brouillon", typedAtMs: 1_000 };
    expect(await operation(s, phone, "/v1/recordings/rename", later)).toBe("done");
    // Typed before, sent after: dropped, and the operation leaves the outbox.
    expect(await operation(s, phone, "/v1/recordings/rename", earlier)).toBe("done");
    expect(await operation(s, phone, "/v1/recordings/rename", earlier)).toBe("done");
    const renamed = await result(s, phone, recordingId, first.revision);
    expect(renamed.result.name).toBe("Budget");
    // The Mac shows it with the phone mark.
    const summary = (await services.episodes.get({ episodeId })).episode;
    expect(summary.phone).toEqual({ timeUncertain: false, name: "Budget" });

    // A note sent twice is one note, found on the Mac.
    const note = { operationId: randomUUID(), recordingId, text: "Relancer Marie vendredi" };
    expect(await operation(s, phone, "/v1/recordings/note", note)).toBe("done");
    expect(await operation(s, phone, "/v1/recordings/note", note)).toBe("done");
    const context = (await services.episodes.get({ episodeId })).context;
    expect(context.map((item) => [item.kind, item.text])).toEqual([
      ["note", "Relancer Marie vendredi"],
    ]);
    const noted = await result(s, phone, recordingId, renamed.revision);
    expect(noted.result.notes.map((entry) => entry.text)).toEqual(["Relancer Marie vendredi"]);

    // Two tries of one note at once (a retry over a slow answer): still one note.
    let release = () => {};
    const all = new Promise<void>((resolve) => {
      release = resolve;
    });
    holding = { count: 0, release, all };
    const retried = { operationId: randomUUID(), recordingId, text: "Envoyer le devis" };
    expect(
      await Promise.all([
        operation(s, phone, "/v1/recordings/note", retried),
        operation(s, phone, "/v1/recordings/note", retried),
      ]),
    ).toEqual(["done", "done"]);
    const both = (await services.episodes.get({ episodeId })).context;
    expect(both.map((item) => item.text)).toEqual(["Relancer Marie vendredi", "Envoyer le devis"]);

    // Deleted on the Mac: both are dropped.
    await services.episodes.delete({ episodeId });
    expect(
      await operation(s, phone, "/v1/recordings/rename", {
        operationId: randomUUID(),
        recordingId,
        name: "Après",
        typedAtMs: 3_000,
      }),
    ).toBe("deleted");
    expect(
      await operation(s, phone, "/v1/recordings/note", {
        operationId: randomUUID(),
        recordingId,
        text: "Après",
      }),
    ).toBe("deleted");
  });

  it("streams the recording's audio by byte ranges, and refuses a moved generation or a deleted one", async () => {
    const s = setup({}, analysis);
    const phone = await pairPhone(s);
    // 40 s: a WAV longer than one slice of core's media reader (1 MiB).
    const { recordingId, episodeId } = await readyRecording(s, phone, randomUUID(), 40);
    const services = await api(s);
    const { result: shown } = await result(s, phone, recordingId, null);
    const audio = shown.audio as NonNullable<PhoneResult["audio"]>;
    const path = `${phoneAudioPath(recordingId)}?g=${audio.generation}`;
    const range = (header: string) => sendRaw(s, phone, path, { range: header });

    const head = await range("bytes=0-43");
    expect(head.status).toBe(206);
    expect(head.headers["content-type"]).toBe("audio/wav");
    expect(head.body.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(head.body).toHaveLength(44);
    const total = Number(/\/(\d+)$/.exec(String(head.headers["content-range"]))?.[1]);
    expect(total).toBeGreaterThan(1024 * 1024);
    // More than one slice of core's media reader: streamed whole, in order.
    const whole = await sendRaw(s, phone, path, {});
    expect(whole.status).toBe(200);
    expect(whole.body).toHaveLength(total);
    const middle = await range(`bytes=1000-${total - 1}`);
    expect(middle.headers["content-range"]).toBe(`bytes 1000-${total - 1}/${total}`);
    expect(sha(middle.body)).toBe(sha(whole.body.subarray(1000)));
    expect((await range(`bytes=${total}-`)).status).toBe(416);
    expect(
      (await sendRaw(s, phone, `${phoneAudioPath(recordingId)}?g=${audio.generation + 1}`, {}))
        .status,
    ).toBe(409);

    await services.episodes.delete({ episodeId });
    const gone = await sendRaw(s, phone, path, {});
    expect(gone.status).toBe(410);
  });
});

/** A `GET` whose body is bytes, not JSON. */
function sendRaw(s: Setup, phone: Phone, path: string, headers: Record<string, string>) {
  let opened: Socket | null = null;
  return new Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }>(
    (resolve, reject) => {
      const req = request(
        {
          method: "GET",
          path,
          headers: {
            connection: "keep-alive",
            authorization: `Bearer ${phone.credential}`,
            ...headers,
          },
          createConnection: () => {
            const socket = connect(s.socketPath);
            opened = socket;
            socket.write(`${JSON.stringify({ v: 1, via: "lan", peer: "192.168.1.20" })}\n`);
            return socket;
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            opened?.destroy();
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks),
            });
          });
        },
      );
      req.on("error", reject);
      req.end();
    },
  );
}
