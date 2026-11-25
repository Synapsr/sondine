import { phoneticInitials, phoneticKey } from "@sondine/core";
import type { Database } from "./database";
import type { EpisodeApp } from "./episode-sources";
import { loadEpisodeSummaries, transcribedSql, type EpisodeSummaryRow } from "./episodes-store";
import { appColumns, appOf, segmentAppIdSql } from "./foreground";
import { int, intOrNull, num, str, strOrNull } from "./rows";
import type { ContextKind, EpisodeContext, EpisodeSize } from "./schema/enums";
import {
  compileSearchQuery,
  highlightRanges,
  widenSearchQuery,
  type SearchQuery,
  type TextRange,
} from "./search-match";

/** Sound-alike words a one-word phrase also matches, the most frequent first. */
const MAX_ALIKE = 12;
/** Words this long or longer, on both sides: short ones are mostly function words. */
const LETTERS = /^[a-z]{4,}$/u;
/** Keys this long or longer: « lait » and « les » share a two-letter one. */
const MIN_KEY = 4;

/**
 * Words of the index that sound like each one-word phrase of the query
 * (phonetic search, M4: "kamille" finds "camille"). Read live from the
 * index's own vocabulary (`segments_vocab`), so a deleted word is never
 * offered.
 */
function soundAlikes(db: Database, query: SearchQuery): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const vocab = db.statement("SELECT term, doc FROM segments_vocab WHERE term >= ? AND term < ?");
  for (const phrase of query.forms.flat()) {
    const [token] = phrase.tokens;
    if (
      phrase.tokens.length !== 1 ||
      token === undefined ||
      out.has(token) ||
      !LETTERS.test(token)
    ) {
      continue;
    }
    const key = phoneticKey(token);
    if (key.length < MIN_KEY) continue;
    const found: { term: string; doc: number }[] = [];
    for (const letter of phoneticInitials(key)) {
      const next = String.fromCodePoint((letter.codePointAt(0) ?? 0) + 1);
      for (const row of vocab.all(letter, next)) {
        const term = str(row, "term");
        if (term === token || (phrase.prefix && term.startsWith(token))) continue;
        if (LETTERS.test(term) && phoneticKey(term) === key)
          found.push({ term, doc: int(row, "doc") });
      }
    }
    out.set(
      token,
      found
        .toSorted((a, b) => b.doc - a.doc || a.term.localeCompare(b.term))
        .slice(0, MAX_ALIKE)
        .map(({ term }) => term),
    );
  }
  return out;
}

/** A search as the app and agents run it: the query, and the words that sound like it. */
export function compileSearch(
  db: Database,
  input: string,
  options: { readonly prefix?: boolean } = {},
): SearchQuery {
  const exact = compileSearchQuery(input, options);
  return widenSearchQuery(exact, soundAlikes(db, exact));
}

export interface SearchOptions {
  readonly limit?: number;
  readonly offset?: number;
  readonly episodeId?: number;
  /** Treat the last word as a prefix (search as you type). Defaults to true. */
  readonly prefix?: boolean;
}

export interface SearchHit {
  readonly segmentId: number;
  readonly episodeId: number;
  readonly runId: number;
  readonly trackRunId: number;
  readonly sampleStart: number;
  readonly sampleEnd: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  /** bm25 score: lower is a better match. */
  readonly score: number;
}

/** Matching segments, best (bm25) first. */
export function searchSegments(
  db: Database,
  input: string,
  options: SearchOptions = {},
): SearchHit[] {
  const { match } = compileQuery(db, input, options.prefix);
  if (match === null) return [];
  const sql = `
    SELECT s.id, s.episode_id, s.run_id, s.track_run_id, s.sample_start, s.sample_end,
      s.start_ms, s.end_ms, s.text, bm25(segments_fts) AS score
    FROM segments_fts
    JOIN segments s ON s.id = segments_fts.rowid
    WHERE segments_fts MATCH :match ${options.episodeId === undefined ? "" : "AND s.episode_id = :episodeId"}
    ORDER BY score, s.id
    LIMIT :limit OFFSET :offset`;
  return db
    .statement(sql)
    .all({
      match,
      limit: options.limit ?? 50,
      offset: options.offset ?? 0,
      ...(options.episodeId === undefined ? {} : { episodeId: options.episodeId }),
    })
    .map((row) => ({
      segmentId: int(row, "id"),
      episodeId: int(row, "episode_id"),
      runId: int(row, "run_id"),
      trackRunId: int(row, "track_run_id"),
      sampleStart: int(row, "sample_start"),
      sampleEnd: int(row, "sample_end"),
      startMs: int(row, "start_ms"),
      endMs: int(row, "end_ms"),
      text: str(row, "text"),
      score: num(row, "score"),
    }));
}

