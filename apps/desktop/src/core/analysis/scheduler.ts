import { createHash } from "node:crypto";
import type {
  AnalysisCheck,
  AnalysisJobSummary,
  AnalysisStatus,
  AnalysisWaitReason,
  InstalledModel,
  Problem,
} from "@sondine/api";
import { decideSize, kindInputsOf, removeEcho, SIZE_TABLE_VERSION } from "@sondine/core";
import {
  analysisClassOfPriority,
  analysisPriorities,
  analysisQueueCounts,
  analysisRequests,
  cancelAttempt,
  claimAnalysisJob,
  currentRunId,
  cancelJobWithoutText,
  discardRun,
  episodesWithoutText,
  textlessZoneOn,
  enqueueAnalysisJob,
  enqueueMissingAnalysis,
  failAttempt,
  interruptedWorkerPids,
  loadAnalysisInput,
  loadEpisodeSizeInput,
  measuredPeakRss,
  nextRetryAtMs,
  nextRetryEpisodeId,
  nextRunnableJob,
  runnableDictations,
  publishAnalysis,
  recordRunOutcome,
  recoverInterruptedJobs,
  setAttemptWorkerPid,
  succeedAttempt,
  selfEchoStretches,
  transaction,
  updateEpisodeSize,
  setWaitFor,
  waitFor,
  wallMsAtSample,
  type AnalysisInput,
  type AttemptRef,
  type Database,
  type PublishRejection,
  type RunnableJob,
  type RunOutcome,
  type SegmentInput,
  type TurnInput,
  type WaitFor,
} from "@sondine/db";
import {
  EngineError,
  peakBytesFor,
  type AsrEngine,
  type AsrResult,
  type EngineProvenance,
  type EngineState,
  type ResidentEngine,
  type StopWorkersReport,
  type TextEngine,
} from "@sondine/engines";
import type { ReadTrackAudio } from "../audio/track-audio";
import type { JournalUnit, JournalWork } from "../journal/journal-work";
import { problem } from "../status/status-model";
import {
  admit,
  admitCheap,
  admitRemote,
  IDLE_REQUIRED_SECONDS,
  pressureRefuses,
  remainingMs,
  shouldCancel,
  SWAP_ROOM_MARGIN_BYTES,
  type AdmissionDecision,
  type AdmissionInput,
  type SystemSample,
} from "./admission";
import { NORMAL_BELOW_SHARE, WARNING_BELOW_SHARE } from "./memory-use";
import {
  cutTurns,
  deriveTurns,
  echoTracks,
  mapResult,
  MAX_SPLIT_DEPTH,
  planRequests,
  splitRequest,
  type RequestPlan,
} from "./requests";
import { TRACE_BATCH } from "../../shared/traces";
import type { SystemSignalsPort } from "./system-signals";
import type { WorkerProcessTools } from "./worker-process";

// The analysis queue's consumer (ADR 016, "Jobs" and "Worker"): one job at a
// time on this Mac, admission before each job and every 10 s during one,
// publication in the job's transaction. A dictation's job runs on Parakeet,
// one voice and no speakers (ADR 020); every other one on the final engine.
// An engine stays loaded while the queue drains and admission passes on warm
// terms, and unloads within 90 s after the last job that was not a trace,
// checking admission while idle. Traces run only on the final engine already
// loaded, after every other job, at most `tracesPerWarmSession` per load: they
// never load it and never keep it loaded. The daily journal (ADR 028) runs on
// its text model in the same loop, under the same admission: a journal the
// user asked for before automatic transcription, an automatic one after
// every transcription, and never two heavy models loaded at once. A compute
// server the user chose (ADR 040) takes the final engine's place, in a loop
// of its own: it holds nothing here, so only heat and critical memory hold its
// jobs back, a server that does not answer pauses them without failing them,
// and dictations and the journal go on here meanwhile. Never logs text, audio,
// or paths.

export interface SchedulerTiming {
  readonly admissionIntervalMs: number;
  /** The worker exits this long after the queue empties. */
  readonly idleUnloadMs: number;
  /** Peak RSS sampling of the worker. */
  readonly rssIntervalMs: number;
  /** How often a queue without an engine looks again. */
  readonly noModelPollMs: number;
  /** Minimum pause after a memory refusal, including explicit requests. */
  readonly memoryRetryMs: number;
  /**
   * After a cold load, how long critical pressure may last before the job is
   * cancelled: the load's own spike falls back within seconds (ADR 016).
   */
  readonly loadSettleMs: number;
  /** How often pressure is read while it settles. */
  readonly loadSettlePollMs: number;
  /**
   * After a cold load, how long swap growth is not judged; the swap baseline
   * is read again once it ends. Nemotron's weights are mapped, not read, at
   * load: its first minutes of work page in 17 GB and push other apps to
   * swap. Judged from the load, every request Téo made while using his Mac
   * stopped 40 s in (64 admission cancellations in 14 days, 2026-11-19).
   * Critical pressure and heat still stop the job at once.
   */
  readonly swapSettleMs: number;
}

export const defaultSchedulerTiming: SchedulerTiming = {
  admissionIntervalMs: 10_000,
  idleUnloadMs: 90_000,
  rssIntervalMs: 2_000,
  noModelPollMs: 30_000,
  memoryRetryMs: 60_000,
  loadSettleMs: 20_000,
  loadSettlePollMs: 1_000,
  swapSettleMs: 180_000,
};

/** Jobs whose finished requests stay in memory for their next attempt. */
const MAX_CARRIED_JOBS = 4;

/** A model this large or larger is never loaded beside another one (Nemotron, the journal's). */
export const HEAVY_ENGINE_BYTES = 4 * 1024 ** 3;

/** After the journal's model failed to load, how long before the queue tries it again. */
export const JOURNAL_LOAD_RETRY_MS = 10 * 60_000;

/** How long jobs wait after a server did not answer, or had no room; doubling up to the last. */
export const REMOTE_RETRY_MS = { first: 30_000, longest: 15 * 60_000 } as const;

/** A server that refuses this Mac, or speaks another version: nothing changes by itself soon. */
const REMOTE_REFUSED_RETRY_MS = 60 * 60_000;

/** More than the roll a request adds around an episode's speech. */
const ROLL_MARGIN_MS = 10_000;

/** Why a compute server's jobs wait, by what the engine said; another code is a failure. */
const REMOTE_WAITS: ReadonlyMap<string, AnalysisWaitReason> = new Map([
  ["network_unavailable", "server-offline"],
  ["server_busy", "server-busy"],
  ["unauthorized", "server-refused"],
  ["server_mismatch", "server-refused"],
  ["quota_exhausted", "server-quota"],
]);

/** The longest pause after memory refusals in a row (they double from `memoryRetryMs`). */
export const MAX_MEMORY_RETRY_MS = 30 * 60_000;

/** Trace jobs one load of the engine runs at most, so a backlog of traces stays bounded. */
export const TRACES_PER_WARM_SESSION = 50;

type Fields = Readonly<Record<string, string | number | boolean | null | undefined>>;

export interface SchedulerDeps {
  readonly db: Database;
  /** The installed final engine; null while no model is installed. */
  readonly engine: () => AsrEngine | null;
  /** This Mac's final engine while a compute server takes its place: it still unloads when idle. */
  readonly idleEngine?: () => AsrEngine | null;
  /** Dictations' engine (Parakeet, shared with near-live text); null until it is installed. */
  readonly dictationEngine?: () => AsrEngine | null;
  /** A dictation's text as its app kept it, in place of a transcription (ADR 020); null: transcribe. */
  readonly dictated?: (input: AnalysisInput) => DictatedText | null;
  /** Verified model artifacts, for the status. */
  readonly models?: () => readonly InstalledModel[];
  /** Reads a run's audio back from the spool or the archive; null waits like a missing model. */
  readonly readAudio: () => ReadTrackAudio | null;
  readonly signals: SystemSignalsPort;
  readonly processes: WorkerProcessTools;
  readonly onStatus: (status: AnalysisStatus) => void;
  /** A transcript was published: its voices can be linked now. */
  readonly onPublished?: (episodeId: number) => void;
  /** An attempt failed, or a compute server refused it: its code (ADR 042). */
  readonly onFailed?: (code: string) => void;
  readonly log: {
    info(event: string, fields?: Fields): void;
    warn(event: string, fields?: Fields): void;
  };
  readonly now?: () => number;
  readonly timing?: Partial<SchedulerTiming>;
  /** Default `TRACES_PER_WARM_SESSION`. */
  readonly tracesPerWarmSession?: number;
  /** The daily journal's work, on its own text model; none without it. */
  readonly journal?: JournalWork;
  /** Stops every process running the journal's server at start; none without a server. */
  readonly textProcesses?: { stopAll(): Promise<StopWorkersReport> };
}

/** What a dictation app typed, placed on what was heard. */
export interface DictatedText {
  readonly bundleId: string;
  readonly segments: readonly SegmentInput[];
}

export type AnalysisRequestOutcome =
  | "queued"
  | "already-queued"
  | "running"
  | "episode-open"
  | "private-zone";

export interface RecoveryOutcome {
  readonly abandoned: number;
  /** Speech processes stopped: orphans and recorded workers. */
  readonly killed: number;
  readonly enqueued: number;
  /** A speech process survived or could not be checked: the queue does not start. */
  readonly blocked: boolean;
}

