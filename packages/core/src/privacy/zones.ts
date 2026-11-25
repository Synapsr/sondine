// Private zones (ADR 029), as pure data and rules. By default Sondine keeps
// everything; each zone takes something away; several zones add up; the
// user's gesture on a recording comes first.

export type ZoneOutcome = "nothing" | "text_only" | "audio_only" | "delete_week" | "delete_day";

export const ZONE_OUTCOMES: readonly ZoneOutcome[] = [
  "nothing",
  "text_only",
  "audio_only",
  "delete_week",
  "delete_day",
];

/** Days of the week as `Date.getDay()` gives them: 0 is Sunday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * A window of the Mac's local time: from `startMinute` on each of `days`
 * to `endMinute`; an end at or before the start crosses midnight (the
 * window belongs to the day it starts).
 */
export interface ScheduleWindow {
  readonly days: readonly Weekday[];
  readonly startMinute: number;
  readonly endMinute: number;
}

/** What a zone is about, named by what happens. */
export type ZoneSituation =
  | { readonly kind: "app"; readonly bundleId: string; readonly name: string }
  | { readonly kind: "site"; readonly site: string }
  /** ADR 023's films, series and music sites, those still left out. */
  | { readonly kind: "media_sites"; readonly sites: readonly string[] }
  /** A network by the keyed hashes of its signatures (IPv4 and IPv6) when it was added; any one matches. */
  | { readonly kind: "network"; readonly hashes: readonly string[]; readonly name: string }
  | { readonly kind: "hours"; readonly name: string; readonly windows: readonly ScheduleWindow[] }
  | { readonly kind: "calls" }
  | { readonly kind: "screen" };

export interface Zone {
  readonly id: string;
  readonly on: boolean;
  readonly outcome: ZoneOutcome;
  readonly situation: ZoneSituation;
}

/** What a recording keeps once every zone touching it took its part. */
export interface Keeping {
  readonly text: boolean;
  /** False: the audio goes once the text exists (or at once when there is no text to make). */
  readonly audio: boolean;
  /** The recording goes whole this long after it ended; null: never by a zone. */
  readonly deleteAfterMs: number | null;
}

export const DAY_MS = 86_400_000;

export const KEEP_ALL: Keeping = { text: true, audio: true, deleteAfterMs: null };

const deleteAfter = (outcome: ZoneOutcome): number | null =>
  outcome === "delete_week" ? 7 * DAY_MS : outcome === "delete_day" ? DAY_MS : null;

/** Zones add up: what is kept is what no zone took away; times take the shortest. */
export function keepingOf(outcomes: readonly ZoneOutcome[]): Keeping {
  let text = true;
  let audio = true;
  let after: number | null = null;
  for (const outcome of outcomes) {
    if (outcome === "nothing" || outcome === "audio_only") text = false;
    if (outcome === "nothing" || outcome === "text_only") audio = false;
    const ms = deleteAfter(outcome);
    if (ms !== null) after = after === null ? ms : Math.min(after, ms);
  }
  return { text, audio, deleteAfterMs: after };
}

/** Nothing left: neither text nor audio. */
export const keepsNothing = (keeping: Keeping): boolean => !keeping.text && !keeping.audio;

// Types and durations

/** A recording's type as the window shows it, for durations (ADR 029). */
export type RecordingType =
  | "calls"
  | "conversations"
  | "moments"
  | "traces"
  | "media"
  | "dictations";

export const RECORDING_TYPES: readonly RecordingType[] = [
  "calls",
  "conversations",
  "moments",
  "traces",
  "media",
  "dictations",
];

/** Audio duration by type, in days (Téo, 2026-11-09). */
export const DEFAULT_AUDIO_DAYS: Readonly<Record<RecordingType, number>> = {
  calls: 90,
  conversations: 90,
  moments: 30,
  traces: 7,
  media: 7,
  dictations: 7,
};

