import { homedir } from "node:os";
import type { AnalysisCheck, PowerStatus } from "@sondine/api";
import type { WaitFor } from "@sondine/db";
import {
  createNemotronEngine,
  createParakeetEngine,
  NEMOTRON_ARTIFACT,
  PARAKEET_ARTIFACT,
  shareEngine,
  type AsrEngine,
} from "@sondine/engines";
import { usageError } from "@sondine/protocol";
import { Context, Effect, Layer, Stream, SubscriptionRef } from "effect";
import { createTrackAudioReader } from "../audio/read-track-audio";
import type { ReadTrackAudio } from "../audio/track-audio";
import { Compute } from "../compute/compute-layer";
import { CoreConfig } from "../config";
import { Database } from "../database";
import { log } from "../log";
import { MainChannel } from "../main-channel";
import { dictationTexts } from "../dictation/dictation-text";
import { Journal } from "../journal/journal-layer";
import { Models } from "../models/models-layer";
import { CoreState } from "../status/core-state";
import { AnalysisScheduler, type AnalysisRequestOutcome, type SchedulerTiming } from "./scheduler";
import { createSystemSignals, type IdleState, type SystemSignalsPort } from "./system-signals";
import { workerProcessTools, type WorkerProcessTools } from "./worker-process";
import { UsageStatistics } from "../usage/usage-layer";

/**
 * The installed ASR engine, or null while no model is installed (the status
 * then says `no-model`): `nemotronEngineLayer` in the app, a fake in tests.
 */
export class EngineProvider extends Context.Service<
  EngineProvider,
  {
    readonly current: () => AsrEngine | null;
    /** This Mac's engine, also while a compute server takes its place. */
    readonly local?: () => AsrEngine | null;
  }
>()("sondine/core/EngineProvider") {}

/**
 * The compute server the user chose (ADR 040), or the reference engine of
 * this Mac (ADR 016): that one once Models has verified its weights (at
 * launch, or after an import or a download) and the speech binary exists.
 * Until then the queue waits with `no-model`. One engine per verified file:
 * a model that becomes ready while core runs is used at once.
 */
export const nemotronEngineLayer = Layer.effect(
  EngineProvider,
  Effect.gen(function* () {
    const config = yield* CoreConfig;
    const models = yield* Models;
    const compute = yield* Compute;
    const speechBinary = config.speechBinary;
    let engine: { readonly path: string; readonly engine: AsrEngine } | null = null;
    const local = () => {
      if (speechBinary === null) return null;
      const installed = models.installed(NEMOTRON_ARTIFACT.artifactId);
      // Models never forgets a verified file while core runs.
      if (installed === null) return engine?.engine ?? null;
      if (engine?.path !== installed.path) {
        engine = {
          path: installed.path,
          engine: createNemotronEngine({ speechBinary, artifact: installed }),
        };
      }
      return engine.engine;
    };
    return EngineProvider.of({ current: () => compute.engine() ?? local(), local });
  }),
);

/**
 * Parakeet, one worker for two users: near-live text (ADR 019) and the
 * dictations' final pass (ADR 020), each through its own handle that waits
 * its turn (`shareEngine`). Null until Models has verified its weights.
 */
export class ParakeetEngineProvider extends Context.Service<
  ParakeetEngineProvider,
  {
    readonly live: () => AsrEngine | null;
    readonly dictation: () => AsrEngine | null;
  }
>()("sondine/core/ParakeetEngineProvider") {}

export const parakeetEngineLayer = Layer.effect(
  ParakeetEngineProvider,
  Effect.gen(function* () {
    const config = yield* CoreConfig;
    const models = yield* Models;
    const speechBinary = config.speechBinary;
    let shared: { readonly path: string; readonly handles: readonly AsrEngine[] } | null = null;
    const handle = (index: number): AsrEngine | null => {
      if (speechBinary === null) return null;
      const installed = models.installed(PARAKEET_ARTIFACT.artifactId);
      if (installed === null) return shared?.handles[index] ?? null;
      if (shared?.path !== installed.path) {
        const engine = createParakeetEngine({ speechBinary, artifact: installed });
        shared = { path: installed.path, handles: shareEngine(engine, 2) };
      }
      return shared.handles[index] ?? null;
    };
    return ParakeetEngineProvider.of({ live: () => handle(0), dictation: () => handle(1) });
  }),
);

/** Reads track audio back from the spool or the archive (ADR 016); tests synthesize it. */
export class TrackAudioSource extends Context.Service<
  TrackAudioSource,
  { readonly reader: () => ReadTrackAudio | null }
>()("sondine/core/TrackAudioSource") {}

/** The spool and archive reader of core's data directory. */
export const trackAudioLayer = Layer.effect(
  TrackAudioSource,
  Effect.gen(function* () {
    const db = yield* Database;
    const config = yield* CoreConfig;
    const reader = createTrackAudioReader(db, config.dataDir);
    return TrackAudioSource.of({ reader: () => reader });
  }),
);

export interface SystemSignalsService extends SystemSignalsPort {
  /** Main's answer to `idle-query`. */
  receiveIdle(state: IdleState): void;
}

export class SystemSignals extends Context.Service<SystemSignals, SystemSignalsService>()(
  "sondine/core/SystemSignals",
) {}

