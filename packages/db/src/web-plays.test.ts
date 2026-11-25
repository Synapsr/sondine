import { webPageOf } from "@sondine/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertApp } from "./capture-import";
import { deleteEpisode } from "./delete-episode";
import { forgetRange } from "./forget-range";
import { count, seedEpisode, t0, tempDatabase, type TempDatabase } from "./test-helpers";
import {
  DEFAULT_UNKEPT_SITES,
  addWebPlayMark,
  endOpenWebPlays,
  endWebPlay,
  heardSites,
  loadEpisodeMarks,
  loadEpisodePages,
  loadWebPlaysBetween,
  pruneWebPlays,
  setSiteKept,
  startWebPlay,
  unkeptSites,
  updateWebPlay,
} from "./web-plays";

let temp: TempDatabase;
let yab: number;
beforeEach(() => {
  temp = tempDatabase();
  yab = upsertApp(temp.db, { bundleId: "dev.serafim.fast", name: "Yab", seenAtMs: t0 }).appId;
});
afterEach(() => temp.cleanup());

const page = (url: string) => {
  const parsed = webPageOf(url);
  if (parsed === null) throw new Error(`not a page: ${url}`);
  return parsed;
};

/** A play of `url` from `from` to `to` seconds after t0 (`to` null: still playing). */
function play(url: string, from: number, to: number | null, title = "Titre") {
  const id = startWebPlay(temp.db, {
    appId: yab,
    page: page(url),
    url,
    title,
    atMs: t0 + from * 1000,
    nowMs: t0 + from * 1000,
  });
  if (to !== null) endWebPlay(temp.db, id, t0 + to * 1000, t0 + to * 1000);
  return id;
}

function setPage(episodeId: number, pageKey: string): void {
  temp.db
    .statement("UPDATE episodes SET page_key = ?, context = 'media' WHERE id = ?")
    .run(pageKey, episodeId);
}

describe("site rules", () => {
  it("leaves out films, series and music by default, and keeps the rest", () => {
    expect([...unkeptSites(temp.db)].toSorted()).toEqual([...DEFAULT_UNKEPT_SITES].toSorted());
    expect(unkeptSites(temp.db).has("youtube.com")).toBe(false);
  });

  it("remembers what the user changes, and nothing that matches the default", () => {
    expect(setSiteKept(temp.db, "netflix.com", true, t0).has("netflix.com")).toBe(false);
    expect(setSiteKept(temp.db, "lemonde.fr", false, t0).has("lemonde.fr")).toBe(true);
    expect(
      JSON.parse(
        String(
          temp.db.statement("SELECT value FROM settings WHERE key = 'browser.sites'").get()?.[
            "value"
          ],
        ),
      ),
    ).toEqual({
      "netflix.com": true,
      "lemonde.fr": false,
    });
    setSiteKept(temp.db, "netflix.com", false, t0);
    setSiteKept(temp.db, "lemonde.fr", true, t0);
    expect(
      JSON.parse(
        String(
          temp.db.statement("SELECT value FROM settings WHERE key = 'browser.sites'").get()?.[
            "value"
          ],
        ),
      ),
    ).toEqual({});
  });

  it("lists the sites played, the latest first, then the ones ruled on", () => {
    play("https://www.youtube.com/watch?v=a", 0, 10);
    play("https://www.netflix.com/watch/81", 20, null);
    setSiteKept(temp.db, "lemonde.fr", false, t0);
    const sites = heardSites(temp.db, t0 + 60_000);
    expect(sites.slice(0, 2)).toEqual([
      { site: "netflix.com", lastPlayedAtMs: t0 + 60_000, kept: false },
      { site: "youtube.com", lastPlayedAtMs: t0 + 10_000, kept: true },
    ]);
    // The defaults and the user's rules that played nothing yet, by name.
    expect(sites.slice(2).map((site) => site.site)).toEqual(
      [...DEFAULT_UNKEPT_SITES.filter((site) => site !== "netflix.com"), "lemonde.fr"].toSorted(),
    );
    expect(sites.find((site) => site.site === "lemonde.fr")).toEqual({
      site: "lemonde.fr",
      lastPlayedAtMs: null,
      kept: false,
    });
  });
});

