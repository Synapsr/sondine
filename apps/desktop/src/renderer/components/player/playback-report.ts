import type { PlayerSnapshot } from "./player-store";

// While the player plays, core is told so (`player.state`, ADR 020): the
// microphone hears what the speakers play, and that speech is left out of
// episodes unless someone spoke over it (ADR 035). At once when playing
// starts, every few seconds while it goes on
// (core's lease lasts 6 s, so a window that dies stops it soon), and once
// when it stops.

/** How often a playing player renews its lease with core. */
export const RENEW_MS = 3_000;

interface Followed {
  subscribe(listener: () => void): () => void;
  getSnapshot(): PlayerSnapshot;
}

/** Follows `player` and calls `report`; returns the stop, which reports a stop if it was playing. */
export function reportPlayback(player: Followed, report: (playing: boolean) => void): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
    report(false);
  };
  const follow = () => {
    const playing = player.getSnapshot().status === "playing";
    if (!playing) {
      stop();
      return;
    }
    if (timer !== null) return;
    report(true);
    timer = setInterval(() => report(true), RENEW_MS);
  };
  const unsubscribe = player.subscribe(follow);
  follow();
  return () => {
    unsubscribe();
    stop();
  };
}
