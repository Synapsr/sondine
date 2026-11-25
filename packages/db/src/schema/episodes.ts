import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import { apps, speechRegions } from "./capture";
import {
  analysisStates,
  classificationStates,
  episodeContexts,
  episodeSizes,
  episodeStates,
} from "./enums";
import { oneOf } from "./check";

export type EpisodeKindInputs = Record<string, unknown>;

export const episodes = sqliteTable(
  "episodes",
  {
    id: integer("id").primaryKey(),
    state: text("state", { enum: episodeStates }).notNull().default("open"),
    context: text("context", { enum: episodeContexts }),
    size: text("size", { enum: episodeSizes }),
    sizeState: text("size_state", { enum: classificationStates }).notNull().default("provisional"),
    analysisState: text("analysis_state", { enum: analysisStates }).notNull().default("pending"),
    inputGeneration: integer("input_generation").notNull().default(1),
    startedAtMs: integer("started_at_ms").notNull(),
    endedAtMs: integer("ended_at_ms"),
    voicedMs: integer("voiced_ms").notNull().default(0),
    primaryAppId: integer("primary_app_id").references(() => apps.id),
    label: text("label"),
    groupingVersion: text("grouping_version").notNull(),
    /** `Episode.key` from the last grouping pass, for diagnostics; ids are kept by region overlap (ADR 016). */
    groupingKey: text("grouping_key"),
    /**
     * A media episode's page, when its browser reported one (`web_plays.page_key`,
     * ADR 023): set by the grouping, which splits media by page.
     */
    pageKey: text("page_key"),
    /**
     * When retention or a private zone took the episode's audio (ADR 029); null
     * while it keeps it. Text stays.
     */
    audioGoneAtMs: integer("audio_gone_at_ms"),
    classifierVersion: text("classifier_version").notNull(),
    kindInputs: text("kind_inputs", { mode: "json" })
      .$type<EpisodeKindInputs>()
      .notNull()
      .default(sql`'{}'`),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [
    index("episodes_started_idx").on(t.startedAtMs),
    index("episodes_size_started_idx").on(t.size, t.startedAtMs),
    index("episodes_page_idx")
      .on(t.pageKey)
      .where(sql`${t.pageKey} is not null`),
    // The user's dictations, newest first, that may teach their voice (ADR 030).
    index("episodes_dictation_idx")
      .on(t.startedAtMs)
      .where(sql`${t.context} = 'dictation'`),
    check("episodes_state_check", oneOf(t.state, episodeStates)),
    check("episodes_context_check", oneOf(t.context, episodeContexts)),
    check("episodes_size_check", oneOf(t.size, episodeSizes)),
    check("episodes_size_state_check", oneOf(t.sizeState, classificationStates)),
    check("episodes_analysis_state_check", oneOf(t.analysisState, analysisStates)),
    check("episodes_generation_check", sql`${t.inputGeneration} > 0`),
    check("episodes_kind_inputs_check", sql`json_valid(${t.kindInputs})`),
    check("episodes_end_check", sql`${t.endedAtMs} is null or ${t.endedAtMs} >= ${t.startedAtMs}`),
  ],
);

export const episodeRegions = sqliteTable(
  "episode_regions",
  {
    episodeId: integer("episode_id")
      .notNull()
      .references(() => episodes.id, { onDelete: "cascade" }),
    speechRegionId: integer("speech_region_id")
      .notNull()
      .references(() => speechRegions.id, { onDelete: "cascade" }),
    groupingVersion: text("grouping_version").notNull(),
    /**
     * First sample of the part of the region this episode holds: the region's
     * `sample_start` unless a manual split or the length cap cut the region.
     */
    sliceSampleStart: integer("slice_sample_start").notNull(),
    /** End of that part (exclusive); null runs to the region's end, open or closed. */
    sliceSampleEnd: integer("slice_sample_end"),
  },
  (t) => [
    primaryKey({ columns: [t.episodeId, t.speechRegionId] }),
    // A cut region is in several episodes of one grouping version, one slice each.
    unique("episode_regions_region_version_slice_unique").on(
      t.speechRegionId,
      t.groupingVersion,
      t.sliceSampleStart,
    ),
    check(
      "episode_regions_slice_check",
      sql`${t.sliceSampleEnd} is null or ${t.sliceSampleEnd} > ${t.sliceSampleStart}`,
    ),
  ],
);
