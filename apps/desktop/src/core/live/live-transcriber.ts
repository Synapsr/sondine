import type { LiveState } from "@sondine/api";
import { removeEcho } from "@sondine/core";
import {
  type AnalysisInput,
  currentRunId,
  type Database,
  episodesWithoutText,
  removeLiveText,
  findDeletedRanges,
  liveEnabled,
  loadAnalysisInput,
  loadOpenEpisodes,
  loadOpenRunClocks,
  publishLive,
  type SegmentInput,
  wallMsAtSample,
} from "@sondine/db";
import { EngineError, type AsrEngine } from "@sondine/engines";
import type { MemoryPressure } from "../analysis/admission";
import {
  cutTurns,
  deriveTurns,
  echoTracks,
  mapResult,
  openLiveTails,
  planLiveUnits,
  type LiveUnit,
  type RequestPlan,
} from "../analysis/requests";
import type { ReadTrackAudio } from "../audio/track-audio";

// Near-live text (architecture §10, ADR 019), when the user turns it on:
// every 2 s, the commit cadence, the finished speech of the episodes open in
// this session is transcribed by a small engine (Parakeet) and published as
// each episode's live run, replaced whole each time. Only on power, the Mac
// not hot and memory not critical; the final pass replaces the text later,
// on its own terms. Units are cached by their exact samples, so a sentence
// is sent once; a deletion anywhere throws the cache away, and work started
// before it is dropped. Never logs text or audio.

export interface LiveTiming {
  readonly tickMs: number;
  /** The worker exits this long after its last request. */
  readonly idleUnloadMs: number;
  /** Audio one tick sends at most, so a backlog never holds back new speech for long. */
  readonly budgetMs: number;
}

export const defaultLiveTiming: LiveTiming = {
  tickMs: 2_000,
  idleUnloadMs: 60_000,
  budgetMs: 120_000,
};

export interface LiveConditions {
  readonly onBattery: boolean | null;
  readonly thermalState: string | null;
  readonly memoryPressure: MemoryPressure | null;
}

type Fields = Readonly<Record<string, string | number | boolean | null | undefined>>;

export interface LiveDeps {
  readonly db: Database;
  /** The installed live engine; null while its model is not installed. */
  readonly engine: () => AsrEngine | null;
  readonly readAudio: () => ReadTrackAudio | null;
  readonly conditions: () => Promise<LiveConditions>;
  /** Grows with every deletion: work read before one is dropped. */
  readonly deletions: () => number;
  /** The final pass's recovery left a worker it could not stop: start none. */
  readonly blocked: () => boolean;
  readonly onState: (state: LiveState, revision: number) => void;
  readonly log: {
    info(event: string, fields?: Fields): void;
    warn(event: string, fields?: Fields): void;
  };
  readonly now?: () => number;
  readonly timing?: Partial<LiveTiming>;
}

const LIVE_REQUEST = "live";
/** A failed request is tried again after this long. */
const RETRY_MS = 30_000;
/** Ticks a closed run's unit waits for samples that may still be imported. */
const MAX_CLOSED_WAITS = 30;

export class LiveTranscriber {
  private readonly timing: LiveTiming;
  private readonly now: () => number;
  private readonly controller = new AbortController();
  private loop: Promise<void> | null = null;
  private wakeUp: (() => void) | null = null;
  /** The running tick's work: `wake` cancels it, so a switch-off stops a request. */
  private tickController: AbortController | null = null;
  /** After a failed request, none before this. */
  private retryAt = 0;
  /** A commit was imported while a tick ran. */
  private nudged = false;
  /** Episodes open at some point in this session, until their last live publish. */
  private readonly tracked = new Set<number>();
  /** Each unit's segments, by `LiveUnit.key`. */
  private readonly cache = new Map<string, readonly SegmentInput[]>();
  /** Ticks a unit waited for samples not imported yet. */
  private readonly waits = new Map<string, number>();
  /** Units of closed runs whose samples never came: the final pass has them. */
  private readonly skipped = new Set<string>();
  /** What each episode's current live run was made from. */
  private readonly published = new Map<number, string>();
  /** Each open episode's sentence being said, in memory only: replaced at each commit. */
  private readonly partials = new Map<
    number,
    { readonly key: string; readonly text: string; readonly atMs: number }
  >();
  private epoch: number;
  private lastRequestAt = 0;
  private requests = 0;
  private state: LiveState = "off";
  private revision = 0;

