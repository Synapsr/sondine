import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteEpisode } from "./delete-episode";
import { loadEpisodeDay, type DayHour } from "./episode-day";
import { listEpisodes } from "./episodes-store";
import { publishAnalysis } from "./publish";
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

// The day of t0, in UTC so the test does not depend on the machine's zone.
const dayStart = Date.UTC(2026, 10, 2);
const HOUR = 3_600_000;
const hours: DayHour[] = Array.from({ length: 24 }, (_, hour) => ({
  hour,
  startMs: dayStart + hour * HOUR,
  endMs: dayStart + (hour + 1) * HOUR,
}));
const day = { fromMs: dayStart, toMs: dayStart + 24 * HOUR, hours, pageSize: 50 };

interface Seed {
  readonly size?: EpisodeSize | null;
  readonly context?: EpisodeContext | null;
  readonly state?: "open" | "closed";
  readonly text?: string;
}

/** An episode starting at hh:mm on the day of t0 (UTC), from 09:00 (t0) on. */
function episode(hh: number, mm: number, seed: Seed = {}): number {
  const startS = (dayStart + hh * HOUR + mm * 60_000 - t0) / 1000;
  const { episodeId, trackRunId } = seedEpisode(temp.db, [[startS, startS + 5]]);
  temp.db.client
    .prepare("UPDATE episodes SET size = ?, context = ?, state = ?, size_state = ? WHERE id = ?")
    .run(
      seed.size === undefined ? "moment" : seed.size,
      seed.context === undefined ? "in_person" : seed.context,
      seed.state ?? "closed",
      seed.state === "open" ? "provisional" : "final",
      episodeId,
    );
  if (seed.text !== undefined) {
    const runId = startRun(temp.db, episodeId, "asr");
    publishAnalysis(temp.db, {
      episodeId,
      stage: "asr",
      runId,
      inputGeneration: 1,
      segments: [segment(trackRunId, startS, startS + 4, seed.text)],
      turns: [],
      analysisState: "complete",
    });
  }
  return episodeId;
}

const load = (overrides: Partial<typeof day> = {}) =>
  loadEpisodeDay(temp.db, { ...day, ...overrides });

describe("loadEpisodeDay", () => {
  it("names the apps an hour's moments heard, the one most of them name first", () => {
    const app = (bundleId: string, name: string) =>
      Number(
        temp.db.client
          .prepare(
            "INSERT INTO apps (bundle_id, name, first_seen_ms, last_seen_ms) VALUES (?, ?, 0, 0) RETURNING id",
          )
          .get(bundleId, name)?.["id"],
      );
    const heard = (episodeId: number, appId: number) =>
      temp.db.client
        .prepare(
          `UPDATE speech_regions SET attributed_app_id = ?
           WHERE id IN (SELECT speech_region_id FROM episode_regions WHERE episode_id = ?)`,
        )
        .run(appId, episodeId);
    const zoom = app("us.zoom.xos", "zoom.us");
    const safari = app("com.apple.Safari", "Safari");
    heard(episode(10, 5, { context: "mixed" }), zoom);
    heard(episode(10, 20, { context: "mixed" }), safari);
    episode(10, 30);
    heard(episode(10, 40, { context: "mixed" }), safari);
    const [ten] = load().momentHours;
    expect(ten).toMatchObject({ hour: 10, moments: 4 });
    expect(ten?.apps).toEqual([
      { bundleId: "com.apple.Safari", name: "Safari" },
      { bundleId: "us.zoom.xos", name: "zoom.us" },
    ]);
  });

  it("lays out a day: conversations, moments per hour, media apart, traces counted", () => {
    const ongoing = episode(16, 31, { size: "conversation", state: "open" });
    const talk = episode(15, 2, { size: "conversation", text: "Allô ?" });
    const mixed = episode(11, 10, { size: "conversation", context: "mixed" });
    episode(14, 5, { text: "On décale à 15 h ?" });
    const m2 = episode(14, 30, { text: "Tu peux me renvoyer le lien du doc ?" });
    episode(14, 40);
    const m4 = episode(14, 50, { text: "Le client est en retard." });
    const m5 = episode(14, 55, { text: "Un café allongé." });
    episode(12, 0, { context: "mixed" });
    episode(9, 0, { size: null, context: null });
    const film = episode(13, 0, { size: "conversation", context: "media" });
    const jingle = episode(13, 30, { size: "trace", context: "media" });
    episode(10, 0, { size: "trace" });
    episode(10, 1, { size: "trace", context: "mixed" });
    episode(24 + 9, 0, { size: "conversation" }); // the next day

    const result = load();
    expect(result.conversations.episodes.map((e) => e.id)).toEqual([ongoing, talk, mixed]);
    expect(result.conversations).toMatchObject({ total: 3, next: null });
    expect(result.conversations.episodes[0]).toMatchObject({
      state: "open",
      sizeState: "provisional",
    });
    expect(result.media.episodes.map((e) => e.id)).toEqual([jingle, film]);
    expect(result.traces).toBe(2);
    expect(result.momentHours.map((h) => [h.hour, h.moments, h.untranscribed])).toEqual([
      [14, 5, 1],
      [12, 1, 1],
      [9, 1, 1],
    ]);
    const [fourteen] = result.momentHours;
    expect(fourteen?.startMs).toBe(dayStart + 14 * HOUR);
    expect(fourteen?.previews).toEqual([
      { episodeId: m5, text: "Un café allongé." },
      { episodeId: m4, text: "Le client est en retard." },
      { episodeId: m2, text: "Tu peux me renvoyer le lien du doc ?" },
    ]);
  });

  it("pages conversations and media past the page size, without losing any", () => {
    const ids = [9, 10, 11].map((hh) => episode(hh, 0, { size: "conversation" }));
    const result = load({ pageSize: 2 });
    expect(result.conversations.total).toBe(3);
    expect(result.conversations.episodes.map((e) => e.id)).toEqual([ids[2], ids[1]]);
    const after = result.conversations.next;
    expect(after).not.toBeNull();
    if (after === null) return;
    const rest = listEpisodes(temp.db, { ...day, limit: 2, lane: "conversations", after });
    expect(rest.episodes.map((e) => e.id)).toEqual([ids[0]]);
    expect(rest.next).toBeNull();
  });

  it("changes its revision when an episode of the day is added, changed or removed", () => {
    const first = episode(9, 0, { text: "Bonjour." });
    const revision = load().revision;
    expect(load().revision).toBe(revision);

    temp.db.client
      .prepare("UPDATE episodes SET updated_at_ms = updated_at_ms + 1 WHERE id = ?")
      .run(first);
    const changed = load().revision;
    expect(changed).not.toBe(revision);

    const second = episode(10, 0);
    const added = load().revision;
    expect(added).not.toBe(changed);

    deleteEpisode(temp.db, second, { origin: "app", checkpoint: false });
    expect(load().revision).not.toBe(added);
    // Another day's episodes do not count.
    const before = load().revision;
    episode(24 + 9, 0);
    expect(load().revision).toBe(before);
  });
});

