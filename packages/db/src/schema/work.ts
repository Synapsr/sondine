import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { analysisRuns } from "./analysis";
import { episodes } from "./episodes";
import { analysisStages, jobAttemptOutcomes, jobKinds, jobStates } from "./enums";
import { oneOf } from "./check";

export type JobPayload = Record<string, unknown>;

export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey(),
    kind: text("kind", { enum: jobKinds }).notNull(),
    state: text("state", { enum: jobStates }).notNull().default("queued"),
    priority: integer("priority").notNull().default(100),
    episodeId: integer("episode_id").references(() => episodes.id, { onDelete: "set null" }),
    stage: text("stage", { enum: analysisStages }),
    inputGeneration: integer("input_generation"),
    dedupeKey: text("dedupe_key"),
    payload: text("payload", { mode: "json" })
      .$type<JobPayload>()
      .notNull()
      .default(sql`'{}'`),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    notBeforeMs: integer("not_before_ms"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
    finishedAtMs: integer("finished_at_ms"),
  },
  (t) => [
    index("jobs_runnable_idx").on(t.state, t.priority, t.createdAtMs),
    index("jobs_episode_idx").on(t.episodeId),
    uniqueIndex("jobs_active_dedupe_unique")
      .on(t.dedupeKey)
      .where(sql`${t.state} in ('queued', 'running') and ${t.dedupeKey} is not null`),
    check("jobs_kind_check", oneOf(t.kind, jobKinds)),
    check("jobs_state_check", oneOf(t.state, jobStates)),
    check("jobs_stage_check", oneOf(t.stage, analysisStages)),
    check("jobs_attempts_check", sql`${t.attempts} >= 0 and ${t.maxAttempts} > 0`),
    check("jobs_payload_check", sql`json_valid(${t.payload})`),
  ],
);

export const jobAttempts = sqliteTable(
  "job_attempts",
  {
    id: integer("id").primaryKey(),
    jobId: integer("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    outcome: text("outcome", { enum: jobAttemptOutcomes }).notNull().default("running"),
    runId: integer("run_id").references(() => analysisRuns.id, { onDelete: "set null" }),
    workerPid: integer("worker_pid"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAtMs: integer("started_at_ms").notNull(),
    finishedAtMs: integer("finished_at_ms"),
  },
  (t) => [
    unique("job_attempts_job_attempt_unique").on(t.jobId, t.attempt),
    check("job_attempts_outcome_check", oneOf(t.outcome, jobAttemptOutcomes)),
  ],
);
