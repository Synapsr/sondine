import { episodesWithoutText } from "./privacy-policy";
import { transaction, type Database } from "./database";
import { int, intOrNull, oneOfValues, str, strOrNull, type Row } from "./rows";
import {
  episodeContexts,
  episodeSizes,
  jobStates,
  type AdapterClass,
  type EpisodeContext,
  type EpisodeSize,
  type JobState,
} from "./schema/enums";

// The durable analysis queue (ADR 016, "Jobs"). One `analysis` job per
// episode at a time (`dedupe_key` `analysis:<episodeId>`); attempts are
// numbered for good and each one owns an `asr` run. Everything here is
// synchronous and transactional: core is the only writer.
//
// The attempts rule (ADR 016, "Attempts"): `jobs.attempts` counts failed
// attempts only, and never passes `jobs.max_attempts`; the job fails at that
// count. Cancelled attempts (admission, shutdown, a new generation) and
// abandoned ones are kept in `job_attempts` but never counted: they say
// nothing about the job. A request from the user on a failed job starts a new
// job, counted from zero.

/**
 * Lower runs first. User requests, then conversations, then moments, then
 * media, then traces. A trace job runs only while the engine is already
 * loaded for other work (the scheduler's rule, ADR 016 "Jobs").
 */
export const analysisPriorities = {
  requested: 10,
  conversation: 20,
  moment: 30,
  media: 40,
  trace: 50,
} as const;

export type AnalysisPriorityClass = keyof typeof analysisPriorities;

/** Delay before the next try after the first and second failed attempts. */
export const analysisRetryDelaysMs = [60_000, 600_000] as const;

/** A new job's `max_attempts`: failed attempts after which it fails for good; cancelled and abandoned ones do not count. */
export const analysisMaxFailures = 3;

/** The automatic class of a closed episode, or null before its size is known. */
export function analysisPriorityClass(episode: {
  readonly context: EpisodeContext | null;
  readonly size: EpisodeSize | null;
}): Exclude<AnalysisPriorityClass, "requested"> | null {
  if (episode.size === null) return null;
  // Parakeet transcribes a dictation in a fraction of a second: even a short
  // one is worth its text, and never waits behind the traces.
  if (episode.context === "dictation") return "moment";
  if (episode.size === "trace") return "trace";
  if (episode.context === "media") return "media";
  return episode.size;
}

/** The class a job's priority stands for; a user request on a trace is `requested`. */
export function analysisClassOfPriority(priority: number): AnalysisPriorityClass {
  if (priority <= analysisPriorities.requested) return "requested";
  if (priority <= analysisPriorities.conversation) return "conversation";
  if (priority <= analysisPriorities.moment) return "moment";
  if (priority <= analysisPriorities.media) return "media";
  return "trace";
}

const analysisDedupeKey = (episodeId: number): string => `analysis:${episodeId}`;

export interface EnqueueAnalysisInput {
  readonly episodeId: number;
  readonly inputGeneration: number;
  readonly priority: number;
  /** A user request: also clears a retry delay. */
  readonly requested?: boolean;
  readonly nowMs: number;
}

export type EnqueueOutcome =
  /** A new job. */
  | "created"
  /** The queued job took the new generation (and the higher priority). */
  | "updated"
  /** A job is running; a stale result requeues it at the new generation. */
  | "running";

export interface EnqueueResult {
  readonly jobId: number;
  readonly outcome: EnqueueOutcome;
}

