import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteEpisode } from "./delete-episode";
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
import {
  addVocabularyWord,
  finishVocabularyPass,
  listVocabulary,
  loadVocabularyCheck,
  nextVocabularyEpisode,
  removeVocabularyWord,
  respellEpisode,
  updateVocabularyWord,
  vocabularyNamesKey,
  vocabularyNotes,
  vocabularyOf,
} from "./vocabulary";

// The Vocabulary (ADR 046): the user's list, their People's names at
// publish, and the model's reading of names that only look like theirs.

let temp: TempDatabase;
beforeEach(() => {
  temp = tempDatabase();
});
afterEach(() => temp.cleanup());

const person = (name: string) =>
  temp.db.client
    .prepare("INSERT INTO people (name, is_self, created_at_ms, updated_at_ms) VALUES (?, 0, ?, ?)")
    .run(name, t0, t0);

/** A closed in-person conversation of 30 s, transcribed. */
function conversation(start: number, segments: (trackRunId: number) => SegmentInput[]) {
  const { episodeId, trackRunId } = seedEpisode(temp.db, [[start, start + 30]]);
  temp.db.client
    .prepare("UPDATE episodes SET context = 'in_person', state = 'closed' WHERE id = ?")
    .run(episodeId);
  const runId = startRun(temp.db, episodeId, "asr");
  const result = publishAnalysis(temp.db, {
    episodeId,
    stage: "asr",
    runId,
    inputGeneration: 1,
    segments: segments(trackRunId),
    turns: [],
  });
  expect(result.published).toBe(true);
  return { episodeId, runId, trackRunId };
}

const texts = (episodeId: number) =>
  getEpisodeDetail(temp.db, episodeId)?.segments.map((s) => [s.text, s.edited]) ?? [];

describe("the Vocabulary list", () => {
  it("adds, notes, renames and removes words, one per spelling without case or accents", () => {
    const added = addVocabularyWord(temp.db, {
      word: " Sondine ",
      note: " le nom de mon app ",
      nowMs: t0,
    });
    if (typeof added === "string") throw new Error(added);
    expect(addVocabularyWord(temp.db, { word: "sondiné", nowMs: t0 })).toBe("exists");
    const teo = addVocabularyWord(temp.db, { word: "Téo", note: "", nowMs: t0 });
    if (typeof teo === "string") throw new Error(teo);
    person("Hélène");
    person("Téo");
    expect(listVocabulary(temp.db)).toEqual({
      words: [
        { id: added.id, word: "Sondine", note: "le nom de mon app" },
        { id: teo.id, word: "Téo", note: null },
      ],
      // A person whose name is in the list shows once, in the list.
      people: ["Hélène"],
    });
    expect(updateVocabularyWord(temp.db, { id: teo.id, word: "SONDINE", nowMs: t0 })).toBe(
      "exists",
    );
    expect(
      updateVocabularyWord(temp.db, { id: added.id, word: "Sondine", note: null, nowMs: t0 }),
    ).toEqual({
      id: added.id,
    });
    expect(updateVocabularyWord(temp.db, { id: 999, word: "X", nowMs: t0 })).toBe("missing");
    expect(removeVocabularyWord(temp.db, teo.id)).toBe(true);
    expect(listVocabulary(temp.db).words.map((entry) => [entry.word, entry.note])).toEqual([
      ["Sondine", null],
    ]);
  });

  it("spells the user's names at publish, keeping what the engine wrote", () => {
    addVocabularyWord(temp.db, { word: "Téo", nowMs: t0 });
    person("Hélène");
    const { episodeId, runId } = conversation(10, (track) => [
      segment(track, 10, 15, "Ouais Théo t'as vu"),
      segment(track, 15, 20, "avec Elène hier"),
      segment(track, 20, 25, "en théorie oui"),
    ]);
    expect(texts(episodeId)).toEqual([
      ["Ouais Téo t'as vu", true],
      ["avec Hélène hier", true],
      ["en théorie oui", false],
    ]);
    const first = getEpisodeDetail(temp.db, episodeId)?.segments[0]?.id ?? 0;
    expect(restoreSegment(temp.db, { episodeId, runId, segmentId: first, nowMs: t0 + 1 })).toBe(
      "ok",
    );
    expect(texts(episodeId)[0]).toEqual(["Ouais Théo t'as vu", false]);
  });

  it("learns a name corrected at a sentence's start once it is the user's", () => {
    const correct = (names: () => void) => {
      names();
      const { episodeId, runId } = conversation(10, (track) => [
        segment(track, 10, 15, "Théo t'as passé Sandrine"),
      ]);
      const id = getEpisodeDetail(temp.db, episodeId)?.segments[0]?.id ?? 0;
      editSegment(temp.db, {
        episodeId,
        runId,
        segmentId: id,
        nowMs: t0 + 1,
        text: "Téo t'as passé Sondine",
      });
      return vocabularyOf(temp.db).corrections;
    };
    expect(correct(() => undefined).size).toBe(0);
    expect(correct(() => person("Téo")).get("theo")).toBe("Téo");
  });
});

