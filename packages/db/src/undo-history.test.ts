import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mergeEpisodes, splitEpisode } from "./episode-boundaries";
import { episodeKindOverride, setEpisodeKind } from "./episode-kind";
import { getEpisodeDetail } from "./episodes-store";
import { enqueueMissingAnalysis } from "./jobs";
import {
  listPeople,
  mergePeople,
  nameSpeaker,
  renamePerson,
  resolveSpeakers,
  unnameSpeaker,
} from "./people";
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
import { editSegment, restoreSegment } from "./transcript-edits";
import { captureUndo } from "./undo";
import { UndoHistory } from "./undo-history";
import { mergeVoice, mergeVoices, refuseSuggestion } from "./voices";

let temp: TempDatabase;
let history: UndoHistory;
beforeEach(() => {
  temp = tempDatabase();
  history = new UndoHistory(temp.db);
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
const ids = () =>
  temp.db.client
    .prepare("SELECT id FROM episodes ORDER BY id")
    .all()
    .map((row) => row["id"]);
const members = () =>
  temp.db.client
    .prepare(
      "SELECT episode_id, speech_region_id, slice_sample_start, slice_sample_end FROM episode_regions ORDER BY episode_id, speech_region_id",
    )
    .all();
const rules = () =>
  temp.db.client
    .prepare("SELECT episode_id, recognize FROM identity_rules ORDER BY episode_id")
    .all();
const edits = () =>
  temp.db.client
    .prepare(
      "SELECT id, sample_start, sample_end FROM user_assertions WHERE kind = 'transcript_edit' ORDER BY id",
    )
    .all();
const print = (episodeIds: number[]) =>
  captureUndo(temp.db, { level: "structure", episodeIds, personIds: [] }).print;
const split = (episodeId: number, atSeconds: number) =>
  history.track(
    "split",
    { level: "structure", episodeIds: [episodeId], personIds: [] },
    () => splitEpisode(temp.db, { episodeId, atMs: s(atSeconds), nowMs: s(100) }),
    (outcome) => ({ episodeIds: outcome.ok ? [outcome.value.newEpisodeId] : [] }),
  );
const merge = (episodeId: number, otherId: number) =>
  history.track(
    "merge",
    { level: "structure", episodeIds: [episodeId, otherId], personIds: [] },
    () => mergeEpisodes(temp.db, { episodeId, otherId, nowMs: s(200) }),
  );

describe("undoing a split", () => {
  it("puts the episode back whole, then redoes it with the same ids", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 30]]);
    close(episodeId);
    publish(
      episodeId,
      [timed(trackRunId, 10, 30, "un deux trois quatre", "A")],
      [turn(trackRunId, 10, 30, "A")],
    );
    const whole = print([episodeId]);
    const outcome = split(episodeId, 20);
    if (!outcome.ok) throw new Error(outcome.reason);
    const { newEpisodeId } = outcome.value;
    const parted = print([episodeId, newEpisodeId]);

    expect(history.undo(s(300))).toEqual({
      outcome: "undone",
      action: "split",
      removed: [newEpisodeId],
      kept: [episodeId],
      removedPeople: [],
      keptPeople: [],
    });
    expect(ids()).toEqual([episodeId]);
    // One segment again, not two pieces side by side.
    expect(texts(episodeId)).toEqual(["un deux trois quatre"]);
    expect(print([episodeId])).toBe(whole);
    expect(enqueueMissingAnalysis(temp.db, s(400))).toEqual([]);

    expect(history.redo(s(500))).toMatchObject({
      outcome: "redone",
      kept: [episodeId, newEpisodeId],
    });
    expect(texts(newEpisodeId)).toEqual(["trois quatre"]);
    expect(print([episodeId, newEpisodeId])).toBe(parted);
    expect(searchEpisodes(temp.db, "quatre", { limit: 5, offset: 0 }).episodes[0]?.episode.id).toBe(
      newEpisodeId,
    );
    expect(history.undo(s(600))).toMatchObject({ outcome: "undone" });
    expect(history.undo(s(700))).toEqual({ outcome: "nothing" });
  });

  it("gives a correction across the cut its whole anchor back", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 30]]);
    close(episodeId);
    const runId = publish(episodeId, [timed(trackRunId, 10, 30, "un deux trois quatre", "A")]);
    const [only] = getEpisodeDetail(temp.db, episodeId)?.segments ?? [];
    editSegment(temp.db, {
      episodeId,
      runId,
      segmentId: only?.id ?? 0,
      nowMs: s(50),
      text: "1 2 3 4",
    });
    const anchors = edits();
    if (!split(episodeId, 20).ok) throw new Error("split refused");
    expect(edits()).not.toEqual(anchors);
    expect(history.undo(s(300))).toMatchObject({ outcome: "undone" });
    expect(edits()).toEqual(anchors);
    expect(texts(episodeId)).toEqual(["1 2 3 4"]);
  });

  it("refuses once the episode changed since, and keeps nothing to redo", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [
      [10, 20],
      [40, 50],
    ]);
    close(episodeId);
    publish(episodeId, [
      segment(trackRunId, 10, 20, "avant"),
      segment(trackRunId, 40, 50, "après"),
    ]);
    const outcome = split(episodeId, 30);
    if (!outcome.ok) throw new Error(outcome.reason);
    // A new transcript of the later part arrived meanwhile.
    temp.db.client
      .prepare("UPDATE segments SET text = 'autre chose' WHERE episode_id = ?")
      .run(outcome.value.newEpisodeId);
    expect(history.undo(s(300))).toEqual({
      outcome: "refused",
      action: "split",
      reason: "changed",
    });
    expect(ids()).toEqual([episodeId, outcome.value.newEpisodeId]);
    expect(history.redo(s(300))).toEqual({ outcome: "nothing" });
  });
});

