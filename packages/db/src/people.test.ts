import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteEpisode } from "./delete-episode";
import {
  currentSpeakerRun,
  deletePerson,
  episodePeople,
  listPeople,
  mergePeople,
  nameSpeaker,
  recognitionEnabled,
  renamePerson,
  namingAllowed,
  resolveSpeakers,
  setEpisodeRecognition,
  setRecognition,
  unnameSpeaker,
} from "./people";
import { publishAnalysis } from "./publish";
import { refuseSuggestion, storeVoicePass } from "./voices";
import {
  at,
  count,
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

type Turn = readonly [start: number, end: number, label: string];

/** Publishes a transcript of `turns` (one segment each) and returns its run. */
function publish(episodeId: number, trackRunId: number, turns: readonly Turn[]): number {
  const runId = startRun(temp.db, episodeId, "asr");
  const result = publishAnalysis(temp.db, {
    episodeId,
    stage: "asr",
    runId,
    inputGeneration: 1,
    segments: turns.map(([start, end, label]) => segment(trackRunId, start, end, "mot", label)),
    turns: turns.map(([start, end, label]) => turn(trackRunId, start, end, label)),
  });
  expect(result.published).toBe(true);
  return runId;
}

const names = (runId: number) =>
  Object.fromEntries([...resolveSpeakers(temp.db, runId)].map(([label, p]) => [label, p.name]));

const conversation: readonly Turn[] = [
  [10, 20, "A"],
  [20, 30, "B"],
  [30, 45, "A"],
  [45, 50, "B"],
];

function named(label: string, name: string, runId: number, episodeId: number, nowMs = t0) {
  const result = nameSpeaker(temp.db, {
    episodeId,
    runId,
    label,
    person: { kind: "new", name },
    nowMs,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

describe("naming voices", () => {
  it("names one voice of the transcript, anchored to its turns", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 50]]);
    const runId = publish(episodeId, trackRunId, conversation);
    expect(currentSpeakerRun(temp.db, episodeId)).toBe(runId);
    named("A", "  Marie   Curie ", runId, episodeId);
    expect(names(runId)).toEqual({ A: "Marie Curie" });
    expect(count(temp.db, "user_assertions", "kind = 'speaker_is'")).toBe(2);
  });

  it("keeps the first name when a second voice's sentence has its words spread over it", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[0, 300]]);
    const runId = startRun(temp.db, episodeId, "asr");
    // One word a second, but B's second sentence: three words over four minutes.
    const spoken = (start: number, end: number, words: number, label: string) => ({
      ...segment(trackRunId, start, end, "mot", label),
      words: Array.from({ length: words }, (_, index) => ({
        charStart: 0,
        charEnd: 3,
        startMs: Math.round((index * (end - start) * 1000) / words),
        endMs: Math.round(((index + 1) * (end - start) * 1000) / words),
      })),
    });
    const segments = [
      spoken(0, 10, 10, "A"),
      spoken(10, 15, 5, "B"),
      spoken(15, 250, 3, "B"),
      spoken(20, 60, 40, "A"),
      spoken(100, 200, 100, "A"),
    ];
    publishAnalysis(temp.db, {
      episodeId,
      stage: "asr",
      runId,
      inputGeneration: 1,
      segments,
      turns: [turn(trackRunId, 10, 250, "B")],
    });
    named("A", "Marie", runId, episodeId);
    named("B", "Jean", runId, episodeId);
    expect(names(runId)).toEqual({ A: "Marie", B: "Jean" });
  });

  it("keeps both names of two voices that talk over each other", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[0, 60]]);
    // B says « oui » and « hm » over a third of A's speech.
    const runId = publish(episodeId, trackRunId, [
      [0, 30, "A"],
      [20, 40, "B"],
      [40, 50, "A"],
      [45, 60, "B"],
    ]);
    named("A", "Marie", runId, episodeId);
    named("B", "Jean", runId, episodeId);
    expect(names(runId)).toEqual({ A: "Marie", B: "Jean" });
  });

  it("keeps the name through a reanalysis that relabels, splits, or merges voices", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 50]]);
    const first = publish(episodeId, trackRunId, conversation);
    named("A", "Marie", first, episodeId);
    named("B", "Jean", first, episodeId);

    // Same voices, new labels.
    const relabelled = publish(episodeId, trackRunId, [
      [10, 20, "x"],
      [20, 30, "y"],
      [30, 45, "x"],
      [45, 50, "y"],
    ]);
    expect(names(relabelled)).toEqual({ x: "Marie", y: "Jean" });

    // Marie's voice split in two: both parts keep her name.
    const split = publish(episodeId, trackRunId, [
      [10, 20, "m1"],
      [20, 30, "j"],
      [30, 45, "m2"],
      [45, 50, "j"],
    ]);
    expect(names(split)).toEqual({ m1: "Marie", m2: "Marie", j: "Jean" });

    // Marie and Jean merged into one voice: it stays unnamed, nothing overwritten.
    const merged = publish(episodeId, trackRunId, [[10, 50, "all"]]);
    expect(names(merged)).toEqual({});
  });

  it("does not lend a name to a voice that only overlaps it", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 60]]);
    const runId = publish(episodeId, trackRunId, [
      [10, 40, "A"],
      [38, 41, "B"],
      [41, 60, "B"],
    ]);
    named("A", "Marie", runId, episodeId);
    expect(names(runId)).toEqual({ A: "Marie" });
  });

  it("refuses a transcript that is no longer current, media, and a do-not-identify rule", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 50]]);
    const old = publish(episodeId, trackRunId, conversation);
    const current = publish(episodeId, trackRunId, conversation);
    const ask = (runId: number) =>
      nameSpeaker(temp.db, {
        episodeId,
        runId,
        label: "A",
        person: { kind: "new", name: "Marie" },
        nowMs: t0,
      });
    expect(ask(old)).toEqual({ ok: false, reason: "stale" });
    expect(count(temp.db, "people")).toBe(0);

    temp.db.client.exec(
      `INSERT INTO identity_rules (scope, recognize, created_at_ms, updated_at_ms) VALUES ('global', 0, 0, 0)`,
    );
    expect(ask(current)).toEqual({ ok: false, reason: "not-allowed" });
    temp.db.client
      .prepare(
        `INSERT INTO identity_rules (scope, episode_id, recognize, created_at_ms, updated_at_ms) VALUES ('episode', ?, 1, 0, 0)`,
      )
      .run(episodeId);
    expect(ask(current).ok).toBe(true);

    temp.db.client.prepare("UPDATE episodes SET context = 'media' WHERE id = ?").run(episodeId);
    expect(ask(current)).toEqual({ ok: false, reason: "not-allowed" });
  });

  it("never brings back an older name when the newer one is taken off", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 50]]);
    const runId = publish(episodeId, trackRunId, conversation);
    named("A", "Marie", runId, episodeId);
    named("A", "Jeanne", runId, episodeId, t0 + 1);
    expect(names(runId)).toEqual({ A: "Jeanne" });
    expect(unnameSpeaker(temp.db, { episodeId, runId, label: "A", nowMs: t0 + 2 })).toEqual({
      ok: true,
      value: null,
    });
    expect(names(runId)).toEqual({});
    expect(count(temp.db, "people")).toBe(2);
  });

  it("names the user once, whatever voice says « c'est moi »", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 50]]);
    const runId = publish(episodeId, trackRunId, conversation);
    const me = (label: string) =>
      nameSpeaker(temp.db, {
        episodeId,
        runId,
        label,
        person: { kind: "self", name: "Moi" },
        nowMs: t0,
      });
    const a = me("A");
    const b = me("B");
    expect(a.ok && b.ok && a.value.id === b.value.id && a.value.isSelf).toBe(true);
    expect(count(temp.db, "people")).toBe(1);
  });
});

