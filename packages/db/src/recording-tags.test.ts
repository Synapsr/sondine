import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteEpisode } from "./delete-episode";
import { deletePassage } from "./delete-passage";
import { mergeEpisodes, splitEpisode } from "./episode-boundaries";
import { publishAnalysis } from "./publish";
import { browseTag, searchEpisodes } from "./search";
import {
  deleteOrphanTags,
  deleteTag,
  episodeTags,
  listTags,
  renameTag,
  setEpisodeTag,
  taggedEpisodeIds,
} from "./recording-tags";
import {
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

const s = (seconds: number) => t0 + seconds * 1000;

/** A closed conversation over these regions, with a sentence in each. */
function conversation(regions: readonly (readonly [number, number])[] = [[10, 40]]) {
  const seeded = seedEpisode(temp.db, regions);
  const { episodeId, trackRunId } = seeded;
  temp.db.client
    .prepare("UPDATE episodes SET size = 'conversation', context = 'in_person' WHERE id = ?")
    .run(episodeId);
  const runId = startRun(temp.db, episodeId, "asr");
  publishAnalysis(temp.db, {
    episodeId,
    stage: "asr",
    runId,
    inputGeneration: 1,
    segments: regions.map(([from, to], index) =>
      segment(trackRunId, from, Math.min(to, from + 5), `phrase ${index}`, "A"),
    ),
    turns: [turn(trackRunId, regions[0]?.[0] ?? 0, regions[0]?.[1] ?? 1, "A")],
  });
  return seeded;
}

const names = (episodeId: number) =>
  (episodeTags(temp.db, [episodeId]).get(episodeId) ?? []).map((tag) => tag.name);

const tag = (episodeId: number, name: string, on = true, nowMs = s(100)) =>
  setEpisodeTag(temp.db, { episodeId, name, on, origin: "app", nowMs });

describe("tags on a recording (ADR 039)", () => {
  it("puts, keeps one spelling per key, and takes off", () => {
    const { episodeId } = conversation();
    expect(tag(episodeId, "  Idées ")).toEqual({
      ok: true,
      tags: [{ id: expect.any(Number), name: "Idées" }],
    });
    // The same word without accents or case is the same tag, put once.
    tag(episodeId, "#idees", true, s(101));
    tag(episodeId, "contenu", true, s(102));
    expect(names(episodeId)).toEqual(["Idées", "contenu"]);
    expect(listTags(temp.db).map((t) => [t.name, t.recordings])).toEqual([
      ["contenu", 1],
      ["Idées", 1],
    ]);
    tag(episodeId, "IDEES", false);
    expect(names(episodeId)).toEqual(["contenu"]);
    // A tag on no recording stays offered.
    expect(listTags(temp.db).map((t) => [t.name, t.recordings])).toContainEqual(["Idées", 0]);
  });

  it("refuses an empty or long name, a missing episode, and a 21st tag", () => {
    const { episodeId } = conversation();
    expect(tag(episodeId, " # ")).toEqual({ ok: false, reason: "invalid-name" });
    expect(tag(episodeId, "x".repeat(41))).toEqual({ ok: false, reason: "invalid-name" });
    expect(tag(episodeId + 99, "idées")).toEqual({ ok: false, reason: "missing" });
    for (let index = 0; index < 20; index += 1) expect(tag(episodeId, `t${index}`).ok).toBe(true);
    expect(tag(episodeId, "t21")).toEqual({ ok: false, reason: "too-many" });
    // One it already has is fine.
    expect(tag(episodeId, "t3").ok).toBe(true);
  });

  it("renames, merges into an existing tag, and deletes everywhere", () => {
    const first = conversation([[10, 40]]).episodeId;
    const second = conversation([[100, 140]]).episodeId;
    tag(first, "idée");
    tag(second, "idées");
    tag(second, "idée");
    const idee = listTags(temp.db).find((t) => t.name === "idée");
    const idees = listTags(temp.db).find((t) => t.name === "idées");
    if (idee === undefined || idees === undefined) throw new Error("no tags");
    expect(renameTag(temp.db, { tagId: idee.id, name: "Idée", nowMs: s(200) })).toMatchObject({
      ok: true,
      merged: false,
    });
    const merged = renameTag(temp.db, { tagId: idee.id, name: "IDÉES", nowMs: s(201) });
    expect(merged).toEqual({ ok: true, tag: { id: idees.id, name: "idées" }, merged: true });
    expect(names(first)).toEqual(["idées"]);
    expect(names(second)).toEqual(["idées"]);
    expect(taggedEpisodeIds(temp.db, idees.id).toSorted()).toEqual([first, second].toSorted());
    expect(deleteTag(temp.db, idees.id)).toBe(2);
    expect(count(temp.db, "recording_tags")).toBe(0);
    expect(deleteTag(temp.db, idees.id)).toBeNull();
  });

  it("stays with the first half of a split and shows once after the merge back", () => {
    const { episodeId } = conversation([
      [10, 20],
      [30, 40],
    ]);
    tag(episodeId, "idées");
    const split = splitEpisode(temp.db, { episodeId, atMs: s(25), nowMs: s(101) });
    if (!split.ok) throw new Error(split.reason);
    const later = split.value.newEpisodeId;
    expect(names(episodeId)).toEqual(["idées"]);
    expect(names(later)).toEqual([]);
    tag(later, "idées");
    const merged = mergeEpisodes(temp.db, { episodeId, otherId: later, nowMs: s(102) });
    if (!merged.ok) throw new Error(merged.reason);
    expect(names(episodeId)).toEqual(["idées"]);
    // Taking it off takes off both rows.
    tag(episodeId, "idées", false);
    expect(count(temp.db, "recording_tags")).toBe(0);
  });

  it("moves out of a deleted passage and goes with a deleted recording", () => {
    const { episodeId } = conversation([
      [10, 20],
      [30, 40],
    ]);
    tag(episodeId, "idées");
    const passage = deletePassage(temp.db, {
      episodeId,
      fromMs: s(10),
      toMs: s(20),
      origin: "app",
      nowMs: s(110),
    });
    expect(passage.deleted).toBe(true);
    expect(names(episodeId)).toEqual(["idées"]);
    expect(deleteEpisode(temp.db, episodeId, { origin: "app", nowMs: s(120) }).deleted).toBe(true);
    expect(count(temp.db, "recording_tags")).toBe(0);
    expect(listTags(temp.db).map((t) => t.recordings)).toEqual([0]);
  });

  it("sweeps rows no episode holds", () => {
    const { episodeId, trackRunId } = conversation();
    tag(episodeId, "idées");
    const [row] = temp.db.client.prepare("SELECT tag_id FROM recording_tags").all();
    temp.db.client
      .prepare(
        "INSERT INTO recording_tags (tag_id, track_run_id, anchor_sample, origin, created_at_ms) VALUES (?, ?, ?, 'app', 0)",
      )
      .run(Number(row?.["tag_id"]), trackRunId, 16_000 * 1000);
    expect(deleteOrphanTags(temp.db)).toBe(1);
    expect(names(episodeId)).toEqual(["idées"]);
  });

  it("filters search by tag, and browses a tag without text", () => {
    const first = conversation([[10, 40]]).episodeId;
    const second = conversation([[100, 140]]).episodeId;
    const third = conversation([[200, 240]]).episodeId;
    tag(first, "idées");
    tag(third, "idées");
    const tagId = listTags(temp.db)[0]?.id ?? 0;
    expect(searchEpisodes(temp.db, "phrase", { limit: 10, offset: 0 }).total).toBe(3);
    const found = searchEpisodes(temp.db, "phrase", { limit: 10, offset: 0, tagId });
    expect(found.episodes.map((match) => match.episode.id)).toEqual([third, first]);
    const browsed = browseTag(temp.db, { tagId, limit: 1, offset: 0 });
    expect(browsed.total).toBe(2);
    expect(browsed.episodes.map((match) => match.episode.id)).toEqual([third]);
    expect(browseTag(temp.db, { tagId, limit: 1, offset: 1 }).episodes[0]?.episode.id).toBe(first);
    expect(browseTag(temp.db, { tagId, limit: 5, offset: 5 }).total).toBe(2);
    expect(second).toBeGreaterThan(0);
  });
});
