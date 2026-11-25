import {
  EnvelopeBuilder,
  type Envelope,
  type SameMomentDetector,
  type SameMomentVerdict,
} from "@sondine/engines";
import {
  loadAnalysisInput,
  nextSameMomentPair,
  pruneSameMoments,
  recordSameMoment,
  sameMomentPairKey,
  wallMsAtSample,
  type Database,
  type SameMomentPair,
  type SameMomentPairKey,
  type SameMomentResult,
} from "@sondine/db";
import { SAMPLE_RATE } from "@sondine/protocol";
import type { TrackSourceKind } from "@sondine/db";
import { planEpisodeTimeline } from "../audio/episode-wav";
import type { ReadTrackAudio } from "../audio/track-audio";

// The same meeting heard by the Mac and the phone (ADR 032, M5.7), in core:
// each pair the wall clocks propose is compared once per generation. Its
// audio is read where the episode's playback reads it (extents, deletions
// cut out, never cached) into a 10 ms energy envelope, a minute at a time
// with a turn of the event loop between, and only the envelope reaches the
// detector. Nothing of either recording is written.

/** Samples read per step: a minute, then core answers other work. */
const READ_STEP = 60 * SAMPLE_RATE;
/** A comparison that failed is tried again after this, three times longer each time, up to 6 h. */
export const SAME_MOMENT_RETRY_MS = 10 * 60_000;
const SAME_MOMENT_RETRY_MAX_MS = 6 * 3_600_000;

/** Core is closing: the comparison stops and stays to do. */
class Cancelled extends Error {
  override readonly name = "Cancelled";
}

/** What became of one pair. */
export type SameMomentOutcome =
  /** Compared: the verdict stored (linked or not). */
  | {
      readonly kind: "compared";
      readonly pair: SameMomentPair;
      readonly verdict: SameMomentVerdict | null;
    }
  /** Core closed during it: nothing stored, compared at the next start. */
  | { readonly kind: "cancelled"; readonly pair: SameMomentPair }
  /** It could not be compared (no reader, an error): nothing stored, tried again later. */
  | { readonly kind: "failed"; readonly pair: SameMomentPair; readonly retryAtMs: number };

export interface SameMomentWorkDeps {
  readonly db: Database;
  readonly reader: () => ReadTrackAudio | null;
  readonly detector: SameMomentDetector;
  readonly log: {
    info(event: string, fields?: Record<string, string | number | boolean | null>): void;
    warn(event: string, fields?: Record<string, string | number | boolean | null>): void;
  };
  readonly now?: () => number;
  /** Lets other work run between reads; a turn of the event loop by default. */
  readonly pause?: () => Promise<void>;
}

/** What one comparison cost, for the logs and the bench. */
export interface SameMomentCost {
  readonly audioSeconds: number;
  readonly readMs: number;
  readonly detectMs: number;
}

export class SameMomentWork {
  readonly #deps: SameMomentWorkDeps;
  #running: Promise<void> | null = null;
  #again = false;
  #closed = false;
  /** Pairs that failed, by their key, with their attempts and when to try again. */
  readonly #failures = new Map<
    string,
    { key: SameMomentPairKey; attempts: number; retryAtMs: number }
  >();

  constructor(deps: SameMomentWorkDeps) {
    this.#deps = deps;
  }