describe("naming voices, edge cases", () => {
  it("counts speech once when anchors overlap, and leaves a tie unnamed", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 20]]);
    const runId = publish(episodeId, trackRunId, [[10, 20, "A"]]);
    const person = (name: string) =>
      Number(
        temp.db.client
          .prepare(
            "INSERT INTO people (name, created_at_ms, updated_at_ms) VALUES (?, 0, 0) RETURNING id",
          )
          .get(name)?.["id"],
      );
    const anchor = temp.db.client.prepare(
      `INSERT INTO user_assertions (kind, track_run_id, sample_start, sample_end, origin, created_at_ms, person_id)
       VALUES ('speaker_is', ?, ?, ?, 'app', 0, ?)`,
    );
    const marie = person("Marie");
    // Twice the same 3 s: 3 s of a 10 s voice, not 6 s.
    anchor.run(trackRunId, at(10), at(13), marie);
    anchor.run(trackRunId, at(10), at(13), marie);
    expect(names(runId)).toEqual({});
    // Marie and Jean over the whole voice: neither wins.
    anchor.run(trackRunId, at(10), at(20), marie);
    anchor.run(trackRunId, at(10), at(20), person("Jean"));
    expect(names(runId)).toEqual({});
  });

  it("corrects one voice without unnaming the voice it overlaps", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 30]]);
    const runId = publish(episodeId, trackRunId, [
      [10, 20, "A"],
      [19, 30, "B"],
    ]);
    named("A", "Marie", runId, episodeId);
    named("B", "Jean", runId, episodeId, t0 + 1);
    expect(names(runId)).toEqual({ A: "Marie", B: "Jean" });
    expect(unnameSpeaker(temp.db, { episodeId, runId, label: "B", nowMs: t0 + 2 }).ok).toBe(true);
    expect(names(runId)).toEqual({ A: "Marie" });
  });

  it("reads no name where voices may no longer be identified", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 50]]);
    const runId = publish(episodeId, trackRunId, conversation);
    named("A", "Marie", runId, episodeId);
    temp.db.client
      .prepare(
        `INSERT INTO identity_rules (scope, episode_id, recognize, created_at_ms, updated_at_ms) VALUES ('episode', ?, 0, 0, 0)`,
      )
      .run(episodeId);
    expect(names(runId)).toEqual({});
    expect(listPeople(temp.db).map((entry) => entry.episodeIds)).toEqual([[]]);
  });

  it("names a voice that says less than a second, as the user names it", () => {
    // « Ouais, d'accord. », 0.63 s, the voice's only sentence.
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 40]]);
    const runId = publish(episodeId, trackRunId, [
      [10, 30, "A"],
      [30, 37, "B"],
      [38, 38.63, "C"],
    ]);
    const self = nameSpeaker(temp.db, {
      episodeId,
      runId,
      label: "C",
      person: { kind: "self", name: "Moi" },
      nowMs: t0,
    });
    expect(self.ok).toBe(true);
    expect(names(runId)).toEqual({ C: "Moi" });
    // Saying it again writes nothing.
    const anchors = () => count(temp.db, "user_assertions");
    const before = anchors();
    expect(
      nameSpeaker(temp.db, {
        episodeId,
        runId,
        label: "C",
        person: { kind: "self", name: "Moi" },
        nowMs: t0 + 1,
      }),
    ).toEqual(self);
    expect(anchors()).toBe(before);
    // Its name survives a reanalysis that moves its bounds a little.
    const again = publish(episodeId, trackRunId, [
      [10, 30, "x"],
      [30, 37, "y"],
      [37.9, 38.7, "z"],
    ]);
    expect(names(again)).toEqual({ z: "Moi" });
  });

  it("does not give a short voice the name of a longer voice it was cut from", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 40]]);
    const first = publish(episodeId, trackRunId, [
      [10, 20, "A"],
      [20, 30, "B"],
    ]);
    named("A", "Marie", first, episodeId);
    // A reanalysis hears a « hm » of 0.6 s at the end of Marie's turn as another voice.
    const split = publish(episodeId, trackRunId, [
      [10, 19.4, "m"],
      [19.4, 20, "hm"],
      [20, 30, "j"],
    ]);
    expect(names(split)).toEqual({ m: "Marie" });
  });

  it("names a voice of many short turns", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[0, 900]]);
    const turns: Turn[] = Array.from({ length: 450 }, (_, i) => [i * 2, i * 2 + 1, "A"] as const);
    const runId = publish(episodeId, trackRunId, turns);
    named("A", "Marie", runId, episodeId);
    expect(names(runId)).toEqual({ A: "Marie" });
  });
});

