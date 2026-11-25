import type { Database } from "./database";
import { endingSql } from "./episode-ends";
import { loadEpisodeApps, type EpisodeApp, type EpisodeAppsInput } from "./episode-sources";
import {
  listEpisodes,
  loadEpisodeSummaries,
  timelineLaneSql,
  timelineLanes,
  transcribedSql,
  type EpisodeCursor,
  type EpisodeSummaryRow,
} from "./episodes-store";
import { int, intOrNull, oneOfValues, str } from "./rows";
import { episodeContexts } from "./schema/enums";

// The Today screen's read model (architecture §11): one local day as the
// timeline shows it, computed here so the screen never aggregates a list it
// may only have part of.

/** One local hour of the day; the caller computes them in the Mac's time zone. */
export interface DayHour {
  /** 0 to 23, as the clock shows it. */
  readonly hour: number;
  readonly startMs: number;
  /** Exclusive. A daylight saving day has 23 or 25 hours of wall time, never a duplicate hour. */
  readonly endMs: number;
}

export interface EpisodeDayOptions {
  readonly fromMs: number;
  readonly toMs: number;
  /** The day's hours, in order, covering `[fromMs, toMs)`. */
  readonly hours: readonly DayHour[];
  /** Conversations, media and dictations returned before paging with `listEpisodes`. */
  readonly pageSize: number;
  /** First words shown per hour of moments. Defaults to 3. */
  readonly previewsPerHour?: number;
  /** An open episode reaches it, for the apps heard. Defaults to `Date.now()`. */
  readonly nowMs?: number;
}

export interface EpisodePageRows {
  /** Newest first. */
  readonly episodes: readonly EpisodeSummaryRow[];
  readonly total: number;
  /** The last episode returned, when more follow. */
  readonly next: EpisodeCursor | null;
}

export interface MomentHourRow {
  readonly hour: number;
  readonly startMs: number;
  readonly moments: number;
  /** Moments without a transcript (still open, waiting, or failed). */
  readonly untranscribed: number;
  /** Newest first: the first words of the newest moments that have text. */
  readonly previews: readonly { readonly episodeId: number; readonly text: string }[];
  /** The apps its moments heard (calls, what played, dictation apps), the most named first. */
  readonly apps: readonly EpisodeApp[];
}

export interface EpisodeDayRows {
  /** Changes whenever an episode of the day is added, changed or removed. */
  readonly revision: string;
  readonly conversations: EpisodePageRows;
  /** Newest first, hours with moments only. */
  readonly momentHours: readonly MomentHourRow[];
  readonly media: EpisodePageRows;
  readonly dictations: EpisodePageRows;
  readonly traces: number;
  /**
   * Open episodes outside media and dictations, whatever their size so far,
   * newest first; one begun the day before too.
   */
  readonly ongoing: readonly EpisodeSummaryRow[];
}

/**
 * One local day: conversations (open ones included, with their provisional
 * size), moments counted per hour with a few previews, media and dictations
 * apart, and a count of traces. One indexed scan of the day's episodes, then
 * summaries for the first page of conversations, media and dictations and the
 * previews' first words.
 */
