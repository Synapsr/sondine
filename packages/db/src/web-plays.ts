import { pageUrlOf, webPageOf, type MediaMark, type WebPage } from "@sondine/core";
import type { Database } from "./database";
import {
  deletedChunks,
  speechPostRollMs,
  speechPreRollMs,
  type DeletedChunk,
} from "./delete-episode";
import { msToSamples, samplesToMs } from "./deleted-ranges";
import { int, intOrNull, num, str } from "./rows";

// Which page a browser played (ADR 023), as Sondine's browser extension
// reports it: one row per page in a tab while it makes sound, and on YouTube
// where the video was. The grouping gives each media region the page its
// browser played at the region's midpoint, so media splits by page; an
// episode keeps its page key, and its address and title come from the plays.
// The user's rule per site says what Sondine keeps: everything by default,
// or nothing of a site they leave out (its episodes go when they close,
// with the audio heard while it played).

const ENABLED_KEY = "browser.enabled";
const SITES_KEY = "browser.sites";

/** Whether the user turned the browser link on (Settings ▸ Navigateurs); off by default. */
export function browserLinkEnabled(db: Database): boolean {
  const row = db.statement("SELECT value FROM settings WHERE key = ?").get(ENABLED_KEY);
  return row !== undefined && JSON.parse(str(row, "value")) === true;
}

export function setBrowserLinkEnabled(db: Database, enabled: boolean, nowMs: number): void {
  writeSetting(db, ENABLED_KEY, enabled, nowMs);
}

function writeSetting(db: Database, key: string, value: unknown, nowMs: number): void {
  db.statement(
    `INSERT INTO settings (key, value, updated_at_ms) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms`,
  ).run(key, JSON.stringify(value), nowMs);
}

/**
 * Sites whose audio Sondine leaves out unless the user keeps them (Téo,
 * 2026-11-09, ADR 023): films and series, and music. Settings lists them
 * from the start, each with its switch; any other site is kept.
 */
export const DEFAULT_UNKEPT_SITES: readonly string[] = [
  "netflix.com",
  "primevideo.com",
  "disneyplus.com",
  "canalplus.com",
  "tv.apple.com",
  "open.spotify.com",
  "deezer.com",
  "music.youtube.com",
  "music.apple.com",
  "soundcloud.com",
];

