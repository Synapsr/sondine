import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { orpc } from "../../core/orpc";
import { usePlayer } from "../player/player-provider";

/**
 * Something was deleted, here or from the menu bar (`Status.deletions`): the
 * window forgets what it holds of it. Cached transcripts go, lists refetch,
 * and the player stops if its recording no longer exists, or reloads without
 * what it buffered when a passage of it went, before playing any more of it.
 */
export function useFollowDeletions(): void {
  const player = usePlayer();
  const queryClient = useQueryClient();
  const status = useQuery(orpc.status.watch.experimental_liveOptions({ retry: true }));
  const deletions = status.data?.deletions;
  const seen = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (deletions === undefined) return;
    const previous = seen.current;
    seen.current = deletions;
    if (previous === undefined || previous === deletions) return;
    queryClient.removeQueries({ queryKey: orpc.episodes.get.key() });
    // The sentence being said may hold what was just deleted.
    queryClient.removeQueries({ queryKey: orpc.live.partial.key() });
    // So may a discussion's answers: core erased those that read Sondine (ADR 027).
    queryClient.removeQueries({ queryKey: orpc.chat.watch.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.episodes.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.search.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.people.key() });
    // Gone, it stops; shorter (a passage deleted), it drops its buffer.
    void player.revalidate();
  }, [deletions, player, queryClient]);
}

/**
 * Near-live text was published (`Status.live.revision`), « Garder les 2
 * dernières minutes » kept a moment (`Status.kept`, from the menu bar too),
 * or tags changed, from the phone too (`Status.changes`, ADR 039):
 * the episodes and searches on screen read them again now, rather than at
 * their next refresh.
 */
export function useFollowEpisodeChanges(): void {
  const queryClient = useQueryClient();
  const status = useQuery(orpc.status.watch.experimental_liveOptions({ retry: true }));
  const revision =
    status.data === undefined
      ? undefined
      : `${status.data.live.revision}:${status.data.kept}:${status.data.changes}`;
  const seen = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (revision === undefined) return;
    const previous = seen.current;
    seen.current = revision;
    if (previous === undefined || previous === revision) return;
    void queryClient.invalidateQueries({ queryKey: orpc.episodes.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.search.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.tags.key() });
  }, [revision, queryClient]);
}
