import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { trackRuns } from "./capture";
import { oneOf } from "./check";
import { assertionOrigins } from "./enums";

/**
 * The user's tags (ADR 039): free words to sort recordings by. `key` is the
 * name without case or accents (`tagKey` in @sondine/core), so « Idées » and
 * « idees » are one tag; the first spelling is kept. A tag on no recording
 * stays until deleted, so a word typed once is offered again.
 */
export const tags = sqliteTable(
  "tags",
  {
    id: integer("id").primaryKey(),
    name: text("name").notNull(),
    key: text("key").notNull().unique(),
    createdAtMs: integer("created_at_ms").notNull(),
    /** Last put on a recording, created or renamed: « recent » order. */
    usedAtMs: integer("used_at_ms").notNull(),
  },
  (t) => [
    check("tags_name_check", sql`length(${t.name}) between 1 and 400`),
    check("tags_key_check", sql`length(${t.key}) between 1 and 400`),
    index("tags_used_idx").on(t.usedAtMs),
  ],
);

/**
 * A tag on a recording, anchored like a context item for the whole
 * conversation (ADR 024): the recording is the episode whose member slice
 * holds `(track_run_id, anchor_sample)`, so regrouping, merges and
 * reanalyses move nothing, and a split leaves it with the first half.
 */
export const recordingTags = sqliteTable(
  "recording_tags",
  {
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    trackRunId: integer("track_run_id")
      .notNull()
      .references(() => trackRuns.id),
    anchorSample: integer("anchor_sample").notNull(),
    origin: text("origin", { enum: assertionOrigins }).notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tagId, t.trackRunId, t.anchorSample] }),
    index("recording_tags_anchor_idx").on(t.trackRunId, t.anchorSample),
    check("recording_tags_origin_check", oneOf(t.origin, assertionOrigins)),
    check("recording_tags_anchor_check", sql`${t.anchorSample} >= 0`),
  ],
);