  /** Compares every pair waiting; a call while it runs makes it look again at the end. */
  wake(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#running !== null) {
      this.#again = true;
      return this.#running;
    }
    this.#running = (async () => {
      try {
        do {
          this.#again = false;
          pruneSameMoments(this.#deps.db);
          for (;;) {
            if (this.#closed) break;
            const outcome = await this.compareNext();
            // One pair at a time, until none waits or core closes.
            if (outcome === null || outcome.kind === "cancelled") break;
          }
        } while (this.#again && !this.#closed);
      } catch (error) {
        this.#deps.log.warn("same-moment.failed", {
          error: error instanceof Error ? error.name : "unknown",
        });
      } finally {
        this.#running = null;
      }
    })();
    return this.#running;
  }

  /** Stops the comparison running now at its next read; it stays to do. */
  close(): Promise<void> {
    this.#closed = true;
    return this.#running ?? Promise.resolve();
  }

  /**
   * Compares the next pair waiting and stores its verdict; null when none
   * waits. A comparison core's closing stopped stores nothing and stays to
   * do; one that failed stores nothing and waits before it is tried again.
   */
  async compareNext(): Promise<SameMomentOutcome | null> {
    const { db, detector, log } = this.#deps;
    const now = this.#deps.now ?? Date.now;
    const nowMs = now();
    const waiting = [...this.#failures.values()]
      .filter((failure) => failure.retryAtMs > nowMs)
      .map((failure) => failure.key);
    const pair = nextSameMomentPair(db, detector.id, waiting);
    if (pair === null) return null;
    const key = sameMomentPairKey(pair);
    const cost = { audioSeconds: 0, readMs: 0, detectMs: 0 };
    let verdict: SameMomentVerdict | null = null;
    let result: SameMomentResult;
    try {
      const read = this.#deps.reader();
      if (read === null) throw new Error("no audio reader");
      const startedAt = performance.now();
      const phone = await this.#envelope(read, pair.phone.episodeId, "phone");
      const mac = await this.#envelope(read, pair.mac.episodeId, "input");
      cost.readMs = Math.round(performance.now() - startedAt);
      if (phone === null || mac === null) {
        // Nothing left to hear (all of it deleted): a verdict, compared again if that changes.
        result = { linked: false, measure: { reason: "no-audio" } };
      } else {
        cost.audioSeconds = Math.round((phone.db.length + mac.db.length) / 100);
        const detectedAt = performance.now();
        verdict = detector.detect(phone, mac, {
          expectedOffsetMs: 0,
          toleranceMs: pair.searchMs,
        });
        cost.detectMs = Math.round(performance.now() - detectedAt);
        result = resultOf(verdict);
      }
    } catch (error) {
      if (error instanceof Cancelled) {
        log.info("same-moment.cancelled", {
          phoneEpisodeId: pair.phone.episodeId,
          macEpisodeId: pair.mac.episodeId,
        });
        return { kind: "cancelled", pair };
      }
      const id = JSON.stringify(key);
      const attempts = (this.#failures.get(id)?.attempts ?? 0) + 1;
      const retryAtMs =
        now() + Math.min(SAME_MOMENT_RETRY_MS * 3 ** (attempts - 1), SAME_MOMENT_RETRY_MAX_MS);
      this.#failures.set(id, { key, attempts, retryAtMs });
      log.warn("same-moment.failed", {
        phoneEpisodeId: pair.phone.episodeId,
        macEpisodeId: pair.mac.episodeId,
        error: error instanceof Error ? error.name : "unknown",
        attempts,
        retryInMs: retryAtMs - now(),
      });
      return { kind: "failed", pair, retryAtMs };
    }
    this.#failures.delete(JSON.stringify(key));
    const stored = recordSameMoment(db, {
      pair,
      method: detector.id,
      result,
      nowMs: now(),
    });
    log.info("same-moment.compared", {
      phoneEpisodeId: pair.phone.episodeId,
      macEpisodeId: pair.mac.episodeId,
      linked: result.linked,
      reason: verdict === null || verdict.linked ? null : verdict.reason,
      offsetMs: result.linked ? result.offsetMs : null,
      score: verdict === null ? null : Math.round(verdict.score * 100) / 100,
      peak: verdict === null ? null : Math.round(verdict.peak * 100) / 100,
      stored,
      ...cost,
    });
    return { kind: "compared", pair, verdict };
  }

  /** The episode's audio of `kind` tracks as a 10 ms envelope; null when it has none. */
  async #envelope(
    read: ReadTrackAudio,
    episodeId: number,
    kind: TrackSourceKind,
  ): Promise<Envelope | null> {
    const { db } = this.#deps;
    const input = loadAnalysisInput(db, episodeId);
    if (input === null) return null;
    const regions = input.regions.filter((region) => region.sourceKind === kind);
    if (regions.length === 0) return null;
    const timeline = planEpisodeTimeline({ ...input, regions }, (trackRunId, sample) =>
      wallMsAtSample(db, trackRunId, sample),
    );
    if (timeline.startedAtMs === null) return null;
    const builder = new EnvelopeBuilder(timeline.startedAtMs, timeline.samples);
    const pause = this.#deps.pause ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
    for (const extent of timeline.extents) {
      for (let from = extent.sampleStart; from < extent.sampleEnd; from += READ_STEP) {
        if (this.#closed) throw new Cancelled();
        const to = Math.min(from + READ_STEP, extent.sampleEnd);
        const audio = read({ trackRunId: extent.trackRunId, sampleStart: from, sampleEnd: to });
        builder.push(extent.offset + from - extent.sampleStart, audio.samples);
        await pause();
      }
    }
    if (this.#closed) throw new Cancelled();
    return builder.finish();
  }
}

function resultOf(verdict: SameMomentVerdict): SameMomentResult {
  const measure = {
    peak: round(verdict.peak),
    prominence: round(verdict.prominence),
    windows: verdict.windows,
    agreeing: verdict.agreeing,
    score: round(verdict.score),
  };
  if (!verdict.linked) return { linked: false, measure: { ...measure, reason: verdict.reason } };
  return {
    linked: true,
    offsetMs: verdict.offsetMs,
    driftPpm: verdict.driftPpm,
    anchorMs: verdict.anchorMs,
    score: round(verdict.score),
    sharedFromMs: verdict.sharedFromMs,
    sharedToMs: verdict.sharedToMs,
    clarity: verdict.clarity,
    measure: { ...measure, clarityPhone: verdict.clarity.phone, clarityMac: verdict.clarity.mac },
  };
}

const round = (value: number) => Math.round(value * 1000) / 1000;
