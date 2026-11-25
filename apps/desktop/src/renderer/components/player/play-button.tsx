import { Button } from "@sondine/ui/components/button";
import { PauseIcon, PlayIcon } from "@sondine/ui/icon";
import { m } from "../../paraglide/messages.js";
import { useEpisodePlayState, usePlayer } from "./player-provider";

/**
 * Plays an episode in the app's player, or pauses it when it is the one
 * playing. Every play button in the app is this one.
 */
export function PlayButton({
  episodeId,
  label,
  variant = "secondary",
}: {
  episodeId: number;
  /** What plays, for the accessible name: « Écouter 16:31 ». */
  label: string;
  variant?: "secondary" | "ghost";
}) {
  const player = usePlayer();
  const state = useEpisodePlayState(episodeId);
  const playing = state === "playing" || state === "loading";
  return (
    <Button
      variant={variant}
      size="icon"
      aria-label={
        playing
          ? m.player_pause_episode({ episode: label })
          : m.player_play_episode({ episode: label })
      }
      isPending={state === "loading"}
      onClick={() => player.toggle(episodeId)}
    >
      {playing ? <PauseIcon /> : <PlayIcon />}
    </Button>
  );
}
