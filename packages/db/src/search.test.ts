import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { publishAnalysis } from "./publish";
import { checkSearchIndex, searchSegments } from "./search";
import { ensureSearchNormalizer, searchNormalizerId, searchTextOf } from "./search-text";
import { seedEpisode, segment, startRun, tempDatabase, type TempDatabase } from "./test-helpers";

let temp: TempDatabase;
let episodeId: number;
let trackRunId: number;

const corpus = [
  "L'école est fermée demain matin.",
  "On se retrouve devant l'ecole primaire, école école.",
  "Il a montré l'image du projet à toute l'équipe.",
  "Une réunion à l'hôpital, puis le déjeuner.",
  "We talked about the budget for next week.",
  "Le budget de la semaine prochaine est validé.",
  "Rien à signaler, à demain.",
  "Le rendez-vous chez le médecin est à dix heures.",
  "Il faudrait renvoyer le devis, sinon on perd 15 % de remise, euh, voilà.",
];

beforeEach(() => {
  temp = tempDatabase();
  ({ episodeId, trackRunId } = seedEpisode(temp.db, [[0, 100]]));
  const runId = startRun(temp.db, episodeId, "asr");
  const result = publishAnalysis(temp.db, {
    episodeId,
    stage: "asr",
    runId,
    inputGeneration: 1,
    segments: corpus.map((text, index) => segment(trackRunId, index * 10, index * 10 + 8, text)),
    turns: [],
  });
  expect(result.published).toBe(true);
});

afterEach(() => temp.cleanup());

const texts = (query: string, prefix = false): string[] =>
  searchSegments(temp.db, query, { prefix }).map((hit) => hit.text);

describe("segments_fts", () => {
  it("matches French words with or without accents", () => {
    const withAccent = texts("école");
    const without = texts("ecole");
    expect(withAccent).toHaveLength(2);
    expect(new Set(without)).toEqual(new Set(withAccent));
    expect(texts("hopital")).toEqual(["Une réunion à l'hôpital, puis le déjeuner."]);
    expect(texts("MÉDECIN")).toEqual(["Le rendez-vous chez le médecin est à dix heures."]);
  });

  it("splits elisions so l'image matches image and the phrase l'image", () => {
    expect(texts("image")).toEqual(["Il a montré l'image du projet à toute l'équipe."]);
    expect(texts("l'image")).toEqual(["Il a montré l'image du projet à toute l'équipe."]);
    expect(texts("l'équipe")).toEqual(["Il a montré l'image du projet à toute l'équipe."]);
  });

  it("matches prefixes of two or more letters", () => {
    expect(texts("réu", true)).toEqual(["Une réunion à l'hôpital, puis le déjeuner."]);
    expect(texts("ec", true)).toHaveLength(2);
    expect(texts("reu", false)).toEqual([]);
  });

  it("ranks with bm25, best match first", () => {
    const hits = searchSegments(temp.db, "école", { prefix: false });
    expect(hits[0]?.text).toBe("On se retrouve devant l'ecole primaire, école école.");
    expect(hits[0]?.score).toBeLessThan(hits[1]?.score ?? 0);
    const budget = searchSegments(temp.db, "budget semaine", { prefix: false });
    expect(budget.map((hit) => hit.text)).toEqual([
      "Le budget de la semaine prochaine est validé.",
    ]);
  });

  it("returns capture anchors with each hit", () => {
    const [hit] = searchSegments(temp.db, "médecin");
    expect(hit).toMatchObject({
      episodeId,
      trackRunId,
      sampleStart: 70 * 16000,
      sampleEnd: 78 * 16000,
    });
  });

  it("keeps the index consistent with its content table", () => {
    expect(() => checkSearchIndex(temp.db)).not.toThrow();
  });
});

describe("query syntax", () => {
  it("treats FTS5 syntax in user input as words", () => {
    for (const input of [
      '"',
      "AND",
      "a OR b",
      "(école",
      "x:y",
      "^début",
      "*",
      'l\'image "de" NEAR(a b) OR -x*',
    ]) {
      expect(() => searchSegments(temp.db, input)).not.toThrow();
    }
    expect(searchSegments(temp.db, "...")).toEqual([]);
  });

  it("matches a typed word's normalized tokens as a phrase", () => {
    // "l'image" is the phrase `l image`: "l'" alone elsewhere is not enough.
    expect(texts("l'image")).toEqual(["Il a montré l'image du projet à toute l'équipe."]);
    expect(texts("l'hôpital")).toEqual(["Une réunion à l'hôpital, puis le déjeuner."]);
    expect(texts("l'budget")).toEqual([]);
  });
});

describe("normalized search (ADR 016)", () => {
  it("indexes the fr-norm form, so digits and their French words find each other", () => {
    expect(searchTextOf("15 % de remise")).toContain("quinze");
    expect(texts("quinze")).toEqual([
      "Il faudrait renvoyer le devis, sinon on perd 15 % de remise, euh, voilà.",
    ]);
    expect(texts("15")).toEqual(texts("quinze"));
  });

  it("drops fillers from the index but keeps the original text", () => {
    expect(texts("euh")).toEqual([]);
    expect(texts("voila")).toEqual([
      "Il faudrait renvoyer le devis, sinon on perd 15 % de remise, euh, voilà.",
    ]);
  });

  it("finds English text with an English query", () => {
    expect(texts("budget")).toHaveLength(2);
    expect(texts("next week")).toEqual(["We talked about the budget for next week."]);
  });

  it("reindexes once when the stored normalizer differs, then does nothing", () => {
    temp.db.client.exec("UPDATE segments SET search_text = ''");
    temp.db.client.exec("INSERT INTO segments_fts (segments_fts) VALUES ('rebuild')");
    expect(texts("quinze")).toEqual([]);
    const first = ensureSearchNormalizer(temp.db);
    expect(first).toEqual({ normalizerId: searchNormalizerId, reindexed: corpus.length });
    expect(texts("quinze")).toHaveLength(1);
    expect(ensureSearchNormalizer(temp.db).reindexed).toBe(0);
    checkSearchIndex(temp.db);
  });
});
