import type { Database } from "./database";
import { int, intOrNull, str, type Row } from "./rows";

// « Terminer » (ADR 044): the user ended an ongoing episode at a moment. The
// end is a `force_boundary` assertion: its payload says when (continuous
// clock, so every pass cuts at the same sample) and in which lane, its anchor
// is the stretch of the episode's last speech before it, which says whose end
// it is whatever the episode's id became. Grouping applies it (`EpisodeEnd`),
// the episode closes once its audio is imported.

/** Open slices reach this far: past any sample. */
const OPEN_END = Number.MAX_SAFE_INTEGER;

const KIND = "force_boundary";

export interface StoredEnd {
  readonly id: number;
  /** The episode's lane, as grouping names it (`endLaneOf`). */
  readonly lane: string;
  /** When, on the capture clock of the boot that began at `bootWallMs`. */
  readonly continuousUs: number;
  readonly bootWallMs: number;
  /** When, in wall time. */
  readonly atWallMs: number;
  readonly trackRunId: number;
  readonly sampleStart: number;
  readonly sampleEnd: number;
}

const COLUMNS = "a.id, a.track_run_id, a.sample_start, a.sample_end, a.payload, a.created_at_ms";

function toEnd(row: Row): StoredEnd {
  const payload = JSON.parse(str(row, "payload")) as Record<string, unknown>;
  const { lane, continuousUs, bootWallMs } = payload;
  if (
    typeof lane !== "string" ||
    typeof continuousUs !== "number" ||
    typeof bootWallMs !== "number"
  ) {
    throw new Error(`assertion ${int(row, "id")} is not an end`);
  }
  return {
    id: int(row, "id"),
    lane,
    continuousUs,
    bootWallMs,
    atWallMs: int(row, "created_at_ms"),
    trackRunId: int(row, "track_run_id"),
    sampleStart: int(row, "sample_start"),
    sampleEnd: int(row, "sample_end"),
  };
}

/** An end `<a>` is the end of the episode holding member `<m>`, whose region is `<r>`. */
const holdsSql = (a: string, m: string, r: string): string =>
  `${a}.kind = '${KIND}' AND ${a}.revoked_at_ms IS NULL AND ${a}.track_run_id = ${r}.track_run_id
   AND ${a}.sample_start >= ${m}.slice_sample_start
   AND ${a}.sample_start < coalesce(${m}.slice_sample_end, ${r}.sample_end, ${OPEN_END})`;

/** The user ended the open episode `<e>`: it closes once its audio is imported. */
export const endingSql = (e: string): string =>
  `(${e}.state = 'open' AND EXISTS (SELECT 1 FROM episode_regions xm
     JOIN speech_regions xr ON xr.id = xm.speech_region_id
     JOIN user_assertions xa ON ${holdsSql("xa", "xm", "xr")}
     WHERE xm.episode_id = ${e}.id))`;

/** The ends made at or after `sinceWallMs`, oldest first. */
export function loadEnds(db: Database, sinceWallMs: number): StoredEnd[] {
  return db
    .statement(
      `SELECT ${COLUMNS} FROM user_assertions a
       WHERE a.kind = '${KIND}' AND a.revoked_at_ms IS NULL AND a.created_at_ms >= ?
       ORDER BY a.created_at_ms, a.id`,
    )
    .all(sinceWallMs)
    .map(toEnd);
}

/** The end of an episode, when the user ended it. */
export function endOfEpisode(db: Database, episodeId: number): StoredEnd | null {
  const row = db
    .statement(
      `SELECT ${COLUMNS} FROM episode_regions m
       JOIN speech_regions r ON r.id = m.speech_region_id
       JOIN user_assertions a ON ${holdsSql("a", "m", "r")}
       WHERE m.episode_id = ? ORDER BY a.created_at_ms DESC, a.id DESC LIMIT 1`,
    )
    .get(episodeId);
  return row === undefined ? null : toEnd(row);
}

interface Anchor {
  readonly trackRunId: number;
  readonly sampleStart: number;
  readonly sampleEnd: number;
}

/** The stretch of the episode's last speech, up to `atMs`: what its end is anchored to. */
function lastSpeech(db: Database, episodeId: number, atMs: number): Anchor | null {
  const row = db
    .statement(
      `SELECT r.track_run_id, t.sample_rate, r.sample_start, r.sample_end, r.wall_start_ms,
         m.slice_sample_start, m.slice_sample_end
       FROM episode_regions m
       JOIN speech_regions r ON r.id = m.speech_region_id
       JOIN track_runs t ON t.id = r.track_run_id
       WHERE m.episode_id = ?
       ORDER BY r.wall_start_ms DESC, m.slice_sample_start DESC, r.id DESC LIMIT 1`,
    )
    .get(episodeId);
  if (row === undefined) return null;
  const sampleStart = int(row, "slice_sample_start");
  const said =
    int(row, "sample_start") +
    Math.floor(((atMs - int(row, "wall_start_ms")) * int(row, "sample_rate")) / 1000);
  const held = intOrNull(row, "slice_sample_end") ?? intOrNull(row, "sample_end");
  return {
    trackRunId: int(row, "track_run_id"),
    sampleStart,
    sampleEnd: Math.max(sampleStart + 1, held ?? said),
  };
}

/** Keeps the user's end of an open episode. Null: it holds no speech. */
export function recordEnd(
  db: Database,
  input: {
    readonly episodeId: number;
    readonly lane: string;
    readonly continuousUs: number;
    readonly bootWallMs: number;
    readonly nowMs: number;
  },
): StoredEnd | null {
  const anchor = lastSpeech(db, input.episodeId, input.nowMs);
  if (anchor === null) return null;
  const { lane, continuousUs, bootWallMs } = input;
  return insertEnd(db, { ...anchor, lane, continuousUs, bootWallMs, atWallMs: input.nowMs });
}

/** Writes an end; with its id, one undone comes back as it was. */
export function insertEnd(
  db: Database,
  end: Omit<StoredEnd, "id"> & { readonly id?: number },
): StoredEnd {
  const row = db
    .statement(
      `INSERT INTO user_assertions (id, kind, track_run_id, sample_start, sample_end, payload,
         origin, created_at_ms)
       VALUES (?, '${KIND}', ?, ?, ?, ?, 'app', ?) RETURNING id`,
    )
    .get(
      end.id ?? null,
      end.trackRunId,
      end.sampleStart,
      end.sampleEnd,
      JSON.stringify({
        lane: end.lane,
        continuousUs: end.continuousUs,
        bootWallMs: end.bootWallMs,
      }),
      end.atWallMs,
    );
  if (row === undefined) throw new Error("user_assertions insert returned no row");
  return { ...end, id: int(row, "id") };
}

/** Takes an end away; false when it is already gone. */
export function deleteEnd(db: Database, id: number): boolean {
  const result = db
    .statement(`DELETE FROM user_assertions WHERE id = ? AND kind = '${KIND}'`)
    .run(id);
  return Number(result.changes) > 0;
}