describe("undoing a merge", () => {
  it("brings back overlapping episodes as they were: ids, slices, voices and rules", () => {
    const first = seedEpisode(temp.db, [[10, 20]]);
    const second = seedEpisode(temp.db, [[15, 30]]);
    for (const id of [first.episodeId, second.episodeId]) close(id);
    publish(
      first.episodeId,
      [segment(first.trackRunId, 10, 20, "bonjour", "S1")],
      [turn(first.trackRunId, 10, 20, "S1")],
    );
    temp.db.client
      .prepare(
        "INSERT INTO identity_rules (scope, episode_id, recognize, created_at_ms, updated_at_ms) VALUES ('episode', ?, 0, 0, 0)",
      )
      .run(second.episodeId);
    const before = { members: members(), rules: rules() };
    const both = print([first.episodeId, second.episodeId]);
    const merged = merge(first.episodeId, second.episodeId);
    if (!merged.ok) throw new Error(merged.reason);
    expect(rules()).toEqual([{ episode_id: first.episodeId, recognize: 0 }]);

    expect(history.undo(s(300))).toEqual({
      outcome: "undone",
      action: "merge",
      removed: [],
      kept: [first.episodeId, second.episodeId],
      removedPeople: [],
      keptPeople: [],
    });
    expect({ members: members(), rules: rules() }).toEqual(before);
    expect(texts(first.episodeId)).toEqual(["bonjour"]);
    expect(print([first.episodeId, second.episodeId])).toBe(both);
    // The untranscribed one is still due; the transcribed one is not.
    expect(enqueueMissingAnalysis(temp.db, s(400))).toHaveLength(1);
  });

  it("refuses when the merged-away id belongs to another episode by then", () => {
    const track = seedTrackRun(temp.db);
    const first = seedEpisode(temp.db, [[10, 20]], track);
    const second = seedEpisode(temp.db, [[60, 70]], track);
    for (const id of [first.episodeId, second.episodeId]) close(id);
    if (!merge(first.episodeId, second.episodeId).ok) throw new Error("merge refused");
    // A new recording takes the free id.
    const next = seedEpisode(temp.db, [[200, 210]], track);
    expect(next.episodeId).toBe(second.episodeId);
    expect(history.undo(s(300))).toEqual({
      outcome: "refused",
      action: "merge",
      reason: "changed",
    });
    expect(count(temp.db, "episodes")).toBe(2);
  });
});

