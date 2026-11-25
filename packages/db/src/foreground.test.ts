import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteEpisode } from "./delete-episode";
import { deletePassage } from "./delete-passage";
import { getEpisodeDetail } from "./episodes-store";
import { forgetRange } from "./forget-range";
import {
  cutForegroundSpans,
  listForegroundApps,
  recordForegroundSpans,
  type ForegroundSpanInput,
} from "./foreground";
import { publishAnalysis } from "./publish";
import { searchEpisodes } from "./search";
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

const xcode = { bundleId: "com.apple.dt.Xcode", name: "Xcode" };
const sondine = { bundleId: "app.sondine", name: "Sondine" };
const safari = { bundleId: "com.apple.Safari", name: "Safari" };

const span = (
  app: { bundleId: string; name: string },
  start: number,
  end: number,
): ForegroundSpanInput => ({ ...app, sampleStart: at(start), sampleEnd: at(end) });

const spans = (where = "1 = 1") =>
  temp.db.client
    .prepare(
      `SELECT a.bundle_id, f.sample_start, f.sample_end, f.wall_start_ms, f.wall_end_ms
       FROM foreground_spans f JOIN apps a ON a.id = f.app_id WHERE ${where}
       ORDER BY f.track_run_id, f.sample_start`,
    )
    .all();

/** A closed conversation over 10–40 s with three sentences, transcribed. */
function seedConversation(texts = ["bonjour à tous", "le budget avance", "on passe au code"]) {
  const seeded = seedEpisode(temp.db, [[10, 40]]);
  const { episodeId, trackRunId } = seeded;
  temp.db.client
    .prepare("UPDATE episodes SET size = 'conversation', context = 'in_person' WHERE id = ?")
    .run(episodeId);
  const runId = startRun(temp.db, episodeId, "asr");
  const published = publishAnalysis(temp.db, {
    episodeId,
    stage: "asr",
    runId,
    inputGeneration: 1,
    segments: texts.map((text, index) =>
      segment(trackRunId, 10 + index * 10, 15 + index * 10, text, "A"),
    ),
    turns: texts.map((_, index) => turn(trackRunId, 10 + index * 10, 15 + index * 10, "A")),
    analysisState: "complete",
  });
  expect(published.published).toBe(true);
  return seeded;
}

describe("recording the app in front", () => {
  it("keeps the spans inside the region, once, with their wall times and apps", () => {
    const { regionIds } = seedEpisode(temp.db, [[10, 20]]);
    const speechRegionId = regionIds[0] ?? 0;
    const input = {
      speechRegionId,
      // The last one reaches past the region's end: it stops there.
      spans: [span(xcode, 10, 14), span(sondine, 14, 25)],
      seenAtMs: t0,
    };
    expect(recordForegroundSpans(temp.db, input)).toBe(2);
    // A replayed close changes nothing.
    expect(recordForegroundSpans(temp.db, input)).toBe(0);
    expect(spans()).toEqual([
      {
        bundle_id: xcode.bundleId,
        sample_start: at(10),
        sample_end: at(14),
        wall_start_ms: t0 + 10_000,
        wall_end_ms: t0 + 14_000,
      },
      {
        bundle_id: sondine.bundleId,
        sample_start: at(14),
        sample_end: at(20),
        wall_start_ms: t0 + 14_000,
        wall_end_ms: t0 + 20_000,
      },
    ]);
    expect(count(temp.db, "apps", "bundle_id = 'app.sondine' AND name = 'Sondine'")).toBe(1);
  });

  it("ignores a span outside its region, and an unknown region", () => {
    const { regionIds } = seedEpisode(temp.db, [[10, 20]]);
    const speechRegionId = regionIds[0] ?? 0;
    expect(
      recordForegroundSpans(temp.db, {
        speechRegionId,
        spans: [span(xcode, 30, 40)],
        seenAtMs: t0,
      }),
    ).toBe(0);
    expect(
      recordForegroundSpans(temp.db, {
        speechRegionId: 999,
        spans: [span(xcode, 10, 12)],
        seenAtMs: t0,
      }),
    ).toBe(0);
  });

  it("cuts a span around a deleted stretch, keeping both sides", () => {
    const { regionIds, trackRunId } = seedEpisode(temp.db, [[10, 20]]);
    recordForegroundSpans(temp.db, {
      speechRegionId: regionIds[0] ?? 0,
      spans: [span(xcode, 10, 20)],
      seenAtMs: t0,
    });
    cutForegroundSpans(temp.db, trackRunId, at(12), at(15));
    expect(spans().map((row) => [row["sample_start"], row["sample_end"]])).toEqual([
      [at(10), at(12)],
      [at(15), at(20)],
    ]);
    expect(spans()[1]?.["wall_start_ms"]).toBe(t0 + 15_000);
  });
});