describe("people", () => {
  it("lists people with the episodes their name reaches, renames and deletes them", () => {
    const one = seedEpisode(temp.db, [[10, 50]]);
    const two = seedEpisode(temp.db, [[100, 140]], one.trackRunId);
    const runOne = publish(one.episodeId, one.trackRunId, conversation);
    const runTwo = publish(two.episodeId, two.trackRunId, [
      [100, 120, "P"],
      [120, 140, "Q"],
    ]);
    const marie = named("A", "Marie", runOne, one.episodeId);
    nameSpeaker(temp.db, {
      episodeId: two.episodeId,
      runId: runTwo,
      label: "P",
      person: { kind: "existing", personId: marie.id },
      nowMs: t0,
    });
    named("B", "Jean", runOne, one.episodeId);

    expect(
      listPeople(temp.db).map((entry) => [entry.person.name, entry.episodeIds, entry.lastHeardMs]),
    ).toEqual([
      ["Marie", [two.episodeId, one.episodeId], t0 + 100_000],
      ["Jean", [one.episodeId], t0 + 10_000],
    ]);

    expect(renamePerson(temp.db, { personId: marie.id, name: "Marie C.", nowMs: t0 })).toBe(true);
    expect(renamePerson(temp.db, { personId: marie.id, name: "   ", nowMs: t0 })).toBe(false);
    expect(names(runTwo)).toEqual({ P: "Marie C." });

    expect(deletePerson(temp.db, marie.id)).toBe(true);
    expect(names(runOne)).toEqual({ B: "Jean" });
    expect(count(temp.db, "user_assertions", `person_id = ${marie.id}`)).toBe(0);
    expect(deletePerson(temp.db, marie.id)).toBe(false);
  });

  it("turns recognition off and on: no name reads while off, and voice embeddings go", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 50]]);
    const runId = publish(episodeId, trackRunId, conversation);
    named("A", "Marie", runId, episodeId);
    temp.db.client
      .prepare(
        `INSERT INTO speaker_embeddings (run_id, episode_id, label, embedder_version, vector, speech_ms, created_at_ms)
         VALUES (?, ?, 'A', 'v', zeroblob(1024), 9000, 0)`,
      )
      .run(runId, episodeId);
    expect(recognitionEnabled(temp.db)).toBe(true);
    setRecognition(temp.db, { on: false, nowMs: t0 });
    expect(recognitionEnabled(temp.db)).toBe(false);
    expect(names(runId)).toEqual({});
    expect(count(temp.db, "speaker_embeddings")).toBe(0);
    setRecognition(temp.db, { on: true, nowMs: t0 + 1 });
    expect(names(runId)).toEqual({ A: "Marie" });
  });

  it("lists the people of each episode, the user first", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 50]]);
    const runId = publish(episodeId, trackRunId, conversation);
    named("A", "Marie", runId, episodeId);
    nameSpeaker(temp.db, {
      episodeId,
      runId,
      label: "B",
      person: { kind: "self", name: "Moi" },
      nowMs: t0,
    });
    expect(
      episodePeople(temp.db, [episodeId, 999])
        .get(episodeId)
        ?.map((person) => person.name),
    ).toEqual(["Moi", "Marie"]);
    expect(episodePeople(temp.db, [999]).size).toBe(0);
  });

  it("loses the anchors of a deleted recording with it", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 50]]);
    const runId = publish(episodeId, trackRunId, conversation);
    named("A", "Marie", runId, episodeId);
    deleteEpisode(temp.db, episodeId, { origin: "app", nowMs: t0 + 60_000 });
    expect(count(temp.db, "user_assertions")).toBe(0);
    expect(listPeople(temp.db).map((entry) => entry.episodeIds)).toEqual([[]]);
  });
});