describe("undoing the user's word", () => {
  it("gives back each part's type after a merge was given one", () => {
    const track = seedTrackRun(temp.db);
    const first = seedEpisode(temp.db, [[10, 20]], track);
    const second = seedEpisode(temp.db, [[60, 70]], track);
    for (const id of [first.episodeId, second.episodeId]) close(id);
    setEpisodeKind(temp.db, { episodeId: first.episodeId, kind: "moment", nowMs: s(80) });
    setEpisodeKind(temp.db, { episodeId: second.episodeId, kind: "conversation", nowMs: s(81) });
    if (!merge(first.episodeId, second.episodeId).ok) throw new Error("merge refused");
    history.track("kind", { level: "kind", episodeIds: [first.episodeId], personIds: [] }, () =>
      setEpisodeKind(temp.db, { episodeId: first.episodeId, kind: "media", nowMs: s(250) }),
    );
    expect(episodeKindOverride(temp.db, first.episodeId)).toBe("media");

    expect(history.undo(s(300))).toMatchObject({ outcome: "undone", action: "kind" });
    expect(history.undo(s(310))).toMatchObject({ outcome: "undone", action: "merge" });
    expect(episodeKindOverride(temp.db, first.episodeId)).toBe("moment");
    expect(episodeKindOverride(temp.db, second.episodeId)).toBe("conversation");
  });

  it("keeps a neighbour's part of a type set before a split", () => {
    const { episodeId } = seedEpisode(temp.db, [[10, 40]]);
    close(episodeId);
    setEpisodeKind(temp.db, { episodeId, kind: "moment", nowMs: s(50) });
    const outcome = splitEpisode(temp.db, { episodeId, atMs: s(25), nowMs: s(60) });
    if (!outcome.ok) throw new Error(outcome.reason);
    setEpisodeKind(temp.db, { episodeId, kind: "conversation", nowMs: s(70) });
    expect(episodeKindOverride(temp.db, outcome.value.newEpisodeId)).toBe("moment");
  });

  it("undoes a correction and « Rétablir l'original », and redoes them", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 20]]);
    close(episodeId);
    const runId = publish(episodeId, [segment(trackRunId, 10, 20, "bonjour")]);
    const segmentId = getEpisodeDetail(temp.db, episodeId)?.segments[0]?.id ?? 0;
    const target = { episodeId, runId, segmentId };
    const scope = { level: "text" as const, episodeIds: [episodeId], personIds: [] };
    history.track("text", scope, () =>
      editSegment(temp.db, { ...target, nowMs: s(30), text: "bonsoir" }),
    );
    history.track("text", scope, () => restoreSegment(temp.db, { ...target, nowMs: s(40) }));
    expect(texts(episodeId)).toEqual(["bonjour"]);

    expect(history.undo(s(50))).toMatchObject({ outcome: "undone", action: "text" });
    expect(texts(episodeId)).toEqual(["bonsoir"]);
    expect(searchEpisodes(temp.db, "bonsoir", { limit: 5, offset: 0 }).total).toBe(1);
    expect(history.undo(s(60))).toMatchObject({ outcome: "undone" });
    expect(texts(episodeId)).toEqual(["bonjour"]);
    expect(edits()).toEqual([]);
    expect(history.redo(s(70))).toMatchObject({ outcome: "redone" });
    expect(texts(episodeId)).toEqual(["bonsoir"]);
  });

  it("keeps another voice's sentence over the same stretch as it is", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 20]]);
    close(episodeId);
    const runId = publish(episodeId, [
      segment(trackRunId, 10, 20, "je parle", "A"),
      segment(trackRunId, 10, 20, "moi aussi", "B"),
    ]);
    const mine = getEpisodeDetail(temp.db, episodeId)?.segments.find((x) => x.text === "je parle");
    const scope = { level: "text" as const, episodeIds: [episodeId], personIds: [] };
    history.track("text", scope, () =>
      editSegment(temp.db, {
        episodeId,
        runId,
        segmentId: mine?.id ?? 0,
        nowMs: s(30),
        text: "je chante",
      }),
    );
    expect(history.undo(s(40))).toMatchObject({ outcome: "undone" });
    expect(texts(episodeId).toSorted()).toEqual(["je parle", "moi aussi"]);
    expect(history.redo(s(50))).toMatchObject({ outcome: "redone" });
    expect(texts(episodeId).toSorted()).toEqual(["je chante", "moi aussi"]);
  });

  it("undoes « Rétablir l'original » on a part of a corrected sentence after a split", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 30]]);
    close(episodeId);
    // A silence between « deux » and « trois »: the later part starts after the cut.
    const words = [
      [0, 4_000],
      [4_000, 9_000],
      [12_000, 16_000],
      [16_000, 20_000],
    ];
    const text = "un deux trois quatre";
    const tokens = [...text.matchAll(/\S+/gu)];
    const runId = publish(episodeId, [
      {
        ...segment(trackRunId, 10, 30, text, "A"),
        words: tokens.map((token, index) => ({
          charStart: token.index,
          charEnd: token.index + token[0].length,
          startMs: words[index]?.[0] ?? 0,
          endMs: words[index]?.[1] ?? 0,
        })),
      },
    ]);
    const [only] = getEpisodeDetail(temp.db, episodeId)?.segments ?? [];
    editSegment(temp.db, {
      episodeId,
      runId,
      segmentId: only?.id ?? 0,
      nowMs: s(40),
      text: "1 2 3 4",
    });
    const outcome = splitEpisode(temp.db, { episodeId, atMs: s(20), nowMs: s(50) });
    if (!outcome.ok) throw new Error(outcome.reason);
    const later = getEpisodeDetail(temp.db, outcome.value.newEpisodeId);
    const piece = later?.segments[0];
    expect(piece?.text).toBe("1 2 3 4");
    history.track(
      "text",
      { level: "text", episodeIds: [outcome.value.newEpisodeId], personIds: [] },
      () =>
        restoreSegment(temp.db, {
          episodeId: outcome.value.newEpisodeId,
          runId: later?.analysis?.runId ?? 0,
          segmentId: piece?.id ?? 0,
          nowMs: s(60),
        }),
    );
    expect(texts(outcome.value.newEpisodeId)).toEqual(["trois quatre"]);
    expect(history.undo(s(70))).toMatchObject({ outcome: "undone", action: "text" });
    expect(texts(outcome.value.newEpisodeId)).toEqual(["1 2 3 4"]);
  });

  it("undoes naming a voice as a new person, and keeps others' names under it", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 40]]);
    close(episodeId);
    const runId = publish(
      episodeId,
      [segment(trackRunId, 10, 20, "salut", "A"), segment(trackRunId, 25, 40, "ça va", "A")],
      [turn(trackRunId, 10, 20, "A"), turn(trackRunId, 25, 40, "A")],
    );
    // Two names under one voice (its turns were once two voices).
    const alice = nameSpeaker(temp.db, {
      episodeId,
      runId,
      label: "A",
      person: { kind: "new", name: "Alice" },
      nowMs: s(50),
    });
    if (!alice.ok) throw new Error(alice.reason);
    const anchors = () =>
      temp.db.client
        .prepare(
          "SELECT id, person_id, revoked_at_ms FROM user_assertions WHERE kind = 'speaker_is' ORDER BY id",
        )
        .all();
    const before = anchors();
    const target = { episodeId, runId, label: "A" };
    const carol = history.track(
      "name",
      { level: "assertions", episodeIds: [episodeId], personIds: [] },
      () =>
        nameSpeaker(temp.db, { ...target, person: { kind: "new", name: "Carol" }, nowMs: s(60) }),
      (change) => ({ personIds: change.ok ? [change.value.id] : [] }),
    );
    if (!carol.ok) throw new Error(carol.reason);
    expect(resolveSpeakers(temp.db, runId).get("A")?.name).toBe("Carol");

    expect(history.undo(s(70))).toMatchObject({ outcome: "undone", action: "name" });
    expect(anchors()).toEqual(before);
    expect(resolveSpeakers(temp.db, runId).get("A")?.name).toBe("Alice");
    expect(count(temp.db, "people")).toBe(1);

    expect(history.redo(s(80))).toMatchObject({ outcome: "redone" });
    expect(resolveSpeakers(temp.db, runId).get("A")).toMatchObject({
      id: carol.value.id,
      name: "Carol",
    });
  });

  it("undoes merging two voices by hand: each gets its sentences back, then redoes it", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 40]]);
    close(episodeId);
    publish(
      episodeId,
      [
        segment(trackRunId, 10, 20, "salut", "A"),
        segment(trackRunId, 20, 30, "ça va", "B"),
        segment(trackRunId, 30, 40, "oui", "C"),
      ],
      [turn(trackRunId, 10, 20, "A"), turn(trackRunId, 20, 30, "B"), turn(trackRunId, 30, 40, "C")],
    );
    const voices = () =>
      getEpisodeDetail(temp.db, episodeId)?.segments.map((x) => `${x.text}=${x.speakerLabel}`);
    const runOf = () => getEpisodeDetail(temp.db, episodeId)?.analysis?.runId ?? 0;
    const numbers = () =>
      getEpisodeDetail(temp.db, episodeId)?.speakers.map((x) => `${x.label}${x.ordinal}`);
    expect(voices()).toEqual(["salut=A", "ça va=B", "oui=C"]);
    const merged = history.track(
      "voice-merge",
      { level: "structure", episodeIds: [episodeId], personIds: [] },
      () =>
        mergeVoice(temp.db, { episodeId, runId: runOf(), label: "B", other: "A", nowMs: s(50) }),
    );
    expect(merged).toEqual({ ok: true, value: { label: "A" } });
    expect(voices()).toEqual(["salut=A", "ça va=A", "oui=C"]);
    expect(numbers()).toEqual(["A1", "C2"]);

    expect(history.undo(s(60))).toMatchObject({ outcome: "undone", action: "voice-merge" });
    expect(voices()).toEqual(["salut=A", "ça va=B", "oui=C"]);
    expect(numbers()).toEqual(["A1", "B2", "C3"]);
    expect(history.redo(s(70))).toMatchObject({ outcome: "redone", action: "voice-merge" });
    expect(voices()).toEqual(["salut=A", "ça va=A", "oui=C"]);
    // The same numbers as the merge itself gave.
    expect(numbers()).toEqual(["A1", "C2"]);
  });

  it("undoes « Non », unnaming and a person's new name", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 20]]);
    close(episodeId);
    const runId = publish(
      episodeId,
      [segment(trackRunId, 10, 20, "salut", "A")],
      [turn(trackRunId, 10, 20, "A")],
    );
    const marie = nameSpeaker(temp.db, {
      episodeId,
      runId,
      label: "A",
      person: { kind: "new", name: "Marie" },
      nowMs: s(30),
    });
    if (!marie.ok) throw new Error(marie.reason);
    const target = { episodeId, runId, label: "A" };
    const scope = { level: "assertions" as const, episodeIds: [episodeId], personIds: [] };
    history.track("name", scope, () => unnameSpeaker(temp.db, { ...target, nowMs: s(40) }));
    history.track("refusal", scope, () =>
      refuseSuggestion(temp.db, { ...target, personId: marie.value.id, nowMs: s(50) }),
    );
    history.track(
      "name",
      { level: "assertions", episodeIds: [], personIds: [marie.value.id] },
      () => renamePerson(temp.db, { personId: marie.value.id, name: "Marie-Anne", nowMs: s(60) }),
    );
    const refusals = () => count(temp.db, "user_assertions", "kind = 'speaker_is_not'");
    expect(refusals()).toBe(1);

    expect(history.undo(s(70))).toMatchObject({ outcome: "undone", action: "name" });
    expect(temp.db.client.prepare("SELECT name FROM people").all()).toEqual([{ name: "Marie" }]);
    expect(history.undo(s(80))).toMatchObject({ outcome: "undone", action: "refusal" });
    expect(refusals()).toBe(0);
    expect(history.undo(s(90))).toMatchObject({ outcome: "undone", action: "name" });
    expect(resolveSpeakers(temp.db, runId).get("A")?.name).toBe("Marie");
  });

  it("undoes merging two people, the user and the « Non » included, and redoes it", () => {
    const one = seedEpisode(temp.db, [[10, 40]]);
    const two = seedEpisode(temp.db, [[100, 140]], one.trackRunId);
    close(one.episodeId);
    close(two.episodeId);
    const runOne = publish(
      one.episodeId,
      [segment(one.trackRunId, 10, 20, "salut", "A"), segment(one.trackRunId, 20, 40, "oui", "B")],
      [turn(one.trackRunId, 10, 20, "A"), turn(one.trackRunId, 20, 40, "B")],
    );
    const runTwo = publish(
      two.episodeId,
      [segment(two.trackRunId, 100, 140, "bonjour", "P")],
      [turn(two.trackRunId, 100, 140, "P")],
    );
    const name = (episodeId: number, runId: number, label: string, kind: "self" | "new") => {
      const change = nameSpeaker(temp.db, {
        episodeId,
        runId,
        label,
        person: { kind, name: kind === "self" ? "Moi" : "Téo" },
        nowMs: s(50),
      });
      if (!change.ok) throw new Error(change.reason);
      return change.value;
    };
    const me = name(one.episodeId, runOne, "A", "self");
    const teo = name(two.episodeId, runTwo, "P", "new");
    // « Non, ce n'est pas Téo » on B, then on A, which is the user.
    for (const label of ["A", "B"]) {
      refuseSuggestion(temp.db, {
        episodeId: one.episodeId,
        runId: runOne,
        label,
        personId: teo.id,
        nowMs: s(60),
      });
    }
    const rows = () =>
      temp.db.client
        .prepare(
          "SELECT id, kind, person_id, sample_start, sample_end, revoked_at_ms FROM user_assertions ORDER BY id",
        )
        .all();
    const people = () =>
      temp.db.client.prepare("SELECT id, name, is_self FROM people ORDER BY id").all();
    const before = { rows: rows(), people: people() };
    const merged = history.track(
      "people-merge",
      { level: "people", episodeIds: [], personIds: [teo.id, me.id] },
      () => mergePeople(temp.db, { personId: teo.id, otherId: me.id, nowMs: s(70) }),
    );
    expect(merged).toMatchObject({ ok: true, value: { id: teo.id, isSelf: true } });
    expect(resolveSpeakers(temp.db, runOne).get("A")).toMatchObject({ id: teo.id, isSelf: true });
    expect(resolveSpeakers(temp.db, runTwo).get("P")?.id).toBe(teo.id);
    const after = { rows: rows(), people: people() };

    expect(history.undo(s(80))).toMatchObject({
      outcome: "undone",
      action: "people-merge",
      removedPeople: [],
      keptPeople: [teo.id, me.id],
    });
    expect({ rows: rows(), people: people() }).toEqual(before);
    expect(resolveSpeakers(temp.db, runOne).get("A")).toMatchObject({ id: me.id, isSelf: true });

    expect(history.redo(s(90))).toMatchObject({
      outcome: "redone",
      action: "people-merge",
      removedPeople: [me.id],
      keptPeople: [teo.id],
    });
    expect({ rows: rows(), people: people() }).toEqual(after);
    expect(listPeople(temp.db).map((entry) => entry.person.id)).toEqual([teo.id]);
  });

  it("refuses to undo a merge once linking joined the two people's voices", () => {
    const { episodeId, trackRunId } = seedEpisode(temp.db, [[10, 40]]);
    close(episodeId);
    const runId = publish(
      episodeId,
      [segment(trackRunId, 10, 20, "salut", "A"), segment(trackRunId, 20, 40, "oui", "B")],
      [turn(trackRunId, 10, 20, "A"), turn(trackRunId, 20, 40, "B")],
    );
    const [alice, bob] = (["A", "B"] as const).map((label) => {
      const change = nameSpeaker(temp.db, {
        episodeId,
        runId,
        label,
        person: { kind: "new", name: label === "A" ? "Alice" : "Bob" },
        nowMs: s(50),
      });
      if (!change.ok) throw new Error(change.reason);
      return change.value;
    });
    if (alice === undefined || bob === undefined) throw new Error("people missing");
    history.track(
      "people-merge",
      { level: "people", episodeIds: [], personIds: [alice.id, bob.id] },
      () => mergePeople(temp.db, { personId: alice.id, otherId: bob.id, nowMs: s(60) }),
    );
    // One name now: the voice pass may join the two voices into one.
    expect(
      mergeVoices(temp.db, { episodeId, runId, links: new Map([["B", "A"]]), nowMs: s(70) }),
    ).toBe(true);
    expect(history.undo(s(80))).toEqual({
      outcome: "refused",
      action: "people-merge",
      reason: "changed",
    });
  });

  it("forgets everything on clear", () => {
    const { episodeId } = seedEpisode(temp.db, [[10, 20]]);
    close(episodeId);
    history.track("kind", { level: "kind", episodeIds: [episodeId], personIds: [] }, () =>
      setEpisodeKind(temp.db, { episodeId, kind: "moment", nowMs: s(30) }),
    );
    history.clear();
    expect(history.undo(s(40))).toEqual({ outcome: "nothing" });
  });

  it("keeps nothing for an edit that changed nothing", () => {
    const { episodeId } = seedEpisode(temp.db, [[10, 20]]);
    temp.db.client.prepare("UPDATE episodes SET state = 'open' WHERE id = ?").run(episodeId);
    expect(split(episodeId, 15)).toEqual({ ok: false, reason: "missing" });
    expect(history.undo(s(40))).toEqual({ outcome: "nothing" });
  });
});
