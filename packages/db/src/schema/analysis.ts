import { sql } from "drizzle-orm";
import {
  blob,
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import { userAssertions } from "./assertions";
import { trackRuns } from "./capture";
import { episodes } from "./episodes";
import { adapterClasses, analysisRunStatuses, analysisStages } from "./enums";
import { oneOf } from "./check";

export type JsonScalar = string | number | boolean | null;
export type RunMetrics = Record<string, JsonScalar>;
export type EngineConfig = Record<string, unknown>;

export const analysisRuns = sqliteTable(
  "analysis_runs",
  {
    id: integer("id").primaryKey(),
    episodeId: integer("episode_id")
      .notNull()
      .references(() => episodes.id, { onDelete: "cascade" }),
    stage: text("stage", { enum: analysisStages }).notNull(),
    status: text("status", { enum: analysisRunStatuses }).notNull().default("running"),
    passUid: text("pass_uid"),
    engineId: text("engine_id").notNull(),
    engineVersion: text("engine_version").notNull(),
    engineRuntime: text("engine_runtime").notNull(),
    adapterClass: text("adapter_class", { enum: adapterClasses }).notNull(),
    modelSha256: text("model_sha256"),
    engineConfig: text("engine_config", { mode: "json" })
      .$type<EngineConfig>()
      .notNull()
      .default(sql`'{}'`),
    inputHash: text("input_hash").notNull(),
    inputGeneration: integer("input_generation").notNull(),
    coverage: real("coverage"),
    metrics: text("metrics", { mode: "json" })
      .$type<RunMetrics>()
      .notNull()
      .default(sql`'{}'`),
    errorCode: text("error_code"),
    startedAtMs: integer("started_at_ms").notNull(),
    finishedAtMs: integer("finished_at_ms"),
    publishedAtMs: integer("published_at_ms"),
  },
  (t) => [
    index("analysis_runs_episode_stage_idx").on(t.episodeId, t.stage),
    index("analysis_runs_pass_idx").on(t.passUid),
    check("analysis_runs_stage_check", oneOf(t.stage, analysisStages)),
    check("analysis_runs_status_check", oneOf(t.status, analysisRunStatuses)),
    check("analysis_runs_adapter_class_check", oneOf(t.adapterClass, adapterClasses)),
    check("analysis_runs_coverage_check", sql`${t.coverage} between 0 and 1`),
    check("analysis_runs_engine_config_check", sql`json_valid(${t.engineConfig})`),
    check("analysis_runs_metrics_check", sql`json_valid(${t.metrics})`),
  ],
);

/** The run currently shown for each (episode, stage); written only by publish. */
export const episodeAnalysis = sqliteTable(
  "episode_analysis",
  {
    episodeId: integer("episode_id")
      .notNull()
      .references(() => episodes.id, { onDelete: "cascade" }),
    stage: text("stage", { enum: analysisStages }).notNull(),
    runId: integer("run_id")
      .notNull()
      .references(() => analysisRuns.id, { onDelete: "cascade" }),
    inputGeneration: integer("input_generation").notNull(),
    publishedAtMs: integer("published_at_ms").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.episodeId, t.stage] }),
    unique("episode_analysis_run_unique").on(t.runId),
    check("episode_analysis_stage_check", oneOf(t.stage, analysisStages)),
  ],
);

export const episodeSpeakers = sqliteTable(
  "episode_speakers",
  {
    id: integer("id").primaryKey(),
    episodeId: integer("episode_id")
      .notNull()
      .references(() => episodes.id, { onDelete: "cascade" }),
    runId: integer("run_id")
      .notNull()
      .references(() => analysisRuns.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    ordinal: integer("ordinal").notNull(),
    voicedMs: integer("voiced_ms").notNull().default(0),
  },
  (t) => [
    unique("episode_speakers_run_label_unique").on(t.runId, t.label),
    unique("episode_speakers_run_ordinal_unique").on(t.runId, t.ordinal),
    index("episode_speakers_episode_idx").on(t.episodeId),
  ],
);

// Segments restrict deletes of their run and episode: every row is mirrored in
// segments_fts, so removal must go through publish or deleteEpisode, which
// delete the index entries first.
export const segments = sqliteTable(
  "segments",
  {
    id: integer("id").primaryKey(),
    runId: integer("run_id")
      .notNull()
      .references(() => analysisRuns.id, { onDelete: "restrict" }),
    episodeId: integer("episode_id")
      .notNull()
      .references(() => episodes.id, { onDelete: "restrict" }),
    trackRunId: integer("track_run_id")
      .notNull()
      .references(() => trackRuns.id),
    seq: integer("seq").notNull(),
    sampleStart: integer("sample_start").notNull(),
    sampleEnd: integer("sample_end").notNull(),
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms").notNull(),
    speakerLabel: text("speaker_label"),
    episodeSpeakerId: integer("episode_speaker_id").references(() => episodeSpeakers.id, {
      onDelete: "set null",
    }),
    text: text("text").notNull(),
    /**
     * The engine's text while the user's correction stands in `text`; null
     * otherwise. `words` stay the engine's: they time `original_text`.
     */
    originalText: text("original_text"),
    /** The `transcript_edit` assertion `text` comes from; null when uncorrected. */
    editId: integer("edit_id").references(() => userAssertions.id, { onDelete: "set null" }),
    /** `text` through fr-norm with the search options; what `segments_fts` indexes (ADR 016). */
    searchText: text("search_text").notNull().default(""),
    lang: text("lang"),
    confidence: real("confidence"),
    words: blob("words", { mode: "buffer" }),
  },
  (t) => [
    unique("segments_run_seq_unique").on(t.runId, t.seq),
    index("segments_episode_start_idx").on(t.episodeId, t.startMs),
    index("segments_run_idx").on(t.runId),
    index("segments_track_run_sample_idx").on(t.trackRunId, t.sampleStart),
    // Deleting an assertion clears its segment without scanning them all.
    index("segments_edit_idx")
      .on(t.editId)
      .where(sql`${t.editId} is not null`),
    check("segments_samples_check", sql`${t.sampleEnd} >= ${t.sampleStart}`),
    check("segments_time_check", sql`${t.endMs} >= ${t.startMs}`),
    check("segments_confidence_check", sql`${t.confidence} between 0 and 1`),
  ],
);

export const speakerTurns = sqliteTable(
  "speaker_turns",
  {
    id: integer("id").primaryKey(),
    runId: integer("run_id")
      .notNull()
      .references(() => analysisRuns.id, { onDelete: "cascade" }),
    episodeId: integer("episode_id")
      .notNull()
      .references(() => episodes.id, { onDelete: "cascade" }),
    trackRunId: integer("track_run_id")
      .notNull()
      .references(() => trackRuns.id),
    sampleStart: integer("sample_start").notNull(),
    sampleEnd: integer("sample_end").notNull(),
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms").notNull(),
    speakerLabel: text("speaker_label").notNull(),
    episodeSpeakerId: integer("episode_speaker_id").references(() => episodeSpeakers.id, {
      onDelete: "set null",
    }),
    confidence: real("confidence"),
  },
  (t) => [
    index("speaker_turns_run_idx").on(t.runId),
    index("speaker_turns_episode_start_idx").on(t.episodeId, t.startMs),
    index("speaker_turns_track_run_sample_idx").on(t.trackRunId, t.sampleStart),
    check("speaker_turns_samples_check", sql`${t.sampleEnd} > ${t.sampleStart}`),
    check("speaker_turns_time_check", sql`${t.endMs} >= ${t.startMs}`),
    check("speaker_turns_confidence_check", sql`${t.confidence} between 0 and 1`),
  ],
);