describe("the model's reading of names that look like the user's", () => {
  const sondine = () =>
    addVocabularyWord(temp.db, { word: "Sondine", note: "le nom de mon app", nowMs: t0 });
  const nowMs = t0 + 3_600_000;

  it("finds the words of the list a name looks like, never a person's, and spells the ones the model said", () => {
    sondine();
    person("Marie");
    const { episodeId, runId } = conversation(10, (track) => [
      segment(track, 10, 15, "On teste l'app."),
      segment(track, 15, 20, "Il va capter les appels, Sandrine."),
      segment(track, 20, 25, "Tu vois Maria demain."),
    ]);
    const namesKey = vocabularyNamesKey(temp.db, { model: true });
    expect(nextVocabularyEpisode(temp.db, { namesKey, nowMs })).toBe(episodeId);
    const check = loadVocabularyCheck(
      temp.db,
      episodeId,
      vocabularyOf(temp.db),
      vocabularyNotes(temp.db),
    );
    expect(check?.runId).toBe(runId);
    // « Maria » looks like « Marie », a person: two close first names are most often two people.
    expect(check?.targets.map((target) => [target.word, target.name, target.note])).toEqual([
      ["Sandrine", "Sondine", "le nom de mon app"],
    ]);
    expect(check?.targets[0]?.before).toEqual(["On teste l'app."]);
    expect(check?.targets[0]?.after).toEqual(["Tu vois Maria demain."]);
    const target = check?.targets[0];
    if (check === null || check === undefined || target === undefined) throw new Error("no check");
    const corrected = finishVocabularyPass(temp.db, {
      episodeId,
      runId,
      namesKey,
      status: "done",
      answers: [{ target, userWord: true }],
      candidates: 1,
      nowMs,
    });
    expect(corrected).toBe(1);
    expect(texts(episodeId)[1]).toEqual(["Il va capter les appels, Sondine.", true]);
    expect(searchEpisodes(temp.db, "Sondine", { limit: 5, offset: 0 }).total).toBe(1);
    expect(nextVocabularyEpisode(temp.db, { namesKey, nowMs })).toBeNull();
    // « Rétablir l'original » still works.
    const id = getEpisodeDetail(temp.db, episodeId)?.segments[1]?.id ?? 0;
    expect(restoreSegment(temp.db, { episodeId, runId, segmentId: id, nowMs })).toBe("ok");
    expect(texts(episodeId)[1]).toEqual(["Il va capter les appels, Sandrine.", false]);
    // A new name reads the transcript again, without asking twice about a word.
    addVocabularyWord(temp.db, { word: "Graphical", nowMs });
    const again = vocabularyNamesKey(temp.db, { model: true });
    expect(nextVocabularyEpisode(temp.db, { namesKey: again, nowMs })).toBe(episodeId);
    expect(
      loadVocabularyCheck(temp.db, episodeId, vocabularyOf(temp.db), vocabularyNotes(temp.db))
        ?.targets,
    ).toEqual([]);
  });

  it("keeps the word as written, and a sentence that changed since it was read", () => {
    sondine();
    const { episodeId, runId } = conversation(10, (track) => [
      segment(track, 10, 15, "allez Sandrine, on y va"),
      segment(track, 15, 20, "et Sandine aussi"),
    ]);
    const namesKey = vocabularyNamesKey(temp.db, { model: true });
    const check = loadVocabularyCheck(
      temp.db,
      episodeId,
      vocabularyOf(temp.db),
      vocabularyNotes(temp.db),
    );
    const [first, second] = check?.targets ?? [];
    if (first === undefined || second === undefined) throw new Error("no targets");
    const id = getEpisodeDetail(temp.db, episodeId)?.segments[1]?.id ?? 0;
    editSegment(temp.db, { episodeId, runId, segmentId: id, nowMs, text: "et Sandine aussi, oui" });
    expect(
      finishVocabularyPass(temp.db, {
        episodeId,
        runId,
        namesKey,
        status: "done",
        answers: [
          { target: first, userWord: false },
          { target: second, userWord: true },
        ],
        candidates: 2,
        nowMs,
      }),
    ).toBe(0);
    expect(texts(episodeId)).toEqual([
      ["allez Sandrine, on y va", false],
      ["et Sandine aussi, oui", true],
    ]);
  });

  it("tries a failed pass again 10 minutes later, three times at most", () => {
    sondine();
    const { episodeId, runId } = conversation(10, (track) => [
      segment(track, 10, 15, "allez Sandrine"),
    ]);
    const namesKey = vocabularyNamesKey(temp.db, { model: true });
    const fail = (at: number) =>
      finishVocabularyPass(temp.db, {
        episodeId,
        runId,
        namesKey,
        status: "failed",
        answers: [],
        candidates: 1,
        nowMs: at,
      });
    fail(nowMs);
    expect(nextVocabularyEpisode(temp.db, { namesKey, nowMs: nowMs + 60_000 })).toBeNull();
    expect(nextVocabularyEpisode(temp.db, { namesKey, nowMs: nowMs + 600_000 })).toBe(episodeId);
    fail(nowMs + 600_000);
    fail(nowMs + 1_200_000);
    expect(nextVocabularyEpisode(temp.db, { namesKey, nowMs: nowMs + 3_600_000 })).toBeNull();
  });

  it("reads only the last 7 days, and leaves with the recording", () => {
    sondine();
    const { episodeId } = conversation(10, (track) => [segment(track, 10, 15, "allez Sandrine")]);
    const namesKey = vocabularyNamesKey(temp.db, { model: true });
    expect(nextVocabularyEpisode(temp.db, { namesKey, nowMs: t0 + 8 * 86_400_000 })).toBeNull();
    const check = loadVocabularyCheck(
      temp.db,
      episodeId,
      vocabularyOf(temp.db),
      vocabularyNotes(temp.db),
    );
    const target = check?.targets[0];
    if (check === null || check === undefined || target === undefined) throw new Error("no check");
    finishVocabularyPass(temp.db, {
      episodeId,
      runId: check.runId,
      namesKey,
      status: "done",
      answers: [{ target, userWord: false }],
      candidates: 1,
      nowMs,
    });
    expect(count(temp.db, "vocabulary_checks")).toBe(1);
    expect(deleteEpisode(temp.db, episodeId, { origin: "app" }).deleted).toBe(true);
    expect(count(temp.db, "vocabulary_checks")).toBe(0);
    expect(count(temp.db, "vocabulary_passes")).toBe(0);
  });

  it("spells the last days' transcripts when a name joins the list, and keeps what the user corrected", () => {
    const { episodeId, runId } = conversation(10, (track) => [
      segment(track, 10, 15, "Ouais Théo t'as vu"),
      segment(track, 15, 20, "Théo, c'est toi"),
      segment(track, 20, 25, "merci Théo"),
    ]);
    const third = getEpisodeDetail(temp.db, episodeId)?.segments[2]?.id ?? 0;
    editSegment(temp.db, { episodeId, runId, segmentId: third, nowMs, text: "merci Théo !" });
    const before = vocabularyNamesKey(temp.db, { model: false });
    addVocabularyWord(temp.db, { word: "Téo", nowMs });
    expect(vocabularyNamesKey(temp.db, { model: false })).not.toBe(before);
    // A new correction or the model installed reads them again too.
    expect(vocabularyNamesKey(temp.db, { model: true })).not.toBe(
      vocabularyNamesKey(temp.db, { model: false }),
    );
    expect(respellEpisode(temp.db, episodeId, vocabularyOf(temp.db), nowMs)).toBe(2);
    expect(texts(episodeId)).toEqual([
      ["Ouais Téo t'as vu", true],
      // At a sentence's start too: the transcript writes it as a name elsewhere.
      ["Téo, c'est toi", true],
      ["merci Théo !", true],
    ]);
    expect(respellEpisode(temp.db, episodeId, vocabularyOf(temp.db), nowMs)).toBe(0);
  });
});
