import { TAGS_PER_RECORDING_MAX, tagKey, tagName } from "@sondine/core";
import { covered, episodeAt, wholeAnchor } from "./context-items";
import { transaction, type Database } from "./database";
import { int, str } from "./rows";
import type { AssertionOrigin } from "./schema/enums";

// Tags on recordings (ADR 039). A tag is a word the user gives a whole
// recording; it is anchored like a context item for the whole conversation
// (ADR 024), at the first audio of the episode no deletion took, never to an
// episode id: regrouping, merges and reanalyses move nothing, a split leaves
// it with the first half. Deleting a recording deletes its tags; a passage
// deletion or a grouping pass that displaces an anchor settles it again at
// its episode's first free audio, as context does.

/** Past any sample: an open slice reaches this far. */
const OPEN_END = Number.MAX_SAFE_INTEGER;

/** The tag rows whose anchor an episode's member slices hold. */
const MEMBER_SQL = `
  FROM episode_regions m
  JOIN speech_regions r ON r.id = m.speech_region_id
  JOIN recording_tags rt ON rt.track_run_id = r.track_run_id
    AND rt.anchor_sample >= m.slice_sample_start
    AND rt.anchor_sample < coalesce(m.slice_sample_end, r.sample_end, ${OPEN_END})`;

/**
 * The episode holding a tag row's anchor, for `rt`: the latest region of its
 * track starting at or before the anchor, found through the
 * `(track_run_id, sample_start)` index without reading the track whole, then
 * the slice of it that holds the anchor (regions of one track never overlap).
 */
const HOLDER_SQL = `(
  SELECT m.episode_id FROM episode_regions m
  JOIN speech_regions r ON r.id = m.speech_region_id
  WHERE m.speech_region_id = (
      SELECT id FROM speech_regions
      WHERE track_run_id = rt.track_run_id AND sample_start <= rt.anchor_sample
      ORDER BY sample_start DESC LIMIT 1)
    AND m.slice_sample_start <= rt.anchor_sample
    AND coalesce(m.slice_sample_end, r.sample_end, ${OPEN_END}) > rt.anchor_sample
  ORDER BY m.episode_id DESC LIMIT 1)`;

export interface Tag {
  readonly id: number;
  readonly name: string;
}

export interface TagSummary extends Tag {
  /** Recordings it is on. */
  readonly recordings: number;
  readonly usedAtMs: number;
}

/** Every tag, the latest used first, with how many recordings carry it. */
export function listTags(db: Database): TagSummary[] {
  const episodes = new Map<number, Set<number>>();
  for (const row of db
    .statement(`SELECT rt.tag_id, ${HOLDER_SQL} AS episode_id FROM recording_tags rt`)
    .all()) {
    if (row["episode_id"] === null) continue;
    const tagId = int(row, "tag_id");
    episodes.set(tagId, (episodes.get(tagId) ?? new Set()).add(int(row, "episode_id")));
  }
  return db
    .statement("SELECT id, name, used_at_ms FROM tags ORDER BY used_at_ms DESC, id DESC")
    .all()
    .map((row) => ({
      id: int(row, "id"),
      name: str(row, "name"),
      recordings: episodes.get(int(row, "id"))?.size ?? 0,
      usedAtMs: int(row, "used_at_ms"),
    }));
}

/** The latest used tags' names, `limit` at most: what the phone offers (ADR 039). */
export function recentTagNames(db: Database, limit: number): string[] {
  return db
    .statement("SELECT name FROM tags ORDER BY used_at_ms DESC, id DESC LIMIT ?")
    .all(limit)
    .map((row) => str(row, "name"));
}

/** Each episode's tags, in the order they were put on it. */
export function episodeTags(
  db: Database,
  episodeIds: readonly number[],
): Map<number, readonly Tag[]> {
  const out = new Map<number, Tag[]>();
  if (episodeIds.length === 0 || !anyTag(db)) return out;
  const rows = db
    .statement(
      `SELECT m.episode_id, t.id, t.name, min(rt.created_at_ms) AS added ${MEMBER_SQL}
       JOIN tags t ON t.id = rt.tag_id
       WHERE m.episode_id IN (SELECT value FROM json_each(?))
       GROUP BY m.episode_id, t.id ORDER BY m.episode_id, added, t.id`,
    )
    .all(JSON.stringify(episodeIds));
  for (const row of rows) {
    const episodeId = int(row, "episode_id");
    const list = out.get(episodeId) ?? [];
    list.push({ id: int(row, "id"), name: str(row, "name") });
    out.set(episodeId, list);
  }
  return out;
}