describe("listEpisodes", () => {
  it("lists one lane of one hour, newest first", () => {
    const moment = episode(14, 5);
    episode(14, 10, { size: "conversation" });
    const later = episode(14, 59);
    episode(15, 0);
    const fourteen = { fromMs: dayStart + 14 * HOUR, toMs: dayStart + 15 * HOUR, limit: 50 };
    expect(
      listEpisodes(temp.db, { ...fourteen, lane: "moments" }).episodes.map((e) => e.id),
    ).toEqual([later, moment]);
    expect(listEpisodes(temp.db, fourteen).episodes).toHaveLength(3);
  });

  it("keeps its cursor stable when newer episodes arrive between pages", () => {
    const ids = [1, 2, 3, 4].map((mm) => episode(9, mm));
    const first = listEpisodes(temp.db, { ...day, limit: 2 });
    expect(first.episodes.map((e) => e.id)).toEqual([ids[3], ids[2]]);
    episode(9, 30);
    const after = first.next;
    if (after === null) throw new Error("expected a next page");
    const second = listEpisodes(temp.db, { ...day, limit: 2, after });
    expect(second.episodes.map((e) => e.id)).toEqual([ids[1], ids[0]]);
    expect(second.next).toBeNull();
  });

  it("breaks ties on start time by id", () => {
    const a = episode(9, 0);
    const b = episode(9, 0);
    const c = episode(9, 0);
    const first = listEpisodes(temp.db, { ...day, limit: 1 });
    expect(first.episodes.map((e) => e.id)).toEqual([c]);
    const after = first.next;
    if (after === null) throw new Error("expected a next page");
    expect(listEpisodes(temp.db, { ...day, limit: 5, after }).episodes.map((e) => e.id)).toEqual([
      b,
      a,
    ]);
  });
});

describe("what is being said now", () => {
  it("lists open episodes outside media, whatever their size, newest first", () => {
    const moment = episode(10, 0, { state: "open", size: "moment" });
    const trace = episode(10, 5, { state: "open", size: "trace" });
    episode(10, 10, { state: "open", context: "media" });
    episode(9, 0, { state: "closed", size: "conversation" });
    expect(load().ongoing.map((row) => row.id)).toEqual([trace, moment]);
  });

  it("keeps one that began the day before, and still goes on", () => {
    const lateLastNight = episode(-1, 50, { state: "open", size: "conversation" });
    expect(load().ongoing.map((row) => row.id)).toEqual([lateLastNight]);
  });
});
