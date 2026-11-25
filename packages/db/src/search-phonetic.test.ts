import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteEpisode } from "./delete-episode";
import { publishAnalysis } from "./publish";
import { compileSearch, searchEpisodes, searchSegments } from "./search";
import { seedEpisode, segment, startRun, tempDatabase, type TempDatabase } from "./test-helpers";

// M4 exit (plan.md): phonetic search, « Kamille » finds Camille.

let temp: TempDatabase;
beforeEach(() => {
  temp = tempDatabase();
});
afterEach(() => temp.cleanup());

function episode(startS: number, texts: readonly string[]): number {
  const { episodeId, trackRunId } = seedEpisode(temp.db, [[startS, startS + 10 * texts.length]]);
  temp.db.client
    .prepare("UPDATE episodes SET size = 'conversation', context = 'in_person' WHERE id = ?")
    .run(episodeId);
  const runId = startRun(temp.db, episodeId, "asr");
  publishAnalysis(temp.db, {
    episodeId,
    stage: "asr",
    runId,
    inputGeneration: 1,
    segments: texts.map((text, index) =>
      segment(trackRunId, startS + index * 10, startS + index * 10 + 8, text, "A"),
    ),
    turns: [],
    analysisState: "complete",
  });
  return episodeId;
}

const search = (q: string) =>
  searchEpisodes(temp.db, q, { limit: 10, offset: 0 }).episodes.flatMap((match) =>
    match.hits.map((hit) => ({
      text: hit.text,
      marked: hit.highlights.map((range) => hit.text.slice(range.start, range.end)),
    })),
  );

describe("phonetic search", () => {
  it("finds a name however the engine spelled it, and marks the word that sounds alike", () => {
    episode(10, ["Camille arrive demain", "on parle du budget"]);
    expect(search("Kamille")).toEqual([{ text: "Camille arrive demain", marked: ["Camille"] }]);
    expect(search("Filip")).toEqual([]);
    episode(100, ["Philippe a appelé"]);
    expect(search("filip")).toEqual([{ text: "Philippe a appelé", marked: ["Philippe"] }]);
  });

  it("picks the exact spelling first as an episode's best excerpt", () => {
    episode(10, ["Kamille est là", "Camille est partie"]);
    const [match] = searchEpisodes(temp.db, "Camille", {
      limit: 10,
      offset: 0,
      hitsPerEpisode: 1,
    }).episodes;
    expect(match?.hitCount).toBe(2);
    expect(match?.hits.map((hit) => hit.text)).toEqual(["Camille est partie"]);
  });

  it("searches several words with a sound-alike among them", () => {
    episode(10, ["Camille arrive demain", "Camille part lundi"]);
    expect(search("Kamille demain")).toEqual([
      { text: "Camille arrive demain", marked: ["Camille", "demain"] },
    ]);
  });

  it("does not widen short words into function words", () => {
    episode(10, ["Les enfants jouent dehors"]);
    expect(search("lait")).toEqual([]);
  });

  it("never offers a word whose last segment was deleted", () => {
    const gone = episode(10, ["Camille arrive demain"]);
    episode(100, ["Rien à voir"]);
    deleteEpisode(temp.db, gone, { origin: "app" });
    const query = compileSearch(temp.db, "Kamille");
    expect(query.forms.flat().flatMap((phrase) => phrase.alternatives ?? [])).toEqual([]);
    expect(searchSegments(temp.db, "Kamille")).toEqual([]);
  });
});