describe("the app a sentence was said in", () => {
  it("is the app in front at its middle; none where no app was", () => {
    const { episodeId, regionIds } = seedConversation();
    // Sentences at 10–15, 20–25 (middle 22.5) and 30–35.
    recordForegroundSpans(temp.db, {
      speechRegionId: regionIds[0] ?? 0,
      spans: [span(xcode, 10, 22), span(sondine, 22, 26)],
      seenAtMs: t0,
    });
    const detail = getEpisodeDetail(temp.db, episodeId);
    expect(detail?.segments.map((s) => s.app)).toEqual([xcode, sondine, null]);
  });

  it("is offered for the search filter, the latest first", () => {
    const { regionIds } = seedConversation();
    recordForegroundSpans(temp.db, {
      speechRegionId: regionIds[0] ?? 0,
      spans: [span(xcode, 10, 20), span(sondine, 20, 30), span(safari, 30, 40)],
      seenAtMs: t0,
    });
    expect(listForegroundApps(temp.db)).toEqual([safari, sondine, xcode]);
  });
});

describe("search while an app was in front", () => {
  it("keeps only what was said in it, and says which app each hit was said in", () => {
    const { regionIds } = seedConversation(["le budget ici", "le budget là", "le budget encore"]);
    recordForegroundSpans(temp.db, {
      speechRegionId: regionIds[0] ?? 0,
      spans: [span(xcode, 10, 20), span(sondine, 20, 40)],
      seenAtMs: t0,
    });
    const all = searchEpisodes(temp.db, "budget", { limit: 10, offset: 0 });
    expect(all.episodes[0]?.hits.map((hit) => hit.app?.bundleId)).toEqual([
      xcode.bundleId,
      sondine.bundleId,
      sondine.bundleId,
    ]);
    const inXcode = searchEpisodes(temp.db, "budget", {
      limit: 10,
      offset: 0,
      foregroundApp: xcode.bundleId,
    });
    expect(inXcode.total).toBe(1);
    expect(inXcode.episodes[0]?.hitCount).toBe(1);
    expect(inXcode.episodes[0]?.hits.map((hit) => hit.text)).toEqual(["le budget ici"]);
    const inSafari = searchEpisodes(temp.db, "budget", {
      limit: 10,
      offset: 0,
      foregroundApp: safari.bundleId,
    });
    expect(inSafari.total).toBe(0);
    expect(
      searchEpisodes(temp.db, "budget", { limit: 10, offset: 0, foregroundApp: "never.seen" })
        .total,
    ).toBe(0);
  });

  it("counts only the untranscribed episodes with speech in that app", () => {
    const inXcode = seedEpisode(temp.db, [[100, 110]]);
    seedEpisode(temp.db, [[200, 210]]);
    recordForegroundSpans(temp.db, {
      speechRegionId: inXcode.regionIds[0] ?? 0,
      spans: [span(xcode, 100, 110)],
      seenAtMs: t0,
    });
    const options = { limit: 10, offset: 0 };
    expect(searchEpisodes(temp.db, "budget", options).untranscribed).toBe(2);
    expect(
      searchEpisodes(temp.db, "budget", { ...options, foregroundApp: xcode.bundleId })
        .untranscribed,
    ).toBe(1);
  });
});

/** A conversation said in Xcode, then in Sondine from 22 s. */
function seedWithSpans() {
  const seeded = seedConversation();
  recordForegroundSpans(temp.db, {
    speechRegionId: seeded.regionIds[0] ?? 0,
    spans: [span(xcode, 10, 22), span(sondine, 22, 40)],
    seenAtMs: t0,
  });
  return seeded;
}

describe("deleting what was said", () => {
  it("takes the apps in front with a deleted recording", () => {
    const { episodeId } = seedWithSpans();
    expect(deleteEpisode(temp.db, episodeId, { origin: "app", nowMs: t0 }).deleted).toBe(true);
    expect(count(temp.db, "foreground_spans")).toBe(0);
  });

  it("cuts them around a deleted passage", () => {
    const { episodeId } = seedWithSpans();
    const result = deletePassage(temp.db, {
      episodeId,
      fromMs: t0 + 20_000,
      toMs: t0 + 25_000,
      origin: "app",
      nowMs: t0 + 60_000,
    });
    expect(result.deleted).toBe(true);
    const left = spans();
    expect(left.length).toBeGreaterThan(0);
    for (const row of left) {
      const start = Number(row["sample_start"]);
      const end = Number(row["sample_end"]);
      expect(end <= at(20) || start >= at(25)).toBe(true);
    }
  });

  it("forgets them with the last minutes", () => {
    seedWithSpans();
    forgetRange(temp.db, { fromWallMs: t0, toWallMs: t0 + 60_000, origin: "app", nowMs: t0 });
    expect(count(temp.db, "foreground_spans")).toBe(0);
  });
});
