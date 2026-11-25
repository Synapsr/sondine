import {
  ENVELOPE_FRAME_MS,
  EnvelopeBuilder,
  SELF_ECHO_THRESHOLDS,
  type SelfEchoDetector,
  type SelfEchoVerdict,
} from "@sondine/engines";
import { recordSelfEcho, regionsToJudge, type Database, type RegionToJudge } from "@sondine/db";
import type { ReadTrackAudio } from "../audio/track-audio";
import { SELF_REFERENCE_RETENTION_MS, type SelfReference } from "./self-reference";

// Sondine's own sound (ADR 035), in core: each closed mic region heard
// during a playback on the speakers is judged once against the private
// `self:playback` reference, as soon as the reference reaches past its end.
// Its audio is read where playback reads it, with a few seconds around it
// for the lag, into a 10 ms energy envelope; only the envelopes reach the
// detector, and only the verdict is stored. Until then, and when the
// reference never came, the region stays out of every episode (ADR 020).

/** Seconds of microphone around a region the detector may use to find the lag. */
const CONTEXT_MS = 5_000;
/** The reference must reach this far past a region's end (it comes about once a second). */
const REFERENCE_MARGIN_MS = 500;
/** Past a playback's end, or a region's, by this long, the reference had its chance. */
const GIVE_UP_AFTER_MS = 10_000;

export interface SelfEchoWorkDeps {
  readonly db: Database;
  readonly reader: () => ReadTrackAudio | null;
  readonly reference: SelfReference;
  readonly detector: SelfEchoDetector;
  readonly log: {
    info(event: string, fields?: Record<string, string | number | boolean | null>): void;
    warn(event: string, fields?: Record<string, string | number | boolean | null>): void;
  };
  readonly now?: () => number;
}

export interface SelfEchoRun {
  /** Regions judged now, with their verdicts. */
  readonly judged: readonly { readonly regionId: number; readonly verdict: SelfEchoVerdict }[];
  /** Regions still waiting for the reference. */
  readonly waiting: number;
  /** CPU of the judgements (read, envelope, detection), ms. */
  readonly costMs: number;
}

export class SelfEchoWork {
  readonly #deps: SelfEchoWorkDeps;

  constructor(deps: SelfEchoWorkDeps) {
    this.#deps = deps;
  }

  /** Judges every region it can now. */
  run(): SelfEchoRun {
    const now = (this.#deps.now ?? Date.now)();
    const read = this.#deps.reader();
    if (read === null) return { judged: [], waiting: 0, costMs: 0 };
    const judged: { regionId: number; verdict: SelfEchoVerdict }[] = [];
    let waiting = 0;
    const started = performance.now();
    for (const region of regionsToJudge(this.#deps.db, now - SELF_REFERENCE_RETENTION_MS)) {
      const endMs = region.continuousEndUs / 1000;
      const latest = this.#deps.reference.latestMs;
      const arrived = latest !== null && latest >= endMs + REFERENCE_MARGIN_MS;
      const over =
        now >= region.playbackEndedWallMs + GIVE_UP_AFTER_MS ||
        now >= region.wallEndMs + GIVE_UP_AFTER_MS;
      if (!arrived && !over) {
        waiting += 1;
        continue;
      }
      try {
        const verdict = this.#judge(region, read, over);
        if (verdict === null) {
          waiting += 1;
          continue;
        }
        recordSelfEcho(this.#deps.db, {
          regionId: region.id,
          method: this.#deps.detector.id,
          kind: verdict.kind,
          voicedMs: verdict.voicedMs,
          coveredMs: verdict.coveredMs,
          echoMs: verdict.echoMs,
          nearEndMs: verdict.nearEndMs,
          lagMs: verdict.lagMs,
          correlation: verdict.correlation,
          spans: verdict.spans.map((span) => [
            sampleAt(region, span.fromMs),
            sampleAt(region, span.toMs),
          ]),
          judgedAtMs: now,
        });
        judged.push({ regionId: region.id, verdict });
      } catch (error) {
        // The audio is unreadable (deleted, expired): ADR 020's rule stays.
        this.#deps.log.warn("self-echo.failed", {
          regionId: region.id,
          error: error instanceof Error ? error.name : "unknown",
        });
        recordSelfEcho(this.#deps.db, {
          regionId: region.id,
          method: this.#deps.detector.id,
          kind: "no-reference",
          voicedMs: 0,
          coveredMs: 0,
          echoMs: 0,
          nearEndMs: 0,
          lagMs: null,
          correlation: 0,
          spans: [],
          judgedAtMs: now,
        });
      }
    }
    const costMs = Math.round((performance.now() - started) * 10) / 10;
    for (const { regionId, verdict } of judged) {
      this.#deps.log.info("self-echo.judged", {
        regionId,
        kind: verdict.kind,
        voicedMs: verdict.voicedMs,
        coveredMs: verdict.coveredMs,
        echoMs: verdict.echoMs,
        nearEndMs: verdict.nearEndMs,
        lagMs: verdict.lagMs,
        correlation: verdict.correlation,
        spans: verdict.spans.length,
      });
    }
    return { judged, waiting, costMs };
  }

  /** Null while the region's own audio is not all committed yet (and the work has not given up). */
  #judge(region: RegionToJudge, read: ReadTrackAudio, over: boolean): SelfEchoVerdict | null {
    const perMs = region.sampleRate / 1000;
    const context = Math.round(CONTEXT_MS * perMs);
    const from = Math.max(0, region.sampleStart - context);
    const to = region.sampleEnd + context;
    const startMs = region.continuousStartUs / 1000;
    const micStartMs = startMs - (region.sampleStart - from) / perMs;
    const audio = read({ trackRunId: region.trackRunId, sampleStart: from, sampleEnd: to });
    // A verdict is final: samples of the region the spool has not committed yet would read as
    // silence and take the user's words out of it.
    const pending = audio.missing.some(
      (span) =>
        span.reason === "unrecorded" &&
        span.sampleStart < region.sampleEnd &&
        span.sampleEnd > region.sampleStart,
    );
    if (pending && !over) return null;
    const builder = new EnvelopeBuilder(micStartMs, to - from);
    builder.push(0, audio.samples);
    const mic = builder.finish();
    // The reference reaches back as far as the longest lag searched.
    const fromMs = micStartMs - SELF_ECHO_THRESHOLDS.maxLagMs;
    const frames = mic.db.length + Math.ceil(SELF_ECHO_THRESHOLDS.maxLagMs / ENVELOPE_FRAME_MS);
    const { reference, captured } = this.#deps.reference.window(fromMs, frames);
    return this.#deps.detector.detect({
      mic,
      reference,
      captured,
      fromMs: startMs,
      toMs: region.continuousEndUs / 1000,
    });
  }
}

/** The run sample of continuous `ms` within `region`, kept inside it. */
function sampleAt(region: RegionToJudge, ms: number): number {
  const sample =
    region.sampleStart +
    Math.round(((ms - region.continuousStartUs / 1000) * region.sampleRate) / 1000);
  return Math.max(region.sampleStart, Math.min(region.sampleEnd, sample));
}
