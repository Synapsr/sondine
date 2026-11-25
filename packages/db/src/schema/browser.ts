import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { apps } from "./capture";

/**
 * A browser tab playing sound, as Sondine's browser extension reports it
 * (ADR 023): which browser, which page, from when to when. The browser says
 * it; nothing is inferred. A row covers one page in one tab: a new address
 * in the tab starts a new row. Wall time only: the browser knows no capture
 * clock, and the grouping places each region at its wall midpoint.
 */
export const webPlays = sqliteTable(
  "web_plays",
  {
    id: integer("id").primaryKey(),
    /** The browser that reported it. */
    appId: integer("app_id")
      .notNull()
      .references(() => apps.id),
    /** The page's host without `www.` or `m.`: what the user's rule applies to. */
    site: text("site").notNull(),
    /** What makes two plays the same page (`youtube.com/watch?v=…`, else host and path). */
    pageKey: text("page_key").notNull(),
    url: text("url").notNull(),
    /** The tab's title as the browser had it; empty when it had none. */
    title: text("title").notNull(),
    startedWallMs: integer("started_wall_ms").notNull(),
    /** Null while the tab plays. */
    endedWallMs: integer("ended_wall_ms"),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [
    index("web_plays_started_idx").on(t.startedWallMs),
    index("web_plays_page_idx").on(t.pageKey, t.startedWallMs),
    check(
      "web_plays_span_check",
      sql`${t.endedWallMs} is null or ${t.endedWallMs} >= ${t.startedWallMs}`,
    ),
  ],
);

/**
 * Where a page's video was at one instant (YouTube only, from the
 * extension's content script): between two marks the position moves at
 * `rate` (0 while paused or waiting), so a sentence heard at a wall time maps
 * to a time in the video.
 */
export const webPlayMarks = sqliteTable(
  "web_play_marks",
  {
    playId: integer("play_id")
      .notNull()
      .references(() => webPlays.id, { onDelete: "cascade" }),
    wallMs: integer("wall_ms").notNull(),
    positionMs: integer("position_ms").notNull(),
    rate: real("rate").notNull(),
    /** Null for a live stream or before the length is known. */
    durationMs: integer("duration_ms"),
    /** An ad played in the video's place: the position is the ad's. */
    ad: integer("ad", { mode: "boolean" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.playId, t.wallMs] }),
    check("web_play_marks_position_check", sql`${t.positionMs} >= 0 and ${t.rate} >= 0`),
  ],
);