describe("merging people", () => {
  /** Two conversations on one track: Marie in the first, « Marie D. » in the second. */
  function twoMaries() {
    const one = seedEpisode(temp.db, [[10, 50]]);
    const two = seedEpisode(temp.db, [[100, 140]], one.trackRunId);
    const runOne = publish(one.episodeId, one.trackRunId, conversation);
    const runTwo = publish(two.episodeId, two.trackRunId, [
      [100, 120, "P"],
      [120, 140, "Q"],
    ]);
    const marie = named("A", "Marie", runOne, one.episodeId);
    const other = named("P", "Marie D.", runTwo, two.episodeId);
    return { one, two, runOne, runTwo, marie, other };
  }
  const anchors = (kind: string) =>
    temp.db.client
      .prepare(
        `SELECT person_id, sample_start, sample_end FROM user_assertions
         WHERE kind = ? AND revoked_at_ms IS NULL ORDER BY sample_start, id`,
      )
      .all(kind);

  it("gives the other's voices to the person who stays, with their name", () => {
    const { one, two, runOne, runTwo, marie, other } = twoMaries();
    const merged = mergePeople(temp.db, { personId: marie.id, otherId: other.id, nowMs: t0 });
    expect(merged).toEqual({ ok: true, value: marie });
    expect(names(runOne)).toEqual({ A: "Marie" });
    expect(names(runTwo)).toEqual({ P: "Marie" });
    expect(listPeople(temp.db).map((entry) => [entry.person.id, entry.episodeIds])).toEqual([
      [marie.id, [two.episodeId, one.episodeId]],
    ]);
    expect(count(temp.db, "people")).toBe(1);
  });

  it("names a voice whose speech the two names shared", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 50]]);
    const runId = publish(episodeId, trackRunId, [[10, 50, "A"]]);
    const marie = named("A", "Marie", runId, episodeId);
    // Two voices named apart, joined by a later transcript: a tie, unnamed.
    const other = Number(
      temp.db.client
        .prepare("INSERT INTO people (name, created_at_ms, updated_at_ms) VALUES ('M.', 0, 0)")
        .run().lastInsertRowid,
    );
    temp.db.client
      .prepare("UPDATE user_assertions SET sample_end = ? WHERE person_id = ?")
      .run(at(30), marie.id);
    temp.db.client
      .prepare(
        `INSERT INTO user_assertions (kind, track_run_id, sample_start, sample_end, origin, created_at_ms, person_id)
         VALUES ('speaker_is', ?, ?, ?, 'app', ?, ?)`,
      )
      .run(trackRunId, at(30), at(50), t0, other);
    expect(names(runId)).toEqual({});
    expect(mergePeople(temp.db, { personId: marie.id, otherId: other, nowMs: t0 }).ok).toBe(true);
    expect(names(runId)).toEqual({ A: "Marie" });
  });

  it("keeps the user, whichever of the two it was", () => {
    const { one, runOne, runTwo, marie } = twoMaries();
    const me = nameSpeaker(temp.db, {
      episodeId: one.episodeId,
      runId: runOne,
      label: "B",
      person: { kind: "self", name: "Moi" },
      nowMs: t0,
    });
    if (!me.ok) throw new Error(me.reason);
    const merged = mergePeople(temp.db, { personId: marie.id, otherId: me.value.id, nowMs: t0 });
    expect(merged).toEqual({ ok: true, value: { ...marie, isSelf: true } });
    expect(
      temp.db.client
        .prepare("SELECT id FROM people WHERE is_self = 1")
        .all()
        .map((row) => row["id"]),
    ).toEqual([marie.id]);
    expect(names(runOne)).toEqual({ A: "Marie", B: "Marie" });
    expect(names(runTwo)).toEqual({ P: "Marie D." });
  });

  it("lets a name win over « Non », and refuses each stretch once", () => {
    const { one, two, runOne, runTwo, marie, other } = twoMaries();
    // « Non, ce n'est pas Marie » on the voice later named Marie D.,
    // and on Q both Marie and Marie D. were refused.
    const refuse = (episodeId: number, runId: number, label: string, personId: number) =>
      expect(refuseSuggestion(temp.db, { episodeId, runId, label, personId, nowMs: t0 })).toBe(
        "ok",
      );
    refuse(two.episodeId, runTwo, "P", marie.id);
    refuse(two.episodeId, runTwo, "Q", marie.id);
    refuse(two.episodeId, runTwo, "Q", other.id);
    refuse(one.episodeId, runOne, "B", other.id);
    expect(mergePeople(temp.db, { personId: marie.id, otherId: other.id, nowMs: t0 }).ok).toBe(
      true,
    );
    expect(anchors("speaker_is_not")).toEqual([
      { person_id: marie.id, sample_start: at(20), sample_end: at(30) },
      { person_id: marie.id, sample_start: at(45), sample_end: at(50) },
      { person_id: marie.id, sample_start: at(120), sample_end: at(140) },
    ]);
    expect(names(runTwo)).toEqual({ P: "Marie" });
  });

  it("refuses one person twice and a person who is gone", () => {
    const { marie, other } = twoMaries();
    expect(mergePeople(temp.db, { personId: marie.id, otherId: marie.id, nowMs: t0 })).toEqual({
      ok: false,
      reason: "same",
    });
    expect(deletePerson(temp.db, other.id)).toBe(true);
    expect(mergePeople(temp.db, { personId: marie.id, otherId: other.id, nowMs: t0 })).toEqual({
      ok: false,
      reason: "not-found",
    });
    expect(count(temp.db, "people")).toBe(1);
  });
});

