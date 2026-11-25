import type { EpisodeSummary } from "@sondine/api";
import { addDays, dayNoonMs } from "../../lib/day";

// The calendar's arithmetic (Téo, 2026-11-19): zoom steps, where a week and
// a month start, and where a week puts each conversation.

/** One hour's height in a week, in pixels. */
export const HOUR_PX = 48;
/** A block is never shorter than this, so a 30 s call still reads. */
const MIN_BLOCK_PX = 22;
const HOUR_MS = 3_600_000;

export type Zoom = "day" | "week" | "month";

export const ORDER: readonly Zoom[] = ["day", "week", "month"];

/** The view transition of a change of zoom (renderer/styles.css): closer is zoom-in; none in place. */
export function zoomTransition(from: Zoom, to: Zoom): { types: string[] } | false {
  if (from === to) return false;
  return { types: [ORDER.indexOf(to) < ORDER.indexOf(from) ? "zoom-in" : "zoom-out"] };
}

export function zoomedOut(zoom: Zoom): Zoom | null {
  return ORDER[ORDER.indexOf(zoom) + 1] ?? null;
}

export function zoomedIn(zoom: Zoom): Zoom | null {
  const index = ORDER.indexOf(zoom);
  return index === 0 ? null : (ORDER[index - 1] ?? null);
}

/** The first day of a day's month. */
export function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/** The Monday of a day's week. */
export function weekStart(day: string): string {
  const weekday = (new Date(dayNoonMs(day)).getDay() + 6) % 7;
  return addDays(day, -weekday);
}

export interface Placed {
  readonly episode: EpisodeSummary;
  readonly top: number;
  readonly height: number;
  /** Its lane among those overlapping it, and how many lanes the day needs. */
  readonly lane: number;
  readonly lanes: number;
}

/** A day's conversations as blocks from `fromHour`, overlapping ones side by side. */
export function placeDay(
  episodes: readonly EpisodeSummary[],
  day: string,
  fromHour: number,
  nowMs: number,
): Placed[] {
  const origin = dayNoonMs(day) - 12 * HOUR_MS + fromHour * HOUR_MS;
  const sorted = episodes.toSorted((a, b) => a.startedAtMs - b.startedAtMs);
  const ends: number[] = [];
  const laned = sorted.map((episode) => {
    const top = ((episode.startedAtMs - origin) / HOUR_MS) * HOUR_PX;
    const end = episode.endedAtMs ?? nowMs;
    const height = Math.max(((end - episode.startedAtMs) / HOUR_MS) * HOUR_PX, MIN_BLOCK_PX);
    let lane = ends.findIndex((bottom) => bottom <= top);
    if (lane === -1) lane = ends.length;
    ends[lane] = top + height;
    return { episode, top, height, lane };
  });
  const lanes = Math.max(ends.length, 1);
  return laned.map((placed) => ({ ...placed, lanes }));
}

/**
 * How far the screen follows a swipe of `distance`: nearly one for one at
 * first, then ever less, never past `max` (a rubber band).
 */
export function rubberBand(distance: number, max: number): number {
  return max * (1 - 1 / (distance / max + 1));
}

/** The spring that brings a swiped screen back: stiff, lightly damped, a small overshoot. */
const STIFFNESS = 320;
const DAMPING = 24;

/** One step of a damped spring toward `target`, over `dt` seconds: the new value and velocity. */
export function springStep(
  value: number,
  velocity: number,
  target: number,
  dt: number,
): [number, number] {
  const acceleration = -STIFFNESS * (value - target) - DAMPING * velocity;
  const nextVelocity = velocity + acceleration * dt;
  return [value + nextVelocity * dt, nextVelocity];
}

/** Whether a spring has come to rest at its target, within half a pixel. */
export function settled(value: number, velocity: number, target: number): boolean {
  return Math.abs(value - target) < 0.5 && Math.abs(velocity) < 0.5;
}

/** How far a gesture goes before it is told a swipe or a scroll, and how much more sideways a swipe is. */
const AXIS_DECIDE_PX = 14;
const SWIPE_SLANT = 2.5;

/**
 * What a gesture is from its first movement (Téo, 2026-11-19: a scroll up
 * started swipes): clearly sideways, a swipe (`x`); anything else, a scroll
 * (`y`); too little yet to tell, null.
 */
export function gestureAxis(dx: number, dy: number): "x" | "y" | null {
  if (Math.abs(dx) + Math.abs(dy) < AXIS_DECIDE_PX) return null;
  return Math.abs(dx) > Math.abs(dy) * SWIPE_SLANT ? "x" : "y";
}
