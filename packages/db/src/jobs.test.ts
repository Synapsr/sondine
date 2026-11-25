import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  analysisClassOfPriority,
  analysisPriorities,
  analysisPriorityClass,
  analysisQueueCounts,
  cancelAttempt,
  claimAnalysisJob,
  enqueueAnalysisJob,
  enqueueMissingAnalysis,
  failAttempt,
  interruptedWorkerPids,
  nextRetryAtMs,
  nextRunnableJob,
  recoverInterruptedJobs,
  setAttemptWorkerPid,
  succeedAttempt,
  type EngineIdentity,
} from "./jobs";
import { bumpInputGeneration, publishAnalysis } from "./publish";
import { count, seedEpisode, segment, t0, tempDatabase, type TempDatabase } from "./test-helpers";

const engine: EngineIdentity = {
  engineId: "fake-asr",
  engineVersion: "1",
  engineRuntime: "fake",
  adapterClass: "probe",
};

let temp: TempDatabase;
beforeEach(() => {
  temp = tempDatabase();
});
afterEach(() => temp.cleanup());

function closedEpisode(
  size: "trace" | "moment" | "conversation" = "moment",
  context = "in_person",
) {
  const seeded = seedEpisode(temp.db, [[0, 30]]);
  temp.db.client
    .prepare("UPDATE episodes SET size = ?, context = ? WHERE id = ?")
    .run(size, context, seeded.episodeId);
  return seeded;
}

function queue(episodeId: number, priority: number = analysisPriorities.moment, nowMs = t0) {
  return enqueueAnalysisJob(temp.db, { episodeId, inputGeneration: 1, priority, nowMs });
}

function claim(jobId: number, nowMs = t0, inputGeneration = 1) {
  const result = claimAnalysisJob(temp.db, {
    jobId,
    inputGeneration,
    engine,
    inputHash: "hash",
    nowMs,
  });
  if (!result.claimed) throw new Error(`not claimed: ${result.reason}`);
  return result;
}

const scalar = (sql: string, ...params: (number | string)[]) =>
  Object.values(temp.db.client.prepare(sql).get(...params) ?? {})[0];

describe("priority classes", () => {
  it("gives media the last lane and traces the lowest class, whatever their context", () => {
    expect(analysisPriorityClass({ context: "in_person", size: "trace" })).toBe("trace");
    expect(analysisPriorityClass({ context: "media", size: "trace" })).toBe("trace");
    expect(analysisPriorityClass({ context: "in_person", size: "moment" })).toBe("moment");
    expect(analysisPriorityClass({ context: "call", size: "conversation" })).toBe("conversation");
    expect(analysisPriorityClass({ context: "media", size: "conversation" })).toBe("media");
    expect(analysisPriorityClass({ context: null, size: null })).toBeNull();
  });

  it("reads a requested trace as a request, not as a trace", () => {
    expect(analysisClassOfPriority(analysisPriorities.requested)).toBe("requested");
    expect(analysisClassOfPriority(analysisPriorities.media)).toBe("media");
    expect(analysisClassOfPriority(analysisPriorities.trace)).toBe("trace");
  });
});

