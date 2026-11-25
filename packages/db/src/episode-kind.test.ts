import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { splitEpisode } from "./episode-boundaries";
import { episodeKindOverride, setEpisodeKind } from "./episode-kind";
import { updateEpisodeSize } from "./episodes-store";
import { seedEpisode, t0, tempDatabase, type TempDatabase } from "./test-helpers";

let temp: TempDatabase;
beforeEach(() => {
  temp = tempDatabase();
});
afterEach(() => temp.cleanup());

const kindOf = (episodeId: number) =>
  temp.db.client.prepare("SELECT size, context FROM episodes WHERE id = ?").get(episodeId);

function closed(context: string, size: string) {
  const { episodeId } = seedEpisode(temp.db, [
    [10, 20],
    [40, 50],
  ]);
  temp.db.client
    .prepare("UPDATE episodes SET size = ?, context = ? WHERE id = ?")
    .run(size, context, episodeId);
  return episodeId;
}

describe("episode kind", () => {
  it("holds the user's word over later decisions, and hands back Sondine's", () => {
    const episodeId = closed("in_person", "moment");
    expect(setEpisodeKind(temp.db, { episodeId, kind: "conversation", nowMs: t0 })).toBe(true);
    expect(kindOf(episodeId)).toEqual({ size: "conversation", context: "in_person" });
    expect(episodeKindOverride(temp.db, episodeId)).toBe("conversation");

    // A transcript re-decides the size: the user's word still wins.
    updateEpisodeSize(
      temp.db,
      episodeId,
      {
        size: "moment",
        sizeState: "final",
        kindInputs: { rule: "voiced" },
        classifierVersion: "size/1",
      },
      t0 + 1,
    );
    expect(kindOf(episodeId)).toEqual({ size: "conversation", context: "in_person" });

    expect(setEpisodeKind(temp.db, { episodeId, kind: null, nowMs: t0 + 2 })).toBe(true);
    expect(kindOf(episodeId)).toEqual({ size: "moment", context: "in_person" });
    expect(episodeKindOverride(temp.db, episodeId)).toBeNull();
  });

  it("turns media into speech and back, and follows the audio through a split", () => {
    const episodeId = closed("media", "conversation");
    setEpisodeKind(temp.db, { episodeId, kind: "moment", nowMs: t0 });
    expect(kindOf(episodeId)).toEqual({ size: "moment", context: "in_person" });
    setEpisodeKind(temp.db, { episodeId, kind: "media", nowMs: t0 + 1 });
    expect(kindOf(episodeId)).toEqual({ size: "conversation", context: "media" });
    setEpisodeKind(temp.db, { episodeId, kind: null, nowMs: t0 + 2 });
    expect(kindOf(episodeId)).toEqual({ size: "conversation", context: "media" });

    const other = closed("in_person", "conversation");
    setEpisodeKind(temp.db, { episodeId: other, kind: "media", nowMs: t0 + 3 });
    const split = splitEpisode(temp.db, { episodeId: other, atMs: t0 + 30_000, nowMs: t0 + 4 });
    if (!split.ok) throw new Error(split.reason);
    // The override is anchored in one of the two parts.
    const kinds = [other, split.value.newEpisodeId].map((id) => episodeKindOverride(temp.db, id));
    expect(kinds.filter((kind) => kind === "media")).toHaveLength(1);
  });

  it("refuses an episode that is not closed", () => {
    const episodeId = closed("in_person", "moment");
    temp.db.client.prepare("UPDATE episodes SET state = 'open' WHERE id = ?").run(episodeId);
    expect(setEpisodeKind(temp.db, { episodeId, kind: "media", nowMs: t0 })).toBe(false);
  });
});