function compileQuery(db: Database, input: string, prefix: boolean | undefined): SearchQuery {
  return compileSearch(db, input, prefix === undefined ? {} : { prefix });
}

/** Which episodes a search looks in. Filters apply before paging. */
export interface EpisodeFilter {
  /** Episodes starting in `[fromMs, toMs)`; unbounded when absent. */
  readonly fromMs?: number;
  readonly toMs?: number;
  /** Sizes to keep (an episode with no size yet counts as a moment); all when absent. */
  readonly sizes?: readonly EpisodeSize[];
  /** Contexts to keep; all when absent, unknown ones included. */
  readonly contexts?: readonly EpisodeContext[];
  /** Only what was said while this app (bundle ID) was in front (ADR 022). */
  readonly foregroundApp?: string;
  /** Only the recordings carrying this tag (ADR 039). */
  readonly tagId?: number;
}

export interface EpisodeSearchOptions extends EpisodeFilter {
  /** Episodes per page. */
  readonly limit: number;
  readonly offset: number;
  readonly prefix?: boolean;
  /** Best matching segments returned per episode. Defaults to 5. */
  readonly hitsPerEpisode?: number;
}

export interface SegmentMatch {
  readonly segmentId: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly speakerLabel: string | null;
  /** The speaker's number in the episode (1, 2, ...), when the segment has one. */
  readonly speakerOrdinal: number | null;
  /** Where the query matched in `text`. */
  readonly highlights: readonly TextRange[];
  /** The app in front on the Mac while it was said; null when none was. */
  readonly app: EpisodeApp | null;
}

/** Context the user added to the episode that the search matched (ADR 024). */
export interface ContextMatch {
  readonly itemId: number;
  readonly kind: ContextKind;
  /** What matched: a note's text (its first 500 characters), a link's title and address, a file's name. */
  readonly text: string;
  readonly highlights: readonly TextRange[];
}

export interface EpisodeMatch {
  readonly episode: EpisodeSummaryRow;
  /** Matching segments in the episode. */
  readonly hitCount: number;
  /** The best few, in time order. */
  readonly hits: readonly SegmentMatch[];
  /** Its matching context, oldest first (at most 5). */
  readonly contextHits: readonly ContextMatch[];
}

export interface EpisodeSearchResult {
  /** Newest first. */
  readonly episodes: readonly EpisodeMatch[];
  /** Matching episodes after filters, for paging by episode. */
  readonly total: number;
  /**
   * Closed episodes the filters keep that have no transcript yet, so the
   * search cannot see them. Traces are not counted: they are not transcribed.
   */
  readonly untranscribed: number;
}

/**
 * Searches transcripts and groups the matches by episode, newest episode
 * first: the filters apply before paging, so a page never splits an episode
 * and `total` counts episodes. Each episode brings its best segments (bm25),
 * shown in time order, with highlights.
 */
