import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { trackRuns } from "./capture";
import { people } from "./people";
import { assertionKinds, assertionOrigins, deletedRangeScopes } from "./enums";
import { oneOf } from "./check";

export type AssertionPayload = Record<string, unknown>;

/** User corrections, anchored to capture facts so they survive reanalysis. */
export const userAssertions = sqliteTable(
  "user_assertions",
  {
    id: integer("id").primaryKey(),
    kind: text("kind", { enum: assertionKinds }).notNull(),
    trackRunId: integer("track_run_id")
      .notNull()
      .references(() => trackRuns.id),
    sampleStart: integer("sample_start").notNull(),
    sampleEnd: integer("sample_end").notNull(),
    payload: text("payload", { mode: "json" })
      .$type<AssertionPayload>()
      .notNull()
      .default(sql`'{}'`),
    origin: text("origin", { enum: assertionOrigins }).notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    revokedAtMs: integer("revoked_at_ms"),
    /**
     * `speaker_is` / `speaker_is_not`: the person the anchored speech is (or
     * is not). Deleting the person deletes these assertions.
     */
    personId: integer("person_id").references(() => people.id, { onDelete: "cascade" }),
  },
  (t) => [
    index("user_assertions_anchor_idx").on(t.trackRunId, t.sampleStart),
    index("user_assertions_person_idx")
      .on(t.personId)
      .where(sql`${t.personId} is not null`),
    check(
      "user_assertions_person_check",
      sql`(${t.kind} in ('speaker_is', 'speaker_is_not')) = (${t.personId} is not null)`,
    ),
    index("user_assertions_active_kind_idx")
      .on(t.kind)
      .where(sql`${t.revokedAtMs} is null`),
    check("user_assertions_kind_check", oneOf(t.kind, assertionKinds)),
    check("user_assertions_origin_check", oneOf(t.origin, assertionOrigins)),
    check("user_assertions_range_check", sql`${t.sampleEnd} >= ${t.sampleStart}`),
    check("user_assertions_payload_check", sql`json_valid(${t.payload})`),
  ],
);

/**
 * Tombstones for user deletions. `all` covers every track over a wall-clock
 * range; `track_run` covers a sample range of one run. Importers, the
 * grouper, and publish refuse anything that intersects one.
 */
export const deletedRanges = sqliteTable(
  "deleted_ranges",
  {
    id: integer("id").primaryKey(),
    scope: text("scope", { enum: deletedRangeScopes }).notNull(),
    trackRunId: integer("track_run_id").references(() => trackRuns.id),
    sampleStart: integer("sample_start"),
    sampleEnd: integer("sample_end"),
    wallStartMs: integer("wall_start_ms").notNull(),
    wallEndMs: integer("wall_end_ms").notNull(),
    origin: text("origin", { enum: assertionOrigins }).notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (t) => [
    index("deleted_ranges_wall_idx").on(t.wallStartMs, t.wallEndMs),
    index("deleted_ranges_run_idx").on(t.trackRunId, t.sampleStart),
    check("deleted_ranges_scope_check", oneOf(t.scope, deletedRangeScopes)),
    check("deleted_ranges_origin_check", oneOf(t.origin, assertionOrigins)),
    check("deleted_ranges_wall_check", sql`${t.wallEndMs} > ${t.wallStartMs}`),
    check(
      "deleted_ranges_shape_check",
      sql`(${t.scope} = 'all' and ${t.trackRunId} is null and ${t.sampleStart} is null and ${t.sampleEnd} is null) or (${t.scope} = 'track_run' and ${t.trackRunId} is not null and ${t.sampleStart} is not null and ${t.sampleEnd} is not null and ${t.sampleStart} >= 0 and ${t.sampleEnd} > ${t.sampleStart})`,
    ),
  ],
);