export function loadEpisodeDay(db: Database, options: EpisodeDayOptions): EpisodeDayRows {
  const scan = db
    .statement(
      `SELECT e.id, e.context, e.started_at_ms, e.ended_at_ms, e.updated_at_ms,
         ${timelineLaneSql} AS lane,
         ${transcribedSql} AS transcribed,
         CASE WHEN ${timelineLaneSql} = 'moments'
           THEN EXISTS (SELECT 1 FROM segments s WHERE s.episode_id = e.id) ELSE 0 END AS has_text
       FROM episodes e
       WHERE e.started_at_ms >= ? AND e.started_at_ms < ?
       ORDER BY e.started_at_ms DESC, e.id DESC`,
    )
    .all(options.fromMs, options.toMs);

  const revision = new RevisionHash();
  // Imported recordings are counted apart, never shown: Today is what the Mac heard.
  const lanes = { conversations: 0, moments: 0, media: 0, dictations: 0, imports: 0, traces: 0 };
  const hours = new Map<
    number,
    { moments: number; untranscribed: number; withText: number[]; ids: number[] }
  >();
  const moments: EpisodeAppsInput[] = [];
  const perHour = options.previewsPerHour ?? 3;
  for (const row of scan) {
    revision.add(int(row, "id"));
    revision.add(int(row, "updated_at_ms"));
    const lane = oneOfValues(row, "lane", timelineLanes);
    lanes[lane] += 1;
    if (lane !== "moments") continue;
    const hour = hourOf(options.hours, int(row, "started_at_ms"));
    if (hour === null) continue;
    const bucket = hours.get(hour.hour) ?? { moments: 0, untranscribed: 0, withText: [], ids: [] };
    bucket.moments += 1;
    bucket.ids.push(int(row, "id"));
    moments.push({
      id: int(row, "id"),
      context: row["context"] === null ? null : oneOfValues(row, "context", episodeContexts),
      startedAtMs: int(row, "started_at_ms"),
      endedAtMs: intOrNull(row, "ended_at_ms"),
    });
    if (int(row, "transcribed") === 0) bucket.untranscribed += 1;
    if (int(row, "has_text") === 1 && bucket.withText.length < perHour) {
      bucket.withText.push(int(row, "id"));
    }
    hours.set(hour.hour, bucket);
  }

  const previewIds = [...hours.values()].flatMap((bucket) => bucket.withText);
  const firstText = new Map(
    previewIds.length === 0
      ? []
      : db
          .statement(
            `SELECT e.value AS id, (SELECT s.text FROM segments s WHERE s.episode_id = e.value
               ORDER BY s.start_ms, s.seq LIMIT 1) AS text
             FROM json_each(?) e`,
          )
          .all(JSON.stringify(previewIds))
          .map((row) => [int(row, "id"), str(row, "text")]),
  );

  const appsOf = loadEpisodeApps(db, moments, options.nowMs ?? Date.now());
  /** The apps of an hour's moments, the one most of them name first. */
  const hourApps = (ids: readonly number[]): EpisodeApp[] => {
    const tally = new Map<string, { app: EpisodeApp; count: number; first: number }>();
    ids.forEach((id, index) => {
      for (const app of appsOf.get(id) ?? []) {
        const entry = tally.get(app.bundleId) ?? { app, count: 0, first: index };
        entry.count += 1;
        tally.set(app.bundleId, entry);
      }
    });
    return [...tally.values()]
      .toSorted((a, b) => b.count - a.count || a.first - b.first)
      .slice(0, HOUR_APPS_MAX)
      .map((entry) => entry.app);
  };

  const page = (lane: "conversations" | "media" | "dictations", total: number): EpisodePageRows => {
    if (total === 0) return { episodes: [], total, next: null };
    const listed = listEpisodes(db, {
      fromMs: options.fromMs,
      toMs: options.toMs,
      limit: options.pageSize,
      lane,
    });
    return { ...listed, total };
  };

  return {
    revision: `${scan.length}-${revision.digest()}`,
    conversations: page("conversations", lanes.conversations),
    momentHours: options.hours.toReversed().flatMap((hour): MomentHourRow[] => {
      const bucket = hours.get(hour.hour);
      if (bucket === undefined) return [];
      return [
        {
          hour: hour.hour,
          startMs: hour.startMs,
          moments: bucket.moments,
          untranscribed: bucket.untranscribed,
          previews: bucket.withText.flatMap((episodeId) => {
            const text = firstText.get(episodeId);
            return text === undefined ? [] : [{ episodeId, text }];
          }),
          apps: hourApps(bucket.ids),
        },
      ];
    }),
    media: page("media", lanes.media),
    dictations: page("dictations", lanes.dictations),
    traces: lanes.traces,
    ongoing: ongoingOf(db, options),
  };
}

function ongoingOf(db: Database, options: EpisodeDayOptions): EpisodeSummaryRow[] {
  const ids = db
    .statement(
      // Started before the day ended, whatever day: one that began before midnight still goes on.
      // A dictation's words already went to its app.
      `SELECT e.id FROM episodes e
       WHERE e.state = 'open' AND e.started_at_ms < ? AND NOT ${endingSql("e")}
         AND (e.context IS NULL OR e.context NOT IN ('media', 'dictation'))
       ORDER BY e.started_at_ms DESC, e.id DESC LIMIT ?`,
    )
    .all(options.toMs, ONGOING_LIMIT)
    .map((row) => int(row, "id"));
  const summaries = loadEpisodeSummaries(db, ids);
  return ids.flatMap((id) => {
    const summary = summaries.get(id);
    return summary === undefined ? [] : [summary];
  });
}

/** Apps an hour of moments names at most. */
const HOUR_APPS_MAX = 4;

/** Open episodes `loadEpisodeDay` returns at most: more at once is not a conversation. */
const ONGOING_LIMIT = 4;

function hourOf(hours: readonly DayHour[], ms: number): DayHour | null {
  return hours.find((hour) => ms >= hour.startMs && ms < hour.endMs) ?? null;
}

/**
 * FNV-1a over the day's (id, updated_at) pairs in list order. Every write to
 * an episode sets its `updated_at_ms`, so any change to what the day shows
 * changes the hash (a collision only delays a refresh to the next change).
 */
class RevisionHash {
  private hash = 0x811c9dc5;

  add(value: number): void {
    // Two 32-bit halves: wall-clock milliseconds exceed 32 bits.
    for (const word of [value % 0x1_0000_0000, Math.floor(value / 0x1_0000_0000)]) {
      for (let shift = 0; shift < 32; shift += 8) {
        this.hash = Math.imul(this.hash ^ ((word >>> shift) & 0xff), 0x01000193) >>> 0;
      }
    }
  }

  digest(): string {
    return this.hash.toString(36);
  }
}
