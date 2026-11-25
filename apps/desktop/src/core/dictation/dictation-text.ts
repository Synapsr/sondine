import {
  dictationAppOf,
  dictationText,
  dictationTextPastTaken,
  DICTATION_TEXT_APPS,
  episodesWithoutText,
  listenSpans,
  loadAnalysisInput,
  ownsStretch,
  pastDictations,
  setDictationTextPastTaken,
  stretchCaptured,
  wallMsAtSample,
  type AnalysisInput,
  type Database,
} from "@sondine/db";
import type { DictatedText } from "../analysis/scheduler";
import { dictatedSegments } from "./dictated-text";
import { dictationHistories } from "./histories";
import { placeTyped } from "./place-typed";
import { removeLeftCopies } from "./read-history";

// A dictation's text as its app kept it (ADR 020): the app's history, placed
// on what Sondine heard.

/** How far from the episode an app's text may have come, and what may stand before it. */
const AROUND_MS = 10 * 60_000;
/** Past episodes looked at between two turns of core's loop. */
const BATCH = 10;

export interface DictationTexts {
  /** The episode's text from its app; null to transcribe it. */
  of(input: AnalysisInput): DictatedText | null;
  /**
   * Hands `publish` the past dictations their app still keeps the text of,
   * once per app: their transcript becomes what the app typed, at once, never
   * a transcription made again. How many.
   */
  takePast(
    nowMs: number,
    publish: (input: AnalysisInput, text: DictatedText) => boolean,
    stop?: () => boolean,
  ): Promise<number>;
}

export function dictationTexts(db: Database, home: string): DictationTexts {
  const histories = dictationHistories(home);
  removeLeftCopies(Date.now());

  const of = (input: AnalysisInput): DictatedText | null => {
    const bundleId = dictationAppOf(db, input.episodeId);
    if (bundleId === null || dictationText(db, bundleId) !== true) return null;
    const typed = histories.get(bundleId)?.() ?? null;
    if (typed === null || input.regions.length === 0) return null;
    const starts = input.regions.map((region) => region.wallStartMs);
    const fromMs = Math.min(...starts) - AROUND_MS;
    const toMs = Math.max(...starts) + AROUND_MS;
    const near = typed.filter((entry) => {
      const atMs = entry.kind === "spoken" ? entry.endMs : entry.fromMs;
      return atMs >= fromMs && atMs <= toMs;
    });
    if (near.length === 0) return null;
    const segments = dictatedSegments(
      input,
      placeTyped(near, listenSpans(db, bundleId, fromMs, toMs)),
      {
        wallMsAt: (trackRunId, sample) => wallMsAtSample(db, trackRunId, sample),
        owns: (stretch) => ownsStretch(db, input.episodeId, stretch),
        captured: (stretch) => stretchCaptured(db, stretch),
      },
    );
    return segments === null ? null : { bundleId, segments };
  };

  return {
    of,
    takePast: async (nowMs, publish, stop = () => false) => {
      let taken = 0;
      for (const bundleId of DICTATION_TEXT_APPS) {
        if (dictationText(db, bundleId) !== true || dictationTextPastTaken(db, bundleId)) continue;
        // Not installed, or not readable: looked for again next time.
        if ((histories.get(bundleId)?.() ?? null) === null) continue;
        const episodes = pastDictations(db, bundleId);
        const hidden = episodesWithoutText(db, episodes, nowMs);
        for (const [index, episodeId] of episodes.entries()) {
          if (index % BATCH === BATCH - 1) {
            await new Promise((resolve) => setImmediate(resolve));
            // The database may be closing: the next start begins again.
            if (stop()) return taken;
          }
          if (hidden.has(episodeId)) continue;
          const input = loadAnalysisInput(db, episodeId);
          if (input === null || input.state !== "closed") continue;
          const text = of(input);
          if (text !== null && publish(input, text)) taken += 1;
        }
        setDictationTextPastTaken(db, bundleId, nowMs);
      }
      return taken;
    },
  };
}