describe("enqueue", () => {
  it("keeps one active job per episode and moves a queued one to the new generation", () => {
    const { episodeId } = closedEpisode();
    const first = queue(episodeId);
    expect(first.outcome).toBe("created");
    expect(scalar("SELECT analysis_state FROM episodes WHERE id = ?", episodeId)).toBe("queued");
    bumpInputGeneration(temp.db, episodeId);
    const again = enqueueAnalysisJob(temp.db, {
      episodeId,
      inputGeneration: 2,
      priority: analysisPriorities.requested,
      requested: true,
      nowMs: t0,
    });
    expect(again).toEqual({ jobId: first.jobId, outcome: "updated" });
    expect(count(temp.db, "jobs")).toBe(1);
    expect(nextRunnableJob(temp.db, t0)).toEqual({
      jobId: first.jobId,
      episodeId,
      inputGeneration: 2,
      priority: analysisPriorities.requested,
      requested: true,
      dictation: false,
    });
    // A later automatic enqueue does not lower the priority or forget the request.
    queue(episodeId, analysisPriorities.media);
    expect(nextRunnableJob(temp.db, t0)?.priority).toBe(analysisPriorities.requested);
    expect(nextRunnableJob(temp.db, t0)?.requested).toBe(true);
  });

  it("leaves a running job alone", () => {
    const { episodeId } = closedEpisode();
    const { jobId } = queue(episodeId);
    claim(jobId);
    expect(queue(episodeId)).toEqual({ jobId, outcome: "running" });
    expect(count(temp.db, "jobs")).toBe(1);
  });

  it("orders user requests, conversations, moments, media, traces, oldest first in each", () => {
    const ids = [
      closedEpisode("trace").episodeId,
      closedEpisode("moment", "media").episodeId,
      closedEpisode("moment").episodeId,
      closedEpisode("conversation").episodeId,
      closedEpisode("moment").episodeId,
      closedEpisode("moment").episodeId,
    ];
    queue(ids[0] ?? 0, analysisPriorities.trace, t0 - 1);
    queue(ids[1] ?? 0, analysisPriorities.media, t0);
    queue(ids[2] ?? 0, analysisPriorities.moment, t0 + 1);
    queue(ids[3] ?? 0, analysisPriorities.conversation, t0 + 2);
    queue(ids[4] ?? 0, analysisPriorities.moment, t0 + 3);
    queue(ids[5] ?? 0, analysisPriorities.requested, t0 + 4);
    expect(analysisQueueCounts(temp.db)).toEqual({
      requested: 1,
      conversations: 1,
      moments: 2,
      media: 1,
      traces: 1,
    });
    const order: number[] = [];
    for (;;) {
      const next = nextRunnableJob(temp.db, t0 + 10);
      if (next === null) break;
      order.push(next.episodeId);
      const claimed = claim(next.jobId, t0 + 10);
      succeedAttempt(temp.db, { ...claimed, nowMs: t0 + 10 });
    }
    expect(order).toEqual([ids[5], ids[3], ids[2], ids[4], ids[1], ids[0]]);
  });

  it("leaves trace jobs out unless traces may run", () => {
    const trace = closedEpisode("trace").episodeId;
    queue(trace, analysisPriorities.trace, t0);
    expect(nextRunnableJob(temp.db, t0 + 10, { traces: false })).toBeNull();
    expect(nextRunnableJob(temp.db, t0 + 10, { traces: true })?.episodeId).toBe(trace);
    // A user request on the trace is a request: it runs like any other.
    queue(trace, analysisPriorities.requested, t0 + 1);
    expect(nextRunnableJob(temp.db, t0 + 10, { traces: false })?.episodeId).toBe(trace);
  });

  it("picks a dictation's job, or every other one, as the engines allow", () => {
    const talk = closedEpisode().episodeId;
    const dictation = closedEpisode().episodeId;
    temp.db.client.prepare("UPDATE episodes SET context = 'dictation' WHERE id = ?").run(dictation);
    queue(talk, analysisPriorities.conversation, t0);
    queue(dictation, analysisPriorities.moment, t0 + 1);
    const next = (jobs: "all" | "dictations" | "others") =>
      nextRunnableJob(temp.db, t0 + 10, { traces: false, jobs });
    expect(next("all")).toMatchObject({ episodeId: talk, dictation: false });
    expect(next("others")?.episodeId).toBe(talk);
    expect(next("dictations")).toMatchObject({ episodeId: dictation, dictation: true });
  });
});

