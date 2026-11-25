import { transaction, type Database } from "./database";
import { samplesToMs } from "./deleted-ranges";
import { endingSql } from "./episode-ends";
import { int, intOrNull, str, strOrNull, type Row } from "./rows";
import type { AssertionOrigin, ContextKind, ContextPreview } from "./schema/enums";
import { searchTextOf } from "./search-text";

// What the user added to a conversation (ADR 024): notes, links, images and
// files. An item is anchored like an assertion to a point of captured audio
// (`track_run_id`, `anchor_sample`) inside one of the episode's member slices,
// never to an episode id: the episode whose slice holds the point owns it, so
// regrouping, splits, merges and reanalyses move no item. Only deletions touch
// items: deleting an episode deletes its items, a tombstone deletes the items
// pinned to a sentence it meets, and a passage deletion that leaves the
// episode moves its conversation-wide items out of the passage.

/** Past any sample: an open slice reaches this far. */
const OPEN_END = Number.MAX_SAFE_INTEGER;

/** Longest note, in UTF-16 code units. */
export const MAX_NOTE_LENGTH = 20_000;
/** Longest link address or title. */
export const MAX_LINK_LENGTH = 4_096;

export interface ContextFile {
  readonly sha256: string;
  readonly bytes: number;
  readonly mediaType: string;
  /** An image's preview; null for a file, or an image `sips` could not read. */
  readonly preview: ContextPreview | null;
}

export type NewContextItem =
  | { readonly kind: "note"; readonly text: string }
  | { readonly kind: "link"; readonly url: string; readonly title: string | null }
  | {
      readonly kind: "image" | "file";
      readonly name: string;
      readonly file: ContextFile;
    };

