import type { EpisodeSameMoment } from "@sondine/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { errorMessage, orpc } from "../../core/orpc";
import { m } from "../../paraglide/messages.js";
import { usePlayer } from "../player/player-provider";
import { wallAt } from "../player/player-time";
import { sameSecond } from "./same-second";

// « Aussi enregistré par le Mac » under a phone recording's title, and « par
// l'iPhone » under the Mac's (ADR 032): it opens the other at the second
// this one is playing (or where they start to share), and says which one
// the journal reads over their shared time, with the switch.

export function SameMomentLines({
  episodeId,
  moments,
}: {
  episodeId: number;
  moments: readonly EpisodeSameMoment[];
}) {
  if (moments.length === 0) return null;
  return (
    <>
      {moments.map((moment) => (
        <SameMomentLine key={moment.episodeId} episodeId={episodeId} moment={moment} />
      ))}
    </>
  );
}

function SameMomentLine({ episodeId, moment }: { episodeId: number; moment: EpisodeSameMoment }) {
  const player = usePlayer();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const choose = useMutation(
    orpc.episodes.setJournalSource.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: orpc.episodes.key() });
        await queryClient.invalidateQueries({ queryKey: orpc.journal.key() });
      },
    }),
  );
  const open = () => {
    const snapshot = player.getSnapshot();
    const here =
      snapshot.episodeId === episodeId && snapshot.timeline !== null
        ? wallAt(snapshot.seconds, snapshot.timeline)
        : moment.sharedFromMs;
    void navigate({
      to: "/episode/$id",
      params: { id: String(moment.episodeId) },
      search: { t: sameSecond(moment, here) },
    });
  };
  return (
    <span className="flex flex-col items-start gap-xxs">
      <span className="flex flex-wrap items-baseline gap-x-xs text-body-s text-cte-text-muted">
        <button
          type="button"
          className="corner-xs text-start text-cte-text underline underline-offset-4 focus-ring"
          title={m.episode_also_recorded_open()}
          onClick={open}
        >
          {moment.by === "mac"
            ? m.episode_also_recorded_by_mac()
            : m.episode_also_recorded_by_phone()}
        </button>
        <span aria-hidden="true">·</span>
        <span>
          {moment.feedsJournal ? m.episode_journal_reads_this() : m.episode_journal_reads_other()}
        </span>
        {moment.feedsJournal ? null : (
          <button
            type="button"
            className="corner-xs underline underline-offset-4 focus-ring disabled:opacity-60"
            disabled={choose.isPending}
            onClick={() => choose.mutate({ episodeId, otherEpisodeId: moment.episodeId })}
          >
            {m.episode_journal_use_this()}
          </button>
        )}
      </span>
      {choose.error === null ? null : (
        <span role="alert" className="text-body-xs text-error">
          {errorMessage(choose.error)}
        </span>
      )}
    </span>
  );
}
