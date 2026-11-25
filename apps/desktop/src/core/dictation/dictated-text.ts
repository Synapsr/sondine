import type { AnalysisInput, SegmentInput, TrackStretch } from "@sondine/db";
import { ONE_VOICE } from "../analysis/requests";
import type { Dictated } from "./place-typed";

// A dictation's text, taken from the app it was said to (ADR 020): exactly
// what that app typed, in place of a transcription. Only when the app's
// dictations account for all that was heard, and for nothing else; anything
// less is transcribed as before.

/** The app's times and the speech heard may differ by this much at each end. */
const PAD_MS = 300;
/** The app's times and the capture's: they agree to about 10 ms. */
const CLOCK_MS = 100;
/** The share of the speech heard, and of each stretch of it, the app's dictations cover. */
const COVERED = 0.9;
const COVERED_REGION = 0.5;
/** An overlap shorter than this is no match. */
const MIN_OVERLAP_MS = 200;

export interface DictatedContext {
  readonly wallMsAt: (trackRunId: number, sample: number) => number;
  /**
   * Whether all of a dictation is this episode's to tell: captured, its speech
   * nobody else's, nothing of it deleted or corrected (`ownsStretch`).
   */
  readonly owns: (stretch: TrackStretch) => boolean;
  /** Whether all of a stretch was captured (`stretchCaptured`). */
  readonly captured: (stretch: TrackStretch) => boolean;
}

interface Heard {
  readonly trackRunId: number;
  readonly trackKey: string;
  readonly sampleRate: number;
  readonly sampleStart: number;
  readonly sampleEnd: number;
  readonly startMs: number;
  readonly endMs: number;
}

const overlap = (
  a: { readonly startMs: number; readonly endMs: number },
  b: { readonly startMs: number; readonly endMs: number },
) => Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));

const padded = ({ startMs, endMs }: Dictated) => ({
  startMs: startMs - PAD_MS,
  endMs: endMs + PAD_MS,
});

/** One segment per dictation, in order; null when the app's text is not the whole of it. */
export function dictatedSegments(
  input: AnalysisInput,
  history: readonly Dictated[],
  context: DictatedContext,
): SegmentInput[] | null {
  if ([...input.deleted.values()].some((ranges) => ranges.length > 0)) return null;
  const heard: Heard[] = [];
  for (const region of input.regions) {
    const sampleEnd = region.sliceEnd ?? region.sampleEnd;
    if (sampleEnd === null || !region.trackKey.startsWith("input:")) return null;
    const { trackRunId, trackKey, sampleRate, sliceStart: sampleStart } = region;
    const startMs = context.wallMsAt(trackRunId, sampleStart);
    const endMs = context.wallMsAt(trackRunId, sampleEnd);
    if (endMs <= startMs) return null;
    heard.push({ trackRunId, trackKey, sampleRate, sampleStart, sampleEnd, startMs, endMs });
  }
  const used = history
    .filter((entry) => heard.some((stretch) => overlap(stretch, entry) >= MIN_OVERLAP_MS))
    .toSorted((a, b) => a.startMs - b.startMs);
  if (used.length === 0) return null;
  let total = 0;
  let covered = 0;
  for (const stretch of heard) {
    const length = stretch.endMs - stretch.startMs;
    const within = Math.min(
      length,
      used.reduce((sum, entry) => sum + overlap(stretch, padded(entry)), 0),
    );
    if (within < length * COVERED_REGION) return null;
    total += length;
    covered += within;
  }
  if (covered < total * COVERED) return null;

  const segments: SegmentInput[] = [];
  for (const entry of used) {
    if (entry.text === "") return null;
    const stretches = heard
      .filter((stretch) => overlap(stretch, entry) >= MIN_OVERLAP_MS)
      .toSorted((a, b) => a.startMs - b.startMs);
    const head = stretches[0];
    const tail = stretches.at(-1);
    if (head === undefined || tail === undefined) return null;
    const { trackRunId } = head;
    // A microphone changed midway: the capture may miss words between the two.
    if (stretches.some((stretch) => stretch.trackRunId !== trackRunId)) return null;
    const sampleOf = (stretch: Heard, ms: number) =>
      stretch.sampleStart + Math.round(((ms - stretch.startMs) * stretch.sampleRate) / 1000);
    // All of it, its silences too: what was said while Sondine did not listen stays out.
    const owned = context.owns({
      trackRunId,
      sampleStart: sampleOf(head, entry.startMs + CLOCK_MS),
      sampleEnd: sampleOf(tail, entry.endMs - CLOCK_MS),
    });
    if (!owned) return null;
    if (
      entry.watchedUntilMs !== undefined &&
      !context.captured({
        trackRunId,
        sampleStart: sampleOf(head, entry.startMs + CLOCK_MS),
        sampleEnd: sampleOf(tail, entry.watchedUntilMs),
      })
    ) {
      return null;
    }
    const sampleStart = Math.max(head.sampleStart, sampleOf(head, entry.startMs));
    const sampleEnd = Math.max(sampleStart, Math.min(tail.sampleEnd, sampleOf(tail, entry.endMs)));
    const startMs = context.wallMsAt(trackRunId, sampleStart);
    segments.push({
      trackRunId,
      sampleStart,
      sampleEnd,
      startMs,
      endMs: Math.max(startMs, context.wallMsAt(trackRunId, sampleEnd)),
      text: entry.text,
      speakerLabel: `${head.trackKey}/${ONE_VOICE}/1`,
    });
  }
  return segments;
}