export function searchEpisodes(
  db: Database,
  input: string,
  options: EpisodeSearchOptions,
): EpisodeSearchResult {
  const query = compileQuery(db, input, options.prefix);
  // Exact matches show before sound-alike ones.
  const exact = compileSearchQuery(
    input,
    options.prefix === undefined ? {} : { prefix: options.prefix },
  );
  const filter = episodeFilter(options);
  const untranscribed = countUntranscribed(db, filter);
  if (query.match === null) return { episodes: [], total: 0, untranscribed };

  const matching = matchingEpisodesSql(filter);
  const page = db
    .statement(
      `${matching}
       SELECT e.id, coalesce(seg.hits, 0) AS hit_count, count(*) OVER () AS total
       FROM matched JOIN episodes e ON e.id = matched.id
       LEFT JOIN seg ON seg.id = e.id
       WHERE ${filter.sql}
       ORDER BY e.started_at_ms DESC, e.id DESC
       LIMIT :limit OFFSET :offset`,
    )
    .all({ match: query.match, ...filter.params, limit: options.limit, offset: options.offset });
  const total =
    page[0] === undefined
      ? options.offset === 0
        ? 0
        : countMatchingEpisodes(db, query.match, filter)
      : int(page[0], "total");
  if (page.length === 0) return { episodes: [], total, untranscribed };

  const pageIds = page.map((row) => int(row, "id"));
  const ids = JSON.stringify(pageIds);
  const summaries = loadEpisodeSummaries(db, pageIds);
  const hitRows = db
    .statement(
      `SELECT s.id, s.episode_id, s.start_ms, s.end_ms, s.text, s.lang, s.speaker_label,
         sp.ordinal AS speaker_ordinal, bm25(segments_fts) AS score, ${appColumns("a")}
       FROM segments_fts
       JOIN segments s ON s.id = segments_fts.rowid
       LEFT JOIN episode_speakers sp ON sp.id = s.episode_speaker_id
       LEFT JOIN apps a ON a.id = ${segmentAppIdSql("s")}
       WHERE segments_fts MATCH :match AND s.episode_id IN (SELECT value FROM json_each(:ids))
         AND ${filter.segmentSql}`,
    )
    .all({ match: query.match, ids, ...filter.segmentParams });
  const byEpisode = Map.groupBy(hitRows, (row) => int(row, "episode_id"));
  // Hits only a sound-alike word matched come after exact ones, once per hit.
  const widened = query.match !== exact.match;
  const inexact = new Map(
    widened
      ? hitRows.map((row) => [
          int(row, "id"),
          highlightRanges(str(row, "text"), strOrNull(row, "lang"), exact).length > 0 ? 0 : 1,
        ])
      : [],
  );
  const perEpisode = options.hitsPerEpisode ?? 5;
  const contextByEpisode = Map.groupBy(
    filter.segmentSql === "1" ? contextMatchesIn(db, query, pageIds) : [],
    (hit) => hit.episodeId,
  );

  const episodes = page.flatMap((row): EpisodeMatch[] => {
    const id = int(row, "id");
    const episode = summaries.get(id);
    if (episode === undefined) return [];
    const best = (byEpisode.get(id) ?? [])
      .toSorted(
        (a, b) =>
          (inexact.get(int(a, "id")) ?? 0) - (inexact.get(int(b, "id")) ?? 0) ||
          num(a, "score") - num(b, "score") ||
          int(a, "id") - int(b, "id"),
      )
      .slice(0, perEpisode)
      .toSorted((a, b) => int(a, "start_ms") - int(b, "start_ms") || int(a, "id") - int(b, "id"));
    return [
      {
        episode,
        hitCount: int(row, "hit_count"),
        hits: best.map((hit) => {
          const text = str(hit, "text");
          return {
            segmentId: int(hit, "id"),
            startMs: int(hit, "start_ms"),
            endMs: int(hit, "end_ms"),
            text,
            speakerLabel: strOrNull(hit, "speaker_label"),
            speakerOrdinal: intOrNull(hit, "speaker_ordinal"),
            highlights: highlightRanges(text, strOrNull(hit, "lang"), query),
            app: appOf(hit),
          };
        }),
        contextHits: (contextByEpisode.get(id) ?? [])
          .slice(0, perEpisode)
          .map(({ episodeId: _episodeId, ...hit }) => hit),
      },
    ];
  });
  return { episodes, total, untranscribed };
}

/**
 * The recordings carrying a tag, with no text to match (ADR 039): newest
 * first, open and untranscribed ones included, the other filters applied
 * before paging. The app in front needs text, so it is not applied here.
 */
