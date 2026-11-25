import type { SearchEpisode, SearchInput } from "@sondine/api";
import { addDays, dayOf } from "../../lib/day";
import type { SearchScreenSearch, SearchPeriod } from "../../routes/search-params";

// Search: the URL's query and filters as `search.query` input, and the
// results grouped by day then episode. The API returns whole episodes newest
// first, so pages concatenate and an episode never splits across days or
// pages.

/** Shorter queries wait for another letter. */
export const MIN_QUERY_LENGTH = 2;
export const PAGE_SIZE = 20;

/** The days a period covers, both included, ending today. */
export function periodRange(
  period: SearchPeriod | undefined,
  today: string,
): { from?: string; to?: string } {
  switch (period) {
    case undefined:
      return {};
    case "today":
      return { from: today, to: today };
    case "7d":
      return { from: addDays(today, -6), to: today };
    case "30d":
      return { from: addDays(today, -29), to: today };
  }
}

/** The query for one page, or null while the text is too short to search and no tag stands alone. */
export function searchInput(
  params: SearchScreenSearch,
  today: string,
  offset: number,
): SearchInput | null {
  const text = params.q?.trim() ?? "";
  // A tag alone lists its recordings (ADR 039); with it, a short text is not searched yet.
  if (text.length < MIN_QUERY_LENGTH && (params.tag === undefined || text !== "")) return null;
  return {
    ...(text === "" ? {} : { text }),
    ...(params.tag === undefined ? {} : { tag: params.tag }),
    ...periodRange(params.period, today),
    ...(params.sizes === undefined ? {} : { sizes: params.sizes }),
    ...(params.contexts === undefined ? {} : { contexts: params.contexts }),
    ...(params.app === undefined ? {} : { foregroundApp: params.app }),
    limit: PAGE_SIZE,
    offset,
  };
}

/** Whether a filter narrows the search. */
export function isFiltered(params: SearchScreenSearch): boolean {
  return (
    params.period !== undefined ||
    params.sizes !== undefined ||
    params.contexts !== undefined ||
    params.app !== undefined ||
    params.tag !== undefined
  );
}

export interface SearchDay {
  readonly day: string;
  readonly episodes: readonly SearchEpisode[];
}

/** Results by local day, newest first, each day's episodes in the order received. */
export function groupByDay(episodes: readonly SearchEpisode[]): SearchDay[] {
  const days: { day: string; episodes: SearchEpisode[] }[] = [];
  const seen = new Set<number>();
  for (const match of episodes) {
    if (seen.has(match.episode.id)) continue;
    seen.add(match.episode.id);
    const day = dayOf(match.episode.startedAtMs);
    const last = days.at(-1);
    if (last?.day === day) last.episodes.push(match);
    else days.push({ day, episodes: [match] });
  }
  return days;
}

/** The next page's offset, or undefined once every match is loaded. */
export function nextOffset(loaded: number, total: number): number | undefined {
  return loaded < total ? loaded : undefined;
}
