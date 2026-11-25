import { ORPCError } from "@orpc/client";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { orpc } from "../../core/orpc";
import { reportPlayback } from "./playback-report";
import { Player, type PlayerSnapshot } from "./player-store";

// The whole app shares one Player and its one audio element. Components read
// the slice of its state they show with `usePlayerState`, so the transcript
// re-renders on time updates and a Today row only when its own play state
// changes.

const PlayerContext = createContext<Player | null>(null);

export function PlayerProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [player] = useState(
    () =>
      new Player(new Audio(), {
        // A plan is never cached: its URL is valid for one generation only.
        fetchPlan: (episodeId) =>
          queryClient.fetchQuery({
            ...orpc.episodes.playback.queryOptions({ input: { episodeId } }),
            staleTime: 0,
            gcTime: 0,
            retry: false,
          }),
        isGone: (error) => error instanceof ORPCError && error.code === "NOT_FOUND",
      }),
  );
  // Core leaves out the mic speech the speakers cause while it plays (ADR 020).
  useEffect(
    () =>
      reportPlayback(player, (playing) => {
        orpc.player.state.call({ playing }).catch(() => undefined);
      }),
    [player],
  );
  // Lives as long as the window: no stop on unmount, which React's strict
  // mode would run between its two mounts and cut a playback just started.
  return <PlayerContext value={player}>{children}</PlayerContext>;
}

export function usePlayer(): Player {
  const player = use(PlayerContext);
  if (player === null) throw new Error("usePlayer needs a PlayerProvider");
  return player;
}

/** A slice of the player's state; return a primitive or a stable object. */
export function usePlayerState<T>(select: (snapshot: PlayerSnapshot) => T): T {
  const player = usePlayer();
  const read = useCallback(() => select(player.getSnapshot()), [player, select]);
  return useSyncExternalStore(player.subscribe, read, read);
}

export type EpisodePlayState = "idle" | "loading" | "playing" | "paused";

const playState = (snapshot: PlayerSnapshot, episodeId: number): EpisodePlayState => {
  if (snapshot.episodeId !== episodeId) return "idle";
  switch (snapshot.status) {
    case "loading":
    case "playing":
    case "paused":
      return snapshot.status;
    default:
      return "idle";
  }
};

/** Whether this episode is the one loading, playing or paused. */
export function useEpisodePlayState(episodeId: number): EpisodePlayState {
  const select = useCallback(
    (snapshot: PlayerSnapshot) => playState(snapshot, episodeId),
    [episodeId],
  );
  return usePlayerState(select);
}
