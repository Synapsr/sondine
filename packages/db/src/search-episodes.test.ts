import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { publishAnalysis } from "./publish";
import { matchingSegmentIds, searchEpisodes, type EpisodeSearchOptions } from "./search";
import { compileSearchQuery } from "./search-match";
import type { EpisodeContext, EpisodeSize } from "./schema/enums";
import {
  seedEpisode,
  segment,
  startRun,
  t0,
  tempDatabase,
  type TempDatabase,
} from "./test-helpers";

let temp: TempDatabase;
beforeEach(() => {
  temp = tempDatabase();
});
afterEach(() => temp.cleanup());

const DAY_S = 86_400;

interface Seed {
  readonly size?: EpisodeSize;
  readonly context?: EpisodeContext;
  readonly state?: "open" | "closed";
  /** Published transcript, one segment per text, alternating two speakers; none when absent. */
  readonly texts?: readonly string[];
}

/** An episode starting `startS` seconds after t0. */
function episode(startS: number, seed: Seed = {}): number {
  const texts = seed.texts ?? [];
  const { episodeId, trackRunId } = seedEpisode(temp.db, [
    [startS, startS + 10 * Math.max(texts.length, 1)],
  ]);
  temp.db.client
    .prepare("UPDATE episodes SET size = ?, context = ?, state = ? WHERE id = ?")
    .run(seed.size ?? "moment", seed.context ?? "in_person", seed.state ?? "closed", episodeId);
  if (seed.texts !== undefined) {
    const runId = startRun(temp.db, episodeId, "asr");
    const result = publishAnalysis(temp.db, {
      episodeId,
      stage: "asr",
      runId,
      inputGeneration: 1,
      segments: texts.map((text, index) =>
        segment(
          trackRunId,
          startS + index * 10,
          startS + index * 10 + 8,
          text,
          index % 2 === 0 ? "A" : "B",
        ),
      ),
      turns: [],
      analysisState: "complete",
    });
    expect(result.published).toBe(true);
  }
  return episodeId;
}

const search = (text: string, options: Partial<EpisodeSearchOptions> = {}) =>
  searchEpisodes(temp.db, text, { limit: 20, offset: 0, ...options });

const ids = (result: ReturnType<typeof search>) => result.episodes.map((match) => match.episode.id);

describe("searchEpisodes", () => {
  it("groups matches by episode, newest first, each with its best segments in time order", () => {
    const morning = episode(9 * 3600, {
      size: "conversation",
      texts: ["Le budget est validé.", "Rien à voir.", "On reparle du budget demain."],
    });
    const later = episode(10 * 3600, { texts: ["Budget, budget, budget !"] });
    const long =
      "Nous avons parlé longuement de beaucoup de choses et aussi du budget sans conclure";
    const nextDay = episode(DAY_S + 9 * 3600, {
      size: "conversation",
      texts: [long, "Budget.", "Budget.", "Rien.", "Budget.", "Budget.", "Budget.", long],
    });
    episode(11 * 3600, { texts: ["Rien de tel ici."] });

    const result = search("budget");
    expect(ids(result)).toEqual([nextDay, later, morning]);
    expect(result.total).toBe(3);
    const [first, second, third] = result.episodes;
    expect(first?.hitCount).toBe(7);
    // The five short segments rank best; they come back in time order.
    expect(first?.hits.map((hit) => hit.text)).toEqual(Array(5).fill("Budget."));
    const starts = first?.hits.map((hit) => hit.startMs) ?? [];
    expect(starts).toEqual(starts.toSorted((a, b) => a - b));
    expect(second?.hitCount).toBe(1);
    expect(third?.hits.map((hit) => [hit.text, hit.speakerLabel, hit.speakerOrdinal])).toEqual([
      ["Le budget est validé.", "A", 1],
      ["On reparle du budget demain.", "A", 1],
    ]);
    expect(third?.hits[0]?.highlights).toEqual([{ start: 3, end: 9 }]);
    expect(third?.episode).toMatchObject({ id: morning, size: "conversation", speakerCount: 2 });
  });

  it("pages by episode and keeps the total on every page", () => {
    const episodes = [0, 1, 2].map((hour) => episode(hour * 3600, { texts: ["Le devis part."] }));
    expect(ids(search("devis", { limit: 2 }))).toEqual([episodes[2], episodes[1]]);
    const second = search("devis", { limit: 2, offset: 2 });
    expect(ids(second)).toEqual([episodes[0]]);
    expect(second.total).toBe(3);
    expect(search("devis", { limit: 2, offset: 4 })).toMatchObject({ episodes: [], total: 3 });
  });

  it("filters by day, size and context before paging, and keeps everything by default", () => {
    const conversation = episode(3600, { size: "conversation", texts: ["Le devis part."] });
    const media = episode(2 * 3600, { size: "trace", context: "media", texts: ["Devis !"] });
    const mixed = episode(3 * 3600, { context: "mixed", texts: ["Un devis."] });
    const tomorrow = episode(DAY_S + 3600, { texts: ["Devis signé."] });
    expect(ids(search("devis"))).toEqual([tomorrow, mixed, media, conversation]);

    expect(ids(search("devis", { sizes: ["conversation"] }))).toEqual([conversation]);
    expect(ids(search("devis", { contexts: ["media", "mixed"] }))).toEqual([mixed, media]);
    const firstDay = { fromMs: t0, toMs: t0 + DAY_S * 1000 };
    expect(ids(search("devis", { ...firstDay, limit: 1 }))).toEqual([mixed]);
    expect(search("devis", { ...firstDay, limit: 1 }).total).toBe(3);
    expect(ids(search("devis", { fromMs: t0 + DAY_S * 1000 }))).toEqual([tomorrow]);
  });

  it("counts closed episodes the filters keep that have no transcript yet", () => {
    episode(3600, { texts: ["Transcrit."] });
    episode(2 * 3600);
    episode(3 * 3600, { size: "conversation", context: "media" });
    episode(4 * 3600, { state: "open" });
    episode(5 * 3600, { size: "trace" });
    episode(DAY_S + 3600, { size: "conversation" });

    expect(search("transcrit").untranscribed).toBe(3);
    expect(search("...").untranscribed).toBe(3);
    expect(search("transcrit", { sizes: ["conversation"] }).untranscribed).toBe(2);
    expect(search("transcrit", { contexts: ["in_person"] }).untranscribed).toBe(2);
    expect(search("transcrit", { toMs: t0 + DAY_S * 1000 }).untranscribed).toBe(2);
  });
});

describe("matchingSegmentIds", () => {
  it("returns the segments of one episode the query matches", () => {
    const one = episode(0, { texts: ["Le devis part.", "Rien.", "Devis signé."] });
    episode(3600, { texts: ["Devis ailleurs."] });
    const found = matchingSegmentIds(temp.db, compileSearchQuery("devis"), one);
    expect(found.size).toBe(2);
    expect(matchingSegmentIds(temp.db, compileSearchQuery("..."), one).size).toBe(0);
  });
});