  constructor(private readonly deps: LiveDeps) {
    this.timing = { ...defaultLiveTiming, ...deps.timing };
    this.now = deps.now ?? Date.now;
    this.epoch = deps.deletions();
  }

  start(): void {
    this.loop ??= this.run(this.controller.signal).catch((error: unknown) => {
      this.deps.log.warn("live.loop-failed", { message: messageOf(error) });
    });
  }

  async stop(): Promise<void> {
    this.controller.abort();
    this.wake();
    await this.loop;
    await this.deps
      .engine()
      ?.unload()
      .catch(() => undefined);
  }

  /** New audio was imported: the next tick runs now, the running one goes on. */
  nudge(): void {
    const resolve = this.wakeUp;
    this.wakeUp = null;
    // Mid-tick, the loop starts the next one at once instead of waiting.
    if (resolve === null) this.nudged = true;
    resolve?.();
  }

  /** Something was deleted: what was read goes now, and the running request stops. */
  deleted(): void {
    this.forget(this.deps.deletions());
    this.wake();
  }

  /** The setting, a model or the Mac changed: the running request stops, and the next tick looks now. */
  wake(): void {
    this.tickController?.abort();
    const resolve = this.wakeUp;
    this.wakeUp = null;
    resolve?.();
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.tick(signal);
      } catch (error) {
        if (signal.aborted) return;
        this.deps.log.warn("live.tick-failed", { message: messageOf(error) });
      }
      if (this.nudged) {
        this.nudged = false;
        continue;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, this.timing.tickMs);
        function done() {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        }
        this.wakeUp = done;
        signal.addEventListener("abort", done, { once: true });
      });
    }
  }

  /** One look at the open episodes, as the loop runs it; for tests. */
  async tickOnce(): Promise<void> {
    await this.tick(this.controller.signal);
  }

  private async tick(stop: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    stop.addEventListener("abort", cancel, { once: true });
    this.tickController = controller;
    try {
      await this.pass(controller.signal);
    } finally {
      stop.removeEventListener("abort", cancel);
      if (this.tickController === controller) this.tickController = null;
    }
  }

  private async pass(signal: AbortSignal): Promise<void> {
    const { db } = this.deps;
    // A deletion first, whatever else: nothing read before it is kept, paused or not.
    const epoch = this.deps.deletions();
    if (epoch !== this.epoch) this.forget(epoch);
    const engine = this.deps.engine();
    const readAudio = this.deps.readAudio();
    const refused = await this.refusal(engine, readAudio);
    if (refused !== null || engine === null || readAudio === null) {
      await this.rest(engine, refused ?? "no-model");
      return;
    }

    for (const episode of loadOpenEpisodes(db)) this.tracked.add(episode.id);
    const watermarks = new Map<number, number>();
    for (const clock of loadOpenRunClocks(db)) {
      const chunk = clock.lastChunk;
      watermarks.set(clock.trackRunId, chunk === null ? 0 : chunk.sampleStart + chunk.sampleCount);
    }

    let budget = this.timing.budgetMs;
    let worked = false;
    /** Open episodes, newest first: their sentence being said goes after every finished one. */
    const following: number[] = [];
    const kept = new Set<string>();
    // Newest first, so a backlog never holds back what is being said now.
    for (const episodeId of [...this.tracked].toSorted((a, b) => b - a)) {
      if (signal.aborted) return;
      const input = loadAnalysisInput(db, episodeId);
      // Gone, or the final transcript is out: nothing live to add.
      if (input === null || currentRunId(db, episodeId, "asr") !== undefined) {
        this.drop(episodeId);
        continue;
      }
      // A private zone keeps its text from being made (ADR 029): what was said live goes too.
      if (this.withoutText(episodeId)) {
        this.drop(episodeId);
        continue;
      }
      const units = planLiveUnits(input);
      for (const unit of units) kept.add(unit.key);
      const ready = units.filter((unit) => isReady(unit, input, watermarks));
      for (const unit of ready.toSorted((a, b) => b.sampleStart - a.sampleStart)) {
        if (this.cache.has(unit.key) || this.skipped.has(unit.key)) continue;
        if (budget <= 0 || this.now() < this.retryAt) continue;
        // Turned off, unplugged or hot since the tick began: stop before the next request.
        if (signal.aborted || (await this.refusal(engine, readAudio)) !== null) return;
        const closed = runClosed(unit, input);
        const segments = await this.transcribe(engine, readAudio, unit, closed, signal);
        if (segments !== null) worked = true;
        budget -= ((unit.sampleEnd - unit.sampleStart) * 1000) / unit.sampleRate;
        // A deletion since the audio was read: nothing read before it is kept.
        if (this.deps.deletions() !== epoch) {
          this.forget(this.deps.deletions());
          return;
        }
        if (signal.aborted) return;
        if (segments !== null) this.cache.set(unit.key, segments);
      }
      const outcome = this.publish(input, ready);
      if (input.state === "open") following.push(episodeId);
      else this.partials.delete(episodeId);
      if (
        input.state !== "open" &&
        outcome !== "retry" &&
        units.every((unit) => this.cache.has(unit.key) || this.skipped.has(unit.key))
      ) {
        // Its last live text is out: the final pass takes it from here.
        this.drop(episodeId);
      }
    }
    for (const episodeId of following) {
      if (budget <= 0) break;
      budget -= await this.follow(engine, readAudio, episodeId, watermarks, signal);
      if (this.deps.deletions() !== epoch) {
        this.forget(this.deps.deletions());
        return;
      }
    }
    for (const key of this.cache.keys()) if (!kept.has(key)) this.cache.delete(key);
    for (const key of this.waits.keys()) if (!kept.has(key)) this.waits.delete(key);
    for (const key of this.skipped) if (!kept.has(key)) this.skipped.delete(key);
    if (
      !worked &&
      engine.state() !== "absent" &&
      this.now() - this.lastRequestAt >= this.timing.idleUnloadMs
    ) {
      await engine.unload().catch(() => undefined);
    }
    this.setState("ready");
  }

  /** The sentence an open episode is hearing now, as far as it is imported; null when none. */
  partial(episodeId: number): { readonly text: string; readonly atMs: number } | null {
    const partial = this.partials.get(episodeId);
    return partial === undefined ? null : { text: partial.text, atMs: partial.atMs };
  }

  /**
   * Transcribes again the sentence still being said, the newest of the
   * episode's open ones, when more of it was imported: the line that follows
   * the voice until the sentence ends and its unit publishes. Returns the
   * audio sent, in ms. Kept only if the episode still hears that sentence
   * afterwards, with nothing deleted in it and no final transcript.
   */
  private async follow(
    engine: AsrEngine,
    readAudio: ReadTrackAudio,
    episodeId: number,
    watermarks: ReadonlyMap<number, number>,
    signal: AbortSignal,
  ): Promise<number> {
    const { db } = this.deps;
    const newest = this.newestTail(episodeId, watermarks);
    if (newest === null) {
      this.partials.delete(episodeId);
      return 0;
    }
    if (this.partials.get(episodeId)?.key === newest.key || this.now() < this.retryAt) return 0;
    if (signal.aborted || (await this.refusal(engine, readAudio)) !== null) return 0;
    const segments = await this.transcribe(engine, readAudio, newest, false, signal);
    const sentMs = ((newest.sampleEnd - newest.sampleStart) * 1000) / newest.sampleRate;
    if (segments === null || signal.aborted) return sentMs;
    // The sentence may have ended, the episode gone or been transcribed meanwhile.
    const still = this.newestTail(episodeId, watermarks);
    if (
      still?.trackRunId !== newest.trackRunId ||
      still.sampleStart !== newest.sampleStart ||
      currentRunId(db, episodeId, "asr") !== undefined
    ) {
      this.partials.delete(episodeId);
      return sentMs;
    }
    const text = segments
      .map((segment) => segment.text)
      .join(" ")
      .trim();
    this.partials.set(episodeId, { key: newest.key, text, atMs: this.now() });
    return sentMs;
  }

  /** The open episode's newest sentence being said, if it holds no deleted speech. */
  private newestTail(episodeId: number, watermarks: ReadonlyMap<number, number>): LiveUnit | null {
    const { db } = this.deps;
    const input = loadAnalysisInput(db, episodeId);
    if (input === null || input.state !== "open") return null;
    const newest = openLiveTails(input, watermarks)
      .map((tail) => ({ tail, endMs: wallMsAtSample(db, tail.trackRunId, tail.sampleEnd) }))
      .toSorted((a, b) => b.endMs - a.endMs)[0]?.tail;
    if (newest === undefined) return null;
    // The analysis input looks for tombstones near an open region's start only: look over all of it.
    const deleted = findDeletedRanges(db, {
      trackRunId: newest.trackRunId,
      sampleStart: newest.sampleStart,
      sampleEnd: newest.sampleEnd,
      wallStartMs: wallMsAtSample(db, newest.trackRunId, newest.sampleStart),
      wallEndMs: wallMsAtSample(db, newest.trackRunId, newest.sampleEnd),
    });
    return deleted.length === 0 ? newest : null;
  }

  /** Why live text cannot run now, or null. */
  private async refusal(
    engine: AsrEngine | null,
    readAudio: ReadTrackAudio | null,
  ): Promise<LiveState | null> {
    if (!liveEnabled(this.deps.db)) return "off";
    if (engine === null || readAudio === null) return "no-model";
    if (this.deps.blocked()) return "blocked";
    const conditions = await this.deps.conditions();
    if (conditions.onBattery !== false) return "on-battery";
    if (conditions.thermalState !== "nominal" && conditions.thermalState !== "fair") return "hot";
    if (conditions.memoryPressure !== "normal" && conditions.memoryPressure !== "warn") {
      return "memory";
    }
    return null;
  }

  /** Not running: the worker goes at once, and the episodes are looked at afresh later. */
  private async rest(engine: AsrEngine | null, state: LiveState): Promise<void> {
    this.partials.clear();
    if (engine !== null && engine.state() !== "absent")
      await engine.unload().catch(() => undefined);
    this.setState(state);
  }

  /** A unit's text; null when it must be tried again (audio still coming, a failed request). */
  private async transcribe(
    engine: AsrEngine,
    readAudio: ReadTrackAudio,
    unit: LiveUnit,
    closed: boolean,
    signal: AbortSignal,
  ): Promise<readonly SegmentInput[] | null> {
    const audio = readAudio(unit);
    // Samples no chunk holds yet may still be imported (a closed run's too, by
    // a later reconciliation): wait, a minute at most once the run closed,
    // then leave the unit to the final pass. Gaps, deletions and expired audio
    // are final.
    if (audio.missing.some((span) => span.reason === "unrecorded")) {
      const waited = (this.waits.get(unit.key) ?? 0) + 1;
      this.waits.set(unit.key, waited);
      if (closed && waited >= MAX_CLOSED_WAITS) this.skipped.add(unit.key);
      return null;
    }
    this.waits.delete(unit.key);
    const silent = audio.missing.reduce((sum, span) => sum + span.sampleEnd - span.sampleStart, 0);
    if (silent >= unit.sampleEnd - unit.sampleStart) return [];
    this.requests += 1;
    this.lastRequestAt = this.now();
    try {
      const result = await engine.transcribe(
        {
          id: `live-${this.requests}`,
          samples: audio.samples,
          sampleRate: 16_000,
          speakers: false,
          timestamps: true,
        },
        { signal },
      );
      const label = `${unit.trackKey}/${LIVE_REQUEST}/1`;
      return mapResult(planOf(unit), result, {
        wallMsAt: (trackRunId, sample) => wallMsAtSample(this.deps.db, trackRunId, sample),
      }).map((segment) => ({ ...segment, speakerLabel: label }));
    } catch (error) {
      if (!(error instanceof EngineError)) throw error;
      // Cancelled by a switch-off: tried again once live text runs. Failed: after a pause.
      if (error.code !== "cancelled") {
        this.deps.log.warn("live.request-failed", { code: error.code });
        this.retryAt = this.now() + RETRY_MS;
      }
      return null;
    }
  }

  /**
   * Publishes the episode's live run when its finished units changed:
   * `retry` when it must be published again (a region joined, deleted
   * speech in it), `done` otherwise.
   */
  /** A zone keeps the episode from having text: drops its live text and says so. */
  private withoutText(episodeId: number): boolean {
    if (!episodesWithoutText(this.deps.db, [episodeId], this.now()).has(episodeId)) return false;
    if (removeLiveText(this.deps.db, episodeId)) {
      this.deps.log.info("live.removed", { episodeId, reason: "zone" });
      this.revision += 1;
      this.deps.onState(this.state, this.revision);
    }
    return true;
  }

  private publish(input: AnalysisInput, ready: readonly LiveUnit[]): "done" | "retry" {
    // Checked again after the engine's answer: a zone may have come on meanwhile.
    if (this.withoutText(input.episodeId)) {
      this.drop(input.episodeId);
      return "done";
    }
    const included = ready.filter((unit) => this.cache.has(unit.key));
    if (included.length === 0) return "done";
    const keys = included.map((unit) => unit.key).toSorted();
    const signature = `${input.inputGeneration}|${keys.join(",")}`;
    if (this.published.get(input.episodeId) === signature) return "done";
    const segments = included.flatMap((unit) => this.cache.get(unit.key) ?? []);
    const plans = included.map(planOf);
    // Played sound comes back on the mic: recomputed from every unit's raw text each time.
    const echo = removeEcho(segments, { ...echoTracks(plans), sampleRate: 16_000 });
    const turns = cutTurns(deriveTurns(echo.segments, included), echo.spans);
    const engine = this.deps.engine();
    if (engine === null) return "retry";
    const result = publishLive(this.deps.db, {
      episodeId: input.episodeId,
      inputGeneration: input.inputGeneration,
      engine: {
        engineId: engine.manifest.id,
        engineVersion: engine.manifest.version,
        engineRuntime: engine.manifest.runtime,
        adapterClass: engine.manifest.adapterClass,
        modelSha256: null,
      },
      inputHash: keys.join(","),
      segments: echo.segments,
      turns,
      nowMs: this.now(),
    });
    if (result.published) {
      this.deps.log.info("live.published", {
        episodeId: input.episodeId,
        units: included.length,
        segments: result.segmentCount,
      });
      this.published.set(input.episodeId, signature);
      this.revision += 1;
      this.deps.onState(this.state, this.revision);
      return "done";
    }
    switch (result.reason) {
      case "final_exists":
      case "episode_missing":
        this.drop(input.episodeId);
        return "done";
      case "deleted_range":
        // Its units are read again, without what was deleted.
        for (const unit of included) this.cache.delete(unit.key);
        return "retry";
      default:
        // A region joined meanwhile, or the episode was split: the next tick reads it again.
        return "retry";
    }
  }

  private drop(episodeId: number): void {
    this.tracked.delete(episodeId);
    this.published.delete(episodeId);
    this.partials.delete(episodeId);
  }

  private forget(epoch: number): void {
    this.epoch = epoch;
    this.cache.clear();
    this.published.clear();
    this.waits.clear();
    this.skipped.clear();
    this.partials.clear();
  }

  private setState(state: LiveState): void {
    if (state === this.state) return;
    this.deps.log.info("live.state", { state });
    this.state = state;
    this.deps.onState(state, this.revision);
  }
}

function runClosed(unit: LiveUnit, input: AnalysisInput): boolean {
  return input.regions.some(
    (region) => region.trackRunId === unit.trackRunId && region.runState === "closed",
  );
}

/** A unit can go once its samples are imported: its run is closed, or past its end. */
function isReady(
  unit: LiveUnit,
  input: AnalysisInput,
  watermarks: ReadonlyMap<number, number>,
): boolean {
  return runClosed(unit, input) || (watermarks.get(unit.trackRunId) ?? 0) >= unit.sampleEnd;
}

function planOf(unit: LiveUnit): RequestPlan {
  const extent = {
    trackRunId: unit.trackRunId,
    sampleStart: unit.sampleStart,
    sampleEnd: unit.sampleEnd,
  };
  return {
    trackKey: unit.trackKey,
    index: 1,
    name: LIVE_REQUEST,
    sampleRate: unit.sampleRate,
    extents: [extent],
    speech: [extent],
    samples: unit.sampleEnd - unit.sampleStart,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