/** Failures of the pass itself (not of the engine). */
class AnalysisFailure extends Error {
  override readonly name = "AnalysisFailure";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Failures a retry cannot fix: the job fails at once. */
const finalFailures: ReadonlySet<string> = new Set(["audio_unavailable", "model_limit"]);
/** Engine errors after which the worker process is still sound. */
const keptAfterFailure: ReadonlySet<string> = new Set(["invalid_output", "rejected"]);

const audioGone = () =>
  new AnalysisFailure(
    "audio_unavailable",
    "a request's audio is gone; the published transcript stays",
  );

/** An admission check: the decision and what the Mac reported for it. */
interface Admission {
  readonly decision: AdmissionDecision;
  readonly sample: SystemSample;
}

/** `no_text`: a private zone keeps the episode's text from being made, and nobody asked (ADR 029). */
class PublishRefused extends Error {
  override readonly name = "PublishRefused";
  constructor(readonly reason: PublishRejection | "no_text") {
    super(`publish refused: ${reason}`);
  }
}

/** One of the two loops: what it runs, or waits for. */
interface Lane {
  readonly tick: (signal: AbortSignal) => Promise<number>;
  loop: Promise<void> | null;
  wakeUp: (() => void) | null;
  woken: boolean;
  running: AnalysisJobSummary | null;
  /** The running job's engine, for the status. */
  engine: ResidentEngine | null;
  waitingFor: readonly AnalysisWaitReason[];
  /** The episode whose job `waitingFor` holds back; null for the journal or an empty queue. */
  waitingEpisodeId: number | null;
}

const lane = (tick: Lane["tick"]): Lane => ({
  tick,
  loop: null,
  wakeUp: null,
  woken: false,
  running: null,
  engine: null,
  waitingFor: [],
  waitingEpisodeId: null,
});

export class AnalysisScheduler {
  private readonly timing: SchedulerTiming;
  private readonly now: () => number;
  private readonly controller = new AbortController();
  /** What this Mac computes: every job with the model here, dictations and the journal always. */
  private readonly here = lane((signal) => this.tick(signal));
  /** What a compute server transcribes. */
  private readonly away = lane((signal) => this.tickRemote(signal));
  private lastError: Problem | null = null;
  /** When it started: an engine that never ran a job counts its idle time from here. */
  private readonly createdAt: number;
  /** Each engine's end of its last job that was not a trace: its idle unload counts from here. */
  private readonly lastWork = new Map<ResidentEngine, number>();
  /** The engines this scheduler loaded or used and has not let go of (Parakeet is shared). */
  private readonly holding = new Set<ResidentEngine>();
  /** The journal's model failed to load: not before this time again. */
  private journalRetryAt = 0;
  /** Trace jobs claimed since the final engine last loaded, or a server last did other work. */
  private tracesThisLoad = 0;
  /** The server takes every trace that waits: there were `TRACE_BATCH` of them. */
  private traceBatch = false;
  /** The compute server last did other work, and has the model loaded until then. */
  private serverWarm: { readonly engine: AsrEngine; readonly until: number } | null = null;
  private lastStatus = "";
  private lastProgressAt = 0;
  private blocked = false;
  /** The job and reasons last logged as waiting. */
  private lastWaitKey: string | null = null;
  private memoryRetryAt = 0;
  /** The pause holds engines at least this heavy: the one refused (0: every engine). */
  private memoryRetryPeak = 0;
  /**
   * Memory refusals in a row since the last published job: each doubles the
   * pause before the next try, so a Mac short on memory is not pushed to
   * swap every minute by a model that cannot stay loaded.
   */
  private memoryRefusals = 0;
  /** The compute server's jobs wait until then, for this reason; null while they run. */
  private remotePause: {
    readonly engine: AsrEngine;
    readonly until: number;
    readonly reason: AnalysisWaitReason;
  } | null = null;
  /** Stops the running request if it may no longer leave; null while none runs on a server. */
  private stopSending: (() => void) | null = null;
  /** Pauses in a row since the server last answered with a transcript. */
  private remotePauses = 0;
  /**
   * Swap in use once each engine finished loading. Loading pushes other apps
   * to swap, so growth counts from here, across jobs, while the engine stays
   * loaded; forgotten when it unloads, whatever the reason.
   */
  private readonly swapBaselines = new Map<ResidentEngine, number>();
  /**
   * Until when, after a cold load, swap growth is not judged for an engine
   * (`swapSettleMs`), in a job or between two; its baseline is read again then.
   */
  private readonly swapSettles = new Map<ResidentEngine, number>();
  /**
   * The requests an attempt finished before it stopped, for the job's next
   * attempt on the same input with the same engine: a long recording stopped
   * by admission keeps its finished parts, even when a dictation ran
   * between. By job, in memory only.
   */
  private readonly carried = new Map<
    number,
    {
      readonly inputHash: string;
      readonly engine: AsrEngine;
      readonly requests: Map<number, FinishedRequest>;
    }
  >();

  constructor(private readonly deps: SchedulerDeps) {
    this.timing = { ...defaultSchedulerTiming, ...deps.timing };
    this.now = deps.now ?? Date.now;
    this.createdAt = this.now();
  }

  private lastWorkOf(engine: ResidentEngine): number {
    return this.lastWork.get(engine) ?? this.createdAt;
  }

  /** The swap baseline admission judges by; null while the engine's load settles. */
  private baselineOf(engine: ResidentEngine | null): number | null {
    if (engine === null) return null;
    const until = this.swapSettles.get(engine);
    if (until !== undefined && this.now() < until) return null;
    return this.swapBaselines.get(engine) ?? null;
  }

  /** `baselineOf`, read again from the Mac once the load settled. */
  private async settledBaseline(
    engine: ResidentEngine,
    jobId: number | null,
  ): Promise<number | null> {
    const until = this.swapSettles.get(engine);
    if (until !== undefined && this.now() >= until) {
      this.swapSettles.delete(engine);
      const swapUsedBytes = (await this.deps.signals.memory()).swapUsedBytes;
      if (swapUsedBytes === null) this.swapBaselines.delete(engine);
      else this.swapBaselines.set(engine, swapUsedBytes);
      this.deps.log.info("analysis.swap-baseline", {
        jobId,
        engine: engine.manifest.id,
        swapBaselineMb: megabytes(swapUsedBytes),
      });
    }
    return this.baselineOf(engine);
  }

  private forgetBaseline(engine: ResidentEngine): void {
    this.swapBaselines.delete(engine);
    this.swapSettles.delete(engine);
  }

  /** The engines this scheduler holds that are loaded, the final one first. */
  private loaded(): ResidentEngine[] {
    return this.engines().filter(
      (engine) => this.holding.has(engine) && engine.state() !== "absent",
    );
  }

  /** Dictations left out while Parakeet is not installed: they wait for their model. */
  private dictationsWait(now: number): boolean {
    return (
      (this.deps.dictationEngine?.() ?? null) === null &&
      nextRunnableJob(this.deps.db, now, { traces: false, jobs: "dictations" }) !== null
    );
  }

  /**
   * At startup, before any worker: stops every process running our speech
   * binary (only core spawns it, so each is an orphan, recorded or not),
   * reaps the workers the interrupted attempts recorded, and only then
   * abandons those attempts and queues every closed episode that lacks a
   * current transcript. A worker that survives, or a check that cannot run,
   * leaves the database as it was and blocks `start` until the next launch.
   */
  async recover(): Promise<RecoveryOutcome> {
    const { db, log, processes } = this.deps;
    let killed = 0;
    try {
      const swept = await processes.stopAll();
      killed += swept.stopped.length;
      if (swept.survivors.length > 0) {
        return this.block(`speech worker ${swept.survivors.join(", ")} survived SIGKILL`, killed);
      }
      // The journal's server: only core starts it, so any running now is an orphan.
      const text = await this.deps.textProcesses?.stopAll();
      killed += text?.stopped.length ?? 0;
      if (text !== undefined && text.survivors.length > 0) {
        return this.block(`text server ${text.survivors.join(", ")} survived SIGKILL`, killed);
      }
      for (const pid of interruptedWorkerPids(db)) {
        if ((await processes.reap(pid)) === "killed") killed += 1;
      }
    } catch (error) {
      return this.block(messageOf(error), killed);
    }
    const recovered = recoverInterruptedJobs(db, this.now());
    const enqueued = enqueueMissingAnalysis(db, this.now()).length;
    this.deps.journal?.recover();
    if (recovered.abandoned + killed + enqueued > 0) {
      log.info("analysis.recovered", { abandoned: recovered.abandoned, killed, enqueued });
    }
    this.publishStatus();
    return { abandoned: recovered.abandoned, killed, enqueued, blocked: false };
  }

  /** Our own messages only (pids, `ps` failures): no text or audio. */
  private block(message: string, killed: number): RecoveryOutcome {
    this.blocked = true;
    this.lastError = problem("analysis.stray_worker", message, this.now());
    this.deps.log.warn("analysis.blocked", { message, killed });
    this.publishStatus();
    return { abandoned: 0, killed, enqueued: 0, blocked: true };
  }

  /** The user turned a condition of automatic jobs on or off: it applies at the next look, now. */
  setWaitFor(condition: keyof WaitFor, wait: boolean): WaitFor {
    const rules = setWaitFor(this.deps.db, condition, wait, this.now());
    this.wake();
    return rules;
  }

  /** Recovery left a speech worker it could not stop: no worker may start until the next launch. */
  isBlocked(): boolean {
    return this.blocked;
  }

  /** Runs the queue, unless recovery left a worker it could not stop. */
  start(): void {
    if (this.blocked) return;
    for (const each of [this.here, this.away]) {
      each.loop ??= this.supervise(each, this.controller.signal);
    }
  }

