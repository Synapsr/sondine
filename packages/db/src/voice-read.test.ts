import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deletePerson, mergePeople, nameSpeaker, setRecognition } from "./people";
import { publishAnalysis } from "./publish";
import {
  seedEpisode,
  segment,
  startRun,
  t0,
  tempDatabase,
  turn,
  type TempDatabase,
} from "./test-helpers";
import { UndoHistory } from "./undo-history";
import {
  forgetVoiceRead,
  recognizedVoices,
  runsNeedingVoices,
  setLearnFromDictations,
  storeVoicePass,
  storeVoiceRead,
  voiceLikeness,
  voiceMatches,
  voiceRead,
  voiceReadConsent,
} from "./voices";

// The user's voice read (ADR 034): one more of their references, never
// enough alone to recognize them.

let temp: TempDatabase;
beforeEach(() => {
  temp = tempDatabase();
});
afterEach(() => temp.cleanup());

const version = "wespeaker-v2:test";
const mic = "input:BuiltInMicrophoneDevice/1/1";
const other = "input:BuiltInMicrophoneDevice/1/2";
const DAY = 86_400;

/** A unit vector pointing mostly along `axis`, a little along `lean`. */
function voice(axis: number, lean = (axis + 1) % 256, amount = 0): number[] {
  const vector = Array.from({ length: 256 }, () => 0);
  vector[axis] = Math.sqrt(1 - amount * amount);
  vector[lean] = amount;
  return vector;
}

/** An in-person conversation on the microphone, `start` seconds after t0, its voices embedded. */
function room(start: number, first: number[], second?: number[]) {
  const episode = seedEpisode(temp.db, [[start, start + 40]]);
  temp.db.client
    .prepare("UPDATE episodes SET context = 'in_person' WHERE id = ?")
    .run(episode.episodeId);
  const runId = startRun(temp.db, episode.episodeId, "asr");
  const turns = [
    [start, start + 20, mic],
    [start + 20, start + 40, other],
  ] as const;
  publishAnalysis(temp.db, {
    episodeId: episode.episodeId,
    stage: "asr",
    runId,
    inputGeneration: 1,
    segments: turns.map(([a, b, label]) => segment(episode.trackRunId, a, b, "mot", label)),
    turns: turns.map(([a, b, label]) => turn(episode.trackRunId, a, b, label)),
  });
  storeVoicePass(temp.db, {
    episodeId: episode.episodeId,
    runId,
    embedderVersion: version,
    voices: [
      { label: mic, vector: first, speechMs: 20_000 },
      ...(second === undefined ? [] : [{ label: other, vector: second, speechMs: 20_000 }]),
    ],
    nowMs: t0,
  });
  return { ...episode, runId };
}

function read(vector: number[], atMs = t0) {
  const stored = storeVoiceRead(temp.db, {
    consent: voiceReadConsent(temp.db),
    selfName: "Moi",
    embedderVersion: version,
    vector,
    speechMs: 24_000,
    nowMs: atMs,
  });
  if (!stored.ok) throw new Error(stored.reason);
  return stored.person;
}

function nameAs(target: { episodeId: number; runId: number }, personId: number) {
  const named = nameSpeaker(temp.db, {
    ...target,
    label: mic,
    person: { kind: "existing", personId },
    nowMs: t0,
  });
  if (!named.ok) throw new Error(named.reason);
}

const reads = () => temp.db.client.prepare("SELECT count(*) AS n FROM voice_reads").get()?.["n"];

