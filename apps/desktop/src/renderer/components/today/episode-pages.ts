import type { EpisodeCursor, TimelineLane } from "@sondine/api";
import { useInfiniteQuery } from "@tanstack/react-query";
import { orpc } from "../../core/orpc";

// Pages of one day's episodes beyond what `episodes.day` gives: an hour's
// moments, the traces, or the conversations and media past the first 100.
// Keyed on the day's `revision`, they load when shown and reload only when
// the day changes, never on a timer (architecture §11).

const PAGE = 100;

export interface EpisodePagesInput {
  readonly day: string;
  readonly lane: TimelineLane;
  readonly hour?: number;
  /** Where to start: after `episodes.day`'s first page; the beginning when absent. */
  readonly after?: EpisodeCursor | null;
}

export function useEpisodePages(input: EpisodePagesInput, revision: string, enabled: boolean) {
  const { day, lane, hour, after } = input;
  const pageInput = (cursor: EpisodeCursor | undefined) => ({
    day,
    lane,
    limit: PAGE,
    ...(hour === undefined ? {} : { hour }),
    ...(cursor === undefined ? {} : { cursor }),
  });
  const initialPageParam: EpisodeCursor | undefined = after ?? undefined;
  return useInfiniteQuery(
    orpc.episodes.list.infiniteOptions({
      input: pageInput,
      initialPageParam,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
      queryKey: [
        ...orpc.episodes.list.infiniteKey({ input: pageInput, initialPageParam }),
        { revision },
      ],
      staleTime: Number.POSITIVE_INFINITY,
      enabled,
    }),
  );
}