  /**
   * Runs a loop, and starts it again if it ever throws: a dead loop leaves
   * the queue still with a stale reason on screen (2026-11-18, 16 h).
   */
  private async supervise(each: Lane, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.run(each, signal);
      } catch (error) {
        if (signal.aborted) return;
        this.deps.log.warn("analysis.loop-failed", { message: messageOf(error) });
        await this.wait(each, this.timing.admissionIntervalMs, signal);
      }
    }
  }

  /** Stops both loops without touching the queue (a restart recovers it), then unloads the worker. */
  async stop(timeoutMs = 10_000): Promise<void> {
    this.controller.abort();
    this.wake();
    await Promise.race([Promise.all([this.here.loop, this.away.loop]), deadline(timeoutMs / 2)]);
    const loaded = this.engines().filter((engine) => engine.state() !== "absent");
    await Promise.race([
      Promise.all(loaded.map((engine) => engine.unload().catch(() => undefined))),
      deadline(timeoutMs / 2),
    ]);
  }

  /** The engines this scheduler may have loaded. */
  private engines(): ResidentEngine[] {
    // Every engine the journal may hold, whoever writes now: a model loaded
    // before the user chose Claude still unloads when idle and makes room.
    const engines: (ResidentEngine | null)[] = [
      this.deps.engine(),
      this.deps.idleEngine?.() ?? null,
      this.deps.dictationEngine?.() ?? null,
      ...(this.deps.journal?.engines() ?? []),
    ];
    return [...new Set(engines)].filter((engine): engine is ResidentEngine => engine !== null);
  }

  /** The pause a compute server's jobs are in; null when they may run. */
  private pauseOf(engine: AsrEngine | null, now: number): AnalysisWaitReason | null {
    const pause = this.remotePause;
    return pause !== null && pause.engine === engine && now < pause.until ? pause.reason : null;
  }

  /** The server did not take the work: its jobs wait, each time longer. */
  private pauseRemote(engine: AsrEngine, reason: AnalysisWaitReason): number {
    const waitMs =
      reason === "server-refused" || reason === "server-quota"
        ? REMOTE_REFUSED_RETRY_MS
        : Math.min(REMOTE_RETRY_MS.first * 2 ** this.remotePauses, REMOTE_RETRY_MS.longest);
    this.remotePauses += 1;
    this.remotePause = { engine, until: this.now() + waitMs, reason };
    return waitMs;
  }

  /** The user asked again: no pause holds. */
  private resumeRemote(): void {
    this.remotePause = null;
    this.remotePauses = 0;
    this.wake();
  }

  /** The user changed where transcription runs: what leaves for the old place stops now. */
  placeChanged(): void {
    this.stopSending?.();
    this.resumeRemote();
  }

  /**
   * The journal's unit to run now instead of `picked`, if any: one the user
   * asked for goes before automatic transcription; an automatic one waits
   * until no transcription can run here. Not while its model's last load
   * failed recently.
   */
  private journalUnit(
    picked: { job: RunnableJob; engine: AsrEngine | null } | null,
    now: number,
  ): { unit: JournalUnit; engine: TextEngine } | null {
    const journal = this.deps.journal;
    if (journal === undefined || now < this.journalRetryAt) return null;
    const next = journal.next();
    if (next === null) return null;
    if (picked === null || picked.engine === null) return next;
    return next.unit.requested && !picked.job.requested ? next : null;
  }

  /** An automatic journal unit, tried when transcription is refused memory a smaller model may fit in. */
  private automaticJournal(now: number): { unit: JournalUnit; engine: TextEngine } | null {
    const journal = this.deps.journal;
    if (journal === undefined || now < this.journalRetryAt) return null;
    return journal.next();
  }

  /**
   * Unloads every other heavy model before `engine` loads, and checks that
   * each one's process is gone: two never share the Mac's memory. False
   * when one is still there.
   */
  private async makeRoomFor(engine: ResidentEngine): Promise<boolean> {
    if (engine.resources.peakBytesBase < HEAVY_ENGINE_BYTES) return true;
    for (const other of this.engines()) {
      if (
        other === engine ||
        other.resources.peakBytesBase < HEAVY_ENGINE_BYTES ||
        other.state() === "absent"
      ) {
        continue;
      }
      await this.unload(other, "exclusive", { for: engine.manifest.id });
      if (other.state() !== "absent") {
        this.deps.log.warn("analysis.exclusive-blocked", {
          engine: other.manifest.id,
          for: engine.manifest.id,
        });
        return false;
      }
    }
    return true;
  }

  /**
   * The next job for this Mac and its engine. Dictations wait for Parakeet;
   * when only Parakeet is installed they go first, and the others say
   * `no-model`. While a server transcribes the others, only dictations.
   */
  private pick(
    now: number,
    traces: boolean,
  ): { job: RunnableJob; engine: AsrEngine | null } | null {
    const { db } = this.deps;
    const final = this.deps.engine();
    const dictation = this.deps.dictationEngine?.() ?? null;
    const dictations = () =>
      dictation === null ? null : nextRunnableJob(db, now, { traces: false, jobs: "dictations" });
    const job = isRemote(final)
      ? dictations()
      : ((final === null ? dictations() : null) ??
        nextRunnableJob(db, now, { traces, jobs: dictation === null ? "others" : "all" }));
    if (job === null) return null;
    return { job, engine: this.engineFor(job.dictation) };
  }

  /** The next job for the compute server the user chose; null without one. */
  private pickRemote(now: number): { job: RunnableJob; engine: AsrEngine } | null {
    const engine = this.deps.engine();
    if (engine === null || !isRemote(engine)) return null;
    // A trace never has the model loaded for itself: it follows other work, or goes with many.
    const warm = this.serverWarm;
    const follows =
      warm?.engine === engine &&
      now < warm.until &&
      this.tracesThisLoad < (this.deps.tracesPerWarmSession ?? TRACES_PER_WARM_SESSION);
    const traces = follows || this.traceBatch || this.tracesMakeBatch();
    const job = nextRunnableJob(this.deps.db, now, { traces, jobs: "others" });
    return job === null ? null : { job, engine };
  }

  private tracesMakeBatch(): boolean {
    return analysisQueueCounts(this.deps.db).traces >= TRACE_BATCH;
  }

  /** A dictation runs on Parakeet, here; the rest on the final engine. */
  private engineFor(dictation: boolean): AsrEngine | null {
    return dictation ? (this.deps.dictationEngine?.() ?? null) : this.deps.engine();
  }

  /** The queue changed: look again now. */
  wake(): void {
    this.wakeLane(this.here);
    this.wakeLane(this.away);
  }

  private wakeLane(each: Lane): void {
    each.woken = true;
    const resolve = each.wakeUp;
    each.wakeUp = null;
    resolve?.();
  }

  /** A user request for one episode: highest priority, skips idle and AC. Null: no such episode. */
  request(episodeId: number): { outcome: AnalysisRequestOutcome; jobId: number | null } | null {
    const episode = loadEpisodeSizeInput(this.deps.db, episodeId);
    if (episode === null) return null;
    // Analysis starts at close; the open episode's speech is still arriving.
    if (episode.state === "open") return { outcome: "episode-open", jobId: null };
    // A private zone that keeps no text: asked for, this Mac makes it (ADR 029), a server never (ADR 040).
    if (
      isRemote(this.engineFor(episode.context === "dictation")) &&
      episodesWithoutText(this.deps.db, [episodeId], this.now()).has(episodeId)
    ) {
      return { outcome: "private-zone", jobId: null };
    }
    // Asked by the user: a server that did not answer is tried now.
    if (this.remotePause !== null) this.resumeRemote();
    const result = enqueueAnalysisJob(this.deps.db, {
      episodeId,
      inputGeneration: episode.inputGeneration,
      priority: analysisPriorities.requested,
      requested: true,
      nowMs: this.now(),
    });
    this.wake();
    this.publishStatus();
    const outcome: AnalysisRequestOutcome =
      result.outcome === "created"
        ? "queued"
        : result.outcome === "running"
          ? "running"
          : "already-queued";
    return { outcome, jobId: result.jobId };
  }

  private async run(each: Lane, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let waitMs: number;
      try {
        waitMs = await each.tick(signal);
      } catch (error) {
        if (signal.aborted) return;
        this.deps.log.warn("analysis.tick-failed", { message: messageOf(error) });
        this.lastError = problem("analysis.internal", messageOf(error), this.now());
        this.publishStatus();
        waitMs = this.timing.admissionIntervalMs;
      }
      if (waitMs > 0) await this.wait(each, waitMs, signal);
    }
  }

  private wait(each: Lane, ms: number, signal: AbortSignal): Promise<void> {
    if (each.woken || signal.aborted) {
      each.woken = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        each.wakeUp = null;
        each.woken = false;
        resolve();
      };
      const timer = Number.isFinite(ms) ? setTimeout(finish, ms) : undefined;
      each.wakeUp = finish;
      signal.addEventListener("abort", finish, { once: true });
    });
  }

  /** One look at this Mac's queue; returns how long to wait before the next one. */
  private async tick(signal: AbortSignal): Promise<number> {
    const { db } = this.deps;
    const now = this.now();
    const final = this.deps.engine();
    // A trace runs only on the final engine already loaded, within its
    // residency, and up to the per-load bound: it never loads it, nor keeps
    // it loaded. A dictation is never a trace.
    const traces =
      final !== null &&
      !isRemote(final) &&
      final.state() === "ready" &&
      now - this.lastWorkOf(final) < this.timing.idleUnloadMs &&
      this.tracesThisLoad < (this.deps.tracesPerWarmSession ?? TRACES_PER_WARM_SESSION);
    // Their apps' text needs no model: without Parakeet too, they do not wait for it.
    if ((this.deps.dictationEngine?.() ?? null) === null) {
      for (const job of runnableDictations(db, now)) this.publishDictated(job);
    }
    const picked = this.pick(now, traces);
    const journal = this.journalUnit(picked, now);
    const working = journal?.engine ?? picked?.engine;
    const unused = isRemote(final) ? (this.deps.idleEngine?.() ?? null) : null;
    // An engine idle past its residency goes, even while the other one's jobs run.
    for (const engine of this.loaded()) {
      if (engine === working) continue;
      // A server transcribes in its place: it would hold its memory for as long as that takes.
      if (engine === unused) {
        await this.unload(engine, "remote");
        continue;
      }
      if (now - this.lastWorkOf(engine) >= this.timing.idleUnloadMs) {
        await this.unload(engine, "idle");
      }
    }
    if (journal !== null) return this.tickJournal(journal.unit, journal.engine, signal);
    if (picked === null) {
      const retryAt = nextRetryAtMs(db, now);
      // A job waiting for its retry: the queue waits on it.
      this.here.waitingEpisodeId = retryAt === null ? null : nextRetryEpisodeId(db, now);
      this.here.waitingFor = [
        ...(this.dictationsWait(now) ? (["no-model"] as const) : []),
        ...(retryAt === null ? [] : (["retry-later"] as const)),
      ];
      let waitMs = retryAt === null ? Number.POSITIVE_INFINITY : Math.max(0, retryAt - now);
      // The journal's model failed to load, or the user's Claude did not
      // answer: look again when its pause ends.
      if (now < this.journalRetryAt) waitMs = Math.min(waitMs, this.journalRetryAt - now);
      const claudeRetryAt = this.deps.journal?.claudeRetryAt() ?? 0;
      if (now < claudeRetryAt) waitMs = Math.min(waitMs, claudeRetryAt - now);
      // Within their residency: the idle ones went above.
      const loaded = this.loaded();
      if (loaded.length > 0) {
        const first = loaded[0];
        const swapBaselineBytes =
          first === undefined ? null : await this.settledBaseline(first, null);
        const { decision, sample } = await this.admission({
          requested: false,
          warm: true,
          loading: false,
          peakBytes: 0,
          swapBaselineBytes,
        });
        if (signal.aborted) return 0;
        if (!decision.admitted) {
          this.deferMemoryRetry(decision, loaded);
          for (const engine of loaded) {
            await this.unload(
              engine,
              "admission",
              refusalFields(decision.reasons, sample, swapBaselineBytes),
            );
          }
        } else {
          const residency = Math.min(
            ...loaded.map((engine) => this.timing.idleUnloadMs - (now - this.lastWorkOf(engine))),
          );
          waitMs = Math.min(waitMs, residency, this.timing.admissionIntervalMs);
        }
      }
      this.publishStatus();
      return waitMs;
    }
    return this.tickJob(picked, now, signal, true);
  }

  /**
   * Admission for one job, then the job. A job refused memory or swap, or
   * paused after such a refusal, lets a dictation on a lighter engine go
   * first (`lighter`): a 1 h 46 call waiting for room must not hold the
   * dictations behind it (2026-11-18, 96 jobs waited).
   */
  private async tickJob(
    picked: { job: RunnableJob; engine: AsrEngine | null },
    now: number,
    signal: AbortSignal,
    lighter: boolean,
  ): Promise<number> {
    const { db } = this.deps;
    const { job, engine } = picked;
    // The app's own text: no model, so nothing to wait for.
    if (job.dictation && this.publishDictated(job)) return 0;
    if (engine === null || this.deps.readAudio() === null) {
      this.here.waitingFor = ["no-model"];
      this.here.waitingEpisodeId = job.episodeId;
      this.publishStatus();
      return this.timing.noModelPollMs;
    }

    // The pause after a memory refusal holds engines as heavy as the one
    // refused; a lighter one such as Parakeet goes through its own admission,
    // at the head or not.
    if (now < this.memoryRetryAt && engine.resources.peakBytesBase >= this.memoryRetryPeak) {
      const other = lighter ? this.lighterThan(picked, now) : null;
      if (other !== null) {
        const waitMs = await this.tickJob(other, now, signal, false);
        if (waitMs === 0) return 0;
      }
      this.here.waitingFor = ["retry-later"];
      this.here.waitingEpisodeId = job.episodeId;
      this.publishStatus();
      // A dictation waiting behind is looked at again at the usual interval.
      return other === null
        ? this.memoryRetryAt - now
        : Math.min(this.timing.admissionIntervalMs, this.memoryRetryAt - now);
    }

    const input = loadAnalysisInput(db, job.episodeId);
    const plans = input === null ? [] : this.plansFor(engine, input);
    const peakBytes = this.peakFor(engine, plans);
    // A loaded engine stays for the next job on warm terms: its own weights
    // hold pressure at warn, and unloading only to load again pushes other
    // apps to swap each time.
    const warm = isWarm(engine.state());
    if (!warm) this.forgetBaseline(engine);
    const swapBaselineBytes = warm ? await this.settledBaseline(engine, job.jobId) : null;
    const { decision, sample } = await this.admission({
      requested: job.requested,
      dictation: job.dictation,
      warm,
      loading: false,
      peakBytes,
      swapBaselineBytes,
    });
    if (signal.aborted) return 0;
    // The engine went away while admission was read: the trace waits for the next load.
    // From here to the claim nothing awaits, so the engine cannot unload in between.
    if (isTraceJob(job) && engine.state() !== "ready") return 0;
    if (!decision.admitted) {
      const roomOnly = decision.reasons.every((reason) => reason === "memory" || reason === "swap");
      // A dictation on a lighter engine may fit where this job does not.
      const other = lighter && roomOnly ? this.lighterThan(picked, now) : null;
      if (other !== null && (await this.tickJob(other, now, signal, false)) === 0) return 0;
      // Transcription cannot fit now, but the journal's smaller model may.
      if (lighter && !warm && roomOnly) {
        const automatic = this.automaticJournal(now);
        if (automatic !== null) return this.tickJournal(automatic.unit, automatic.engine, signal);
      }
      this.here.waitingFor = decision.reasons;
      this.here.waitingEpisodeId = job.episodeId;
      // Once per job and reasons, so a queue that waits says on which job and why.
      const waitKey = `${job.jobId}:${decision.reasons.join()}`;
      if (waitKey !== this.lastWaitKey) {
        this.lastWaitKey = waitKey;
        this.deps.log.info("analysis.waiting", {
          jobId: job.jobId,
          episodeId: job.episodeId,
          requested: job.requested,
          priority: job.priority,
          reasons: decision.reasons.join(),
          ...refusalFields(decision.reasons, sample, swapBaselineBytes),
        });
      }
      // Waiting with the model loaded would hold its memory while the Mac is in use.
      if (this.holding.has(engine) && isWarm(engine.state())) {
        this.deferMemoryRetry(decision, [engine]);
        await this.unload(
          engine,
          "admission",
          refusalFields(decision.reasons, sample, swapBaselineBytes),
        );
      }
      this.publishStatus();
      return this.timing.admissionIntervalMs;
    }
    if (engine.state() === "absent" && !(await this.makeRoomFor(engine))) {
      this.here.waitingFor = ["memory"];
      this.here.waitingEpisodeId = job.episodeId;
      this.publishStatus();
      return this.timing.admissionIntervalMs;
    }
    this.here.waitingFor = [];
    this.here.waitingEpisodeId = null;
    this.lastWaitKey = null;
    await this.runJob(this.here, job, input, plans, engine, peakBytes, signal);
    return 0;
  }

  /** One look at the compute server's queue: nothing to load here, so little to wait for. */
  private async tickRemote(signal: AbortSignal): Promise<number> {
    const { away } = this;
    const now = this.now();
    const picked = this.pickRemote(now);
    const wait = (reasons: readonly AnalysisWaitReason[], ms: number) => {
      away.waitingFor = reasons;
      away.waitingEpisodeId = reasons.length === 0 ? null : (picked?.job.episodeId ?? null);
      this.publishStatus();
      return ms;
    };
    if (picked === null) {
      this.traceBatch = false;
      const retryAt = isRemote(this.deps.engine()) ? nextRetryAtMs(this.deps.db, now) : null;
      return wait([], retryAt === null ? Number.POSITIVE_INFINITY : Math.max(0, retryAt - now));
    }
    const { job, engine } = picked;
    // Once begun, down to the last one.
    if (isTraceJob(job) && this.tracesMakeBatch()) this.traceBatch = true;
    if (this.deps.readAudio() === null) return wait(["no-model"], this.timing.noModelPollMs);
    const paused = this.pauseOf(engine, now);
    if (paused !== null && this.remotePause !== null) {
      return wait([paused], this.remotePause.until - now);
    }
    const reasons = admitRemote(await this.sample());
    if (signal.aborted) return 0;
    if (reasons.length > 0) return wait(reasons, this.timing.admissionIntervalMs);
    const input = loadAnalysisInput(this.deps.db, job.episodeId);
    away.waitingFor = [];
    away.waitingEpisodeId = null;
    const plans = input === null ? [] : this.plansFor(engine, input);
    await this.runJob(away, job, input, plans, engine, 0, signal);
    return 0;
  }

  private async sample(): Promise<SystemSample> {
    return { ...(await this.deps.signals.cheap()), ...(await this.deps.signals.memory()) };
  }

  /** The first dictation waiting on an engine lighter than `picked`'s, if any. */
  private lighterThan(
    picked: { job: RunnableJob; engine: AsrEngine | null },
    now: number,
  ): { job: RunnableJob; engine: AsrEngine } | null {
    const dictation = this.deps.dictationEngine?.() ?? null;
    if (picked.job.dictation || dictation === null || picked.engine === null) return null;
    if (dictation.resources.peakBytesBase >= picked.engine.resources.peakBytesBase) return null;
    const job = nextRunnableJob(this.deps.db, now, { traces: false, jobs: "dictations" });
    return job === null ? null : { job, engine: dictation };
  }

  /** The journal's turn: admission as for a job, then one episode written. */
  private async tickJournal(
    unit: JournalUnit,
    engine: TextEngine,
    signal: AbortSignal,
  ): Promise<number> {
    this.here.waitingEpisodeId = null;
    // A transcript without words is written empty: no model, no admission.
    if (this.deps.journal?.hasText(unit) === false) {
      await this.deps.journal.run(engine, unit, signal);
      return 0;
    }
    const now = this.now();
    if (now < this.memoryRetryAt) {
      this.here.waitingFor = ["retry-later"];
      this.publishStatus();
      return this.memoryRetryAt - now;
    }
    const peakBytes = engine.resources.peakBytesBase;
    const warm = isWarm(engine.state());
    if (!warm) this.forgetBaseline(engine);
    const swapBaselineBytes = this.baselineOf(engine);
    const { decision, sample } = await this.admission({
      requested: unit.requested,
      warm,
      loading: false,
      peakBytes,
      swapBaselineBytes,
    });
    if (signal.aborted) return 0;
    if (!decision.admitted) {
      this.here.waitingFor = decision.reasons;
      const waitKey = `journal:${unit.episodeId}:${decision.reasons.join()}`;
      if (waitKey !== this.lastWaitKey) {
        this.lastWaitKey = waitKey;
        this.deps.log.info("journal.waiting", {
          episodeId: unit.episodeId,
          requested: unit.requested,
          ...refusalFields(decision.reasons, sample, swapBaselineBytes),
        });
      }
      if (this.holding.has(engine) && isWarm(engine.state())) {
        this.deferMemoryRetry(decision, [engine]);
        await this.unload(
          engine,
          "admission",
          refusalFields(decision.reasons, sample, swapBaselineBytes),
        );
      }
      this.publishStatus();
      return this.timing.admissionIntervalMs;
    }
    if (engine.state() === "absent" && !(await this.makeRoomFor(engine))) {
      this.here.waitingFor = ["memory"];
      this.publishStatus();
      return this.timing.admissionIntervalMs;
    }
    this.here.waitingFor = [];
    this.lastWaitKey = null;
    await this.runJournal(unit, engine, peakBytes, signal);
    return 0;
  }

  /**
   * Loads the journal's model if needed, then writes one episode, checking
   * admission every 10 s: any refusal stops it at once (its progress gives
   * no reliable time left), and the model unloads.
   */
  private async runJournal(
    unit: JournalUnit,
    engine: TextEngine,
    peakBytes: number,
    signal: AbortSignal,
  ): Promise<void> {
    const journal = this.deps.journal;
    if (journal === undefined) return;
    const { log } = this.deps;
    this.holding.add(engine);
    this.here.engine = engine;
    this.publishStatus();
    const controller = new AbortController();
    const forward = () => controller.abort();
    if (signal.aborted) controller.abort();
    signal.addEventListener("abort", forward, { once: true });
    // Written by the admission timer when it stops the pass: why, for the log.
    const cancel: { refusal: Fields | null } = { refusal: null };
    let settled = false;
    const checkAdmission = async (): Promise<void> => {
      const swapBaselineBytes = this.baselineOf(engine);
      const { decision, sample } = await this.admission({
        requested: unit.requested,
        warm: true,
        loading: engine.state() === "loading",
        peakBytes,
        swapBaselineBytes,
      });
      if (settled || controller.signal.aborted || decision.admitted) return;
      this.deferMemoryRetry(decision, [engine]);
      cancel.refusal = refusalFields(decision.reasons, sample, swapBaselineBytes);
      this.here.waitingFor = decision.reasons;
      controller.abort();
    };
    let checking = false;
    const timer = setInterval(() => {
      if (checking || controller.signal.aborted) return;
      checking = true;
      void checkAdmission()
        .catch(() => undefined)
        .finally(() => {
          checking = false;
        });
    }, this.timing.admissionIntervalMs);
    try {
      if (engine.state() === "absent") {
        let loadMs: number;
        try {
          loadMs = (await engine.load(controller.signal)).loadMs;
        } catch (error) {
          if (controller.signal.aborted) throw error;
          // A model that cannot load (no server, a bad file) is not tried every tick.
          this.journalRetryAt = this.now() + JOURNAL_LOAD_RETRY_MS;
          this.lastError = problem(
            "journal.load_failed",
            "the journal's model did not load",
            this.now(),
          );
          log.warn("journal.load-failed", {
            code: error instanceof EngineError ? error.code : "internal",
          });
          return;
        }
        const swapUsedBytes = (await this.deps.signals.memory()).swapUsedBytes;
        if (swapUsedBytes === null) this.swapBaselines.delete(engine);
        else this.swapBaselines.set(engine, swapUsedBytes);
        log.info("journal.loaded", { engine: engine.manifest.id, loadMs });
        // As for transcription: a load's own pressure spike falls back within seconds.
        const settleUntil = this.now() + this.timing.loadSettleMs;
        while (this.now() < settleUntil) {
          if ((await this.deps.signals.memory()).memoryPressure !== "critical") break;
          await new Promise((resolve) => setTimeout(resolve, this.timing.loadSettlePollMs));
          controller.signal.throwIfAborted();
        }
        await checkAdmission();
        controller.signal.throwIfAborted();
      }
      const outcome = await journal.run(engine, unit, controller.signal);
      if (outcome === "published") this.memoryRefusals = 0;
      // The pass took the refusal as a cancel: the model still goes.
      const { refusal } = cancel;
      if (outcome === "cancelled" && refusal !== null && !signal.aborted) {
        log.info("journal.cancelled", {
          episodeId: unit.episodeId,
          reason: "admission",
          ...refusal,
        });
        await this.unload(engine, "admission", refusal);
      }
    } catch (error) {
      if (signal.aborted) return;
      const { refusal } = cancel;
      if (refusal !== null) {
        log.info("journal.cancelled", {
          episodeId: unit.episodeId,
          reason: "admission",
          ...refusal,
        });
        await this.unload(engine, "admission", refusal);
        return;
      }
      // The server failed under the pass: let it go, and say so.
      this.lastError = problem(
        `journal.${error instanceof EngineError ? error.code : "internal"}`,
        error instanceof Error ? error.name : "error",
        this.now(),
      );
      if (engine.state() !== "absent") await this.unload(engine, "failure");
    } finally {
      settled = true;
      clearInterval(timer);
      signal.removeEventListener("abort", forward);
      this.here.engine = null;
      this.lastWork.set(engine, this.now());
      if (!signal.aborted) this.publishStatus();
    }
  }

  /**
   * What the next job would wait for now, every condition read (the queue
   * itself stops at the first cheap refusal): its request mode and peak, the
   * engine warm or cold, and the retry delays, as `tick` decides. With no job
   * queued, the automatic terms. For the window's panel.
   */
  async check(): Promise<AnalysisCheck> {
    const { db } = this.deps;
    const now = this.now();
    const picked = this.pickRemote(now) ?? this.pick(now, false);
    const job = picked?.job ?? null;
    const engine = picked === null ? this.deps.engine() : picked.engine;
    const state = engine?.state() ?? "absent";
    const warm = isWarm(state);
    const requested = job?.requested ?? false;
    const retrying = now < this.memoryRetryAt || (job === null && nextRetryAtMs(db, now) !== null);
    let peakBytes = 0;
    if (engine !== null && !warm) {
      const input = job === null ? null : loadAnalysisInput(db, job.episodeId);
      peakBytes = this.peakFor(engine, input === null ? [] : this.plansFor(engine, input));
    }
    const sample = await this.sample();
    const rules = this.rulesFor(job?.dictation ?? false);
    if (engine !== null && isRemote(engine)) return this.checkRemote(engine, requested, sample);
    const decision = admit({
      sample,
      requested,
      warm,
      loading: state === "loading",
      peakBytes,
      swapBaselineBytes: warm ? this.baselineOf(engine) : null,
      waitFor: rules,
    });
    const model =
      engine !== null &&
      this.deps.readAudio() !== null &&
      (job !== null || !this.dictationsWait(now));
    const mode = { requested, warm, loading: state === "loading", waitFor: rules };
    const use = pressureRefuses(mode, sample.memoryPressure)
      ? await this.deps.signals.memoryUse()
      : null;
    return {
      requested,
      waitFor: rules,
      remote: false,
      reasons: [
        ...(model ? [] : (["no-model"] as const)),
        ...(decision.admitted ? [] : decision.reasons),
        ...(retrying ? (["retry-later"] as const) : []),
      ],
      onBattery: sample.onBattery,
      idleSeconds: sample.idleSeconds === null ? null : Math.floor(sample.idleSeconds),
      idleRequiredSeconds: IDLE_REQUIRED_SECONDS,
      locked: sample.locked,
      thermalState: sample.thermalState,
      memoryPressure: sample.memoryPressure,
      swapRoomBytes: warm ? null : sample.swapRoomBytes,
      swapRoomNeededBytes: warm || engine === null ? null : peakBytes + SWAP_ROOM_MARGIN_BYTES,
      memoryUse:
        use === null
          ? null
          : {
              countedBytes: use.uncompressedBytes + use.compressedBytes,
              compressedBytes: use.compressedBytes,
              // Normal is needed cold and automatic; out of critical will do otherwise.
              limitBytes: Math.round(
                (use.uncompressedBytes + use.compressedBytes) *
                  (warm || requested || !rules.memory ? WARNING_BELOW_SHARE : NORMAL_BELOW_SHARE),
              ),
              apps: use.apps.map((app) => ({
                name: app.name,
                appPath: app.appPath,
                bytes: app.bytes,
              })),
            },
    };
  }

  /** `check` for a compute server: none of the conditions of a model loaded here. */
  private checkRemote(engine: AsrEngine, requested: boolean, sample: SystemSample): AnalysisCheck {
    const paused = this.pauseOf(engine, this.now());
    return {
      requested,
      waitFor: { power: false, idle: false, memory: false },
      remote: true,
      reasons: paused === null ? [...admitRemote(sample)] : [paused],
      onBattery: sample.onBattery,
      idleSeconds: sample.idleSeconds === null ? null : Math.floor(sample.idleSeconds),
      idleRequiredSeconds: IDLE_REQUIRED_SECONDS,
      locked: sample.locked,
      thermalState: sample.thermalState,
      memoryPressure: sample.memoryPressure,
      swapRoomBytes: null,
      swapRoomNeededBytes: null,
      memoryUse: null,
    };
  }

  /**
   * Unloading must not erase a memory refusal and immediately trigger another
   * load. Returns the pause, or null when memory was not the reason.
   */
  private deferMemoryRetry(
    decision: AdmissionDecision,
    engines: readonly ResidentEngine[],
  ): number | null {
    if (
      decision.admitted ||
      !decision.reasons.some((reason) => reason === "memory" || reason === "swap")
    ) {
      return null;
    }
    const pause = Math.min(
      this.timing.memoryRetryMs * 2 ** this.memoryRefusals,
      MAX_MEMORY_RETRY_MS,
    );
    this.memoryRefusals += 1;
    this.memoryRetryAt = this.now() + pause;
    this.memoryRetryPeak = Math.min(
      ...engines.map((engine) => engine.resources.peakBytesBase),
      Infinity,
    );
    if (!Number.isFinite(this.memoryRetryPeak)) this.memoryRetryPeak = 0;
    return pause;
  }

  /** A job's requests, no longer than its engine takes. */
  private plansFor(engine: AsrEngine, input: AnalysisInput): RequestPlan[] {
    const { maxRequestSeconds } = engine.capabilities;
    return planRequests(input, {
      maxRequestSeconds,
      speechOnly: isRemote(engine) && this.besideTextlessZone(input.episodeId),
    });
  }

  /** A zone that keeps no text was on around the episode. */
  private besideTextlessZone(episodeId: number): boolean {
    const episode = loadEpisodeSizeInput(this.deps.db, episodeId);
    if (episode === null) return true;
    return textlessZoneOn(
      this.deps.db,
      episode.startedAtMs - ROLL_MARGIN_MS,
      (episode.endedAtMs ?? this.now()) + ROLL_MARGIN_MS,
    );
  }

  private peakFor(engine: AsrEngine, plans: readonly RequestPlan[]): number {
    const longestSeconds = plans.reduce(
      (max, plan) => Math.max(max, plan.samples / plan.sampleRate),
      0,
    );
    const measured = measuredPeakRss(this.deps.db, engine.manifest.id) ?? 0;
    return Math.max(peakBytesFor(engine.resources, longestSeconds), measured);
  }

  /**
   * Cold, the cheap conditions first: a waiting queue never spawns `sysctl`.
   * Warm, every condition, so a refusal logs the whole picture.
   */
  private async admission({
    dictation = false,
    ...input
  }: Omit<AdmissionInput, "sample" | "waitFor"> & {
    readonly dictation?: boolean;
  }): Promise<Admission> {
    // What the user lets automatic jobs wait for, read after the Mac is: a
    // switch moved while it was read applies to this decision.
    const cheap = await this.deps.signals.cheap();
    if (!input.warm) {
      const rules = this.rulesFor(dictation);
      const quick = admitCheap({ sample: cheap, requested: input.requested, waitFor: rules });
      if (!quick.admitted) return { decision: quick, sample: cheap };
    }
    const sample = { ...cheap, ...(await this.deps.signals.memory()) };
    return { decision: admit({ ...input, sample, waitFor: this.rulesFor(dictation) }), sample };
  }

  /**
   * What an automatic job waits for. While a server transcribes the rest,
   * dictations, about a second of Parakeet each, wait for neither power nor
   * idle (Téo, 2026-11-25); heat and memory still hold them.
   */
  private rulesFor(dictation: boolean): WaitFor {
    const rules = waitFor(this.deps.db);
    return dictation && isRemote(this.deps.engine())
      ? { ...rules, power: false, idle: false }
      : rules;
  }

  /**
   * A private zone keeps its text from being made, and nobody asked (ADR 029):
   * never run. On a server, not even then (ADR 040).
   */
  private skipWithoutText(job: RunnableJob, remote: boolean): boolean {
    const { db, log } = this.deps;
    const zoned =
      (remote || !job.requested) &&
      episodesWithoutText(db, [job.episodeId], this.now()).has(job.episodeId);
    if (zoned && cancelJobWithoutText(db, job.jobId, job.episodeId, this.now())) {
      log.info("analysis.skipped", { jobId: job.jobId, episodeId: job.episodeId, reason: "zone" });
    }
    return zoned;
  }

  /** Publishes a dictation as its app typed it; false when it is to be transcribed. */
  private publishDictated(job: RunnableJob): boolean {
    const input = loadAnalysisInput(this.deps.db, job.episodeId);
    const text = input === null ? null : (this.deps.dictated?.(input) ?? null);
    if (input === null || text === null) return false;
    if (!this.skipWithoutText(job, false)) this.publishText(job, input, text);
    return true;
  }

  /**
   * Replaces a past dictation's transcript by what its app typed. Queued,
   * claimed and published without a turn of the loop between: nothing can
   * make it a transcription instead.
   */
  publishPastDictation(input: AnalysisInput, text: DictatedText): boolean {
    const { db } = this.deps;
    if (this.blocked || this.controller.signal.aborted) return false;
    const queued = enqueueAnalysisJob(db, {
      episodeId: input.episodeId,
      inputGeneration: input.inputGeneration,
      priority: analysisPriorities.moment,
      nowMs: this.now(),
    });
    // Queued or running for another reason: that goes on as it is.
    if (queued.outcome !== "created") return false;
    return this.publishText(
      {
        jobId: queued.jobId,
        episodeId: input.episodeId,
        inputGeneration: input.inputGeneration,
        priority: analysisPriorities.moment,
        requested: false,
        dictation: true,
      },
      input,
      text,
    );
  }

  private publishText(job: RunnableJob, input: AnalysisInput, text: DictatedText): boolean {
    const { db, log } = this.deps;
    const plans = planRequests(input, {});
    const claim = claimAnalysisJob(db, {
      jobId: job.jobId,
      inputGeneration: input.inputGeneration,
      engine: {
        engineId: `dictation-text:${text.bundleId}`,
        engineVersion: "1",
        engineRuntime: "app history",
        adapterClass: "product",
        engineConfig: { speakers: false, timestamps: false },
      },
      inputHash: hashPlans(input.inputGeneration, plans),
      nowMs: this.now(),
    });
    // Another generation: the next tick looks again.
    if (!claim.claimed) return false;
    const ref = { jobId: claim.jobId, attemptId: claim.attemptId, runId: claim.runId };
    log.info("analysis.started", {
      jobId: claim.jobId,
      episodeId: claim.episodeId,
      attempt: claim.attempt,
      engine: "dictation-text",
    });
    const total = plans.reduce((sum, plan) => sum + plan.samples, 0);
    this.carried.delete(claim.jobId);
    try {
      this.publish(
        claim.episodeId,
        claim.inputGeneration,
        ref,
        text.segments,
        deriveTurns(
          text.segments,
          plans.flatMap((plan) => plan.extents),
        ),
        {
          coverage: 1,
          metrics: {
            audioMs: Math.round((total * 1000) / 16_000),
            computeMs: 0,
            loadMs: 0,
            segments: text.segments.length,
          },
          modelSha256: null,
          nowMs: this.now(),
        },
        job.requested,
        false,
      );
    } catch (error) {
      failAttempt(db, { ...ref, nowMs: this.now(), errorCode: "internal", retry: true });
      this.lastError = problem("analysis.internal", messageOf(error), this.now());
      log.warn("analysis.failed", { jobId: claim.jobId, code: "internal" });
      this.deps.onFailed?.("internal");
    }
    this.publishStatus();
    return true;
  }

  private async runJob(
    each: Lane,
    job: RunnableJob,
    input: AnalysisInput | null,
    plans: readonly RequestPlan[],
    engine: AsrEngine,
    peakBytes: number,
    signal: AbortSignal,
  ): Promise<void> {
    const { db, log } = this.deps;
    const remote = isRemote(engine);
    if (this.skipWithoutText(job, remote)) return;
    // A dictation is the user alone talking to an app: no speakers to find.
    const oneVoice = job.dictation;
    const inputHash = hashPlans(input?.inputGeneration ?? 0, plans);
    const claim = claimAnalysisJob(db, {
      jobId: job.jobId,
      inputGeneration: input?.inputGeneration ?? job.inputGeneration,
      engine: {
        engineId: engine.manifest.id,
        engineVersion: engine.manifest.version,
        engineRuntime: engine.manifest.runtime,
        adapterClass: engine.manifest.adapterClass,
        engineConfig: { speakers: !oneVoice, timestamps: true },
      },
      inputHash,
      nowMs: this.now(),
    });
    // Another generation: the next tick plans again. A missing episode cancelled the job.
    if (!claim.claimed || input === null) return;
    if (!remote) this.holding.add(engine);
    each.engine = engine;
    const trace = isTraceJob(job);
    if (trace) this.tracesThisLoad += 1;
    const ref = { jobId: claim.jobId, attemptId: claim.attemptId, runId: claim.runId };
    const startedAtMs = this.now();
    each.running = { jobId: claim.jobId, episodeId: claim.episodeId, progress: null, startedAtMs };
    this.publishStatus();
    log.info("analysis.started", {
      jobId: claim.jobId,
      episodeId: claim.episodeId,
      attempt: claim.attempt,
      requests: plans.length,
      requested: job.requested,
      trace,
    });

    const controller = new AbortController();
    const forward = () => controller.abort();
    if (signal.aborted) controller.abort();
    signal.addEventListener("abort", forward, { once: true });
    // Written by the admission timer below when it cancels the job: why, for the log.
    const cancel: { refusal: { readonly reasons: string; readonly fields: Fields } | null } = {
      refusal: null,
    };
    let progress: number | null = null;
    let computeStartedAt: number | null = null;
    let recordedPid: number | null = null;
    let peakRssBytes = 0;
    const recordPid = (): number | undefined => {
      // Once stopped, nothing touches the database: it may be closing.
      if (controller.signal.aborted) return undefined;
      const pid = engine.pid();
      if (pid !== undefined && pid !== recordedPid) {
        setAttemptWorkerPid(db, claim.attemptId, pid);
        recordedPid = pid;
      }
      return pid;
    };
    // During a cold load the pid appears after spawn: record it early, so a
    // core killed while loading still finds the worker to reap.
    const pidTimer = setInterval(recordPid, 200);
    const rssTimer = setInterval(() => {
      const pid = recordPid();
      if (pid === undefined) return;
      this.publishStatus();
      void this.deps.processes.residentBytes(pid).then((bytes) => {
        if (bytes !== null) peakRssBytes = Math.max(peakRssBytes, bytes);
      });
    }, this.timing.rssIntervalMs);
    let finished = false;
    // True while a fresh load's pressure spike settles: the timer waits too.
    let settling = false;
    /**
     * Whether the episode may still leave for a server: it stands as it was
     * planned, outside any zone that keeps no text, and the user's choice is
     * still this server. Deleted, forgotten, cut or switched back: no.
     */
    const maySend = (): boolean => {
      if (finished || controller.signal.aborted) return false;
      const episode = loadEpisodeSizeInput(db, claim.episodeId);
      return (
        episode !== null &&
        episode.inputGeneration === claim.inputGeneration &&
        this.deps.engine() === engine &&
        !episodesWithoutText(db, [claim.episodeId], this.now()).has(claim.episodeId)
      );
    };
    const checkAdmission = async (allowFinish: boolean): Promise<void> => {
      if (settling) return;
      if (remote) {
        // The audio held here is all it takes of this Mac; sent, it is not called back.
        const reasons = admitRemote(await this.sample());
        if (finished || controller.signal.aborted || reasons.length === 0) return;
        cancel.refusal = { reasons: reasons.join(), fields: { reasons: reasons.join() } };
        each.waitingFor = reasons;
        each.waitingEpisodeId = job.episodeId;
        controller.abort();
        return;
      }
      const swapBaselineBytes = await this.settledBaseline(engine, claim.jobId);
      if (finished || controller.signal.aborted) return;
      const { decision, sample } = await this.admission({
        requested: job.requested,
        dictation: job.dictation,
        warm: true,
        loading: engine.state() === "loading",
        peakBytes,
        swapBaselineBytes,
      });
      // A late sample must not affect a stopped or already published attempt.
      if (finished || controller.signal.aborted || decision.admitted) return;
      const remaining =
        allowFinish && computeStartedAt !== null
          ? remainingMs(progress, this.now() - computeStartedAt)
          : null;
      if (!shouldCancel(decision, remaining)) return;
      const retryInMs = this.deferMemoryRetry(decision, [engine]);
      cancel.refusal = {
        reasons: decision.reasons.join(),
        fields: {
          ...refusalFields(decision.reasons, sample, swapBaselineBytes),
          ...(retryInMs === null ? {} : { retryInMs }),
        },
      };
      each.waitingFor = decision.reasons;
      each.waitingEpisodeId = job.episodeId;
      controller.abort();
    };
    let checking = false;
    const admissionTimer = setInterval(() => {
      if (checking || controller.signal.aborted) return;
      checking = true;
      void checkAdmission(true)
        .catch(() => undefined)
        .finally(() => {
          checking = false;
        });
    }, this.timing.admissionIntervalMs);
    // What may no longer leave stops within a second, whatever took it away.
    const stopSending = () => {
      if (!maySend()) controller.abort();
    };
    if (remote) this.stopSending = stopSending;
    const sendTimer = remote ? setInterval(stopSending, 1_000) : undefined;
    // An engine slow to honour the abort must not keep timers on a closing database.
    const stopTimers = () => {
      finished = true;
      clearInterval(pidTimer);
      clearInterval(rssTimer);
      clearInterval(admissionTimer);
      clearInterval(sendTimer);
    };
    controller.signal.addEventListener("abort", stopTimers, { once: true });

    try {
      const readAudio = this.deps.readAudio();
      if (readAudio === null) throw new AnalysisFailure("audio_reader_missing", "no audio reader");
      // A pass missing a request must not replace a published transcript:
      // checked before a cold load, and again as each request is read.
      const published = currentRunId(db, claim.episodeId, "asr") !== undefined;
      if (published && plans.some((plan) => assemble(readAudio, plan).missing >= plan.samples)) {
        throw audioGone();
      }
      let loadMs = 0;
      // Never for a trace: `tick` saw the engine ready, with no await before here.
      if (!remote && engine.state() === "absent") {
        this.publishStatus();
        if (engine === this.deps.engine()) this.tracesThisLoad = 0;
        loadMs = (await engine.load(controller.signal)).loadMs;
        controller.signal.throwIfAborted();
        if (this.timing.swapSettleMs > 0) {
          this.swapSettles.set(engine, this.now() + this.timing.swapSettleMs);
        }
        const swapUsedBytes = (await this.deps.signals.memory()).swapUsedBytes;
        if (swapUsedBytes === null) this.swapBaselines.delete(engine);
        else this.swapBaselines.set(engine, swapUsedBytes);
        log.info("analysis.loaded", {
          jobId: claim.jobId,
          engine: engine.manifest.id,
          loadMs,
          swapBaselineMb: megabytes(swapUsedBytes),
        });
        controller.signal.throwIfAborted();
        // Loading Nemotron spikes pressure to critical for a few seconds
        // (2026-11-05, 2026-11-07): wait for it to fall back before the
        // first check, rather than paying the load again.
        settling = true;
        try {
          const settleUntil = this.now() + this.timing.loadSettleMs;
          while (this.now() < settleUntil) {
            if ((await this.deps.signals.memory()).memoryPressure !== "critical") break;
            await new Promise((resolve) => setTimeout(resolve, this.timing.loadSettlePollMs));
            controller.signal.throwIfAborted();
          }
        } finally {
          settling = false;
        }
        await checkAdmission(false);
      }
      controller.signal.throwIfAborted();
      recordPid();
      clearInterval(pidTimer);
      computeStartedAt = this.now();

      const total = plans.reduce((sum, plan) => sum + plan.samples, 0);
      let done = 0;
      let missing = 0;
      let skipped = 0;
      // Written by the recursive `transcribe` below.
      const pass: {
        sent: number;
        splits: number;
        untimedSplits: number;
        untimedSilent: number;
        untimedRetries: number;
        computeMs: number;
        provenance: EngineProvenance | null;
      } = {
        sent: 0,
        splits: 0,
        untimedSplits: 0,
        untimedSilent: 0,
        untimedRetries: 0,
        computeMs: 0,
        provenance: null,
      };
      const segments: SegmentInput[] = [];
      const transcribed: RequestPlan[] = [];
      /** Transcribes a request, halving it while the model stops at its limit. */
      const transcribe = async (
        plan: RequestPlan,
        samples: Int16Array,
        offset: number,
        depth: number,
      ): Promise<void> => {
        controller.signal.throwIfAborted();
        pass.sent += 1;
        const split = depth < MAX_SPLIT_DEPTH ? splitRequest(plan) : null;
        const halves = async () => {
          if (split === null) return;
          const [first, second] = split.parts;
          await transcribe(first, samples.subarray(0, split.at), offset, depth + 1);
          await transcribe(second, samples.subarray(split.at), offset + split.at, depth + 1);
        };
        const send = (speakers: boolean) =>
          engine.transcribe(
            {
              id: `attempt-${claim.attemptId}-${pass.sent}`,
              samples,
              sampleRate: 16_000,
              speakers,
              timestamps: true,
            },
            {
              signal: controller.signal,
              ...(remote ? { maySend } : {}),
              onProgress: (fraction) => {
                progress = total === 0 ? null : (offset + fraction * plan.samples) / total;
                this.setProgress(each, progress);
              },
            },
          );
        let result: AsrResult;
        try {
          result = await send(!oneVoice);
        } catch (error) {
          if (!isUntimed(error) || controller.signal.aborted) throw error;
          // The model wrote text it could not time: its alignment found no
          // path through a long request (2026-11-18: three
          // attempts of 20 min lost on one 55 min request). Shorter halves
          // align; text without times is never published.
          if (split !== null) {
            pass.untimedSplits += 1;
            log.info("analysis.split", { jobId: claim.jobId, reason: "untimed", depth });
            await halves();
            return;
          }
          const speechMs = speechMsOf(plan);
          const fields = { jobId: claim.jobId, speechMs, audioMs: msIn(plan, plan.samples) };
          if (speechMs < UNTIMED_SILENT_SPEECH_MS) {
            // A noise too short for the text the model wrote: no speech, not a failure.
            pass.untimedSilent += 1;
            log.info("analysis.untimed", { ...fields, outcome: "silent" });
            transcribed.push(plan);
            return;
          }
          // The alignment is searched per voice; without voices it has the whole request.
          if (oneVoice) throw error;
          pass.untimedRetries += 1;
          pass.sent += 1;
          log.info("analysis.untimed", { ...fields, outcome: "retry-one-voice" });
          // Still untimed: it fails as `invalid_output`, without retry.
          result = oneSpeaker(await send(false));
        }
        pass.computeMs += result.metrics.computeMs;
        pass.provenance = result.provenance;
        if (result.stop === "model_limit") {
          // Truncated text is never published: each half goes again, on its own.
          if (split === null) {
            throw new AnalysisFailure(
              "model_limit",
              "a request reaches the model's limit even at the smallest split",
            );
          }
          pass.splits += 1;
          await halves();
          return;
        }
        segments.push(
          ...mapResult(plan, result, {
            wallMsAt: (trackRunId, sample) => wallMsAtSample(db, trackRunId, sample),
            oneVoice,
          }),
        );
        transcribed.push(plan);
      };
      // What an earlier attempt of this job finished on the same input stays.
      const earlier = this.carried.get(claim.jobId);
      const carried =
        earlier?.inputHash === inputHash && earlier.engine === engine
          ? earlier.requests
          : new Map<number, FinishedRequest>();
      this.carried.delete(claim.jobId);
      this.carried.set(claim.jobId, { inputHash, engine, requests: carried });
      // The oldest goes first: a few long recordings at most wait in memory.
      for (const jobId of this.carried.keys()) {
        if (this.carried.size <= MAX_CARRIED_JOBS) break;
        // Not the job the other loop runs.
        if (jobId !== this.away.running?.jobId && jobId !== this.here.running?.jobId) {
          this.carried.delete(jobId);
        }
      }
      for (const [index, plan] of plans.entries()) {
        controller.signal.throwIfAborted();
        const kept = carried.get(index);
        if (kept !== undefined) {
          segments.push(...kept.segments);
          transcribed.push(...kept.transcribed);
          missing += kept.missing;
          pass.computeMs += kept.computeMs;
          pass.provenance ??= kept.provenance;
          done += plan.samples;
          continue;
        }
        const audio = assemble(readAudio, plan);
        missing += audio.missing;
        if (audio.missing >= plan.samples) {
          // Publishing without this request would retire a fuller transcript.
          if (published) throw audioGone();
          // Nothing to hear: sending silence would only invite invented text.
          skipped += 1;
          done += plan.samples;
          continue;
        }
        const before = { segments: segments.length, transcribed: transcribed.length };
        const computeBefore = pass.computeMs;
        await transcribe(plan, audio.samples, done, 0);
        carried.set(index, {
          segments: segments.slice(before.segments),
          transcribed: transcribed.slice(before.transcribed),
          missing: audio.missing,
          computeMs: pass.computeMs - computeBefore,
          provenance: pass.provenance,
        });
        done += plan.samples;
      }

      if (total === 0 || skipped === plans.length) {
        throw new AnalysisFailure("audio_unavailable", "no audio left for this episode");
      }
      const audioMs = Math.round((total * 1000) / 16_000);
      const coverage = (total - missing) / total;
      // The mic heard what the Mac played (a call on its speakers): that text
      // is the other side's, already on its own track. What it heard of
      // Sondine's own playback around the user's words goes too (ADR 035).
      const tracks = echoTracks(transcribed);
      const echo = removeEcho(segments, {
        ...tracks,
        sampleRate: 16_000,
        known: selfEchoStretches(db, [...tracks.heard]),
      });
      // Turns come from what is left; pieces of one sentence would join again
      // over the echo between them, so its stretches are cut out after.
      const turns = cutTurns(
        deriveTurns(
          echo.segments,
          transcribed.flatMap((plan) => plan.extents),
        ),
        echo.spans,
      );
      // Deleted, put in a zone, or the choice taken back while its text was on its way.
      if (remote) stopSending();
      controller.signal.throwIfAborted();
      this.carried.delete(claim.jobId);
      if (!remote) this.memoryRefusals = 0;
      else {
        this.remotePauses = 0;
        if (!trace) {
          this.serverWarm = { engine, until: this.now() + this.timing.idleUnloadMs };
          this.tracesThisLoad = 0;
        }
      }
      this.publish(
        claim.episodeId,
        claim.inputGeneration,
        ref,
        echo.segments,
        turns,
        {
          coverage,
          metrics: {
            audioMs,
            coverage,
            loadMs,
            computeMs: pass.computeMs,
            rtf: audioMs === 0 ? null : pass.computeMs / audioMs,
            peakRssBytes: peakRssBytes === 0 ? null : peakRssBytes,
            requests: plans.length,
            skippedRequests: skipped,
            modelLimitSplits: pass.splits,
            untimedSplits: pass.untimedSplits,
            untimedSilent: pass.untimedSilent,
            untimedRetries: pass.untimedRetries,
            segments: echo.segments.length,
            echoWords: echo.echoWords,
          },
          modelSha256: pass.provenance?.modelSha256 ?? null,
          ...(pass.provenance === null ? {} : { engineConfig: pass.provenance.config }),
          nowMs: this.now(),
        },
        job.requested,
        remote,
      );
    } catch (error) {
      // Core is stopping: the attempt stays running and the next start recovers it.
      if (signal.aborted) return;
      const nowMs = this.now();
      const { refusal } = cancel;
      if (refusal !== null) {
        cancelAttempt(db, { ...ref, nowMs, reason: "admission" });
        log.info("analysis.cancelled", {
          jobId: claim.jobId,
          reason: "admission",
          ...refusal.fields,
        });
        if (!remote) await this.unload(engine, "admission", { reasons: refusal.reasons });
        return;
      }
      if (remote && isCancelled(error)) {
        // Deleted, cut, put in a zone or switched back to this Mac: the next look decides.
        const state = cancelAttempt(db, { ...ref, nowMs, reason: "not_sent" });
        if (state !== "queued") this.carried.delete(claim.jobId);
        log.info("analysis.cancelled", { jobId: claim.jobId, reason: "not-sent" });
        return;
      }
      const code =
        error instanceof EngineError || error instanceof AnalysisFailure ? error.code : "internal";
      const waits = remote ? REMOTE_WAITS.get(code) : undefined;
      if (waits !== undefined) {
        // The server's trouble is not the episode's: its attempts are not counted.
        const retryInMs = this.pauseRemote(engine, waits);
        cancelAttempt(db, { ...ref, nowMs, reason: code });
        this.deps.onFailed?.(code);
        each.waitingFor = [waits];
        each.waitingEpisodeId = job.episodeId;
        log.info("analysis.cancelled", { jobId: claim.jobId, reason: code, retryInMs });
        return;
      }
      // An engine's reason is a fixed code; its message could quote its output.
      const reason = error instanceof EngineError ? error.reason : undefined;
      // Untimed even at the smallest split: the same audio gives the same text, so
      // another attempt would only spend the model's time again.
      const retry = !finalFailures.has(code) && !isUntimed(error);
      const failed = failAttempt(db, {
        ...ref,
        nowMs,
        errorCode: code,
        errorMessage: reason ?? (error instanceof Error ? error.name : "error"),
        retry,
      });
      this.deps.onFailed?.(code);
      if (failed.jobState !== "queued") this.carried.delete(claim.jobId);
      // Our own failures say what happened; an engine's message could quote its output.
      const message =
        error instanceof AnalysisFailure
          ? error.message
          : error instanceof Error
            ? error.name
            : code;
      this.lastError = problem(`analysis.${code}`, message, nowMs);
      log.warn("analysis.failed", {
        jobId: claim.jobId,
        code,
        reason,
        jobState: failed.jobState,
        failures: failed.failures,
      });
      // A refused request or output leaves the worker healthy: it stays for the next job.
      if (
        engine.state() !== "absent" &&
        error instanceof EngineError &&
        !keptAfterFailure.has(error.code)
      ) {
        await this.unload(engine, "failure");
      }
    } finally {
      stopTimers();
      controller.signal.removeEventListener("abort", stopTimers);
      signal.removeEventListener("abort", forward);
      if (remote) this.stopSending = null;
      each.running = null;
      each.engine = null;
      if (!trace) this.lastWork.set(engine, this.now());
      if (!signal.aborted) {
        this.publishStatus();
        // What the job left may be the other loop's: a transcript to write the
        // journal from, or a job taken back from the server.
        this.wakeLane(each === this.here ? this.away : this.here);
      }
    }
  }

  /**
   * Publishes in one transaction with the job and attempt; a refusal rolls it
   * all back, then a second transaction discards the run and handles the
   * reason: a stale generation queues the job at the new one.
   */
  private publish(
    episodeId: number,
    inputGeneration: number,
    ref: Omit<AttemptRef, "nowMs">,
    segments: readonly SegmentInput[],
    turns: readonly TurnInput[],
    outcome: RunOutcome,
    requested: boolean,
    remote: boolean,
  ): void {
    const { db, log } = this.deps;
    const nowMs = outcome.nowMs;
    try {
      const published = transaction(db, () => {
        if ((remote || !requested) && episodesWithoutText(db, [episodeId], nowMs).has(episodeId)) {
          throw new PublishRefused("no_text");
        }
        recordRunOutcome(db, ref.runId, outcome);
        const result = publishAnalysis(db, {
          episodeId,
          stage: "asr",
          runId: ref.runId,
          inputGeneration,
          segments,
          turns,
          analysisState: "complete",
          nowMs,
        });
        if (!result.published) throw new PublishRefused(result.reason);
        succeedAttempt(db, { ...ref, nowMs });
        redecideSize(db, episodeId, { speakers: result.speakerCount, turns: turns.length }, nowMs);
        return result;
      });
      log.info("analysis.published", {
        jobId: ref.jobId,
        episodeId,
        segments: published.segmentCount,
        speakers: published.speakerCount,
        coverage: outcome.coverage,
        audioMs: outcome.metrics["audioMs"],
        computeMs: outcome.metrics["computeMs"],
        loadMs: outcome.metrics["loadMs"],
      });
      this.deps.onPublished?.(episodeId);
    } catch (error) {
      if (!(error instanceof PublishRefused)) throw error;
      transaction(db, () => {
        recordRunOutcome(db, ref.runId, outcome);
        discardRun(db, ref.runId, error.reason, nowMs);
        switch (error.reason) {
          case "stale_generation":
          case "episode_missing":
          case "run_missing":
          case "no_text":
            cancelAttempt(db, { ...ref, nowMs, reason: error.reason });
            return;
          default:
            failAttempt(db, { ...ref, nowMs, errorCode: error.reason, retry: true });
            this.deps.onFailed?.(error.reason);
        }
      });
      log.info("analysis.refused", { jobId: ref.jobId, reason: error.reason });
      if (error.reason !== "stale_generation" && error.reason !== "no_text") {
        this.lastError = problem(`analysis.${error.reason}`, "publication refused", nowMs);
      }
    }
  }

  /** `fields` say why, for an admission refusal. */
  private async unload(engine: ResidentEngine, reason: string, fields: Fields = {}): Promise<void> {
    try {
      await engine.unload();
      this.holding.delete(engine);
      this.forgetBaseline(engine);
      // The traces belong to the final engine's load.
      if (engine === this.deps.engine()) this.tracesThisLoad = 0;
      this.deps.log.info("analysis.unloaded", { reason, engine: engine.manifest.id, ...fields });
    } catch (error) {
      this.deps.log.warn("analysis.unload-failed", { reason, message: messageOf(error) });
    }
    this.publishStatus();
  }

  private setProgress(each: Lane, progress: number | null): void {
    if (each.running === null) return;
    const value = progress === null ? null : Math.min(1, Math.max(0, progress));
    const nowMs = this.now();
    const previous = each.running.progress;
    // Throttled: status changes reach every open window.
    if (
      value !== null &&
      previous !== null &&
      Math.abs(value - previous) < 0.01 &&
      nowMs - this.lastProgressAt < 1_000
    ) {
      return;
    }
    this.lastProgressAt = nowMs;
    each.running = { ...each.running, progress: value };
    this.publishStatus();
  }

  private publishStatus(): void {
    const now = this.now();
    // A server's job runs for minutes and a dictation for a second: the server's says more.
    const running = this.away.running ?? this.here.running;
    const { waitingFor, waitingEpisodeId } =
      this.away.waitingFor.length > 0 ? this.away : this.here;
    const retrying = waitingFor.includes("retry-later");
    const pause = this.remotePause;
    const remoteRetryAt =
      pause !== null && now < pause.until && waitingFor.includes(pause.reason) ? pause.until : null;
    const status: AnalysisStatus = {
      worker: (this.away.engine ?? this.here.engine ?? this.deps.engine())?.state() ?? "absent",
      queued: analysisQueueCounts(this.deps.db),
      running,
      waitingFor: [...waitingFor],
      waitingEpisodeId: waitingFor.length === 0 ? null : waitingEpisodeId,
      server: isRemote(this.deps.engine())
        ? {
            waitingFor: [...this.away.waitingFor],
            dictationsWaitingFor: [...this.here.waitingFor],
          }
        : null,
      requests: analysisRequests(this.deps.db, now),
      retryAtMs:
        remoteRetryAt ??
        (!retrying
          ? null
          : now < this.memoryRetryAt
            ? this.memoryRetryAt
            : nextRetryAtMs(this.deps.db, now)),
      lastError: this.lastError,
      models: [...(this.deps.models?.() ?? [])],
    };
    const key = JSON.stringify(status);
    if (key === this.lastStatus) return;
    try {
      this.deps.onStatus(status);
      this.lastStatus = key;
    } catch (error) {
      // The status is only shown: the queue goes on, and the next change publishes again.
      this.deps.log.warn("analysis.status-failed", { message: messageOf(error) });
    }
  }
}

