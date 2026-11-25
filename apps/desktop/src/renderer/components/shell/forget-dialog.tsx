import type { ForgetInput } from "@sondine/api";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@sondine/ui/components/alert-dialog";
import { Button } from "@sondine/ui/components/button";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessage, orpc } from "../../core/orpc";
import { formatDuration, timeRange } from "../../lib/labels";
import { m } from "../../paraglide/messages.js";
import { usePlayer } from "../player/player-provider";

export type ForgetMinutes = ForgetInput["minutes"];

export const FORGET_CHOICES: readonly ForgetMinutes[] = [5, 15, 60];

/** « les 5 dernières minutes », « la dernière heure ». */
export function forgetLabel(minutes: ForgetMinutes): string {
  return minutes === 60
    ? m.forget_last_hour()
    : m.forget_last_minutes({ minutes: String(minutes) });
}

/**
 * Confirms « Effacer les N dernières minutes » with what it deletes: every
 * recording the range touches goes whole, so one that started earlier is
 * listed with its full span before anything happens.
 */
export function ForgetDialog({
  minutes,
  onClose,
}: {
  /** Null while closed. */
  minutes: ForgetMinutes | null;
  onClose: () => void;
}) {
  const player = usePlayer();
  const queryClient = useQueryClient();
  const preview = useQuery(
    orpc.episodes.forgetPreview.queryOptions({
      input: minutes === null ? skipToken : { minutes },
      staleTime: 0,
      gcTime: 0,
    }),
  );
  const forget = useMutation(
    orpc.episodes.forget.mutationOptions({
      onSuccess: async (result) => {
        const playing = player.getSnapshot().episodeId;
        if (playing !== null && result.episodeIds.includes(playing)) player.stop();
        onClose();
        queryClient.removeQueries({ queryKey: orpc.episodes.get.key() });
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.episodes.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.search.key() }),
        ]);
      },
    }),
  );
  const episodes = preview.data?.episodes ?? [];
  const phoneRecordings = preview.data?.phoneRecordings ?? [];
  const earliest = preview.data?.fromMs ?? 0;
  return (
    <AlertDialog
      open={minutes !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogTitle>
          {minutes === null ? null : m.forget_title({ range: forgetLabel(minutes) })}
        </AlertDialogTitle>
        <AlertDialogDescription>{m.forget_description()}</AlertDialogDescription>
        {episodes.length === 0 ? null : (
          <div className="flex flex-col gap-xs">
            <p>{m.forget_recordings({ count: episodes.length })}</p>
            <ul className="flex flex-col gap-xxs">
              {episodes.map((episode) => (
                <li key={episode.id} className="flex items-baseline gap-xs">
                  <span className="font-data tabular-nums">
                    {timeRange(episode.startedAtMs, episode.endedAtMs)}
                  </span>
                  <span className="text-body-s text-cte-text-muted">
                    {episode.endedAtMs === null
                      ? m.forget_ongoing()
                      : formatDuration(episode.endedAtMs - episode.startedAtMs)}
                    {episode.startedAtMs < earliest ? ` · ${m.forget_started_before()}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {phoneRecordings.length === 0 ? null : (
          <div className="flex flex-col gap-xs">
            <p>{m.forget_phone_stays({ count: phoneRecordings.length })}</p>
            <ul className="flex flex-col gap-xxs">
              {phoneRecordings.map((recording) => (
                <li key={recording.id} className="font-data tabular-nums">
                  {timeRange(recording.startedAtMs, recording.endedAtMs)}
                </li>
              ))}
            </ul>
          </div>
        )}
        {preview.error === null && forget.error === null ? null : (
          <p role="alert" className="text-error">
            {errorMessage(forget.error ?? preview.error)}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogClose>{m.cancel()}</AlertDialogClose>
          <Button
            variant="danger"
            disabled={preview.data === undefined}
            isPending={forget.isPending}
            onClick={() => {
              // Exactly the range the list shows, even if the dialog stayed open.
              if (minutes !== null && preview.data !== undefined) {
                forget.mutate({ minutes, untilMs: preview.data.toMs });
              }
            }}
          >
            {m.forget_confirm()}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