describe("claim", () => {
  it("creates the attempt and the run at the current generation in one step", () => {
    const { episodeId } = closedEpisode();
    const { jobId } = queue(episodeId);
    const claimed = claim(jobId);
    expect(claimed.attempt).toBe(1);
    expect(scalar("SELECT state FROM jobs WHERE id = ?", jobId)).toBe("running");
    // Only failures count (ADR 016, "Attempts").
    expect(scalar("SELECT attempts FROM jobs WHERE id = ?", jobId)).toBe(0);
    expect(
      temp.db.client
        .prepare(
          "SELECT stage, status, input_generation, episode_id FROM analysis_runs WHERE id = ?",
        )
        .get(claimed.runId),
    ).toEqual({ stage: "asr", status: "running", input_generation: 1, episode_id: episodeId });
    expect(scalar("SELECT run_id FROM job_attempts WHERE id = ?", claimed.attemptId)).toBe(
      claimed.runId,
    );
    setAttemptWorkerPid(temp.db, claimed.attemptId, 4242);
    expect(scalar("SELECT worker_pid FROM job_attempts WHERE id = ?", claimed.attemptId)).toBe(
      4242,
    );
    expect(scalar("SELECT analysis_state FROM episodes WHERE id = ?", episodeId)).toBe("running");
  });

  it("refuses a plan made from an older generation", () => {
    const { episodeId } = closedEpisode();
    const { jobId } = queue(episodeId);
    bumpInputGeneration(temp.db, episodeId);
    const result = claimAnalysisJob(temp.db, {
      jobId,
      inputGeneration: 1,
      engine,
      inputHash: "h",
      nowMs: t0,
    });
    expect(result).toEqual({ claimed: false, reason: "generation_changed" });
    expect(count(temp.db, "job_attempts")).toBe(0);
  });
});

describe("failures", () => {
  it("retries after 1 min, then 10 min, and fails after three failed attempts", () => {
    const { episodeId } = closedEpisode();
    const { jobId } = queue(episodeId);
    let now = t0;
    const delays: (number | null)[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const next = nextRunnableJob(temp.db, now);
      expect(next?.jobId).toBe(jobId);
      const claimed = claim(jobId, now);
      expect(claimed.attempt).toBe(attempt);
      const result = failAttempt(temp.db, {
        ...claimed,
        nowMs: now,
        errorCode: "crashed",
        retry: true,
      });
      delays.push(result.notBeforeMs === null ? null : result.notBeforeMs - now);
      if (result.notBeforeMs !== null) {
        expect(nextRunnableJob(temp.db, now)).toBeNull();
        expect(nextRetryAtMs(temp.db, now)).toBe(result.notBeforeMs);
        now = result.notBeforeMs;
      }
    }
    expect(delays).toEqual([60_000, 600_000, null]);
    expect(scalar("SELECT state FROM jobs WHERE id = ?", jobId)).toBe("failed");
    expect(scalar("SELECT analysis_state FROM episodes WHERE id = ?", episodeId)).toBe("failed");
    expect(count(temp.db, "analysis_runs", "status = 'failed'")).toBe(3);
  });

  it("does not count cancelled or abandoned attempts", () => {
    const { episodeId } = closedEpisode();
    const { jobId } = queue(episodeId);
    const first = claim(jobId);
    expect(cancelAttempt(temp.db, { ...first, nowMs: t0, reason: "admission" })).toBe("queued");
    expect(nextRunnableJob(temp.db, t0)?.jobId).toBe(jobId);
    const second = claim(jobId);
    setAttemptWorkerPid(temp.db, second.attemptId, 777);
    // Reading the pids to reap changes nothing: a crash before recovery forgets none.
    expect(interruptedWorkerPids(temp.db)).toEqual([777]);
    expect(scalar("SELECT outcome FROM job_attempts WHERE id = ?", second.attemptId)).toBe(
      "running",
    );
    expect(recoverInterruptedJobs(temp.db, t0)).toEqual({ abandoned: 1 });
    expect(scalar("SELECT status FROM analysis_runs WHERE id = ?", second.runId)).toBe("cancelled");
    // The abandoned attempt keeps its worker pid.
    expect(scalar("SELECT worker_pid FROM job_attempts WHERE id = ?", second.attemptId)).toBe(777);
    expect(interruptedWorkerPids(temp.db)).toEqual([]);
    const third = claim(jobId);
    expect(third.attempt).toBe(3);
    const failed = failAttempt(temp.db, { ...third, nowMs: t0, errorCode: "crashed", retry: true });
    expect(failed).toMatchObject({ jobState: "queued", failures: 1, notBeforeMs: t0 + 60_000 });
    expect(
      temp.db.client
        .prepare("SELECT outcome FROM job_attempts WHERE job_id = ? ORDER BY attempt")
        .all(jobId)
        .map((row) => row["outcome"]),
    ).toEqual(["cancelled", "abandoned", "failed"]);
  });

  it("never counts past max_attempts, however many attempts are cancelled", () => {
    // Job 1371 (2026-11-18): five admission cancellations showed attempts 5 of 3.
    const { episodeId } = closedEpisode();
    const { jobId } = queue(episodeId);
    for (let index = 0; index < 5; index++) {
      cancelAttempt(temp.db, { ...claim(jobId), nowMs: t0, reason: "admission" });
    }
    expect(scalar("SELECT attempts FROM jobs WHERE id = ?", jobId)).toBe(0);
    const sixth = claim(jobId);
    expect(sixth.attempt).toBe(6);
    failAttempt(temp.db, { ...sixth, nowMs: t0, errorCode: "crashed", retry: true });
    expect(scalar("SELECT attempts FROM jobs WHERE id = ?", jobId)).toBe(1);
    expect(scalar("SELECT max_attempts FROM jobs WHERE id = ?", jobId)).toBe(3);
  });

  it("recovery counts the failures of a job counted the old way", () => {
    const { episodeId } = closedEpisode();
    const { jobId } = queue(episodeId);
    const first = claim(jobId);
    failAttempt(temp.db, { ...first, nowMs: t0, errorCode: "crashed", retry: true });
    temp.db.client.prepare("UPDATE jobs SET attempts = 5 WHERE id = ?").run(jobId);
    recoverInterruptedJobs(temp.db, t0);
    expect(scalar("SELECT attempts FROM jobs WHERE id = ?", jobId)).toBe(1);
  });

  it("fails at once without retry", () => {
    const { episodeId } = closedEpisode();
    const { jobId } = queue(episodeId);
    const claimed = claim(jobId);
    const result = failAttempt(temp.db, {
      ...claimed,
      nowMs: t0,
      errorCode: "audio_unavailable",
      retry: false,
    });
    expect(result.jobState).toBe("failed");
  });
});