describe("« Reconnaître les voix ici »", () => {
  it("hides names in one episode, deletes its embeddings, and keeps a rule only when it differs", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 50]]);
    const runId = publish(episodeId, trackRunId, conversation);
    const named = nameSpeaker(temp.db, {
      episodeId,
      runId,
      label: "A",
      person: { kind: "new", name: "Marie" },
      nowMs: t0,
    });
    if (!named.ok) throw new Error(named.reason);
    storeVoicePass(temp.db, {
      episodeId,
      runId,
      embedderVersion: "v",
      voices: [
        {
          label: "A",
          vector: Array.from({ length: 256 }, (_, i) => (i === 0 ? 1 : 0)),
          speechMs: 9_000,
        },
      ],
      nowMs: t0,
    });
    const rules = () => count(temp.db, "identity_rules", "scope = 'episode'");

    expect(setEpisodeRecognition(temp.db, { episodeId, allowed: false, nowMs: t0 })).toBe(true);
    expect(namingAllowed(temp.db, episodeId)).toBe(false);
    expect(names(runId)).toEqual({});
    expect(count(temp.db, "speaker_embeddings")).toBe(0);
    expect(rules()).toBe(1);

    // Back on: as everywhere else, so no rule is kept; the name reads again.
    expect(setEpisodeRecognition(temp.db, { episodeId, allowed: true, nowMs: t0 })).toBe(true);
    expect(rules()).toBe(0);
    expect(names(runId)).toEqual({ A: "Marie" });

    // With recognition off everywhere, on here is a rule of its own.
    setRecognition(temp.db, { on: false, nowMs: t0 });
    setEpisodeRecognition(temp.db, { episodeId, allowed: true, nowMs: t0 });
    expect(rules()).toBe(1);
    expect(namingAllowed(temp.db, episodeId)).toBe(true);
  });

  it("refuses media, where voices are never recognised", () => {
    const { episodeId } = seedEpisode(temp.db, [[10, 20]]);
    temp.db.client.prepare("UPDATE episodes SET context = 'media' WHERE id = ?").run(episodeId);
    expect(setEpisodeRecognition(temp.db, { episodeId, allowed: true, nowMs: t0 })).toBe(false);
  });
});