export interface ContextItemRow {
  readonly id: number;
  readonly kind: ContextKind;
  readonly trackRunId: number;
  readonly anchorSample: number;
  /** The sentence it is pinned to, on its track; null for the whole conversation. */
  readonly span: { readonly start: number; readonly end: number } | null;
  /** A note's text or a link's address; empty for a file. */
  readonly body: string;
  /** A link's title, or a file's name. */
  readonly title: string | null;
  readonly file: ContextFile | null;
  /** An audio file's transcription: the imported recording made of it (ADR 021). */
  readonly transcriptRunId: number | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

/** An item with the episode it belongs to and, pinned, the sentence that shows it now. */
export interface ContextItemView extends ContextItemRow {
  readonly episodeId: number;
  /** The current segment its marker sits on; null for the whole conversation or before a transcript. */
  readonly segmentId: number | null;
  /** Wall time of its point: where it sits in the conversation. */
  readonly atMs: number;
  /** Its transcription's episode; null when never made, or deleted since. */
  readonly transcriptEpisodeId: number | null;
}

/** One member slice of an episode on one track. */
interface Slice {
  readonly trackRunId: number;
  readonly start: number;
  readonly end: number;
  readonly regionStart: number;
  readonly wallStartMs: number;
  readonly sampleRate: number;
}

function slicesOf(db: Database, episodeId: number): Slice[] {
  return db
    .statement(
      `SELECT r.track_run_id, m.slice_sample_start AS start,
         coalesce(m.slice_sample_end, r.sample_end, ${OPEN_END}) AS end,
         r.sample_start AS region_start, r.wall_start_ms, t.sample_rate
       FROM episode_regions m
       JOIN speech_regions r ON r.id = m.speech_region_id
       JOIN track_runs t ON t.id = r.track_run_id
       WHERE m.episode_id = ?`,
    )
    .all(episodeId)
    .map((row) => ({
      trackRunId: int(row, "track_run_id"),
      start: int(row, "start"),
      end: Math.max(int(row, "end"), int(row, "start") + 1),
      regionStart: int(row, "region_start"),
      wallStartMs: int(row, "wall_start_ms"),
      sampleRate: int(row, "sample_rate"),
    }))
    .toSorted((a, b) => wallOf(a, a.start) - wallOf(b, b.start) || a.trackRunId - b.trackRunId);
}

const wallOf = (slice: Slice, sample: number) =>
  slice.wallStartMs + samplesToMs(sample - slice.regionStart, slice.sampleRate);

/** Whether a user deletion's tombstone covers this sample of a track run. */
export function covered(db: Database, trackRunId: number, sample: number): boolean {
  return (
    db
      .statement(
        `SELECT 1 AS hit FROM deleted_ranges WHERE scope = 'track_run' AND track_run_id = ?
           AND sample_start <= ? AND sample_end > ? LIMIT 1`,
      )
      .get(trackRunId, sample, sample) !== undefined
  );
}

/** The first sample of a slice no tombstone covers (a neighbour's roll may cover its start). */
function firstFree(db: Database, slice: Slice): number | null {
  const stones = db
    .statement(
      `SELECT sample_start, sample_end FROM deleted_ranges WHERE scope = 'track_run'
         AND track_run_id = ? AND sample_start < ? AND sample_end > ? ORDER BY sample_start`,
    )
    .all(slice.trackRunId, slice.end, slice.start);
  let at = slice.start;
  for (const stone of stones) {
    if (int(stone, "sample_start") > at) break;
    at = Math.max(at, int(stone, "sample_end"));
  }
  return at < slice.end ? at : null;
}

/** Where an item is anchored, and the episode it is meant for. */
export interface ContextAnchor {
  readonly episodeId: number;
  readonly trackRunId: number;
  readonly anchorSample: number;
  /** The sentence's samples on that track; null for the whole conversation. */
  readonly span: { readonly start: number; readonly end: number } | null;
}

/** The whole conversation's anchor: its first audio no deletion took (tags use it too, ADR 039). */
export function wholeAnchor(db: Database, episodeId: number): ContextAnchor | null {
  for (const slice of slicesOf(db, episodeId)) {
    const at = firstFree(db, slice);
    if (at !== null)
      return { episodeId, trackRunId: slice.trackRunId, anchorSample: at, span: null };
  }
  return null;
}

/** A pinned item's anchor: the sentence's middle, clamped into the slice it overlaps most. */
function pinnedAnchor(
  db: Database,
  episodeId: number,
  pin: { readonly trackRunId: number; readonly start: number; readonly end: number },
): ContextAnchor | null {
  const own = slicesOf(db, episodeId).filter((slice) => slice.trackRunId === pin.trackRunId);
  if (own.length === 0) return null;
  const end = Math.max(pin.end, pin.start + 1);
  const overlap = (slice: Slice) => Math.min(end, slice.end) - Math.max(pin.start, slice.start);
  const distance = (slice: Slice) =>
    pin.start >= slice.end ? pin.start - slice.end + 1 : slice.start > end ? slice.start - end : 0;
  // The slice the sentence overlaps most, else the nearest: a sentence may start in the roll.
  const best = own.reduce((a, b) =>
    overlap(b) > overlap(a) || (overlap(b) === overlap(a) && distance(b) < distance(a)) ? b : a,
  );
  const middle = Math.floor((pin.start + end) / 2);
  const anchorSample = Math.min(Math.max(middle, best.start), best.end - 1);
  if (covered(db, pin.trackRunId, anchorSample)) return null;
  return {
    episodeId,
    trackRunId: pin.trackRunId,
    anchorSample,
    span: { start: pin.start, end },
  };
}

/** The episode whose member slice holds a point of capture; null when none does. */
export function episodeAt(db: Database, trackRunId: number, sample: number): number | null {
  const row = db
    .statement(
      `SELECT m.episode_id FROM speech_regions r
       JOIN episode_regions m ON m.speech_region_id = r.id
       WHERE r.track_run_id = ? AND r.sample_start <= ?
         AND m.slice_sample_start <= ? AND coalesce(m.slice_sample_end, r.sample_end, ${OPEN_END}) > ?
       ORDER BY m.episode_id DESC LIMIT 1`,
    )
    .get(trackRunId, sample, sample, sample);
  return row === undefined ? null : int(row, "episode_id");
}

export type ContextAnchorRefusal =
  /** No such episode, or no audio left in it to hold an item. */
  | "missing"
  /** No such sentence in the episode's transcript, or its audio was deleted. */
  | "no-sentence";

/**
 * Where items added now to an episode go: the whole conversation, or the
 * sentence `segmentId` of its current transcript. Planned before any file
 * is copied, so a deletion meanwhile is caught when they are written.
 */
export function planContextAnchor(
  db: Database,
  episodeId: number,
  segmentId?: number,
): ContextAnchor | ContextAnchorRefusal {
  if (db.statement("SELECT 1 AS hit FROM episodes WHERE id = ?").get(episodeId) === undefined) {
    return "missing";
  }
  if (segmentId === undefined) return wholeAnchor(db, episodeId) ?? "missing";
  const segment = db
    .statement(
      "SELECT track_run_id, sample_start, sample_end FROM segments WHERE id = ? AND episode_id = ?",
    )
    .get(segmentId, episodeId);
  if (segment === undefined) return "no-sentence";
  return (
    pinnedAnchor(db, episodeId, {
      trackRunId: int(segment, "track_run_id"),
      start: int(segment, "sample_start"),
      end: Math.max(int(segment, "sample_end"), int(segment, "sample_start") + 1),
    }) ?? "no-sentence"
  );
}

/** Whether a planned anchor still points into its episode's audio, deleted nowhere. */
function anchorHolds(db: Database, anchor: ContextAnchor): boolean {
  if (episodeAt(db, anchor.trackRunId, anchor.anchorSample) !== anchor.episodeId) return false;
  if (covered(db, anchor.trackRunId, anchor.anchorSample)) return false;
  if (anchor.span === null) return true;
  return (
    db
      .statement(
        `SELECT 1 AS hit FROM deleted_ranges WHERE scope = 'track_run' AND track_run_id = ?
           AND sample_start < ? AND sample_end > ? LIMIT 1`,
      )
      .get(anchor.trackRunId, anchor.span.end, anchor.span.start) === undefined
  );
}

/** What search reads of an item: a note's text, a link's title and address, a file's name. */
export function contextSearchText(item: NewContextItem): string {
  switch (item.kind) {
    case "note":
      return searchTextOf(item.text);
    case "link":
      return searchTextOf(`${item.title ?? ""} ${item.url}`);
    case "image":
    case "file":
      return searchTextOf(item.name);
  }
}

function rowOf(row: Row): ContextItemRow {
  const sha256 = strOrNull(row, "file_sha256");
  const spanStart = intOrNull(row, "span_start");
  const spanEnd = intOrNull(row, "span_end");
  const preview = strOrNull(row, "preview");
  return {
    id: int(row, "id"),
    kind: str(row, "kind") as ContextKind,
    trackRunId: int(row, "track_run_id"),
    anchorSample: int(row, "anchor_sample"),
    span: spanStart === null || spanEnd === null ? null : { start: spanStart, end: spanEnd },
    body: str(row, "body"),
    title: strOrNull(row, "title"),
    file:
      sha256 === null
        ? null
        : {
            sha256,
            bytes: int(row, "file_bytes"),
            mediaType: str(row, "media_type"),
            preview: preview === "jpeg" || preview === "png" ? preview : null,
          },
    transcriptRunId: intOrNull(row, "transcript_run_id"),
    createdAtMs: int(row, "created_at_ms"),
    updatedAtMs: int(row, "updated_at_ms"),
  };
}

const MEMBER_SQL = `
  FROM episode_regions m
  JOIN speech_regions r ON r.id = m.speech_region_id
  JOIN track_runs t ON t.id = r.track_run_id
  JOIN context_items c ON c.track_run_id = r.track_run_id
    AND c.anchor_sample >= m.slice_sample_start
    AND c.anchor_sample < coalesce(m.slice_sample_end, r.sample_end, ${OPEN_END})`;

/** The ids of the episode's items. */
function itemIdsOf(db: Database, episodeId: number): number[] {
  return db
    .statement(`SELECT DISTINCT c.id ${MEMBER_SQL} WHERE m.episode_id = ? ORDER BY c.id`)
    .all(episodeId)
    .map((row) => int(row, "id"));
}

/** The episode an item belongs to; null when its audio is in none (being deleted). */
export function contextEpisodeOf(db: Database, itemId: number): number | null {
  const row = db
    .statement(
      `SELECT m.episode_id ${MEMBER_SQL} WHERE c.id = ? ORDER BY m.episode_id DESC LIMIT 1`,
    )
    .get(itemId);
  return row === undefined ? null : int(row, "episode_id");
}

interface SegmentPlace {
  readonly id: number;
  readonly trackRunId: number;
  readonly start: number;
  readonly end: number;
}

/** The current sentence a pinned item's marker sits on. */
function segmentOf(item: ContextItemRow, segments: readonly SegmentPlace[]): number | null {
  if (item.span === null) return null;
  const { start, end } = item.span;
  const own = segments.filter((segment) => segment.trackRunId === item.trackRunId);
  if (own.length === 0) return null;
  const overlap = (segment: SegmentPlace) =>
    Math.min(end, Math.max(segment.end, segment.start + 1)) - Math.max(start, segment.start);
  const distance = (segment: SegmentPlace) =>
    item.anchorSample < segment.start
      ? segment.start - item.anchorSample
      : item.anchorSample >= segment.end
        ? item.anchorSample - segment.end + 1
        : 0;
  const best = own.reduce((a, b) =>
    overlap(b) > overlap(a) ||
    (overlap(b) === overlap(a) && overlap(a) <= 0 && distance(b) < distance(a))
      ? b
      : a,
  );
  return best.id;
}

/** The episode's context, oldest first, each with where it sits now. */
export function listContextItems(db: Database, episodeId: number): ContextItemView[] {
  const rows = db
    .statement(
      `SELECT DISTINCT c.*, r.sample_start AS region_start, r.wall_start_ms, t.sample_rate
       ${MEMBER_SQL} WHERE m.episode_id = ? ORDER BY c.created_at_ms, c.id`,
    )
    .all(episodeId);
  if (rows.length === 0) return [];
  const segments = db
    .statement(
      "SELECT id, track_run_id, sample_start, sample_end FROM segments WHERE episode_id = ?",
    )
    .all(episodeId)
    .map((row) => ({
      id: int(row, "id"),
      trackRunId: int(row, "track_run_id"),
      start: int(row, "sample_start"),
      end: int(row, "sample_end"),
    }));
  const seen = new Set<number>();
  return rows.flatMap((row) => {
    const item = rowOf(row);
    if (seen.has(item.id)) return [];
    seen.add(item.id);
    return [
      {
        ...item,
        episodeId,
        segmentId: segmentOf(item, segments),
        atMs:
          int(row, "wall_start_ms") +
          samplesToMs(item.anchorSample - int(row, "region_start"), int(row, "sample_rate")),
        transcriptEpisodeId:
          item.transcriptRunId === null ? null : episodeOfRun(db, item.transcriptRunId),
      },
    ];
  });
}

/** The episode holding a track run's audio: an imported recording has one. */
export function episodeOfRun(db: Database, trackRunId: number): number | null {
  const row = db
    .statement(
      `SELECT m.episode_id FROM episode_regions m
       JOIN speech_regions r ON r.id = m.speech_region_id
       WHERE r.track_run_id = ? ORDER BY m.episode_id LIMIT 1`,
    )
    .get(trackRunId);
  return row === undefined ? null : int(row, "episode_id");
}

/** Why a transcription cannot be linked to its item. */
export type TranscriptLinkRefusal = "missing" | "transcribed";

/**
 * Links an audio file's item to the imported recording made of it, in the
 * import's transaction: refused when the item is gone or holds other bytes
 * now, or already has a transcription still there.
 */
export function linkContextTranscript(
  db: Database,
  input: { readonly itemId: number; readonly sha256: string; readonly trackRunId: number },
): TranscriptLinkRefusal | null {
  const row = db
    .statement(
      "SELECT transcript_run_id FROM context_items WHERE id = ? AND kind = 'file' AND file_sha256 = ?",
    )
    .get(input.itemId, input.sha256);
  if (row === undefined) return "missing";
  const current = intOrNull(row, "transcript_run_id");
  if (current !== null && episodeOfRun(db, current) !== null) return "transcribed";
  db.statement("UPDATE context_items SET transcript_run_id = ? WHERE id = ?").run(
    input.trackRunId,
    input.itemId,
  );
  return null;
}

/** How long after a conversation ends ⌃⌥⌘V still adds to it. */
export const ONGOING_GRACE_MS = 5 * 60_000;

/**
 * The conversation going on, for the menu bar's « Ajouter le presse-papiers »
 * (ADR 024): an open episode, else one that ended within 5 minutes; a call
 * first, the latest heard first. Never media, a dictation or an import.
 */
export function ongoingEpisode(db: Database, nowMs: number): number | null {
  const row = db
    .statement(
      `SELECT id FROM episodes e
       WHERE (context IS NULL OR context IN ('call', 'in_person', 'mixed'))
         AND (state = 'open' OR ended_at_ms >= ?)
       ORDER BY (state = 'open' AND NOT ${endingSql("e")}) DESC, context = 'call' DESC, coalesce(ended_at_ms, ?) DESC,
         started_at_ms DESC, id DESC
       LIMIT 1`,
    )
    .get(nowMs - ONGOING_GRACE_MS, nowMs);
  return row === undefined ? null : int(row, "id");
}

/** The imported recordings items hold as their transcription. */
export function linkedTranscripts(db: Database): Set<number> {
  return new Set(
    db
      .statement(
        "SELECT DISTINCT transcript_run_id FROM context_items WHERE transcript_run_id IS NOT NULL",
      )
      .all()
      .map((row) => int(row, "transcript_run_id")),
  );
}

/** One item, with its episode; null once it is gone. */
export function getContextItem(db: Database, itemId: number): ContextItemView | null {
  const episodeId = contextEpisodeOf(db, itemId);
  if (episodeId === null) return null;
  return listContextItems(db, episodeId).find((item) => item.id === itemId) ?? null;
}

const indexItem = (db: Database, id: number, searchText: string) =>
  db.statement("INSERT INTO context_fts (rowid, search_text) VALUES (?, ?)").run(id, searchText);

/** Takes items out of the index before their rows change or go. */
const unindexWhere = (db: Database, where: string, ...params: (number | string)[]) =>
  db
    .statement(
      `INSERT INTO context_fts (context_fts, rowid, search_text)
       SELECT 'delete', id, search_text FROM context_items WHERE ${where}`,
    )
    .run(...params);

export type AddContextResult =
  | { readonly ok: true; readonly itemIds: readonly number[] }
  /** The episode, or the sentence, was deleted or regrouped away since the anchor was planned. */
  | { readonly ok: false };

/**
 * Writes items at an anchor `planContextAnchor` gave, in one transaction,
 * once it still holds: the episode still owns that audio and no deletion
 * reached it (an episode id may come back as another episode).
 */
export function addContextItems(
  db: Database,
  input: {
    readonly anchor: ContextAnchor;
    readonly items: readonly NewContextItem[];
    readonly origin: AssertionOrigin;
    readonly nowMs: number;
  },
): AddContextResult {
  const { anchor } = input;
  return transaction(db, (): AddContextResult => {
    if (!anchorHolds(db, anchor)) return { ok: false };
    const insert = db.statement(
      `INSERT INTO context_items (kind, track_run_id, anchor_sample, span_start, span_end, body,
         title, file_sha256, file_bytes, media_type, preview, search_text, origin, created_at_ms,
         updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const itemIds: number[] = [];
    // Items of one gesture keep their order: each a millisecond after the one before.
    for (const [index, item] of input.items.entries()) {
      const searchText = contextSearchText(item);
      const file = item.kind === "image" || item.kind === "file" ? item.file : null;
      const at = input.nowMs + index;
      const result = insert.run(
        item.kind,
        anchor.trackRunId,
        anchor.anchorSample,
        anchor.span?.start ?? null,
        anchor.span?.end ?? null,
        item.kind === "note" ? item.text : item.kind === "link" ? item.url : "",
        item.kind === "link" ? item.title : item.kind === "note" ? null : item.name,
        file?.sha256 ?? null,
        file?.bytes ?? null,
        file?.mediaType ?? null,
        file?.preview ?? null,
        searchText,
        input.origin,
        at,
        at,
      );
      const id = Number(result.lastInsertRowid);
      indexItem(db, id, searchText);
      itemIds.push(id);
    }
    return { ok: true, itemIds };
  });
}

export type ContextEdit =
  | { readonly kind: "note"; readonly text: string }
  | { readonly kind: "link"; readonly url: string; readonly title: string | null };

/** Changes a note's text or a link's address and title; false when there is no such item of that kind. */
export function editContextItem(
  db: Database,
  input: { readonly itemId: number; readonly edit: ContextEdit; readonly nowMs: number },
): boolean {
  const { itemId, edit, nowMs } = input;
  return transaction(db, () => {
    const row = db.statement("SELECT kind FROM context_items WHERE id = ?").get(itemId);
    if (row === undefined || str(row, "kind") !== edit.kind) return false;
    const item: NewContextItem =
      edit.kind === "note"
        ? { kind: "note", text: edit.text }
        : { kind: "link", url: edit.url, title: edit.title };
    const searchText = contextSearchText(item);
    unindexWhere(db, "id = ?", itemId);
    db.statement(
      "UPDATE context_items SET body = ?, title = ?, search_text = ?, updated_at_ms = ? WHERE id = ?",
    ).run(
      edit.kind === "note" ? edit.text : edit.url,
      edit.kind === "note" ? null : edit.title,
      searchText,
      nowMs,
      itemId,
    );
    indexItem(db, itemId, searchText);
    return true;
  });
}

/** Takes an item off its sentence: it is the whole conversation's now. False when it is not pinned. */
export function unpinContextItem(
  db: Database,
  input: { readonly itemId: number; readonly nowMs: number },
): boolean {
  return transaction(db, () => {
    const row = db.statement("SELECT span_start FROM context_items WHERE id = ?").get(input.itemId);
    if (row === undefined || intOrNull(row, "span_start") === null) return false;
    const episodeId = contextEpisodeOf(db, input.itemId);
    if (episodeId === null) return false;
    const anchor = wholeAnchor(db, episodeId);
    if (anchor === null) return false;
    db.statement(
      `UPDATE context_items SET track_run_id = ?, anchor_sample = ?, span_start = NULL,
         span_end = NULL, updated_at_ms = ? WHERE id = ?`,
    ).run(anchor.trackRunId, anchor.anchorSample, input.nowMs, input.itemId);
    return true;
  });
}

/** Removes one item (its file goes once nothing holds it). False when there is none. */
export function removeContextItem(db: Database, itemId: number): boolean {
  return transaction(db, () => {
    unindexWhere(db, "id = ?", itemId);
    return db.statement("DELETE FROM context_items WHERE id = ?").run(itemId).changes > 0;
  });
}

/** Deletes rows by id, index first. */
function deleteItems(db: Database, ids: readonly number[]): number {
  if (ids.length === 0) return 0;
  const json = JSON.stringify(ids);
  unindexWhere(db, "id IN (SELECT value FROM json_each(?))", json);
  return Number(
    db.statement("DELETE FROM context_items WHERE id IN (SELECT value FROM json_each(?))").run(json)
      .changes,
  );
}

/** Deleting an episode: every item it holds, read while its slices are still there. */
export function deleteEpisodeContext(db: Database, episodeId: number): number {
  return transaction(db, () => deleteItems(db, itemIdsOf(db, episodeId)));
}

/**
 * A tombstone over `[from, to)` of a track run: the items pinned to a
 * sentence it meets go with that sentence, whatever episode holds them.
 */
export function dropPinnedContext(
  db: Database,
  trackRunId: number,
  from: number,
  to: number,
): number {
  if (!(to > from)) return 0;
  return transaction(db, () =>
    deleteItems(
      db,
      db
        .statement(
          `SELECT id FROM context_items
           WHERE track_run_id = ? AND span_start IS NOT NULL AND span_start < ? AND span_end > ?`,
        )
        .all(trackRunId, to, from)
        .map((row) => int(row, "id")),
    ),
  );
}

/** Where items lived before a change: their episode, and its regions in time order. */
export type ContextHomes = ReadonlyMap<
  number,
  { readonly episodeId: number; readonly regionIds: readonly number[] }
>;

const anyContext = (db: Database) =>
  db.statement("SELECT 1 AS hit FROM context_items LIMIT 1").get() !== undefined;

/** The items of these episodes, with their home, before a change that may move their audio. */
export function contextHomes(db: Database, episodeIds: Iterable<number>): ContextHomes {
  const homes = new Map<number, { episodeId: number; regionIds: number[] }>();
  if (!anyContext(db)) return homes;
  const regions = db.statement(
    `SELECT m.speech_region_id FROM episode_regions m
     JOIN speech_regions r ON r.id = m.speech_region_id
     WHERE m.episode_id = ? ORDER BY r.wall_start_ms, m.slice_sample_start`,
  );
  for (const episodeId of new Set(episodeIds)) {
    const ids = itemIdsOf(db, episodeId);
    if (ids.length === 0) continue;
    const regionIds = regions.all(episodeId).map((row) => int(row, "speech_region_id"));
    for (const id of ids) homes.set(id, { episodeId, regionIds });
  }
  return homes;
}

/** The items anchored in these stretches of capture, with their home now. */
export function contextHomesIn(
  db: Database,
  ranges: readonly { readonly trackRunId: number; readonly from: number; readonly to: number }[],
): ContextHomes {
  const homes = new Map<number, { episodeId: number; regionIds: readonly number[] }>();
  if (ranges.length === 0 || !anyContext(db)) return homes;
  const query = db.statement(
    "SELECT id, anchor_sample FROM context_items WHERE track_run_id = ? AND anchor_sample >= ? AND anchor_sample < ?",
  );
  for (const range of ranges) {
    for (const row of query.all(range.trackRunId, range.from, range.to)) {
      const episodeId = episodeAt(db, range.trackRunId, int(row, "anchor_sample"));
      if (episodeId !== null) homes.set(int(row, "id"), { episodeId, regionIds: [] });
    }
  }
  return homes;
}

/** What settling did: items moved to their episode's first free audio, and items deleted. */
export interface SettleReport {
  readonly moved: number;
  readonly deleted: number;
}

/**
 * After a change (a grouping pass, a deletion): every item of `homes` still
 * stored whose point no episode holds any more, or a deletion covers, moves
 * to the first free audio of its episode (the same one if it still exists,
 * else the one that now holds the first of its former regions), as the whole
 * conversation's: its sentence is no longer there. An item no episode can
 * hold goes. `gone` names episodes the change deleted or created: an id of
 * theirs may now be another conversation's, so a home among them counts as
 * gone.
 */
export function settleContext(
  db: Database,
  homes: ContextHomes,
  nowMs: number,
  gone: ReadonlySet<number> = new Set(),
): SettleReport {
  if (homes.size === 0) return { moved: 0, deleted: 0 };
  return transaction(db, () => {
    const row = db.statement("SELECT track_run_id, anchor_sample FROM context_items WHERE id = ?");
    const exists = db.statement("SELECT 1 AS hit FROM episodes WHERE id = ?");
    const holder = db.statement(
      `SELECT m.episode_id FROM episode_regions m WHERE m.speech_region_id = ?
       ORDER BY m.episode_id DESC LIMIT 1`,
    );
    const update = db.statement(
      `UPDATE context_items SET track_run_id = ?, anchor_sample = ?, span_start = NULL,
         span_end = NULL, updated_at_ms = ? WHERE id = ?`,
    );
    const orphans: number[] = [];
    let moved = 0;
    for (const [id, home] of homes) {
      const item = row.get(id);
      if (item === undefined) continue;
      const trackRunId = int(item, "track_run_id");
      const sample = int(item, "anchor_sample");
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
      if (anchor === null) {
        orphans.push(id);
        continue;
      }
      moved += Number(update.run(anchor.trackRunId, anchor.anchorSample, nowMs, id).changes);
    }
    return { moved, deleted: deleteItems(db, orphans) };
  });
}

/**
 * Items whose audio no episode holds any more (a path that removed their
 * region without deleting them): deleted, so no file stays for nothing.
 * Run at startup; returns how many went.
 */
export function deleteOrphanContext(db: Database): number {
  return transaction(db, () =>
    deleteItems(
      db,
      db
        .statement(
          `SELECT c.id FROM context_items c WHERE NOT EXISTS (
             SELECT 1 FROM speech_regions r
             JOIN episode_regions m ON m.speech_region_id = r.id
             WHERE r.track_run_id = c.track_run_id
               AND c.anchor_sample >= m.slice_sample_start
               AND c.anchor_sample < coalesce(m.slice_sample_end, r.sample_end, ${OPEN_END}))`,
        )
        .all()
        .map((row) => int(row, "id")),
    ),
  );
}

/** Every file an item holds, by SHA-256: the rest of `<data>/context` may go. */
export function referencedContextFiles(db: Database): Set<string> {
  return new Set(
    db
      .statement("SELECT DISTINCT file_sha256 FROM context_items WHERE file_sha256 IS NOT NULL")
      .all()
      .map((row) => str(row, "file_sha256")),
  );
}

/** Whether an item already holds these bytes (no copy needed). */
export function hasContextFile(db: Database, sha256: string): ContextFile | null {
  const row = db
    .statement(
      "SELECT file_sha256, file_bytes, media_type, preview FROM context_items WHERE file_sha256 = ? LIMIT 1",
    )
    .get(sha256);
  if (row === undefined) return null;
  const preview = strOrNull(row, "preview");
  return {
    sha256,
    bytes: int(row, "file_bytes"),
    mediaType: str(row, "media_type"),
    preview: preview === "jpeg" || preview === "png" ? preview : null,
  };
}

/** Re-reads every item's search text with the current normalizer (`ensureSearchNormalizer`). */
export function reindexContext(db: Database): number {
  const rows = db.statement("SELECT id, kind, body, title FROM context_items").all();
  const update = db.statement("UPDATE context_items SET search_text = ? WHERE id = ?");
  for (const row of rows) {
    const kind = str(row, "kind");
    const body = str(row, "body");
    const title = strOrNull(row, "title");
    const text =
      kind === "note"
        ? searchTextOf(body)
        : kind === "link"
          ? searchTextOf(`${title ?? ""} ${body}`)
          : searchTextOf(title ?? "");
    update.run(text, int(row, "id"));
  }
  db.client.exec("INSERT INTO context_fts (context_fts) VALUES ('rebuild')");
  return rows.length;
}

/** A row exactly as stored, for ⌘Z's captures (undo.ts). */
export interface ContextItemState {
  readonly id: number;
  readonly kind: string;
  readonly trackRunId: number;
  readonly anchorSample: number;
  readonly spanStart: number | null;
  readonly spanEnd: number | null;
  readonly body: string;
  readonly title: string | null;
  readonly fileSha256: string | null;
  readonly fileBytes: number | null;
  readonly mediaType: string | null;
  readonly preview: string | null;
  readonly searchText: string;
  readonly origin: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly transcriptRunId: number | null;
}

/** The items anchored in these stretches of capture, by id. */
export function contextStatesIn(
  db: Database,
  window: readonly (readonly [trackRunId: number, start: number, end: number])[],
): ContextItemState[] {
  const query = db.statement(
    "SELECT * FROM context_items WHERE track_run_id = ? AND anchor_sample >= ? AND anchor_sample < ?",
  );
  const found = new Map<number, ContextItemState>();
  for (const [trackRunId, start, end] of window) {
    for (const row of query.all(trackRunId, start, end)) {
      found.set(int(row, "id"), {
        id: int(row, "id"),
        kind: str(row, "kind"),
        trackRunId: int(row, "track_run_id"),
        anchorSample: int(row, "anchor_sample"),
        spanStart: intOrNull(row, "span_start"),
        spanEnd: intOrNull(row, "span_end"),
        body: str(row, "body"),
        title: strOrNull(row, "title"),
        fileSha256: strOrNull(row, "file_sha256"),
        fileBytes: intOrNull(row, "file_bytes"),
        mediaType: strOrNull(row, "media_type"),
        preview: strOrNull(row, "preview"),
        searchText: str(row, "search_text"),
        origin: str(row, "origin"),
        createdAtMs: int(row, "created_at_ms"),
        updatedAtMs: int(row, "updated_at_ms"),
        transcriptRunId: intOrNull(row, "transcript_run_id"),
      });
    }
  }
  return [...found.values()].toSorted((a, b) => a.id - b.id);
}

/** Puts captured items back exactly, ids included, replacing the ones in `now` (undo.ts). */
export function restoreContextStates(
  db: Database,
  target: readonly ContextItemState[],
  now: readonly ContextItemState[],
): void {
  const wanted = new Map(target.map((item) => [item.id, item]));
  const same = (a: ContextItemState, b: ContextItemState) =>
    JSON.stringify(a) === JSON.stringify(b);
  for (const item of now) {
    const keep = wanted.get(item.id);
    if (keep !== undefined && same(keep, item)) continue;
    deleteItems(db, [item.id]);
  }
  const present = new Map(now.map((item) => [item.id, item]));
  const insert = db.statement(
    `INSERT INTO context_items (id, kind, track_run_id, anchor_sample, span_start, span_end, body,
       title, file_sha256, file_bytes, media_type, preview, search_text, origin, created_at_ms,
       updated_at_ms, transcript_run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const item of target) {
    const current = present.get(item.id);
    if (current !== undefined && same(current, item)) continue;
    insert.run(
      item.id,
      item.kind,
      item.trackRunId,
      item.anchorSample,
      item.spanStart,
      item.spanEnd,
      item.body,
      item.title,
      item.fileSha256,
      item.fileBytes,
      item.mediaType,
      item.preview,
      item.searchText,
      item.origin,
      item.createdAtMs,
      item.updatedAtMs,
      item.transcriptRunId,
    );
    indexItem(db, item.id, item.searchText);
  }
}