/** Power and thermal state from core's status (main's power events), idle from main, memory from sysctl. */
export const systemSignalsLayer = Layer.effect(
  SystemSignals,
  Effect.gen(function* () {
    const state = yield* CoreState;
    const main = yield* MainChannel;
    let power: PowerStatus = (yield* SubscriptionRef.get(state.status)).power;
    let known = () => undefined as void;
    const powerKnown = new Promise<void>((resolve) => {
      known = resolve;
    });
    // Main's snapshots always say on battery or not: null is before the first.
    if (power.onBattery !== null) known();
    yield* SubscriptionRef.changes(state.status).pipe(
      Stream.runForEach((status) =>
        Effect.sync(() => {
          power = status.power;
          if (power.onBattery !== null) known();
        }),
      ),
      Effect.forkScoped,
    );
    const signals = createSystemSignals({
      power: () => power,
      powerKnown,
      queryIdle: () => main.post({ type: "idle-query" }),
    });
    return SystemSignals.of(signals);
  }),
);

export interface AnalysisQueueService {
  /** A user request for one episode; null when the episode does not exist. */
  request(episodeId: number): { outcome: AnalysisRequestOutcome; jobId: number | null } | null;
  /** New or changed jobs: the scheduler looks at the queue now. */
  wake(): void;
  /** What an automatic job would wait for now. */
  check(): Promise<AnalysisCheck>;
  /** Recovery left a speech worker it could not stop: no worker starts until the next launch. */
  blocked(): boolean;
  /** Turns a condition of automatic jobs on or off, and looks at the queue now. */
  setWaitFor(condition: keyof WaitFor, wait: boolean): WaitFor;
  /** Takes the past dictations an app still keeps the text of, once per app (ADR 020). */
  takePastDictations(): void;
  /** Called after each transcript is published, with its episode. */
  onPublished(listener: (episodeId: number) => void): void;
}

export class AnalysisQueue extends Context.Service<AnalysisQueue, AnalysisQueueService>()(
  "sondine/core/AnalysisQueue",
) {}

export interface AnalysisOptions {
  readonly timing?: Partial<SchedulerTiming>;
  readonly processes?: WorkerProcessTools;
  readonly now?: () => number;
  /** The home folder whose dictation apps' histories are read; null reads none. */
  readonly dictationHome?: string | null;
}

/**
 * Recovers interrupted jobs (before any worker), then runs the queue until
 * the runtime closes; closing stops the loop and unloads the worker.
 */
export const analysisQueueLayer = (options: AnalysisOptions = {}) =>
  Layer.effect(
    AnalysisQueue,
    Effect.gen(function* () {
      const db = yield* Database;
      const state = yield* CoreState;
      const engines = yield* EngineProvider;
      const parakeet = yield* ParakeetEngineProvider;
      const audio = yield* TrackAudioSource;
      const signals = yield* SystemSignals;
      const config = yield* CoreConfig;
      const models = yield* Models;
      const journal = yield* Journal;
      const compute = yield* Compute;
      const usage = yield* UsageStatistics;
      const published = new Set<(episodeId: number) => void>();
      const home = options.dictationHome === undefined ? homedir() : options.dictationHome;
      const texts = home === null ? null : dictationTexts(db, home);
      const scheduler = new AnalysisScheduler({
        db,
        engine: engines.current,
        ...(engines.local === undefined ? {} : { idleEngine: engines.local }),
        dictationEngine: parakeet.dictation,
        dictated: (input) => texts?.of(input) ?? null,
        models: () => models.installedModels(),
        readAudio: audio.reader,
        signals,
        processes: options.processes ?? workerProcessTools(config.speechBinary),
        onStatus: (analysis) =>
          state.publish((status, nowMs) => ({ ...status, analysis, updatedAtMs: nowMs })),
        onPublished: (episodeId) => {
          for (const listener of published) listener(episodeId);
        },
        onFailed: (code) => usage.error(usageError("transcription", code)),
        log,
        journal: journal.work,
        textProcesses: { stopAll: () => journal.stopServers() },
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.timing === undefined ? {} : { timing: options.timing }),
      });
      yield* Effect.promise(() => scheduler.recover());
      // A model installed while core runs: look at the queue now, not at the next poll.
      models.onInstalled(() => scheduler.wake());
      // Another place to transcribe: the queue looks now, and what was leaving stops.
      compute.onChanged(() => scheduler.placeChanged());
      // A place that paid, or got its hours back: what waited for the server goes now.
      compute.onHoursLeft(() => scheduler.hoursLeft());
      scheduler.start();
      let closing = false;
      const takePastDictations = async () => {
        if (texts === null) return;
        try {
          const taken = await texts.takePast(
            (options.now ?? Date.now)(),
            (input, text) => scheduler.publishPastDictation(input, text),
            () => closing,
          );
          if (taken > 0) log.info("dictation.past-taken", { count: taken });
          if (!closing) scheduler.wake();
        } catch (error) {
          if (!closing)
            log.warn("dictation.past-failed", {
              name: error instanceof Error ? error.name : "error",
            });
        }
      };
      void takePastDictations();
      yield* Effect.addFinalizer(() => {
        closing = true;
        return Effect.promise(() => scheduler.stop());
      });
      return AnalysisQueue.of({
        request: (episodeId) => scheduler.request(episodeId),
        wake: () => scheduler.wake(),
        check: () => scheduler.check(),
        blocked: () => scheduler.isBlocked(),
        setWaitFor: (condition, wait) => scheduler.setWaitFor(condition, wait),
        takePastDictations: () => void takePastDictations(),
        onPublished: (listener) => {
          published.add(listener);
        },
      });
    }),
  );
