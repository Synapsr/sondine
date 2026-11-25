import { upsertApp } from "./capture-import";
import { transaction, type Database } from "./database";
import { samplesToMs } from "./deleted-ranges";
import { appDisplayName, type EpisodeApp } from "./episode-sources";
import { int, intOrNull } from "./rows";

// The app in front on the Mac while something was said (ADR 022): the helper
// cuts each speech region at every change of the app in front, and these
// spans are all Sondine keeps of it, never the rest of the day. A span goes
// with its region (cascade); a deletion that keeps the region cuts it like the
// user's assertions. A sentence was said in the app in front at its middle.

/** One span of the app in front, in run samples, as the helper reported it for a region. */
export interface ForegroundSpanInput {
  readonly bundleId: string;
  readonly name: string;
  readonly sampleStart: number;
  readonly sampleEnd: number;
}

/**
 * Stores the apps in front over a closed region, clipped to the region as
 * stored (a deletion may have cut its end). A replayed close changes nothing.
 * Returns the spans inserted.
 */
export function recordForegroundSpans(
  db: Database,
  input: {
    readonly speechRegionId: number;
    readonly spans: readonly ForegroundSpanInput[];
    readonly seenAtMs: number;
  },
): number {
  if (input.spans.length === 0) return 0;
  return transaction(db, () => {
    const region = db
      .statement(
        `SELECT r.track_run_id, r.sample_start, r.sample_end, r.wall_start_ms, t.sample_rate
         FROM speech_regions r JOIN track_runs t ON t.id = r.track_run_id
         WHERE r.id = ? AND r.state = 'closed'`,
      )
      .get(input.speechRegionId);
    if (region === undefined) return 0;
    const start = int(region, "sample_start");
    const end = intOrNull(region, "sample_end") ?? start;
    const rate = int(region, "sample_rate");
    const wallStartMs = int(region, "wall_start_ms");
    const insert = db.statement(
      `INSERT OR IGNORE INTO foreground_spans
         (speech_region_id, track_run_id, sample_start, sample_end, wall_start_ms, wall_end_ms, app_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    let inserted = 0;
    let previousEnd = start;
    for (const span of input.spans) {
      const from = Math.max(span.sampleStart, previousEnd);
      const to = Math.min(span.sampleEnd, end);
      if (to <= from) continue;
      previousEnd = to;
      const { appId } = upsertApp(db, {
        bundleId: span.bundleId,
        name: span.name,
        seenAtMs: input.seenAtMs,
      });
      const changes = insert.run(
        input.speechRegionId,
        int(region, "track_run_id"),
        from,
        to,
        wallStartMs + samplesToMs(from - start, rate),
        wallStartMs + samplesToMs(to - start, rate),
        appId,
      ).changes;
      inserted += Number(changes);
    }
    return inserted;
  });
}

/**
 * Removes what lies in `[from, to)` of a track run (a deletion's tombstone):
 * spans inside go, spans across an edge keep their outside part.
 */
export function cutForegroundSpans(
  db: Database,
  trackRunId: number,
  from: number,
  to: number,
): void {
  if (!(to > from)) return;
  transaction(db, () => {
    const rows = db
      .statement(
        `SELECT id, speech_region_id, sample_start, sample_end, wall_start_ms, wall_end_ms, app_id
         FROM foreground_spans WHERE track_run_id = ? AND sample_start < ? AND sample_end > ?`,
      )
      .all(trackRunId, to, from);
    const remove = db.statement("DELETE FROM foreground_spans WHERE id = ?");
    const insert = db.statement(
      `INSERT INTO foreground_spans
         (speech_region_id, track_run_id, sample_start, sample_end, wall_start_ms, wall_end_ms, app_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of rows) {
      const start = int(row, "sample_start");
      const end = int(row, "sample_end");
      const wallStart = int(row, "wall_start_ms");
      const wallEnd = int(row, "wall_end_ms");
      const wallAt = (sample: number) =>
        wallStart + Math.round(((sample - start) * (wallEnd - wallStart)) / (end - start));
      remove.run(int(row, "id"));
      const parts: [number, number][] = [];
      if (start < from) parts.push([start, from]);
      if (end > to) parts.push([to, end]);
      for (const [a, b] of parts) {
        insert.run(
          int(row, "speech_region_id"),
          trackRunId,
          a,
          b,
          wallAt(a),
          wallAt(b),
          int(row, "app_id"),
        );
      }
    }
  });
}

/** « Forget the last minutes »: every span heard in the wall range goes, whole. */
export function forgetForegroundBetween(db: Database, fromWallMs: number, toWallMs: number): void {
  db.statement("DELETE FROM foreground_spans WHERE wall_start_ms < ? AND wall_end_ms > ?").run(
    toWallMs,
    fromWallMs,
  );
}

/**
 * The id of the app in front at the middle of a segment of `segments`
 * aliased `alias`, or null: the span of its track run starting last at or
 * before that sample, when it reaches past it. Spans of a run never overlap,
 * so this is one index seek.
 */
export function segmentAppIdSql(alias: string): string {
  const middle = `((${alias}.sample_start + ${alias}.sample_end) / 2)`;
  return `(SELECT CASE WHEN f.sample_end > ${middle} THEN f.app_id END
    FROM foreground_spans f
    WHERE f.track_run_id = ${alias}.track_run_id AND f.sample_start <= ${middle}
    ORDER BY f.sample_start DESC LIMIT 1)`;
}

/** The app of a row read with `appColumns`, or null. */
export function appOf(row: Record<string, unknown>): EpisodeApp | null {
  const bundleId = row["app_bundle_id"];
  const name = row["app_name"];
  if (typeof bundleId !== "string" || typeof name !== "string") return null;
  return { bundleId, name: appDisplayName(name) };
}

/** Columns naming an app joined as `alias` (see `appOf`). */
export const appColumns = (alias: string): string =>
  `${alias}.bundle_id AS app_bundle_id, coalesce(${alias}.name, ${alias}.bundle_id) AS app_name`;

/**
 * The apps something was said in, the latest first: what « dit pendant que
 * j'étais dans… » offers.
 */
export function listForegroundApps(db: Database, limit = 50): EpisodeApp[] {
  return db
    .statement(
      `SELECT ${appColumns("a")}, max(f.wall_start_ms) AS last_ms
       FROM foreground_spans f JOIN apps a ON a.id = f.app_id
       GROUP BY f.app_id ORDER BY last_ms DESC, a.bundle_id LIMIT ?`,
    )
    .all(limit)
    .flatMap((row) => {
      const app = appOf(row);
      return app === null ? [] : [app];
    });
}
