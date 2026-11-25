import type { EpisodeSummary } from "@sondine/api";
import { Button } from "@sondine/ui/components/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@sondine/ui/components/tooltip";
import { WaveformIcon } from "@sondine/ui/icon";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessage, orpc } from "../../core/orpc";
import { canTranscribe } from "../../lib/labels";
import { requestView } from "../../lib/request-view";
import { m } from "../../paraglide/messages.js";
import { RequestState } from "./request-state";

/**
 * « Transcrire maintenant »: puts the episode first in the queue, without
 * waiting for the Mac to be idle or plugged in. Once asked, the request's
 * state (waiting and why, or failed and what to do); nothing when it does not
 * apply. `compact`: an icon with a tooltip, for list rows.
 */
export function TranscribeButton({
  episode,
  compact = false,
}: {
  episode: EpisodeSummary;
  compact?: boolean;
}) {
  const queryClient = useQueryClient();
  const request = useMutation(
    orpc.analysis.request.mutationOptions({
      onSuccess: () =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.episodes.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.search.key() }),
        ]),
    }),
  );
  const status = useQuery(orpc.status.watch.experimental_liveOptions({ retry: true }));
  const transcribe = () => request.mutate({ episodeId: episode.id });
  const view = status.data === undefined ? null : requestView(status.data.analysis, episode);
  if (view !== null) {
    return <RequestState view={view} onRetry={transcribe} retrying={request.isPending} />;
  }
  if (!canTranscribe(episode)) return null;
  if (request.data?.outcome === "private-zone") {
    return <span className="text-body-s text-cte-text-muted">{m.episode_private_zone()}</span>;
  }
  // Until the queue's status says more.
  if (request.isSuccess)
    return (
      <span className="text-body-s text-cte-text-muted">
        {compact ? m.episode_requested() : m.episode_requested_first()}
      </span>
    );
  return (
    <>
      {compact ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label={m.episode_transcribe()}
                isPending={request.isPending}
                onClick={transcribe}
              />
            }
          >
            <WaveformIcon />
          </TooltipTrigger>
          <TooltipPopup>{m.episode_transcribe()}</TooltipPopup>
        </Tooltip>
      ) : (
        <Button variant="secondary" isPending={request.isPending} onClick={transcribe}>
          <WaveformIcon />
          {m.episode_transcribe()}
        </Button>
      )}
      {request.error === null ? null : (
        <span role="alert" className="text-error">
          {errorMessage(request.error)}
        </span>
      )}
    </>
  );
}