describe("startup", () => {
  it("queues closed episodes without a current transcript, once, traces last", () => {
    const moment = closedEpisode("moment").episodeId;
    const conversation = closedEpisode("conversation").episodeId;
    const trace = closedEpisode("trace").episodeId;
    const done = closedEpisode("moment");
    const { jobId } = queue(done.episodeId);
    const claimed = claim(jobId);
    const published = publishAnalysis(temp.db, {
      episodeId: done.episodeId,
      stage: "asr",
      runId: claimed.runId,
      inputGeneration: 1,
      segments: [segment(done.trackRunId, 1, 2, "bonjour")],
      turns: [],
    });
    expect(published.published).toBe(true);
    succeedAttempt(temp.db, { ...claimed, nowMs: t0 });

    expect(enqueueMissingAnalysis(temp.db, t0)).toEqual([moment, conversation, trace]);
    expect(scalar("SELECT priority FROM jobs WHERE episode_id = ?", trace)).toBe(
      analysisPriorities.trace,
    );
    expect(enqueueMissingAnalysis(temp.db, t0)).toEqual([]);
    // A new generation of the published one needs a new pass.
    bumpInputGeneration(temp.db, done.episodeId);
    expect(enqueueMissingAnalysis(temp.db, t0)).toEqual([done.episodeId]);
  });

  it("does not retry a job that failed at the current generation", () => {
    const { episodeId } = closedEpisode();
    const { jobId } = queue(episodeId);
    const claimed = claim(jobId);
    failAttempt(temp.db, { ...claimed, nowMs: t0, errorCode: "audio_unavailable", retry: false });
    expect(enqueueMissingAnalysis(temp.db, t0)).toEqual([]);
    bumpInputGeneration(temp.db, episodeId);
    expect(enqueueMissingAnalysis(temp.db, t0)).toEqual([episodeId]);
  });
});