describe("the user's voice read (ADR 034)", () => {
  it("makes the user's row and reads their voice as them, to confirm, from the first day", () => {
    const moi = read(voice(0, 1, 0.3));
    expect(moi).toMatchObject({ name: "Moi", isSelf: true });
    expect(voiceRead(temp.db)).toMatchObject({ person: { id: moi.id }, speechMs: 24_000 });
    const heard = room(DAY, voice(0, 4, 0.7), voice(80));
    expect(voiceMatches(temp.db, heard.runId).get(mic)).toMatchObject({
      person: { id: moi.id },
      zone: "likely",
      references: 1,
      reads: 1,
      dictations: 0,
    });
    // A stranger is nobody.
    expect(voiceMatches(temp.db, heard.runId).has(other)).toBe(false);
    expect(voiceLikeness(temp.db, { runId: heard.runId, label: mic })).toMatchObject([
      { person: { id: moi.id }, references: 1, reads: 1 },
    ]);
  });

  it("counts as one reference on its day: recognition still needs named voices on another", () => {
    const moi = read(voice(0, 1, 0.3));
    const heard = room(3 * DAY, voice(0, 5, 0.7));
    // One named voice the same day as the read: two references, one day.
    nameAs(room(60, voice(0, 2, 0.3)), moi.id);
    expect(voiceMatches(temp.db, heard.runId).get(mic)).toMatchObject({
      zone: "likely",
      references: 2,
    });
    // A second, on another day: three references on two days.
    nameAs(room(DAY, voice(0, 3, 0.3)), moi.id);
    expect(voiceMatches(temp.db, heard.runId).get(mic)).toMatchObject({
      zone: "recognized",
      references: 3,
      reads: 1,
    });
    expect(recognizedVoices(temp.db).map((entry) => entry.episodeId)).toEqual([heard.episodeId]);
  });

  it("replaces the last read when read again, and keeps one name for the user", () => {
    const first = read(voice(0, 1, 0.3));
    const again = read(voice(0, 2, 0.3), t0 + 1_000);
    expect(again.id).toBe(first.id);
    expect(reads()).toBe(1);
    expect(voiceRead(temp.db)?.createdAtMs).toBe(t0 + 1_000);
  });

  it("is refused while voices are not recognized, and goes when recognition is turned off", () => {
    setRecognition(temp.db, { on: false, nowMs: t0 });
    expect(
      storeVoiceRead(temp.db, {
        consent: voiceReadConsent(temp.db),
        selfName: "Moi",
        embedderVersion: version,
        vector: voice(0),
        speechMs: 20_000,
        nowMs: t0,
      }),
    ).toEqual({ ok: false, reason: "recognition-off" });
    // Refused whole: no user's row made for it either.
    expect(temp.db.client.prepare("SELECT count(*) AS n FROM people").get()?.["n"]).toBe(0);
    setRecognition(temp.db, { on: true, nowMs: t0 });
    read(voice(0, 1, 0.3));
    setRecognition(temp.db, { on: false, nowMs: t0 });
    expect(reads()).toBe(0);
  });

  it("goes with « Oublier ma voix lue » and with the user's row", () => {
    const moi = read(voice(0, 1, 0.3));
    expect(forgetVoiceRead(temp.db)).toBe(true);
    expect(forgetVoiceRead(temp.db)).toBe(false);
    read(voice(0, 1, 0.3));
    expect(deletePerson(temp.db, moi.id)).toBe(true);
    expect(reads()).toBe(0);
    expect(voiceRead(temp.db)).toBeNull();
  });

  it("is never kept when the user or recognition changed while it was read", () => {
    const moi = read(voice(0, 1, 0.3));
    const store = (consent: ReturnType<typeof voiceReadConsent>) =>
      storeVoiceRead(temp.db, {
        consent,
        selfName: "Moi",
        embedderVersion: version,
        vector: voice(0, 2, 0.3),
        speechMs: 20_000,
        nowMs: t0,
      });
    // Recognition turned off then on during the read.
    const before = voiceReadConsent(temp.db);
    setRecognition(temp.db, { on: false, nowMs: t0 + 1 });
    setRecognition(temp.db, { on: true, nowMs: t0 + 2 });
    expect(store(before)).toEqual({ ok: false, reason: "changed" });
    // The user deleted during the read: not made again for it.
    read(voice(0, 1, 0.3));
    const during = voiceReadConsent(temp.db);
    deletePerson(temp.db, moi.id);
    expect(store(during)).toEqual({ ok: false, reason: "changed" });
    expect(temp.db.client.prepare("SELECT count(*) AS n FROM people").get()?.["n"]).toBe(0);
    expect(reads()).toBe(0);
  });

  it("follows the user back when a merge is undone", () => {
    const history = new UndoHistory(temp.db);
    const moi = read(voice(0, 1, 0.3));
    const named = nameSpeaker(temp.db, {
      ...room(60, voice(9)),
      label: mic,
      person: { kind: "new", name: "Téo" },
      nowMs: t0,
    });
    if (!named.ok) throw new Error(named.reason);
    const teo = named.value;
    history.track(
      "people-merge",
      { level: "people", episodeIds: [], personIds: [teo.id, moi.id] },
      () => mergePeople(temp.db, { personId: teo.id, otherId: moi.id, nowMs: t0 }),
    );
    expect(voiceRead(temp.db)?.person.id).toBe(teo.id);
    expect(history.undo(t0)).toMatchObject({ outcome: "undone" });
    expect(voiceRead(temp.db)?.person).toEqual({ id: moi.id, name: "Moi", isSelf: true });
    expect(history.redo(t0)).toMatchObject({ outcome: "redone" });
    expect(voiceRead(temp.db)?.person.id).toBe(teo.id);
  });

  it("follows the user into a merge", () => {
    const moi = read(voice(0, 1, 0.3));
    const marie = nameSpeaker(temp.db, {
      ...room(60, voice(9)),
      label: mic,
      person: { kind: "new", name: "Téo" },
      nowMs: t0,
    });
    if (!marie.ok) throw new Error(marie.reason);
    expect(mergePeople(temp.db, { personId: marie.value.id, otherId: moi.id, nowMs: t0 })).toEqual({
      ok: true,
      value: { ...marie.value, isSelf: true },
    });
    expect(voiceRead(temp.db)?.person).toEqual({ id: marie.value.id, name: "Téo", isSelf: true });
  });

  it("is never erased by undoing the name that made the user's row", () => {
    const history = new UndoHistory(temp.db);
    const first = room(60, voice(0, 1, 0.3));
    const scope = { level: "assertions" as const, episodeIds: [first.episodeId], personIds: [] };
    history.track(
      "name",
      scope,
      () => {
        const named = nameSpeaker(temp.db, {
          ...first,
          label: mic,
          person: { kind: "self", name: "Moi" },
          nowMs: t0,
        });
        if (!named.ok) throw new Error(named.reason);
        return named.value;
      },
      (person) => ({ personIds: [person.id] }),
    );
    read(voice(0, 2, 0.3));
    // The row the name made now holds the read: ⌘Z says the state changed.
    expect(history.undo(t0)).toMatchObject({ outcome: "refused", reason: "changed" });
    expect(voiceRead(temp.db)).toMatchObject({ person: { name: "Moi" } });
  });

  it("vouches for the user's dictations with no voice named", () => {
    setLearnFromDictations(temp.db, { on: true, nowMs: t0 });
    expect(runsNeedingVoices(temp.db, { embedderVersion: version, sinceMs: 0, limit: 10 })).toEqual(
      [],
    );
    const dictation = seedEpisode(temp.db, [[100, 120]]);
    temp.db.client
      .prepare("UPDATE episodes SET context = 'dictation' WHERE id = ?")
      .run(dictation.episodeId);
    const runId = startRun(temp.db, dictation.episodeId, "asr");
    publishAnalysis(temp.db, {
      episodeId: dictation.episodeId,
      stage: "asr",
      runId,
      inputGeneration: 1,
      segments: [segment(dictation.trackRunId, 100, 120, "mot", mic)],
      turns: [turn(dictation.trackRunId, 100, 120, mic)],
    });
    read(voice(0, 1, 0.3));
    expect(
      runsNeedingVoices(temp.db, { embedderVersion: version, sinceMs: 0, limit: 10 }).map(
        (run) => run.episodeId,
      ),
    ).toEqual([dictation.episodeId]);
  });
});
