import type { EpisodeApp } from "@sondine/api";
import { isRecognized, sameVoice, voiceOfLabel, type Voice } from "../../lib/voices";

// The transcript as speaker turns: consecutive segments of one voice form a
// turn, shown with the voice and the time it started, until a long silence
// starts a new one, or, on screen, another app comes to the front (ADR 022):
// a turn shows the app it was said in only where that app changes. Each
// segment stays its own control (it plays from its start). Search matches
// are the segments whose text matched, stepped through in order.

/** A silence this long between two segments of one voice starts a new turn. */
export const TURN_GAP_MS = 30_000;

export interface SegmentLike {
  readonly id: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly speakerLabel: string | null;
  readonly highlights: readonly unknown[];
  /** The app in front when it was said; null or absent when none is known. */
  readonly app?: EpisodeApp | null;
}

export interface TranscriptTurn {
  readonly key: number;
  readonly voice: Voice;
  readonly startMs: number;
  /** Indices into the segments. */
  readonly segments: readonly number[];
  /** The app it was said in, where that changes from the turns before; null otherwise. */
  readonly app: EpisodeApp | null;
}

export function groupTurns(
  segments: readonly SegmentLike[],
  voices: ReadonlyMap<string, Voice>,
  { byApp = false }: { readonly byApp?: boolean } = {},
): TranscriptTurn[] {
  const turns: {
    key: number;
    voice: Voice;
    startMs: number;
    segments: number[];
    app: EpisodeApp | null;
  }[] = [];
  let lastEndMs = Number.NEGATIVE_INFINITY;
  let lastLabel: string | null = null;
  /** The last app known, through segments without one. */
  let lastApp: string | null = null;
  segments.forEach((segment, index) => {
    const voice = voiceOfLabel(voices, segment.speakerLabel);
    const app = byApp ? (segment.app ?? null) : null;
    const newApp = app !== null && app.bundleId !== lastApp;
    if (app !== null) lastApp = app.bundleId;
    const last = turns.at(-1);
    const continues =
      last !== undefined &&
      sameVoice(last.voice, voice) &&
      // A recognized voice keeps its turns, so each can be confirmed or corrected (ADR 030).
      (segment.speakerLabel === lastLabel || (!isRecognized(last.voice) && !isRecognized(voice))) &&
      segment.startMs - lastEndMs < TURN_GAP_MS &&
      !newApp;
    if (continues) last.segments.push(index);
    else
      turns.push({
        key: segment.id,
        voice,
        startMs: segment.startMs,
        segments: [index],
        app: newApp ? app : null,
      });
    lastEndMs = Math.max(lastEndMs, segment.endMs);
    lastLabel = segment.speakerLabel;
  });
  return turns;
}

/** The segments the search matched, in time order. */
export function matchingSegments(segments: readonly SegmentLike[]): number[] {
  return segments.flatMap((segment, index) => (segment.highlights.length > 0 ? [index] : []));
}

/** The match « précédent » (-1) or « suivant » (1) goes to, wrapping around; -1 without matches. */
export function stepMatch(current: number, count: number, direction: -1 | 1): number {
  if (count === 0) return -1;
  if (current < 0) return direction === 1 ? 0 : count - 1;
  return (current + direction + count) % count;
}

/** Sentences chosen for deletion, by index, both ends included. */
export interface PassageRange {
  readonly from: number;
  readonly to: number;
}

/**
 * The wall-clock span « Supprimer » erases: from the first sentence's start
 * to the latest end among them (sentences may overlap); null when out of range.
 */
export function passageSpan(
  segments: readonly SegmentLike[],
  passage: PassageRange,
): { readonly startMs: number; readonly endMs: number } | null {
  const first = segments[passage.from];
  if (first === undefined || passage.to < passage.from) return null;
  const endMs = segments
    .slice(passage.from, passage.to + 1)
    .reduce((end, segment) => Math.max(end, segment.endMs), first.endMs);
  return { startMs: first.startMs, endMs: Math.max(endMs, first.startMs + 1) };
}

/**
 * Whether « Supprimer » takes a sentence: everything said during the span
 * goes, so a sentence that overlaps it (another voice at the same time, on
 * another track) goes too, as `deletePassage` decides.
 */
export function inSpan(
  segment: SegmentLike,
  span: { readonly startMs: number; readonly endMs: number },
): boolean {
  return (
    segment.startMs < span.endMs && Math.max(segment.endMs, segment.startMs + 1) > span.startMs
  );
}

/** After the user scrolls, the transcript stops following playback for this long. */
export const FOLLOW_QUIET_MS = 4_000;

/** Whether the transcript may scroll to the segment playing. */
export function mayFollow(nowMs: number, lastUserScrollMs: number | null): boolean {
  return lastUserScrollMs === null || nowMs - lastUserScrollMs >= FOLLOW_QUIET_MS;
}