/** The episodes carrying a tag, newest first. */
export function taggedEpisodeIds(db: Database, tagId: number): number[] {
  return db
    .statement(
      `SELECT e.id FROM episodes e WHERE e.id IN (
         SELECT ${HOLDER_SQL} FROM recording_tags rt WHERE rt.tag_id = ?)
       ORDER BY e.started_at_ms DESC, e.id DESC`,
    )
    .all(tagId)
    .map((row) => int(row, "id"));
}

/** A tag by its name's key; null when none has it. */
export function findTag(db: Database, name: string): Tag | null {
  const clean = tagName(name);
  if (clean === null) return null;
  const row = db.statement("SELECT id, name FROM tags WHERE key = ?").get(tagKey(clean));
  return row === undefined ? null : { id: int(row, "id"), name: str(row, "name") };
}

export type TagRefusal =
  /** No such episode, or no audio left in it to hold a tag. */
  | "missing"
  /** Empty once cleaned, or longer than `TAG_NAME_MAX`. */
  | "invalid-name"
  /** The recording already has `TAGS_PER_RECORDING_MAX` tags. */
  | "too-many";

export type TagOutcome =
  | { readonly ok: true; readonly tags: readonly Tag[] }
  | { readonly ok: false; readonly reason: TagRefusal };

/**
 * Puts a tag on an episode, creating it from the name when no tag has its
 * key, or takes it off (every row of it the episode holds). Taking off a
 * tag it does not have, or putting one it has, changes nothing but the
 * tag's recency. Answers the episode's tags after.
 */
