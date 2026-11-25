import type { EpisodeSummary } from "@sondine/api";
import { Button } from "@sondine/ui/components/button";
import { useToastManager } from "@sondine/ui/components/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@sondine/ui/components/tooltip";
import { StopIcon } from "@sondine/ui/icon";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { errorMessage, orpc } from "../../core/orpc";
import { contextLabel } from "../../lib/labels";
import { m } from "../../paraglide/messages.js";

/**
 * « Terminer » (ADR 044): the ongoing recording ends now, and what is said
 * next opens another. Sondine goes on listening; ⌘Z takes it back.
 */
export function useEndEpisode() {
  const queryClient = useQueryClient();
  const toasts = useToastManager();
  return useMutation(
    orpc.episodes.end.mutationOptions({
      onSuccess: async (result) => {
        if (result.ended) toasts.add({ title: m.episode_ended() });
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.episodes.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.search.key() }),
        ]);
      },
      onError: (error) => toasts.add({ title: errorMessage(error) }),
    }),
  );
}

/** « Terminer Appel · Discord »: which one, where several may go on. */
export const endLabel = (episode: EpisodeSummary) =>
  m.episode_end_named({ name: contextLabel(episode) ?? m.ongoing_title() });

/** Beside the « En cours » badge, or (`compact`) an icon on the sidebar's card. */
export function EndButton({
  episode,
  compact = false,
  className,
}: {
  episode: EpisodeSummary;
  compact?: boolean;
  className?: string;
}) {
  const end = useEndEpisode();
  const onClick = () => end.mutate({ episodeId: episode.id });
  const { isPending } = end;
  if (!compact) {
    return (
      <Button variant="secondary" className={className} isPending={isPending} onClick={onClick}>
        <StopIcon />
        {m.episode_end()}
      </Button>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-s"
            className={className}
            aria-label={endLabel(episode)}
            isPending={isPending}
            onClick={onClick}
          />
        }
      >
        <StopIcon />
      </TooltipTrigger>
      <TooltipPopup side="right">{m.episode_end()}</TooltipPopup>
    </Tooltip>
  );
}