/** The user's rules over the defaults, by site: true keeps it, false leaves it out. */
function siteRules(db: Database): ReadonlyMap<string, boolean> {
  const row = db.statement("SELECT value FROM settings WHERE key = ?").get(SITES_KEY);
  if (row === undefined) return new Map();
  const value: unknown = JSON.parse(str(row, "value"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) return new Map();
  return new Map(
    Object.entries(value).filter(
      (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
    ),
  );
}

/** Sites whose episodes Sondine deletes when they close. */
export function unkeptSites(db: Database): ReadonlySet<string> {
  const out = new Set(DEFAULT_UNKEPT_SITES);
  for (const [site, keep] of siteRules(db)) {
    if (keep) out.delete(site);
    else out.add(site);
  }
  return out;
}

/** Keeps a site's audio or leaves it out, from the episodes that close from now on. */
export function setSiteKept(
  db: Database,
  site: string,
  keep: boolean,
  nowMs: number,
): ReadonlySet<string> {
  const next = Object.fromEntries(siteRules(db));
  // A rule equal to the default is no rule: the defaults may change with a release.
  const keptByDefault = !DEFAULT_UNKEPT_SITES.includes(site);
  if (keep === keptByDefault) delete next[site];
  else next[site] = keep;
  writeSetting(db, SITES_KEY, next, nowMs);
  return unkeptSites(db);
}

/** A site a browser played, or one the user ruled on. */
export interface HeardSite {
  readonly site: string;
  /** Null for a site ruled on that no tab played yet (or whose plays were pruned). */
  readonly lastPlayedAtMs: number | null;
  readonly kept: boolean;
}

/** Every site played, the latest first, then the ones ruled on that did not play. */
export function heardSites(db: Database, nowMs: number): HeardSite[] {
  const unkept = unkeptSites(db);
  const played = db
    .statement(
      `SELECT site, max(coalesce(ended_wall_ms, ?)) AS last_ms FROM web_plays
       GROUP BY site ORDER BY last_ms DESC, site`,
    )
    .all(nowMs)
    .map((row) => {
      const site = str(row, "site");
      return { site, lastPlayedAtMs: int(row, "last_ms"), kept: !unkept.has(site) };
    });
  const listed = new Set(played.map((entry) => entry.site));
  const ruled = [...new Set([...siteRules(db).keys(), ...DEFAULT_UNKEPT_SITES])]
    .filter((site) => !listed.has(site))
    .toSorted()
    .map((site) => ({ site, lastPlayedAtMs: null, kept: !unkept.has(site) }));
  return [...played, ...ruled];
}

// Recording

export interface StartPlayInput {
  readonly appId: number;
  readonly page: WebPage;
  readonly url: string;
  readonly title: string;
  readonly atMs: number;
  readonly nowMs: number;
}

/** A tab started playing a page (or an audible tab moved to another page). */
export function startWebPlay(db: Database, input: StartPlayInput): number {
  const row = db
    .statement(
      `INSERT INTO web_plays (app_id, site, page_key, url, title, started_wall_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      input.appId,
      input.page.site,
      input.page.pageKey,
      input.url,
      input.title,
      input.atMs,
      input.nowMs,
    );
  if (row === undefined) throw new Error("web_plays insert returned no row");
  return int(row, "id");
}

/** The playing tab's address or title changed within the same page. */
export function updateWebPlay(
  db: Database,
  id: number,
  input: { readonly url: string; readonly title: string; readonly nowMs: number },
): void {
  db.statement("UPDATE web_plays SET url = ?, title = ?, updated_at_ms = ? WHERE id = ?").run(
    input.url,
    input.title,
    input.nowMs,
    id,
  );
}

/** The tab went silent, closed, or its browser went away. */
export function endWebPlay(db: Database, id: number, atMs: number, nowMs: number): void {
  db.statement(
    `UPDATE web_plays SET ended_wall_ms = max(started_wall_ms, ?), updated_at_ms = ?
     WHERE id = ? AND ended_wall_ms IS NULL`,
  ).run(atMs, nowMs, id);
}

/**
 * Plays core left open when it stopped end where they were last heard of:
 * their browser reconnects with what plays now.
 */
export function endOpenWebPlays(db: Database, nowMs: number): number {
  return Number(
    db
      .statement(
        `UPDATE web_plays SET ended_wall_ms = max(started_wall_ms, updated_at_ms), updated_at_ms = ?
         WHERE ended_wall_ms IS NULL`,
      )
      .run(nowMs).changes,
  );
}

/** Where the page's video was at `mark.wallMs`; a second mark at the same instant replaces it. */
export function addWebPlayMark(db: Database, playId: number, mark: MediaMark): void {
  db.statement(
    `INSERT INTO web_play_marks (play_id, wall_ms, position_ms, rate, duration_ms, ad)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (play_id, wall_ms) DO UPDATE SET position_ms = excluded.position_ms,
       rate = excluded.rate, duration_ms = excluded.duration_ms, ad = excluded.ad`,
  ).run(playId, mark.wallMs, mark.positionMs, mark.rate, mark.durationMs, mark.ad ? 1 : 0);
  db.statement("UPDATE web_plays SET updated_at_ms = max(updated_at_ms, ?) WHERE id = ?").run(
    mark.wallMs,
    playId,
  );
}

// Grouping

/** A play as the grouping reads it. */
export interface StoredWebPlay {
  /** The browser's bundle id: a region of that app (its tap, or `system:other` attributed to it) heard it. */
  readonly bundleId: string;
  readonly pageKey: string;
  readonly startedWallMs: number;
  /** Null while the tab plays. */
  readonly endedWallMs: number | null;
}

/** Plays that meet `[fromWallMs, toWallMs]`, in start order. */
export function loadWebPlaysBetween(
  db: Database,
  fromWallMs: number,
  toWallMs: number,
): StoredWebPlay[] {
  return db
    .statement(
      `SELECT a.bundle_id, p.page_key, p.started_wall_ms, p.ended_wall_ms
       FROM web_plays p JOIN apps a ON a.id = p.app_id
       WHERE p.started_wall_ms <= ? AND (p.ended_wall_ms IS NULL OR p.ended_wall_ms >= ?)
       ORDER BY p.started_wall_ms, p.id`,
    )
    .all(toWallMs, fromWallMs)
    .map((row) => ({
      bundleId: str(row, "bundle_id"),
      pageKey: str(row, "page_key"),
      startedWallMs: int(row, "started_wall_ms"),
      endedWallMs: intOrNull(row, "ended_wall_ms"),
    }));
}

// Reading

/** The page an episode heard, as summaries show it. */
export interface StoredEpisodePage {
  readonly site: string;
  readonly pageKey: string;
  /** The browser's address for it, else one rebuilt from the key. */
  readonly url: string;
  /** The tab's title as the browser had it; empty when none is kept. */
  readonly title: string;
  readonly video: boolean;
  /** The browser that played it, when one of its plays is kept. */
  readonly browser: { readonly bundleId: string; readonly name: string } | null;
}

export interface EpisodePageInput {
  readonly id: number;
  readonly pageKey: string | null;
  readonly startedAtMs: number;
  /** Null while open: it reaches `nowMs`. */
  readonly endedAtMs: number | null;
}

/**
 * The page of each episode that has one: its address and title from the
 * play of that page that shares the most time with it (else the latest one).
 */
export function loadEpisodePages(
  db: Database,
  episodes: readonly EpisodePageInput[],
  nowMs: number,
): Map<number, StoredEpisodePage> {
  const out = new Map<number, StoredEpisodePage>();
  const plays = db.statement(
    `SELECT p.url, p.title, p.started_wall_ms, coalesce(p.ended_wall_ms, ?) AS ended_ms,
       a.bundle_id, coalesce(a.name, a.bundle_id) AS app_name
     FROM web_plays p JOIN apps a ON a.id = p.app_id
     WHERE p.page_key = ? ORDER BY p.started_wall_ms DESC, p.id DESC LIMIT 50`,
  );
  for (const episode of episodes) {
    if (episode.pageKey === null) continue;
    const fallback = webPageOf(pageUrlOf(episode.pageKey));
    if (fallback === null) continue;
    const endMs = episode.endedAtMs ?? nowMs;
    let best: {
      url: string;
      title: string;
      browser: { bundleId: string; name: string };
      overlap: number;
    } | null = null;
    for (const row of plays.all(nowMs, episode.pageKey)) {
      const overlap =
        Math.min(endMs, int(row, "ended_ms")) -
        Math.max(episode.startedAtMs, int(row, "started_wall_ms"));
      if (best === null || overlap > best.overlap) {
        best = {
          url: str(row, "url"),
          title: str(row, "title"),
          browser: { bundleId: str(row, "bundle_id"), name: str(row, "app_name") },
          overlap,
        };
      }
    }
    out.set(episode.id, {
      site: fallback.site,
      pageKey: episode.pageKey,
      url: best?.url ?? pageUrlOf(episode.pageKey),
      title: best?.title ?? "",
      video: fallback.video,
      browser: best?.browser ?? null,
    });
  }
  return out;
}

/**
 * Where the video was over an episode: the marks of the plays of its page
 * that meet it, in time order. Empty for a page without marks (any site
 * but YouTube).
 */
export function loadEpisodeMarks(db: Database, episodeId: number, nowMs: number): MediaMark[] {
  return db
    .statement(
      `SELECT m.wall_ms, m.position_ms, m.rate, m.duration_ms, m.ad
       FROM episodes e
       JOIN web_plays p ON p.page_key = e.page_key
         AND p.started_wall_ms <= coalesce(e.ended_at_ms, ?)
         AND coalesce(p.ended_wall_ms, ?) >= e.started_at_ms
       JOIN web_play_marks m ON m.play_id = p.id
       WHERE e.id = ?
       ORDER BY m.wall_ms`,
    )
    .all(nowMs, nowMs, episodeId)
    .map((row) => ({
      wallMs: int(row, "wall_ms"),
      positionMs: int(row, "position_ms"),
      rate: num(row, "rate"),
      durationMs: intOrNull(row, "duration_ms"),
      ad: int(row, "ad") === 1,
    }));
}

// Deleting

/** Plays that meet `[fromWallMs, toWallMs)`: « forget the last minutes » takes them too. */
export function deletePlaysBetween(
  db: Database,
  fromWallMs: number,
  toWallMs: number,
  nowMs: number,
): number {
  return Number(
    db
      .statement(
        `DELETE FROM web_plays
         WHERE started_wall_ms < ? AND coalesce(ended_wall_ms, ?) > ?`,
      )
      .run(toWallMs, nowMs, fromWallMs).changes,
  );
}

/**
 * Plays that ended before `beforeWallMs` and that no episode of their page
 * met: nothing shows them. Returns how many went.
 */
export function pruneWebPlays(db: Database, beforeWallMs: number): number {
  return Number(
    db
      .statement(
        `DELETE FROM web_plays
         WHERE ended_wall_ms IS NOT NULL AND ended_wall_ms < ?
           AND NOT EXISTS (SELECT 1 FROM episodes e
             WHERE e.page_key = web_plays.page_key
               AND e.started_at_ms <= web_plays.ended_wall_ms
               AND coalesce(e.ended_at_ms, e.started_at_ms) >= web_plays.started_wall_ms)`,
      )
      .run(beforeWallMs).changes,
  );
}

export interface DroppedEpisodes {
  readonly episodeIds: readonly number[];
  /** Audio blocks the caller must scrub from disk. */
  readonly chunks: readonly DeletedChunk[];
}

/**
 * The audio of these track runs while the page played: every block wholly
 * inside a play that no region left on the run needs (with its roll) is
 * marked deleted under a tombstone, so no import or job brings it back.
 */
export function forgetPlayedAudio(
  db: Database,
  trackRunIds: readonly number[],
  spans: readonly { readonly fromMs: number; readonly toMs: number }[],
  nowMs: number,
): DeletedChunk[] {
  const chunkIds: number[] = [];
  const insertTombstone = db.statement(
    `INSERT INTO deleted_ranges
       (scope, track_run_id, sample_start, sample_end, wall_start_ms, wall_end_ms, origin, created_at_ms)
     VALUES ('track_run', ?, ?, ?, ?, ?, 'app', ?)`,
  );
  const markChunks = db.statement(
    `UPDATE chunks SET audio_state = 'deleted'
     WHERE track_run_id = ? AND sample_start >= ? AND sample_start + sample_count <= ?
       AND audio_state <> 'deleted'
     RETURNING id`,
  );
  for (const trackRunId of trackRunIds) {
    const run = db.statement("SELECT sample_rate FROM track_runs WHERE id = ?").get(trackRunId);
    if (run === undefined) continue;
    const rate = int(run, "sample_rate");
    const kept = db
      .statement("SELECT sample_start, sample_end FROM speech_regions WHERE track_run_id = ?")
      .all(trackRunId)
      .map((row) => ({
        from: int(row, "sample_start") - msToSamples(speechPreRollMs, rate),
        // An open region needs everything after its start.
        to:
          (intOrNull(row, "sample_end") ?? Number.MAX_SAFE_INTEGER) +
          msToSamples(speechPostRollMs, rate),
      }));
    for (const span of spans) {
      const blocks = db
        .statement(
          `SELECT sample_start, sample_count, wall_ms FROM chunks
           WHERE track_run_id = ? AND audio_state IN ('present', 'archived')
             AND wall_ms >= ? AND wall_ms < ?
           ORDER BY sample_start`,
        )
        .all(trackRunId, span.fromMs, span.toMs)
        .map((row) => ({
          start: int(row, "sample_start"),
          end: int(row, "sample_start") + int(row, "sample_count"),
          wallMs: int(row, "wall_ms"),
        }))
        .filter(
          (block) =>
            block.wallMs + samplesToMs(block.end - block.start, rate) <= span.toMs &&
            !kept.some((region) => block.start < region.to && block.end > region.from),
        );
      // Consecutive blocks share one tombstone.
      let range: { start: number; end: number; wallStart: number; wallEnd: number } | null = null;
      const flush = () => {
        if (range === null) return;
        insertTombstone.run(
          trackRunId,
          range.start,
          range.end,
          range.wallStart,
          range.wallEnd,
          nowMs,
        );
        for (const row of markChunks.all(trackRunId, range.start, range.end)) {
          chunkIds.push(int(row, "id"));
        }
        range = null;
      };
      for (const block of blocks) {
        const wallEnd = block.wallMs + samplesToMs(block.end - block.start, rate);
        if (range !== null && range.end === block.start) {
          range.end = block.end;
          range.wallEnd = wallEnd;
        } else {
          flush();
          range = { start: block.start, end: block.end, wallStart: block.wallMs, wallEnd };
        }
      }
      flush();
    }
  }
  return deletedChunks(db, chunkIds);
}
