import type { EpisodePlayback } from "@sondine/api";
import type { Voice } from "../../lib/voices";

// Time on the playback timeline (architecture §11). `episodes.playback`
// plans one timeline per episode: every track mixed at its wall-clock place
// from `startedAtMs`, silent where nothing was kept and between extents. So
// a wall-clock time maps to a position by a plain subtraction, gaps
// included, and a segment plays from `(segment.startMs - startedAtMs) / 1000`
// whatever its track.

export interface Timeline {
  /** Wall-clock time of the first sample. */
  readonly startedAtMs: number;
  readonly durationMs: number;
  /** Where the VAD heard speech, known before any transcript. */
  readonly speech: EpisodePlayback["speech"];
}

/** The position of a wall-clock time on the timeline, in seconds, within its bounds. */
export function secondsAt(wallMs: number, timeline: Timeline): number {
  const offsetMs = Math.min(Math.max(wallMs - timeline.startedAtMs, 0), timeline.durationMs);
  return offsetMs / 1000;
}

/** The wall-clock time at a position of the timeline. */
export function wallAt(seconds: number, timeline: Timeline): number {
  return timeline.startedAtMs + seconds * 1000;
}

/**
 * Where to resume on a new plan of the same episode (its generation moved
 * on, so its URL answers 409): at the same wall-clock time.
 */
export function resumeSeconds(previous: Timeline, seconds: number, next: Timeline): number {
  return secondsAt(wallAt(seconds, previous), next);
}

export interface TimedSpan {
  readonly startMs: number;
  readonly endMs: number;
}

/** The last segment that started at or before `wallMs`; -1 before the first. */
function lastStartedAt(segments: readonly TimedSpan[], wallMs: number): number {
  let low = 0;
  let high = segments.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((segments[middle]?.startMs ?? Infinity) <= wallMs) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}

/** How far back an overlapping segment (another track) may have started. */
const OVERLAP_LOOKBACK = 8;

/**
 * The segment heard at `wallMs` (segments in time order): of those that
 * cover it, the one that started last; -1 in a silence.
 */
export function segmentAt(segments: readonly TimedSpan[], wallMs: number): number {
  const last = lastStartedAt(segments, wallMs);
  for (let index = last; index >= 0 && index > last - OVERLAP_LOOKBACK; index--) {
    if ((segments[index]?.endMs ?? -Infinity) > wallMs) return index;
  }
  return -1;
}

/** Within this much of a segment's start, ↑ goes to the one before rather than restarting it. */
export const RESTART_WINDOW_MS = 1_500;
/** A segment that starts this close ahead is the one already playing. */
const AHEAD_MS = 250;

/**
 * The segment ↑ (-1) or ↓ (1) goes to from `wallMs`: the next one to start,
 * or the start of the one playing, or the one before when it just started.
 * -1 when there is none.
 */
export function stepSegment(
  segments: readonly TimedSpan[],
  wallMs: number,
  direction: -1 | 1,
): number {
  if (direction === 1) {
    const next = lastStartedAt(segments, wallMs + AHEAD_MS) + 1;
    return next < segments.length ? next : -1;
  }
  return lastStartedAt(segments, wallMs - RESTART_WINDOW_MS);
}

/** How long someone can be heard, overlaps counted once. */
export function heardMs(speech: readonly TimedSpan[]): number {
  let total = 0;
  let reach = Number.NEGATIVE_INFINITY;
  for (const span of speech.toSorted((a, b) => a.startMs - b.startMs)) {
    const from = Math.max(span.startMs, reach);
    if (span.endMs > from) total += span.endMs - from;
    reach = Math.max(reach, span.endMs);
  }
  return total;
}

/** A stretch of speech on the scrubber, as fractions of the timeline. */
export interface LaneSpan {
  readonly start: number;
  readonly end: number;
}

export interface SpeechLane {
  readonly voice: Voice;
  readonly spans: readonly LaneSpan[];
  /** The voices who speak least, together: no one voice to name. */
  readonly others?: true;
}

export interface VoicedSpan extends TimedSpan {
  readonly voice: Voice;
}

function laneKey(voice: Voice): string {
  if (voice.kind === "person") return `person-${voice.personId}`;
  if (voice.kind === "other") return `other-${voice.number}`;
  return voice.kind === "track" ? `track-${voice.track}` : voice.kind;
}

function laneOrder(voice: Voice): number {
  if (voice.kind === "self") return 0;
  if (voice.kind === "track") return voice.track === "microphone" ? 0 : 1;
  return voice.kind === "other" || voice.kind === "person" ? voice.number : Number.MAX_SAFE_INTEGER;
}

/** Lanes the scrubber's height holds. */
export const MAX_LANES = 3;

/**
 * Where each voice speaks, one lane per voice (the user's first, unknown
 * last). Spans closer than `mergeGap` (a share of the timeline) merge, so a
 * long episode draws a few hundred marks, not one per segment. Past
 * `MAX_LANES` voices, those who speak least share the last lane.
 */
export function speechLanes(
  segments: readonly VoicedSpan[],
  timeline: Timeline,
  mergeGap = 0.003,
): SpeechLane[] {
  if (timeline.durationMs <= 0) return [];
  const lanes = new Map<string, { voice: Voice; spans: LaneSpan[] }>();
  const fraction = (wallMs: number) =>
    Math.min(Math.max((wallMs - timeline.startedAtMs) / timeline.durationMs, 0), 1);
  for (const segment of segments) {
    const start = fraction(segment.startMs);
    const end = fraction(segment.endMs);
    if (end <= start) continue;
    const key = laneKey(segment.voice);
    const lane = lanes.get(key) ?? { voice: segment.voice, spans: [] };
    lanes.set(key, lane);
    const previous = lane.spans.at(-1);
    if (previous !== undefined && start - previous.end <= mergeGap) {
      lane.spans[lane.spans.length - 1] = {
        start: previous.start,
        end: Math.max(previous.end, end),
      };
    } else lane.spans.push({ start, end });
  }
  const all = [...lanes.values()];
  const length = (lane: SpeechLane) =>
    lane.spans.reduce((sum, span) => sum + span.end - span.start, 0);
  const kept = new Set(
    all.length <= MAX_LANES
      ? all
      : all.toSorted((a, b) => length(b) - length(a)).slice(0, MAX_LANES - 1),
  );
  const ordered = [...kept].toSorted((a, b) => laneOrder(a.voice) - laneOrder(b.voice));
  if (kept.size === all.length) return ordered;
  const rest: LaneSpan[] = [];
  for (const span of all
    .filter((lane) => !kept.has(lane))
    .flatMap((lane) => lane.spans)
    .toSorted((a, b) => a.start - b.start)) {
    const previous = rest.at(-1);
    if (previous !== undefined && span.start - previous.end <= mergeGap) {
      rest[rest.length - 1] = { start: previous.start, end: Math.max(previous.end, span.end) };
    } else rest.push(span);
  }
  return [...ordered, { voice: { kind: "unknown" }, spans: rest, others: true }];
}
