import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { trackRuns } from "./capture";
import { keptAudioOrigins, situationKinds, zoneOutcomes } from "./enums";
import { oneOf } from "./check";

// Private zones (ADR 029). What decides which recordings a zone touches is
// stored, never a snapshot: when each zone was on, with its outcome and its
// situation as they were (`privacy_zone_spans`), and what the helper saw
// (`situation_spans`). The user's « Garder l'audio » is a range of captured
// audio (`kept_audio`), so it follows the audio through splits and merges;
// so is « Garder les 2 dernières minutes », whose ranges carry `moment`.

/** A zone on, from `started_wall_ms` until it was switched off, changed or removed. */
export const privacyZoneSpans = sqliteTable(
  "privacy_zone_spans",
  {
    id: integer("id").primaryKey(),
    zoneId: text("zone_id").notNull(),
    outcome: text("outcome", { enum: zoneOutcomes }).notNull(),
    /** The zone's situation while this span lasted (`ZoneSituation` as JSON). */
    situation: text("situation", { mode: "json" }).$type<unknown>().notNull(),
    startedWallMs: integer("started_wall_ms").notNull(),
    /** Null while the zone is on as it is. */
    endedWallMs: integer("ended_wall_ms"),
  },
  (t) => [
    index("privacy_zone_spans_started_idx").on(t.startedWallMs),
    index("privacy_zone_spans_open_idx")
      .on(t.zoneId)
      .where(sql`${t.endedWallMs} is null`),
    check("privacy_zone_spans_outcome_check", oneOf(t.outcome, zoneOutcomes)),
    check("privacy_zone_spans_situation_check", sql`json_valid(${t.situation})`),
    check(
      "privacy_zone_spans_span_check",
      sql`${t.endedWallMs} is null or ${t.endedWallMs} >= ${t.startedWallMs}`,
    ),
  ],
);

/** The screen away, or the Mac on one network (a keyed hash, never the signature). */
export const situationSpans = sqliteTable(
  "situation_spans",
  {
    id: integer("id").primaryKey(),
    kind: text("kind", { enum: situationKinds }).notNull(),
    /** For `network`: the keyed hash the helper reported. */
    networkHash: text("network_hash"),
    startedWallMs: integer("started_wall_ms").notNull(),
    /** Null while it lasts. */
    endedWallMs: integer("ended_wall_ms"),
  },
  (t) => [
    index("situation_spans_started_idx").on(t.startedWallMs),
    check("situation_spans_kind_check", oneOf(t.kind, situationKinds)),
    check(
      "situation_spans_network_check",
      sql`(${t.kind} = 'network') = (${t.networkHash} is not null)`,
    ),
    check(
      "situation_spans_span_check",
      sql`${t.endedWallMs} is null or ${t.endedWallMs} >= ${t.startedWallMs}`,
    ),
  ],
);

/**
 * Audio the user keeps past every duration, zone and the disk cap, and past
 * the spool's 24 h (« Garder l'audio », « Garder les 2 dernières minutes »).
 */
export const keptAudio = sqliteTable(
  "kept_audio",
  {
    id: integer("id").primaryKey(),
    trackRunId: integer("track_run_id")
      .notNull()
      .references(() => trackRuns.id, { onDelete: "cascade" }),
    sampleStart: integer("sample_start").notNull(),
    sampleEnd: integer("sample_end").notNull(),
    /** When the user kept it: a moment's « Gardé à 14:32 ». */
    createdAtMs: integer("created_at_ms").notNull(),
    origin: text("origin", { enum: keptAudioOrigins }).notNull().default("recording"),
  },
  (t) => [
    index("kept_audio_run_idx").on(t.trackRunId, t.sampleStart),
    check("kept_audio_span_check", sql`${t.sampleEnd} > ${t.sampleStart}`),
    check("kept_audio_origin_check", oneOf(t.origin, keptAudioOrigins)),
  ],
);