export function browseTag(
  db: Database,
  options: EpisodeFilter & {
    readonly tagId: number;
    readonly limit: number;
    readonly offset: number;
  },
): EpisodeSearchResult {
  const { foregroundApp: _app, ...rest } = options;
  const filter = episodeFilter(rest);
  const page = db
    .statement(
      `SELECT e.id, count(*) OVER () AS total FROM episodes e
       WHERE ${filter.sql}
       ORDER BY e.started_at_ms DESC, e.id DESC
       LIMIT :limit OFFSET :offset`,
    )
    .all({ ...filter.params, limit: options.limit, offset: options.offset });
  const total =
    page[0] === undefined
      ? options.offset === 0
        ? 0
        : int(
            db
              .statement(`SELECT count(*) AS n FROM episodes e WHERE ${filter.sql}`)
              .get(filter.params) ?? { n: 0 },
            "n",
          )
      : int(page[0], "total");
  const ids = page.map((row) => int(row, "id"));
  const summaries = loadEpisodeSummaries(db, ids);
  return {
    episodes: ids.flatMap((id) => {
      const episode = summaries.get(id);
      return episode === undefined ? [] : [{ episode, hitCount: 0, hits: [], contextHits: [] }];
    }),
    total,
    untranscribed: 0,
  };
}

interface FilterSql {
  /** Conditions over `episodes e`, ANDed; `1` when nothing is filtered. */
  readonly sql: string;
  /** Conditions over its `segments s`; `1` when nothing is filtered. */
  readonly segmentSql: string;
  /** Every parameter, the segments' included. */
  readonly params: Record<string, number | string>;
  readonly segmentParams: Record<string, number | string>;
}

/**
 * Only the filters given become conditions, so a day range can use
 * `episodes_started_idx` (an `:x IS NULL OR` form would hide it from the
 * planner).
 */
function episodeFilter(filter: EpisodeFilter): FilterSql {
  const conditions: string[] = [];
  const params: Record<string, number | string> = {};
  if (filter.fromMs !== undefined) {
    conditions.push("e.started_at_ms >= :fromMs");
    params["fromMs"] = filter.fromMs;
  }
  if (filter.toMs !== undefined) {
    conditions.push("e.started_at_ms < :toMs");
    params["toMs"] = filter.toMs;
  }
  if (filter.sizes !== undefined) {
    conditions.push("coalesce(e.size, 'moment') IN (SELECT value FROM json_each(:sizes))");
    params["sizes"] = JSON.stringify(filter.sizes);
  }
  if (filter.contexts !== undefined) {
    conditions.push("e.context IN (SELECT value FROM json_each(:contexts))");
    params["contexts"] = JSON.stringify(filter.contexts);
  }
  if (filter.tagId !== undefined) {
    conditions.push(`EXISTS (SELECT 1 FROM episode_regions m
      JOIN speech_regions r ON r.id = m.speech_region_id
      JOIN recording_tags rt ON rt.track_run_id = r.track_run_id
        AND rt.anchor_sample >= m.slice_sample_start
        AND rt.anchor_sample < coalesce(m.slice_sample_end, r.sample_end, ${OPEN_END})
      WHERE m.episode_id = e.id AND rt.tag_id = :tagId)`);
    params["tagId"] = filter.tagId;
  }
  const segmentParams: Record<string, string> = {};
  // A sentence was said in the app in front at its middle; an app Sondine
  // never saw matches nothing.
  const segmentSql =
    filter.foregroundApp === undefined
      ? "1"
      : `${segmentAppIdSql("s")} = (SELECT id FROM apps WHERE bundle_id = :foregroundApp)`;
  if (filter.foregroundApp !== undefined) segmentParams["foregroundApp"] = filter.foregroundApp;
  return {
    sql: conditions.length === 0 ? "1" : conditions.join(" AND "),
    segmentSql,
    params: { ...params, ...segmentParams },
    segmentParams,
  };
}

/** Past any sample: an open slice reaches this far. */
const OPEN_END = Number.MAX_SAFE_INTEGER;

/** Context items with the episode whose member slice holds their anchor (ADR 024). */
const CONTEXT_EPISODES = `
  FROM context_fts
  JOIN context_items c ON c.id = context_fts.rowid
  JOIN speech_regions r ON r.track_run_id = c.track_run_id AND r.sample_start <= c.anchor_sample
  JOIN episode_regions m ON m.speech_region_id = r.id
    AND c.anchor_sample >= m.slice_sample_start
    AND c.anchor_sample < coalesce(m.slice_sample_end, r.sample_end, ${OPEN_END})`;

