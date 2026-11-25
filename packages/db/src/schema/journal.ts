import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { analysisRuns } from "./analysis";
import { trackRuns } from "./capture";
import { episodes } from "./episodes";
import { oneOf } from "./check";
import { journalItemKinds, journalMarkStatuses, journalRunStatuses } from "./enums";

export type JournalRunMetrics = Record<string, string | number | boolean | null>;

/**
 * One pass of the daily journal over one episode's transcript (ADR 028): the
 * attempt, then, once published, the output's owner. Deleting any sentence of
 * the episode deletes its runs and so their items (`journal-triggers.ts`);
 * changing a sentence's text or voice marks them `stale`, and the queue
 * writes the episode again.
 */
export const journalRuns = sqliteTable(
  "journal_runs",
  {
    id: integer("id").primaryKey(),
    episodeId: integer("episode_id")
      .notNull()
      .references(() => episodes.id, { onDelete: "cascade" }),
    /** The `asr` run it read. */
    asrRunId: integer("asr_run_id")
      .notNull()
      .references(() => analysisRuns.id, { onDelete: "cascade" }),
    /** `journalInputHash` of what the model read; publish checks it again. */
    inputHash: text("input_hash").notNull(),
    /**
     * The prompt version it was written with: a journal of another is old.
     * Who wrote it (`engine_id`, `model_sha256`) is the user's choice and
     * never makes it old (ADR 028).
     */
    configKey: text("config_key").notNull(),
    engineId: text("engine_id").notNull(),
    modelSha256: text("model_sha256"),
    status: text("status", { enum: journalRunStatuses }).notNull().default("running"),
    /** A sentence it read changed since (a correction, a voice relabelled). */
    stale: integer("stale", { mode: "boolean" }).notNull().default(false),
    /** `P1` → the transcript's speaker label, as the request numbered the voices. */
    speakerRefs: text("speaker_refs", { mode: "json" })
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'`),
    metrics: text("metrics", { mode: "json" })
      .$type<JournalRunMetrics>()
      .notNull()
      .default(sql`'{}'`),
    /** A fixed code, never the engine's words. */
    errorCode: text("error_code"),
    startedAtMs: integer("started_at_ms").notNull(),
    finishedAtMs: integer("finished_at_ms"),
  },
  (t) => [
    index("journal_runs_episode_idx").on(t.episodeId, t.status),
    check("journal_runs_status_check", oneOf(t.status, journalRunStatuses)),
    check("journal_runs_speaker_refs_check", sql`json_valid(${t.speakerRefs})`),
    check("journal_runs_metrics_check", sql`json_valid(${t.metrics})`),
  ],
);

/** A line of the journal or a commitment, as the model wrote it, with voices as `{P2}`. */
export const journalItems = sqliteTable(
  "journal_items",
  {
    /** Never reused: a window still showing a replaced line cannot reach its successor. */
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: integer("run_id")
      .notNull()
      .references(() => journalRuns.id, { onDelete: "cascade" }),
    episodeId: integer("episode_id")
      .notNull()
      .references(() => episodes.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: journalItemKinds }).notNull(),
    seq: integer("seq").notNull(),
    text: text("text").notNull(),
    /** A commitment's voices, as refs of the run (`P1`); null when not said. */
    whoRef: text("who_ref"),
    toRef: text("to_ref"),
    /** `YYYY-MM-DD`. */
    due: text("due"),
    dueText: text("due_text"),
    /** When its first cited sentence starts: the journal's order. */
    startMs: integer("start_ms").notNull(),
  },
  (t) => [
    index("journal_items_run_idx").on(t.runId),
    index("journal_items_episode_idx").on(t.episodeId),
    index("journal_items_kind_start_idx").on(t.kind, t.startMs),
    check("journal_items_kind_check", oneOf(t.kind, journalItemKinds)),
  ],
);

/**
 * The sentences an item cites. No foreign key to `segments`: the trigger
 * that deletes a sentence's journal runs goes first (`BEFORE DELETE`), so a
 * citation never outlives its sentence, and a deletion is never refused.
 */
export const journalCitations = sqliteTable(
  "journal_citations",
  {
    itemId: integer("item_id")
      .notNull()
      .references(() => journalItems.id, { onDelete: "cascade" }),
    ord: integer("ord").notNull(),
    segmentId: integer("segment_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.itemId, t.ord] }),
    index("journal_citations_segment_idx").on(t.segmentId),
  ],
);

/**
 * The user's word on an item (ADR 006 assertions): a commitment done or not
 * one, a line that is wrong, a corrected text or date. Anchored to the
 * audio its item cited (`journal_mark_spans`), never to the item, so it holds
 * through regeneration; a tombstone that meets any of those spans deletes
 * it (its text may quote what was said there).
 */
export const journalMarks = sqliteTable(
  "journal_marks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind", { enum: journalItemKinds }).notNull(),
    status: text("status", { enum: journalMarkStatuses }).notNull().default("open"),
    /** The user's text; null keeps the model's. */
    text: text("text"),
    /** The user's date, when `dueEdited`; null there clears it. */
    due: text("due"),
    dueEdited: integer("due_edited", { mode: "boolean" }).notNull().default(false),
    /**
     * The model's text when the mark was made, with `{P2}` voices: how a new
     * item is recognized. Emptied by a tombstone anywhere in its conversation
     * (`source_*`): the model's words may draw on a sentence they do not cite.
     */
    generatedText: text("generated_text").notNull(),
    /** The conversation the marked line came from, wall clock, when the mark was made. */
    sourceStartMs: integer("source_start_ms").notNull(),
    sourceEndMs: integer("source_end_ms").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (t) => [
    check("journal_marks_kind_check", oneOf(t.kind, journalItemKinds)),
    check("journal_marks_status_check", oneOf(t.status, journalMarkStatuses)),
  ],
);

export const journalMarkSpans = sqliteTable(
  "journal_mark_spans",
  {
    markId: integer("mark_id")
      .notNull()
      .references(() => journalMarks.id, { onDelete: "cascade" }),
    trackRunId: integer("track_run_id")
      .notNull()
      .references(() => trackRuns.id),
    sampleStart: integer("sample_start").notNull(),
    sampleEnd: integer("sample_end").notNull(),
    wallStartMs: integer("wall_start_ms").notNull(),
    wallEndMs: integer("wall_end_ms").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.markId, t.trackRunId, t.sampleStart] }),
    index("journal_mark_spans_anchor_idx").on(t.trackRunId, t.sampleStart),
    index("journal_mark_spans_wall_idx").on(t.wallStartMs),
    check("journal_mark_spans_range_check", sql`${t.sampleEnd} >= ${t.sampleStart}`),
  ],
);
