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
import { oneOf } from "./check";
import { sameMomentSources } from "./enums";
import { episodes } from "./episodes";

export type SameMomentMeasureJson = Record<string, number | string>;

/**
 * A phone recording and a Mac recording compared for the same meeting
 * (ADR 032, M5.7): one row per pair the wall clocks proposed, for the
 * generations and the method compared, linked or not, so a pair is
 * compared again only when either changes. A linked row holds the offset
 * between the clocks, the time both heard and which one feeds the journal
 * there; the other's lines over that time are not written
 * (`journal-input.ts`, `journal-triggers.ts`). Deleting either episode
 * deletes the row. Nothing of either recording is ever changed for it.
 */
export const sameMomentLinks = sqliteTable(
  "same_moment_links",
  {
    phoneEpisodeId: integer("phone_episode_id")
      .notNull()
      .references(() => episodes.id, { onDelete: "cascade" }),
    macEpisodeId: integer("mac_episode_id")
      .notNull()
      .references(() => episodes.id, { onDelete: "cascade" }),
    /** The episodes' `input_generation` when compared. */
    phoneGeneration: integer("phone_generation").notNull(),
    macGeneration: integer("mac_generation").notNull(),
    /** The detector's id (`envelope-xcorr/1`). */
    method: text("method").notNull(),
    linked: integer("linked", { mode: "boolean" }).notNull(),
    /** Mac wall − phone wall at `anchor_ms` (phone clock), ms. */
    offsetMs: integer("offset_ms"),
    driftPpm: real("drift_ppm"),
    anchorMs: integer("anchor_ms"),
    /** Median correlation of the agreeing windows. */
    score: real("score"),
    /** The time both heard, on the Mac's clock. */
    sharedFromMs: integer("shared_from_ms"),
    sharedToMs: integer("shared_to_ms"),
    /** Which feeds the journal over the shared time. */
    journalSource: text("journal_source", { enum: sameMomentSources }),
    /** The user chose it; a comparison made again keeps it. */
    sourceChosen: integer("source_chosen", { mode: "boolean" }).notNull().default(false),
    /** The detector's numbers (peak, prominence, windows, clarity…), for diagnostics; no audio. */
    measure: text("measure", { mode: "json" })
      .$type<SameMomentMeasureJson>()
      .notNull()
      .default(sql`'{}'`),
    checkedAtMs: integer("checked_at_ms").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.phoneEpisodeId, t.macEpisodeId] }),
    index("same_moment_links_mac_idx").on(t.macEpisodeId),
    check("same_moment_links_source_check", oneOf(t.journalSource, sameMomentSources)),
    check("same_moment_links_measure_check", sql`json_valid(${t.measure})`),
    check(
      "same_moment_links_linked_check",
      sql`(${t.linked} = 1 and ${t.offsetMs} is not null and ${t.driftPpm} is not null
          and ${t.anchorMs} is not null and ${t.score} is not null
          and ${t.sharedFromMs} is not null and ${t.sharedToMs} >= ${t.sharedFromMs}
          and ${t.journalSource} is not null)
        or (${t.linked} = 0 and ${t.offsetMs} is null and ${t.sharedFromMs} is null
          and ${t.sharedToMs} is null and ${t.journalSource} is null)`,
    ),
    check("same_moment_links_pair_check", sql`${t.phoneEpisodeId} <> ${t.macEpisodeId}`),
  ],
);
