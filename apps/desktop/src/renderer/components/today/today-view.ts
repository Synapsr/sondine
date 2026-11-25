import type { EpisodeSummary, MomentHour } from "@sondine/api";

// Today's timeline (ADR 007, architecture §11): conversations as rows and the
// moments of each hour collapsed into one row, newest first, with the media
// and dictations the user shows in the same thread, one line each (Téo,
// 2026-11-19). An episode sorts by its start and an hour by the start of the
// hour, so an episode sits above the hour it started in. Traces have one
// counting line, outside the timeline.

export type TimelineItem =
  | { readonly kind: "conversation"; readonly episode: EpisodeSummary }
  | { readonly kind: "short"; readonly episode: EpisodeSummary }
  | { readonly kind: "hour"; readonly hour: MomentHour };

const at = (item: TimelineItem) =>
  item.kind === "hour" ? item.hour.startMs : item.episode.startedAtMs;

/**
 * The timeline, newest first: conversations, hours of moments, and `shorts`
 * (media and dictations shown). While older conversations are still to load
 * (`complete` false), hours and shorts older than the oldest loaded
 * conversation wait with them, so nothing shows out of order.
 */
export function timelineItems(
  conversations: readonly EpisodeSummary[],
  hours: readonly MomentHour[],
  complete: boolean,
  shorts: readonly EpisodeSummary[] = [],
): TimelineItem[] {
  const oldest = conversations.reduce(
    (min, episode) => Math.min(min, episode.startedAtMs),
    Number.POSITIVE_INFINITY,
  );
  const shownHours = complete ? hours : hours.filter((hour) => hour.startMs >= oldest);
  const shownShorts = complete ? shorts : shorts.filter((episode) => episode.startedAtMs >= oldest);
  const rank = { conversation: 0, short: 1, hour: 2 } as const;
  return [
    ...conversations.map((episode): TimelineItem => ({ kind: "conversation", episode })),
    ...shownShorts.map((episode): TimelineItem => ({ kind: "short", episode })),
    ...shownHours.map((hour): TimelineItem => ({ kind: "hour", hour })),
  ].toSorted((a, b) => at(b) - at(a) || rank[a.kind] - rank[b.kind]);
}

/** Conversations of several pages, once each (a page may repeat an episode that moved). */
export function mergePages(pages: readonly (readonly EpisodeSummary[])[]): EpisodeSummary[] {
  const seen = new Set<number>();
  const merged: EpisodeSummary[] = [];
  for (const page of pages) {
    for (const episode of page) {
      if (seen.has(episode.id)) continue;
      seen.add(episode.id);
      merged.push(episode);
    }
  }
  return merged;
}

export type DayPart = "morning" | "afternoon" | "evening";

/** Before noon is the morning, before 18:00 the afternoon, then the evening (local time). */
export function dayPart(ms: number): DayPart {
  const hour = new Date(ms).getHours();
  return hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
}

/** The timeline cut into parts of the day, in its order (ADR 037: « Ce matin »…). */
export function timelineParts(
  items: readonly TimelineItem[],
): { readonly part: DayPart; readonly items: readonly TimelineItem[] }[] {
  const parts: { part: DayPart; items: TimelineItem[] }[] = [];
  for (const item of items) {
    const part = dayPart(at(item));
    const last = parts.at(-1);
    if (last?.part === part) last.items.push(item);
    else parts.push({ part, items: [item] });
  }
  return parts;
}

/** What an hour row says under its count: previews, or that none has text yet. */
export type HourSummary =
  | { readonly kind: "previews"; readonly texts: readonly string[]; readonly untranscribed: number }
  | { readonly kind: "untranscribed" };

export function hourSummary(hour: MomentHour): HourSummary {
  if (hour.previews.length === 0) return { kind: "untranscribed" };
  return {
    kind: "previews",
    texts: hour.previews.map((preview) => preview.firstWords),
    untranscribed: hour.untranscribed,
  };
}