/** One request an attempt finished: what it gave, kept for the job's next attempt. */
interface FinishedRequest {
  readonly segments: readonly SegmentInput[];
  readonly transcribed: readonly RequestPlan[];
  readonly missing: number;
  readonly computeMs: number;
  readonly provenance: EngineProvenance | null;
}

/** The engine is a compute server's (ADR 040). */
function isRemote(engine: AsrEngine | null): boolean {
  return engine?.capabilities.locality === "remote";
}

/** Stopped on purpose, by this Mac. */
function isCancelled(error: unknown): boolean {
  return (
    (error instanceof EngineError && error.code === "cancelled") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

/** A trace's automatic job; a user request on a trace is a request. */
function isTraceJob(job: RunnableJob): boolean {
  return analysisClassOfPriority(job.priority) === "trace";
}

/** The engine wrote text it could not time (speech.cpp's `untimed`). */
function isUntimed(error: unknown): boolean {
  return (
    error instanceof EngineError && error.code === "invalid_output" && error.reason === "untimed"
  );
}

/**
 * Speech under this, in a request the model cannot time and the split cannot
 * halve, is published as no speech. From 2026-11-08 to 2026-11-26 one Mac had
 * 101 episodes fail untimed; 86 of them held less than 1 s of speech (65 less
 * than 0.5 s), all traces: a noise the model wrote text over, likely more
 * than the frames of its one voice can hold. The live transcripts of the
 * seven that failed on the compute server found one 80 ms piece in all.
 */
export const UNTIMED_SILENT_SPEECH_MS = 1_000;

const msIn = (plan: RequestPlan, samples: number) => Math.round((samples * 1000) / plan.sampleRate);

/** The speech inside a request, without its roll. */
const speechMsOf = (plan: RequestPlan) =>
  msIn(
    plan,
    plan.speech.reduce((sum, span) => sum + span.sampleEnd - span.sampleStart, 0),
  );

/** A request sent again without voices: its text is one voice of the request. */
function oneSpeaker(result: AsrResult): AsrResult {
  return { ...result, segments: result.segments.map((segment) => ({ ...segment, speaker: 0 })) };
}

/** Loaded or loading: the engine holds its memory, or is taking it. */
function isWarm(state: EngineState): boolean {
  return state === "loading" || state === "ready" || state === "busy";
}

/** Why admission refused, for the log: the reasons and what the Mac reported. */
function refusalFields(
  reasons: readonly AnalysisWaitReason[],
  sample: SystemSample,
  swapBaselineBytes: number | null,
): Fields {
  return {
    reasons: reasons.join(),
    onBattery: sample.onBattery,
    thermalState: sample.thermalState,
    idleSeconds: sample.idleSeconds,
    locked: sample.locked,
    memoryPressure: sample.memoryPressure,
    swapUsedMb: megabytes(sample.swapUsedBytes),
    swapBaselineMb: megabytes(swapBaselineBytes),
  };
}

function megabytes(bytes: number | null): number | null {
  return bytes === null ? null : Math.round(bytes / 1024 ** 2);
}

/** A request's audio, extents back to back; missing samples are zero. */
function assemble(
  read: ReadTrackAudio,
  plan: RequestPlan,
): { samples: Int16Array; missing: number } {
  const samples = new Int16Array(plan.samples);
  let offset = 0;
  let missing = 0;
  for (const extent of plan.extents) {
    const audio = read(extent);
    const length = extent.sampleEnd - extent.sampleStart;
    if (audio.samples.length !== length) {
      throw new AnalysisFailure("audio_read", "the audio reader returned a wrong length");
    }
    samples.set(audio.samples, offset);
    for (const span of audio.missing) missing += span.sampleEnd - span.sampleStart;
    offset += length;
  }
  return { samples, missing };
}

function redecideSize(
  db: Database,
  episodeId: number,
  diarization: { readonly speakers: number; readonly turns: number },
  nowMs: number,
): void {
  const episode = loadEpisodeSizeInput(db, episodeId);
  if (episode === null || episode.state !== "closed") return;
  const decision = decideSize({
    context: episode.context ?? "in_person",
    voicedMs: episode.voicedMs,
    elapsedMs: Math.max(0, (episode.endedAtMs ?? episode.startedAtMs) - episode.startedAtMs),
    episodeOpen: false,
    diarization,
    ...(episode.size === null ? {} : { previous: episode.size }),
  });
  updateEpisodeSize(
    db,
    episodeId,
    {
      size: decision.size,
      sizeState: decision.provisional ? "provisional" : "final",
      kindInputs: kindInputsOf(decision),
      classifierVersion: SIZE_TABLE_VERSION,
    },
    nowMs,
  );
}

function hashPlans(generation: number, plans: readonly RequestPlan[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        generation,
        requests: plans.map((plan) => ({ trackKey: plan.trackKey, extents: plan.extents })),
      }),
    )
    .digest("hex");
}

function deadline(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms).unref());
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