/**
 * `seg` (episodes with matching segments and their count) and `matched`
 * (those, and the episodes whose context matches), for `:match`. Context has
 * no app in front, so an app filter leaves it out.
 */
function matchingEpisodesSql(filter: FilterSql): string {
  const context =
    filter.segmentSql === "1"
      ? `UNION SELECT m.episode_id ${CONTEXT_EPISODES} WHERE context_fts MATCH :match`
      : "";
  return `WITH seg AS (
      SELECT s.episode_id AS id, count(*) AS hits
      FROM segments_fts JOIN segments s ON s.id = segments_fts.rowid
      WHERE segments_fts MATCH :match AND ${filter.segmentSql}
      GROUP BY s.episode_id
    ),
    matched AS (SELECT id FROM seg ${context})`;
}

/** The longest note text a context match carries. */
const CONTEXT_TEXT = 500;

function contextMatchesIn(
  db: Database,
  query: SearchQuery,
  episodeIds: readonly number[],
): (ContextMatch & { readonly episodeId: number })[] {
  if (query.match === null || episodeIds.length === 0) return [];
  const seen = new Set<number>();
  return db
    .statement(
      `SELECT m.episode_id, c.id, c.kind, c.body, c.title ${CONTEXT_EPISODES}
       WHERE context_fts MATCH :match AND m.episode_id IN (SELECT value FROM json_each(:ids))
       ORDER BY c.created_at_ms, c.id`,
    )
    .all({ match: query.match, ids: JSON.stringify(episodeIds) })
    .flatMap((row) => {
      const itemId = int(row, "id");
      if (seen.has(itemId)) return [];
      seen.add(itemId);
      const kind = str(row, "kind") as ContextKind;
      const body = str(row, "body");
      const title = strOrNull(row, "title");
      const text =
        kind === "note"
          ? body.slice(0, CONTEXT_TEXT)
          : kind === "link"
            ? title === null || title === ""
              ? body
              : `${title} — ${body}`
            : (title ?? "");
      return [
        {
          episodeId: int(row, "episode_id"),
          itemId,
          kind,
          text,
          highlights: highlightRanges(text, null, query),
        },
      ];
    });
}

function countMatchingEpisodes(db: Database, match: string, filter: FilterSql): number {
  const row = db
    .statement(
      `${matchingEpisodesSql(filter)}
       SELECT count(*) AS n FROM matched JOIN episodes e ON e.id = matched.id
       WHERE ${filter.sql}`,
    )
    .get({ match, ...filter.params });
  return row === undefined ? 0 : int(row, "n");
}

function countUntranscribed(db: Database, filter: FilterSql): number {
  // With an app, only the episodes with speech while it was in front.
  const inApp =
    filter.segmentSql === "1"
      ? "1"
      : `EXISTS (SELECT 1 FROM episode_regions er
           JOIN foreground_spans f ON f.speech_region_id = er.speech_region_id
           JOIN apps a ON a.id = f.app_id
           WHERE er.episode_id = e.id AND a.bundle_id = :foregroundApp)`;
  const row = db
    .statement(
      `SELECT count(*) AS n FROM episodes e
       WHERE e.state = 'closed' AND coalesce(e.size, 'moment') <> 'trace'
         AND ${filter.sql} AND ${inApp} AND NOT ${transcribedSql}`,
    )
    .get(filter.params);
  return row === undefined ? 0 : int(row, "n");
}

/** Segments of one episode the query matches (FTS5), for highlighting a transcript. */
export function matchingSegmentIds(
  db: Database,
  query: SearchQuery,
  episodeId: number,
): Set<number> {
  if (query.match === null) return new Set();
  return new Set(
    db
      .statement(
        `SELECT s.id FROM segments_fts JOIN segments s ON s.id = segments_fts.rowid
         WHERE segments_fts MATCH :match AND s.episode_id = :episodeId`,
      )
      .all({ match: query.match, episodeId })
      .map((row) => int(row, "id")),
  );
}

/** Runs FTS5's integrity check against the content table; throws if corrupt. */
export function checkSearchIndex(db: Database): void {
  db.client.exec("INSERT INTO segments_fts (segments_fts, rank) VALUES ('integrity-check', 1)");
}