/** The audio durations offered, in days. */
export const AUDIO_DAY_CHOICES: readonly number[] = [1, 7, 30, 90, 365];
/** The « Effacé après » choices by type, in days; null is never. */
export const DELETE_DAY_CHOICES: readonly (number | null)[] = [null, 1, 7, 30, 365];

/** Audio still waiting for its first transcript keeps it at most this long past its time. */
export const TRANSCRIPT_GRACE_MS = 7 * DAY_MS;

export function recordingTypeOf(episode: {
  readonly context: string | null;
  readonly size: string | null;
}): RecordingType {
  switch (episode.context) {
    case "call":
      return "calls";
    case "media":
      return "media";
    case "dictation":
      return "dictations";
    default:
      break;
  }
  switch (episode.size) {
    case "conversation":
      return "conversations";
    case "trace":
      return "traces";
    default:
      return "moments";
  }
}

// Hours

/** The local-time instant of `minute` minutes into the day of `day` (DST-safe). */
function localAt(day: Date, minute: number): number {
  return new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    Math.floor(minute / 60),
    minute % 60,
  ).getTime();
}

/** Each occurrence of the windows, as wall-clock spans, that may touch `[fromMs, toMs]`. */
export function scheduleSpans(
  windows: readonly ScheduleWindow[],
  fromMs: number,
  toMs: number,
): { readonly startMs: number; readonly endMs: number }[] {
  const out: { startMs: number; endMs: number }[] = [];
  if (windows.length === 0 || toMs < fromMs) return out;
  // A window that crosses midnight starts the day before.
  const first = new Date(fromMs);
  first.setHours(0, 0, 0, 0);
  first.setDate(first.getDate() - 1);
  for (let day = first; day.getTime() <= toMs; day = nextDay(day)) {
    const weekday = day.getDay();
    for (const window of windows) {
      if (!window.days.includes(weekday as Weekday)) continue;
      const startMs = localAt(day, window.startMinute);
      const endMs =
        window.endMinute > window.startMinute
          ? localAt(day, window.endMinute)
          : localAt(nextDay(day), window.endMinute);
      if (endMs >= fromMs && startMs <= toMs) out.push({ startMs, endMs });
    }
  }
  return out.toSorted((a, b) => a.startMs - b.startMs);
}

function nextDay(day: Date): Date {
  const next = new Date(day.getTime());
  next.setDate(next.getDate() + 1);
  next.setHours(0, 0, 0, 0);
  return next;
}

/** Whether `[fromMs, toMs]` touches one of the windows. */
export function scheduleTouches(
  windows: readonly ScheduleWindow[],
  fromMs: number,
  toMs: number,
): boolean {
  return scheduleSpans(windows, fromMs, toMs).length > 0;
}

/** The end of the window occurrence holding `atMs`, or null when none does. */
export function scheduleEndAt(windows: readonly ScheduleWindow[], atMs: number): number | null {
  let end: number | null = null;
  for (const span of scheduleSpans(windows, atMs, atMs)) {
    if (span.startMs <= atMs && atMs < span.endMs) end = Math.max(end ?? 0, span.endMs);
  }
  return end;
}

/** A valid window: days 0–6 without repeats, minutes in the day, start and end apart. */
export function validWindow(window: ScheduleWindow): boolean {
  return (
    window.days.length > 0 &&
    window.days.length <= 7 &&
    new Set(window.days).size === window.days.length &&
    window.days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6) &&
    Number.isInteger(window.startMinute) &&
    Number.isInteger(window.endMinute) &&
    window.startMinute >= 0 &&
    window.startMinute < 1440 &&
    window.endMinute >= 0 &&
    window.endMinute <= 1440 &&
    window.endMinute !== window.startMinute
  );
}

export const EVERY_DAY: readonly Weekday[] = [0, 1, 2, 3, 4, 5, 6];

/** « La nuit », 23:00 to 7:00 every day. */
export const NIGHT: ScheduleWindow = {
  days: EVERY_DAY,
  startMinute: 23 * 60,
  endMinute: 7 * 60,
};