describe("plays", () => {
  it("records, updates and ends a tab's play, and gives the grouping what met a window", () => {
    const id = play("https://www.youtube.com/watch?v=a", 0, null, "Une vidéo - YouTube");
    updateWebPlay(temp.db, id, {
      url: "https://www.youtube.com/watch?v=a&t=5",
      title: "(1) Une vidéo - YouTube",
      nowMs: t0 + 5_000,
    });
    play("https://www.netflix.com/watch/81", 100, 200);
    expect(loadWebPlaysBetween(temp.db, t0 + 50_000, t0 + 60_000)).toEqual([
      {
        bundleId: "dev.serafim.fast",
        pageKey: "youtube.com/watch?v=a",
        startedWallMs: t0,
        endedWallMs: null,
      },
    ]);
    // Core stopped while it played: it ends where it was last heard of.
    expect(endOpenWebPlays(temp.db, t0 + 90_000)).toBe(1);
    expect(loadWebPlaysBetween(temp.db, t0, t0 + 300_000).map((p) => p.endedWallMs)).toEqual([
      t0 + 5_000,
      t0 + 200_000,
    ]);
  });

  it("gives an episode its page's address and title, and the video's marks", () => {
    const episode = seedEpisode(temp.db, [[10, 20]]);
    setPage(episode.episodeId, "youtube.com/watch?v=a");
    play("https://www.youtube.com/watch?v=a", 500, 600, "Plus tard");
    const id = play("https://www.youtube.com/watch?v=a&list=x", 5, 30, "La bonne - YouTube");
    addWebPlayMark(temp.db, id, {
      wallMs: t0 + 5_000,
      positionMs: 60_000,
      rate: 1,
      durationMs: 300_000,
      ad: false,
    });
    const pages = loadEpisodePages(
      temp.db,
      [
        {
          id: episode.episodeId,
          pageKey: "youtube.com/watch?v=a",
          startedAtMs: t0 + 10_000,
          endedAtMs: t0 + 20_000,
        },
      ],
      t0 + 1_000_000,
    );
    expect(pages.get(episode.episodeId)).toEqual({
      site: "youtube.com",
      pageKey: "youtube.com/watch?v=a",
      url: "https://www.youtube.com/watch?v=a&list=x",
      title: "La bonne - YouTube",
      video: true,
      browser: { bundleId: "dev.serafim.fast", name: "Yab" },
    });
    expect(loadEpisodeMarks(temp.db, episode.episodeId, t0 + 1_000_000)).toEqual([
      { wallMs: t0 + 5_000, positionMs: 60_000, rate: 1, durationMs: 300_000, ad: false },
    ]);
  });

  it("rebuilds the address of a page whose plays are gone", () => {
    const pages = loadEpisodePages(
      temp.db,
      [{ id: 7, pageKey: "netflix.com/watch/81", startedAtMs: t0, endedAtMs: null }],
      t0,
    );
    expect(pages.get(7)?.url).toBe("https://netflix.com/watch/81");
    expect(pages.get(7)?.title).toBe("");
  });
});

describe("deleting", () => {
  it("takes the page's plays with a deleted episode, and leaves other pages", () => {
    const episode = seedEpisode(temp.db, [[10, 20]]);
    setPage(episode.episodeId, "youtube.com/watch?v=a");
    play("https://www.youtube.com/watch?v=a", 5, 30);
    play("https://www.youtube.com/watch?v=b", 5, 30);
    play("https://www.youtube.com/watch?v=a", 500, 600);
    deleteEpisode(temp.db, episode.episodeId, { origin: "app", nowMs: t0 + 1_000_000 });
    expect(
      temp.db
        .statement("SELECT page_key, started_wall_ms FROM web_plays ORDER BY id")
        .all()
        .map((row) => [row["page_key"], Number(row["started_wall_ms"]) - t0]),
    ).toEqual([
      ["youtube.com/watch?v=b", 5_000],
      ["youtube.com/watch?v=a", 500_000],
    ]);
  });

  it("forgets the plays of a forgotten range", () => {
    play("https://www.youtube.com/watch?v=a", 0, 100);
    play("https://www.youtube.com/watch?v=b", 200, 300);
    forgetRange(temp.db, {
      fromWallMs: t0 + 50_000,
      toWallMs: t0 + 150_000,
      origin: "app",
      nowMs: t0 + 400_000,
    });
    expect(count(temp.db, "web_plays")).toBe(1);
  });

  it("prunes old plays no episode met", () => {
    const episode = seedEpisode(temp.db, [[10, 20]]);
    setPage(episode.episodeId, "youtube.com/watch?v=a");
    const kept = play("https://www.youtube.com/watch?v=a", 5, 30);
    const unheard = play("https://www.youtube.com/watch?v=a", 100, 130);
    const recent = play("https://www.youtube.com/watch?v=c", 900, 950);
    addWebPlayMark(temp.db, unheard, {
      wallMs: t0 + 100_000,
      positionMs: 0,
      rate: 1,
      durationMs: null,
      ad: false,
    });
    expect(pruneWebPlays(temp.db, t0 + 500_000)).toBe(1);
    expect(
      temp.db
        .statement("SELECT id FROM web_plays ORDER BY id")
        .all()
        .map((row) => row["id"]),
    ).toEqual([kept, recent]);
    expect(count(temp.db, "web_play_marks")).toBe(0);
  });
});