/** Queues the episode's analysis, or moves its queued job to the new generation. */
export function enqueueAnalysisJob(db: Database, input: EnqueueAnalysisInput): EnqueueResult {
  return transaction(db, () => {
    const active = db
      .statement(
        `SELECT id, state, coalesce(json_extract(payload, '$.requested'), 0) AS requested FROM jobs
         WHERE dedupe_key = ? AND state IN ('queued', 'running')`,
      )
      .get(analysisDedupeKey(input.episodeId));
    const requested = input.requested === true;
    if (active !== undefined && str(active, "state") === "running") {
      return { jobId: int(active, "id"), outcome: "running" };
    }
    if (active !== undefined) {
      const jobId = int(active, "id");
      const wasRequested = int(active, "requested") !== 0;
      db.statement(
        `UPDATE jobs SET input_generation = ?, priority = min(priority, ?), payload = ?,
           not_before_ms = CASE WHEN ? THEN NULL ELSE not_before_ms END, updated_at_ms = ?
         WHERE id = ?`,
      ).run(
        input.inputGeneration,
        input.priority,
        JSON.stringify({ requested: requested || wasRequested }),
        requested ? 1 : 0,
        input.nowMs,
        jobId,
      );
      markEpisode(db, input.episodeId, "queued", input.nowMs);
      return { jobId, outcome: "updated" };
    }
    const inserted = db
      .statement(
        `INSERT INTO jobs (kind, state, priority, episode_id, stage, input_generation, dedupe_key,
           payload, attempts, max_attempts, created_at_ms, updated_at_ms)
         VALUES ('analysis', 'queued', ?, ?, 'asr', ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        input.priority,
        input.episodeId,
        input.inputGeneration,
        analysisDedupeKey(input.episodeId),
        JSON.stringify({ requested }),
        analysisMaxFailures,
        input.nowMs,
        input.nowMs,
      );
    markEpisode(db, input.episodeId, "queued", input.nowMs);
    return { jobId: Number(inserted.lastInsertRowid), outcome: "created" };
  });
}

/** Whether an episode's analysis job is queued or running as a user request. */
export function analysisRequested(db: Database, episodeId: number): boolean {
  return (
    db
      .statement(
        `SELECT 1 AS requested FROM jobs
         WHERE kind = 'analysis' AND episode_id = ? AND state IN ('queued', 'running')
           AND coalesce(json_extract(payload, '$.requested'), 0) = 1`,
      )
      .get(episodeId) !== undefined
  );
}

export interface RunnableJob {
  readonly jobId: number;
  readonly episodeId: number;
  readonly inputGeneration: number;
  readonly priority: number;
  readonly requested: boolean;
  /** A dictation's job runs on Parakeet (ADR 020), the others on the final engine. */
  readonly dictation: boolean;
}

export interface RunnableJobOptions {
  /** Trace jobs too (the engine is already loaded). */
  readonly traces: boolean;
  /** Which jobs: every one, a dictation's only, or every other one. */
  readonly jobs?: "all" | "dictations" | "others";
}

/** The dictations that may run, in the queue's order. */
export function runnableDictations(db: Database, nowMs: number, limit = 20): RunnableJob[] {
  return db
    .statement(
      `SELECT j.id, j.episode_id, j.input_generation, j.priority,
         coalesce(json_extract(j.payload, '$.requested'), 0) AS requested
       FROM jobs j JOIN episodes e ON e.id = j.episode_id
       WHERE j.kind = 'analysis' AND j.state = 'queued' AND e.context = 'dictation'
         AND (j.not_before_ms IS NULL OR j.not_before_ms <= ?)
       ORDER BY j.priority, j.created_at_ms, j.id LIMIT ?`,
    )
    .all(nowMs, limit)
    .map((row) => ({
      jobId: int(row, "id"),
      episodeId: int(row, "episode_id"),
      inputGeneration: intOrNull(row, "input_generation") ?? 1,
      priority: int(row, "priority"),
      requested: int(row, "requested") !== 0,
      dictation: true,
    }));
}

/**
 * The next job to run: lowest priority value, then oldest. Trace jobs are
 * left out unless `traces`.
 */
export function nextRunnableJob(
  db: Database,
  nowMs: number,
  options: RunnableJobOptions = { traces: true },
): RunnableJob | null {
  const jobs = options.jobs ?? "all";
  const row = db
    .statement(
      `SELECT j.id, j.episode_id, j.input_generation, j.priority,
         coalesce(json_extract(j.payload, '$.requested'), 0) AS requested,
         coalesce(e.context = 'dictation', 0) AS dictation
       FROM jobs j LEFT JOIN episodes e ON e.id = j.episode_id
       WHERE j.kind = 'analysis' AND j.state = 'queued' AND j.episode_id IS NOT NULL
         AND (j.not_before_ms IS NULL OR j.not_before_ms <= ?) AND j.priority <= ?
         AND (? = 'all' OR (? = 'dictations') = coalesce(e.context = 'dictation', 0))
       ORDER BY j.priority, j.created_at_ms, j.id
       LIMIT 1`,
    )
    .get(nowMs, options.traces ? analysisPriorities.trace : analysisPriorities.media, jobs, jobs);
  if (row === undefined) return null;
  return {
    jobId: int(row, "id"),
    episodeId: int(row, "episode_id"),
    inputGeneration: intOrNull(row, "input_generation") ?? 1,
    priority: int(row, "priority"),
    requested: int(row, "requested") !== 0,
    dictation: int(row, "dictation") !== 0,
  };
}

/** When the earliest delayed job becomes runnable, or null when none waits. */
export function nextRetryAtMs(db: Database, nowMs: number): number | null {
  const row = db
    .statement(
      `SELECT min(not_before_ms) AS at FROM jobs
       WHERE kind = 'analysis' AND state = 'queued' AND not_before_ms > ?`,
    )
    .get(nowMs);
  return row === undefined ? null : intOrNull(row, "at");
}

/** The episode of the job that becomes runnable first, or null when none waits. */
export function nextRetryEpisodeId(db: Database, nowMs: number): number | null {
  const row = db
    .statement(
      `SELECT episode_id FROM jobs
       WHERE kind = 'analysis' AND state = 'queued' AND not_before_ms > ?
       ORDER BY not_before_ms, priority, id LIMIT 1`,
    )
    .get(nowMs);
  return row === undefined ? null : intOrNull(row, "episode_id");
}

export interface AnalysisRequestRow {
  readonly episodeId: number;
  readonly state: "queued" | "running" | "failed";
  readonly failure: string | null;
}

/** How long a failed request stays on its row, unless the episode is transcribed meanwhile. */
export const FAILED_REQUEST_SHOWN_MS = 7 * 24 * 3_600_000;

/**
 * The user's requests, newest first: each episode's latest analysis job, when
 * it was asked for and waits, runs, or failed (within `FAILED_REQUEST_SHOWN_MS`,
 * its episode still without a transcript), with its last failure's code.
 */
export function analysisRequests(db: Database, nowMs: number, limit = 20): AnalysisRequestRow[] {
  return db
    .statement(
      `SELECT j.episode_id, j.state,
         (SELECT a.error_code FROM job_attempts a WHERE a.job_id = j.id AND a.outcome = 'failed'
          ORDER BY a.attempt DESC LIMIT 1) AS failure
       FROM jobs j JOIN episodes e ON e.id = j.episode_id
       WHERE j.kind = 'analysis' AND coalesce(json_extract(j.payload, '$.requested'), 0) = 1
         AND (j.state IN ('queued', 'running')
           OR (j.state = 'failed' AND e.analysis_state = 'failed' AND j.finished_at_ms > ?))
         AND j.id = (SELECT max(k.id) FROM jobs k WHERE k.episode_id = j.episode_id AND k.kind = 'analysis')
       ORDER BY j.id DESC
       LIMIT ?`,
    )
    .all(nowMs - FAILED_REQUEST_SHOWN_MS, limit)
    .map((row) => ({
      episodeId: int(row, "episode_id"),
      state: oneOfValues(row, "state", ["queued", "running", "failed"] as const),
      failure: strOrNull(row, "failure"),
    }));
}

export interface QueueCounts {
  readonly requested: number;
  readonly conversations: number;
  readonly moments: number;
  readonly media: number;
  readonly traces: number;
}

export function analysisQueueCounts(db: Database): QueueCounts {
  const counts = { requested: 0, conversations: 0, moments: 0, media: 0, traces: 0 };
  const rows = db
    .statement(
      `SELECT priority, count(*) AS n FROM jobs
       WHERE kind = 'analysis' AND state = 'queued' GROUP BY priority`,
    )
    .all();
  for (const row of rows) {
    const n = int(row, "n");
    switch (analysisClassOfPriority(int(row, "priority"))) {
      case "requested":
        counts.requested += n;
        break;
      case "conversation":
        counts.conversations += n;
        break;
      case "moment":
        counts.moments += n;
        break;
      case "media":
        counts.media += n;
        break;
      case "trace":
        counts.traces += n;
        break;
    }
  }
  return counts;
}

export interface EngineIdentity {
  readonly engineId: string;
  readonly engineVersion: string;
  readonly engineRuntime: string;
  readonly adapterClass: AdapterClass;
  readonly engineConfig?: Readonly<Record<string, unknown>>;
}

export interface ClaimAnalysisInput {
  readonly jobId: number;
  /** The generation the caller planned the requests from. */
  readonly inputGeneration: number;
  readonly engine: EngineIdentity;
  readonly inputHash: string;
  readonly nowMs: number;
}

export type ClaimResult =
  | {
      readonly claimed: true;
      readonly jobId: number;
      readonly episodeId: number;
      readonly attemptId: number;
      readonly attempt: number;
      readonly runId: number;
      readonly inputGeneration: number;
    }
  | {
      readonly claimed: false;
      readonly reason: "not_queued" | "episode_missing" | "generation_changed";
    };

/**
 * In one transaction: the job becomes `running`, a `job_attempts` row
 * (numbered after the job's last one) and an `asr` run at the episode's
 * current generation are created, and the attempt points at the run.
 * `attempts` stays: it counts failures only.
 */
export function claimAnalysisJob(db: Database, input: ClaimAnalysisInput): ClaimResult {
  return transaction(db, () => {
    const job = db
      .statement(
        `SELECT state, episode_id,
           (SELECT coalesce(max(attempt), 0) FROM job_attempts WHERE job_id = jobs.id) AS last
         FROM jobs WHERE id = ?`,
      )
      .get(input.jobId);
    if (job === undefined || str(job, "state") !== "queued") {
      return { claimed: false, reason: "not_queued" };
    }
    const episodeId = intOrNull(job, "episode_id");
    const episode =
      episodeId === null
        ? undefined
        : db.statement("SELECT input_generation FROM episodes WHERE id = ?").get(episodeId);
    if (episodeId === null || episode === undefined) {
      db.statement(
        `UPDATE jobs SET state = 'cancelled', updated_at_ms = ?, finished_at_ms = ? WHERE id = ?`,
      ).run(input.nowMs, input.nowMs, input.jobId);
      return { claimed: false, reason: "episode_missing" };
    }
    const generation = int(episode, "input_generation");
    if (generation !== input.inputGeneration)
      return { claimed: false, reason: "generation_changed" };

    const attempt = int(job, "last") + 1;
    db.statement(
      `UPDATE jobs SET state = 'running', input_generation = ?, not_before_ms = NULL,
         updated_at_ms = ?
       WHERE id = ?`,
    ).run(generation, input.nowMs, input.jobId);
    const run = db
      .statement(
        `INSERT INTO analysis_runs (episode_id, stage, status, pass_uid, engine_id, engine_version,
           engine_runtime, adapter_class, engine_config, input_hash, input_generation, started_at_ms)
         VALUES (?, 'asr', 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        episodeId,
        `job-${input.jobId}/${attempt}`,
        input.engine.engineId,
        input.engine.engineVersion,
        input.engine.engineRuntime,
        input.engine.adapterClass,
        JSON.stringify(input.engine.engineConfig ?? {}),
        input.inputHash,
        generation,
        input.nowMs,
      );
    const runId = Number(run.lastInsertRowid);
    const attemptRow = db
      .statement(
        `INSERT INTO job_attempts (job_id, attempt, outcome, run_id, started_at_ms)
         VALUES (?, ?, 'running', ?, ?)`,
      )
      .run(input.jobId, attempt, runId, input.nowMs);
    markEpisode(db, episodeId, "running", input.nowMs);
    return {
      claimed: true,
      jobId: input.jobId,
      episodeId,
      attemptId: Number(attemptRow.lastInsertRowid),
      attempt,
      runId,
      inputGeneration: generation,
    };
  });
}

/** Records the worker serving an attempt, so a restarted core can reap it. */
export function setAttemptWorkerPid(db: Database, attemptId: number, pid: number): void {
  db.statement("UPDATE job_attempts SET worker_pid = ? WHERE id = ? AND outcome = 'running'").run(
    pid,
    attemptId,
  );
}

export interface RunOutcome {
  readonly coverage: number | null;
  readonly metrics: Readonly<Record<string, string | number | boolean | null>>;
  readonly modelSha256: string | null;
  readonly engineConfig?: Readonly<Record<string, unknown>>;
  readonly nowMs: number;
}

/** Stores what a finished pass measured; the run stays publishable. */
export function recordRunOutcome(db: Database, runId: number, outcome: RunOutcome): void {
  db.statement(
    `UPDATE analysis_runs SET coverage = ?, metrics = ?, model_sha256 = coalesce(?, model_sha256),
       engine_config = coalesce(?, engine_config), finished_at_ms = ?
     WHERE id = ?`,
  ).run(
    outcome.coverage,
    JSON.stringify(outcome.metrics),
    outcome.modelSha256,
    outcome.engineConfig === undefined ? null : JSON.stringify(outcome.engineConfig),
    outcome.nowMs,
    runId,
  );
}

export interface AttemptRef {
  readonly jobId: number;
  readonly attemptId: number;
  readonly runId: number;
  readonly nowMs: number;
}

/** The attempt and its job succeeded; call inside the publish transaction. */
export function succeedAttempt(db: Database, ref: AttemptRef): void {
  db.statement(
    `UPDATE job_attempts SET outcome = 'succeeded', finished_at_ms = ? WHERE id = ? AND outcome = 'running'`,
  ).run(ref.nowMs, ref.attemptId);
  db.statement(
    `UPDATE jobs SET state = 'succeeded', updated_at_ms = ?, finished_at_ms = ?
     WHERE id = ? AND state = 'running'`,
  ).run(ref.nowMs, ref.nowMs, ref.jobId);
}

export interface FailAttemptInput extends AttemptRef {
  readonly errorCode: string;
  readonly errorMessage?: string;
  /** False fails the job at once (`audio_unavailable`). */
  readonly retry: boolean;
}

export interface FailAttemptResult {
  readonly jobState: JobState;
  readonly notBeforeMs: number | null;
  readonly failures: number;
}

/**
 * A failed attempt: retried after 1 min, then 10 min; the job fails after
 * three failed attempts, or at once without `retry`.
 */
export function failAttempt(db: Database, input: FailAttemptInput): FailAttemptResult {
  return transaction(db, () => {
    db.statement(
      `UPDATE job_attempts SET outcome = 'failed', error_code = ?, error_message = ?, finished_at_ms = ?
       WHERE id = ? AND outcome = 'running'`,
    ).run(input.errorCode, input.errorMessage?.slice(0, 200) ?? null, input.nowMs, input.attemptId);
    endRun(db, input.runId, "failed", input.errorCode, input.nowMs);
    const failures = int(
      db
        .statement("SELECT count(*) AS n FROM job_attempts WHERE job_id = ? AND outcome = 'failed'")
        .get(input.jobId) ?? { n: 0 },
      "n",
    );
    const job = db
      .statement("SELECT state, episode_id, max_attempts FROM jobs WHERE id = ?")
      .get(input.jobId);
    if (job === undefined) return { jobState: "cancelled", notBeforeMs: null, failures };
    const state = oneOfValues(job, "state", jobStates);
    const episodeId = intOrNull(job, "episode_id");
    // Cancelled meanwhile (the episode was deleted): nothing to retry.
    if (state !== "running") return { jobState: state, notBeforeMs: null, failures };
    const maxAttempts = int(job, "max_attempts");
    db.statement("UPDATE jobs SET attempts = ? WHERE id = ?").run(
      Math.min(failures, maxAttempts),
      input.jobId,
    );
    if (!input.retry || failures >= maxAttempts) {
      db.statement(
        `UPDATE jobs SET state = 'failed', updated_at_ms = ?, finished_at_ms = ? WHERE id = ?`,
      ).run(input.nowMs, input.nowMs, input.jobId);
      if (episodeId !== null) markEpisode(db, episodeId, "failed", input.nowMs);
      return { jobState: "failed", notBeforeMs: null, failures };
    }
    const delay =
      analysisRetryDelaysMs[Math.min(failures, analysisRetryDelaysMs.length) - 1] ??
      analysisRetryDelaysMs[0];
    const notBeforeMs = input.nowMs + delay;
    requeue(db, input.jobId, episodeId, notBeforeMs, input.nowMs);
    return { jobState: "queued", notBeforeMs, failures };
  });
}

export interface CancelAttemptInput extends AttemptRef {
  /** Why: `admission`, `stale_generation`, `shutdown`… Stored as the error code. */
  readonly reason: string;
}

/**
 * A cancelled attempt does not count as a failure: the job is queued again at
 * the episode's current generation. A job cancelled meanwhile stays cancelled.
 */
export function cancelAttempt(db: Database, input: CancelAttemptInput): JobState {
  return transaction(db, () => {
    db.statement(
      `UPDATE job_attempts SET outcome = 'cancelled', error_code = ?, finished_at_ms = ?
       WHERE id = ? AND outcome = 'running'`,
    ).run(input.reason, input.nowMs, input.attemptId);
    endRun(db, input.runId, "cancelled", input.reason, input.nowMs);
    const job = db.statement("SELECT state, episode_id FROM jobs WHERE id = ?").get(input.jobId);
    if (job === undefined) return "cancelled";
    const state = oneOfValues(job, "state", jobStates);
    if (state !== "running") return state;
    const episodeId = intOrNull(job, "episode_id");
    if (episodeId === null) {
      db.statement(
        `UPDATE jobs SET state = 'cancelled', updated_at_ms = ?, finished_at_ms = ? WHERE id = ?`,
      ).run(input.nowMs, input.nowMs, input.jobId);
      return "cancelled";
    }
    requeue(db, input.jobId, episodeId, null, input.nowMs);
    return "queued";
  });
}

/** Marks a refused run discarded (the publish transaction rolled back its own mark). */
export function discardRun(db: Database, runId: number, reason: string, nowMs: number): void {
  db.statement(
    `UPDATE analysis_runs SET status = 'discarded', error_code = ?, finished_at_ms = coalesce(finished_at_ms, ?)
     WHERE id = ? AND status IN ('running', 'succeeded')`,
  ).run(reason, nowMs, runId);
}

/**
 * Worker pids recorded by the attempts a previous core left running. Read
 * before recovery: core reaps them first, so a crash in between forgets none.
 */
export function interruptedWorkerPids(db: Database): number[] {
  const rows = db
    .statement(
      "SELECT DISTINCT worker_pid FROM job_attempts WHERE outcome = 'running' AND worker_pid IS NOT NULL",
    )
    .all();
  return rows.map((row) => int(row, "worker_pid"));
}

export interface RecoveryReport {
  readonly abandoned: number;
}

/**
 * At startup, once the recorded workers are reaped and before any new one:
 * each running attempt becomes `abandoned` (keeping its worker pid), its run
 * `cancelled`, and its job `queued` again. Abandoned attempts do not count as
 * failures.
 */
export function recoverInterruptedJobs(db: Database, nowMs: number): RecoveryReport {
  return transaction(db, () => {
    const abandoned = db
      .statement(
        `UPDATE job_attempts SET outcome = 'abandoned', finished_at_ms = ? WHERE outcome = 'running'`,
      )
      .run(nowMs).changes;
    // Nothing runs before recovery, so every running run is left over.
    db.statement(
      `UPDATE analysis_runs SET status = 'cancelled', error_code = 'abandoned', finished_at_ms = ?
       WHERE status = 'running'`,
    ).run(nowMs);
    const jobs = db
      .statement("SELECT id, episode_id FROM jobs WHERE kind = 'analysis' AND state = 'running'")
      .all();
    for (const job of jobs) requeue(db, int(job, "id"), intOrNull(job, "episode_id"), null, nowMs);
    // Before 2026-11-19 every claim counted (job 1371: 5 of 3, all cancelled):
    // active jobs count their failures again, under the rule above.
    db.statement(
      `UPDATE jobs SET attempts = min(max_attempts, (SELECT count(*) FROM job_attempts a
         WHERE a.job_id = jobs.id AND a.outcome = 'failed'))
       WHERE kind = 'analysis' AND state = 'queued'`,
    ).run();
    return { abandoned: Number(abandoned) };
  });
}

/**
 * Gives every closed episode without a published `asr` at its current
 * generation, and without an active job, a job (traces at the lowest
 * priority), unless a private zone keeps its text from being made. A job that failed at the current generation is not retried
 * here: a new generation or a user request queues it again.
 */
export function enqueueMissingAnalysis(db: Database, nowMs: number): number[] {
  return transaction(db, () => {
    const rows = db
      .statement(
        `SELECT e.id, e.context, e.size, e.input_generation FROM episodes e
         WHERE e.state = 'closed' AND e.size IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM episode_analysis a
             WHERE a.episode_id = e.id AND a.stage = 'asr' AND a.input_generation = e.input_generation)
           AND NOT EXISTS (SELECT 1 FROM jobs j
             WHERE j.episode_id = e.id AND j.kind = 'analysis'
               AND (j.state IN ('queued', 'running')
                 OR (j.state = 'failed' AND j.input_generation = e.input_generation)))
         ORDER BY e.started_at_ms, e.id`,
      )
      .all();
    // A private zone that keeps no text: nothing is transcribed unless the user asks (ADR 029).
    const withoutText = episodesWithoutText(
      db,
      rows.map((row) => int(row, "id")),
      nowMs,
    );
    const enqueued: number[] = [];
    for (const row of rows) {
      if (withoutText.has(int(row, "id"))) continue;
      const priorityClass = analysisPriorityClass(episodeKind(row));
      if (priorityClass === null) continue;
      enqueueAnalysisJob(db, {
        episodeId: int(row, "id"),
        inputGeneration: int(row, "input_generation"),
        priority: analysisPriorities[priorityClass],
        nowMs,
      });
      enqueued.push(int(row, "id"));
    }
    return enqueued;
  });
}

function episodeKind(row: Row): { context: EpisodeContext | null; size: EpisodeSize | null } {
  return {
    context:
      strOrNull(row, "context") === null ? null : oneOfValues(row, "context", episodeContexts),
    size: strOrNull(row, "size") === null ? null : oneOfValues(row, "size", episodeSizes),
  };
}

function requeue(
  db: Database,
  jobId: number,
  episodeId: number | null,
  notBeforeMs: number | null,
  nowMs: number,
): void {
  db.statement(
    `UPDATE jobs SET state = 'queued', not_before_ms = ?, updated_at_ms = ?,
       input_generation = coalesce((SELECT input_generation FROM episodes WHERE id = jobs.episode_id), input_generation)
     WHERE id = ?`,
  ).run(notBeforeMs, nowMs, jobId);
  if (episodeId !== null) markEpisode(db, episodeId, "queued", nowMs);
}

function endRun(
  db: Database,
  runId: number,
  status: "failed" | "cancelled",
  errorCode: string,
  nowMs: number,
): void {
  db.statement(
    `UPDATE analysis_runs SET status = ?, error_code = ?, finished_at_ms = coalesce(finished_at_ms, ?)
     WHERE id = ? AND status IN ('running', 'succeeded')`,
  ).run(status, errorCode, nowMs, runId);
}

/**
 * A queued job nobody asked for, of an episode a private zone keeps from text
 * (ADR 029): cancelled before it runs, and the episode no longer waits for it.
 */
export function cancelJobWithoutText(
  db: Database,
  jobId: number,
  episodeId: number,
  nowMs: number,
): boolean {
  return transaction(db, () => {
    const cancelled = db
      .statement(
        `UPDATE jobs SET state = 'cancelled', updated_at_ms = ?, finished_at_ms = ?
         WHERE id = ? AND state = 'queued'`,
      )
      .run(nowMs, nowMs, jobId).changes;
    if (Number(cancelled) === 0) return false;
    db.statement(
      "UPDATE episodes SET analysis_state = 'pending', updated_at_ms = ? WHERE id = ? AND analysis_state = 'queued'",
    ).run(nowMs, episodeId);
    return true;
  });
}

function markEpisode(
  db: Database,
  episodeId: number,
  state: "queued" | "running" | "failed",
  nowMs: number,
): void {
  db.statement("UPDATE episodes SET analysis_state = ?, updated_at_ms = ? WHERE id = ?").run(
    state,
    nowMs,
    episodeId,
  );
}