export function setEpisodeTag(
  db: Database,
  input: {
    readonly episodeId: number;
    readonly name: string;
    readonly on: boolean;
    readonly origin: AssertionOrigin;
    readonly nowMs: number;
  },
): TagOutcome {
  const { episodeId, on, origin, nowMs } = input;
  const name = tagName(input.name);
  if (name === null) return { ok: false, reason: "invalid-name" };
  return transaction(db, (): TagOutcome => {
    if (db.statement("SELECT 1 AS hit FROM episodes WHERE id = ?").get(episodeId) === undefined) {
      return { ok: false, reason: "missing" };
    }
    const current = episodeTags(db, [episodeId]).get(episodeId) ?? [];
    const key = tagKey(name);
    const existing = db.statement("SELECT id FROM tags WHERE key = ?").get(key);
    if (!on) {
      if (existing !== undefined) {
        const tagId = int(existing, "id");
        db.statement(
          `DELETE FROM recording_tags WHERE rowid IN (
             SELECT rt.rowid ${MEMBER_SQL} WHERE m.episode_id = ? AND rt.tag_id = ?)`,
        ).run(episodeId, tagId);
      }
      return { ok: true, tags: episodeTags(db, [episodeId]).get(episodeId) ?? [] };
    }
    const has = existing !== undefined && current.some((tag) => tag.id === int(existing, "id"));
    if (!has && current.length >= TAGS_PER_RECORDING_MAX) return { ok: false, reason: "too-many" };
    const anchor = wholeAnchor(db, episodeId);
    if (anchor === null) return { ok: false, reason: "missing" };
    let tagId: number;
    if (existing === undefined) {
      tagId = Number(
        db
          .statement(
            "INSERT INTO tags (name, key, created_at_ms, used_at_ms) VALUES (?, ?, ?, ?) RETURNING id",
          )
          .get(name, key, nowMs, nowMs)?.["id"],
      );
    } else {
      tagId = int(existing, "id");
      db.statement("UPDATE tags SET used_at_ms = ? WHERE id = ?").run(nowMs, tagId);
    }
    if (!has) {
      db.statement(
        `INSERT OR IGNORE INTO recording_tags (tag_id, track_run_id, anchor_sample, origin, created_at_ms)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(tagId, anchor.trackRunId, anchor.anchorSample, origin, nowMs);
    }
    return { ok: true, tags: episodeTags(db, [episodeId]).get(episodeId) ?? [] };
  });
}

export type RenameOutcome =
  | { readonly ok: true; readonly tag: Tag; readonly merged: boolean }
  | { readonly ok: false; readonly reason: "missing" | "invalid-name" };

/**
 * Renames a tag; to the name of another tag, merges it into that one (its
 * recordings get the other tag, then it goes).
 */
export function renameTag(
  db: Database,
  input: { readonly tagId: number; readonly name: string; readonly nowMs: number },
): RenameOutcome {
  const name = tagName(input.name);
  if (name === null) return { ok: false, reason: "invalid-name" };
  return transaction(db, (): RenameOutcome => {
    if (db.statement("SELECT 1 AS hit FROM tags WHERE id = ?").get(input.tagId) === undefined) {
      return { ok: false, reason: "missing" };
    }
    const key = tagKey(name);
    const other = db
      .statement("SELECT id, name FROM tags WHERE key = ? AND id != ?")
      .get(key, input.tagId);
    if (other === undefined) {
      db.statement("UPDATE tags SET name = ?, key = ?, used_at_ms = ? WHERE id = ?").run(
        name,
        key,
        input.nowMs,
        input.tagId,
      );
      return { ok: true, tag: { id: input.tagId, name }, merged: false };
    }
    const into = int(other, "id");
    db.statement(
      `INSERT OR IGNORE INTO recording_tags (tag_id, track_run_id, anchor_sample, origin, created_at_ms)
       SELECT ?, track_run_id, anchor_sample, origin, created_at_ms FROM recording_tags WHERE tag_id = ?`,
    ).run(into, input.tagId);
    db.statement("DELETE FROM tags WHERE id = ?").run(input.tagId);
    db.statement("UPDATE tags SET used_at_ms = ? WHERE id = ?").run(input.nowMs, into);
    return { ok: true, tag: { id: into, name: str(other, "name") }, merged: true };
  });
}

/** Deletes a tag from every recording; answers how many recordings had it, or null when none such. */
export function deleteTag(db: Database, tagId: number): number | null {
  return transaction(db, () => {
    if (db.statement("SELECT 1 AS hit FROM tags WHERE id = ?").get(tagId) === undefined)
      return null;
    const recordings = taggedEpisodeIds(db, tagId).length;
    db.statement("DELETE FROM recording_tags WHERE tag_id = ?").run(tagId);
    db.statement("DELETE FROM tags WHERE id = ?").run(tagId);
    return recordings;
  });
}

const anyTag = (db: Database) =>
  db.statement("SELECT 1 AS hit FROM recording_tags LIMIT 1").get() !== undefined;

/** Deleting an episode: every tag row it holds, read while its slices are still there. */
export function deleteEpisodeTags(db: Database, episodeId: number): number {
  if (!anyTag(db)) return 0;
  return Number(
    db
      .statement(
        `DELETE FROM recording_tags WHERE rowid IN (SELECT rt.rowid ${MEMBER_SQL} WHERE m.episode_id = ?)`,
      )
      .run(episodeId).changes,
  );
}

/** Where tag rows lived before a change, by rowid: their episode and its regions in time order. */
export type TagHomes = ReadonlyMap<
  number,
  { readonly episodeId: number; readonly regionIds: readonly number[] }
>;

/** The tag rows of these episodes, with their home, before a change that may move their audio. */
export function tagHomes(db: Database, episodeIds: Iterable<number>): TagHomes {
  const homes = new Map<number, { episodeId: number; regionIds: number[] }>();
  if (!anyTag(db)) return homes;
  const rows = db.statement(`SELECT DISTINCT rt.rowid AS id ${MEMBER_SQL} WHERE m.episode_id = ?`);
  const regions = db.statement(
    `SELECT m.speech_region_id FROM episode_regions m
     JOIN speech_regions r ON r.id = m.speech_region_id
     WHERE m.episode_id = ? ORDER BY r.wall_start_ms, m.slice_sample_start`,
  );
  for (const episodeId of new Set(episodeIds)) {
    const ids = rows.all(episodeId).map((row) => int(row, "id"));
    if (ids.length === 0) continue;
    const regionIds = regions.all(episodeId).map((row) => int(row, "speech_region_id"));
    for (const id of ids) homes.set(id, { episodeId, regionIds });
  }
  return homes;
}

/** The tag rows anchored in these stretches of capture, with their home now. */
export function tagHomesIn(
  db: Database,
  ranges: readonly { readonly trackRunId: number; readonly from: number; readonly to: number }[],
): TagHomes {
  const homes = new Map<number, { episodeId: number; regionIds: readonly number[] }>();
  if (ranges.length === 0 || !anyTag(db)) return homes;
  const query = db.statement(
    `SELECT rowid AS id, anchor_sample FROM recording_tags
     WHERE track_run_id = ? AND anchor_sample >= ? AND anchor_sample < ?`,
  );
  for (const range of ranges) {
    for (const row of query.all(range.trackRunId, range.from, range.to)) {
      const episodeId = episodeAt(db, range.trackRunId, int(row, "anchor_sample"));
      if (episodeId !== null) homes.set(int(row, "id"), { episodeId, regionIds: [] });
    }
  }
  return homes;
}

/**
 * After a change (a grouping pass, a deletion): every tag row of `homes`
 * whose point no episode holds any more, or a deletion covers, moves to the
 * first free audio of its episode (the same one if it still exists, else the
 * one that now holds the first of its former regions), as `settleContext`
 * does; a row no episode can hold goes, and so does one whose episode
 * already has that tag. `gone` names episodes the change deleted or created.
 */
export function settleTags(
  db: Database,
  homes: TagHomes,
  gone: ReadonlySet<number> = new Set(),
): { readonly moved: number; readonly deleted: number } {
  if (homes.size === 0) return { moved: 0, deleted: 0 };
  return transaction(db, () => {
    const row = db.statement(
      "SELECT tag_id, track_run_id, anchor_sample FROM recording_tags WHERE rowid = ?",
    );
    const exists = db.statement("SELECT 1 AS hit FROM episodes WHERE id = ?");
    const holder = db.statement(
      `SELECT m.episode_id FROM episode_regions m WHERE m.speech_region_id = ?
       ORDER BY m.episode_id DESC LIMIT 1`,
    );
    const remove = db.statement("DELETE FROM recording_tags WHERE rowid = ?");
    const move = db.statement(
      "UPDATE OR IGNORE recording_tags SET track_run_id = ?, anchor_sample = ? WHERE rowid = ?",
    );
    let moved = 0;
    let deleted = 0;
    for (const [id, home] of homes) {
      const tag = row.get(id);
      if (tag === undefined) continue;
      const trackRunId = int(tag, "track_run_id");
      const sample = int(tag, "anchor_sample");
      const current = episodeAt(db, trackRunId, sample);
      if (current !== null && !covered(db, trackRunId, sample)) continue;
      const stayed = !gone.has(home.episodeId) && exists.get(home.episodeId) !== undefined;
      let target = current ?? (stayed ? home.episodeId : null);
      for (const regionId of home.regionIds) {
        if (target !== null) break;
        const found = holder.get(regionId);
        if (found !== undefined) target = int(found, "episode_id");
      }
      const anchor = target === null ? null : wholeAnchor(db, target);
      const already =
        anchor !== null &&
        target !== null &&
        (episodeTags(db, [target]).get(target) ?? []).some((t) => t.id === int(tag, "tag_id")) &&
        current !== target;
      if (anchor === null || already) {
        deleted += Number(remove.run(id).changes);
        continue;
      }
      const changed = Number(move.run(anchor.trackRunId, anchor.anchorSample, id).changes);
      if (changed === 0) deleted += Number(remove.run(id).changes);
      else moved += changed;
    }
    return { moved, deleted };
  });
}

/** Tag rows whose audio no episode holds any more: deleted. Run at startup; returns how many went. */
export function deleteOrphanTags(db: Database): number {
  return Number(
    db
      .statement(
        `DELETE FROM recording_tags WHERE NOT EXISTS (
           SELECT 1 FROM speech_regions r
           JOIN episode_regions m ON m.speech_region_id = r.id
           WHERE r.track_run_id = recording_tags.track_run_id
             AND recording_tags.anchor_sample >= m.slice_sample_start
             AND recording_tags.anchor_sample < coalesce(m.slice_sample_end, r.sample_end, ${OPEN_END}))`,
      )
      .run().changes,
  );
}
