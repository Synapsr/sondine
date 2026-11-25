// Chromium spawns its audio service at the first playback, after the last
// periodic PID refresh: without a prompt one, the system-audio tap would
// record up to 30 s of Sondine's own playback. The window's playback event
// refreshes the excluded PIDs at once and again a second later, in case the
// service appears just after. No Electron import, so it is unit-tested.

/** The part of a WebContents this listens to. */
export interface PlaybackEvents {
  on(event: "media-started-playing", listener: () => void): unknown;
}

/** The second refresh after playback starts. */
export const PLAYBACK_RECHECK_MS = 1_000;

export function refreshPidsOnPlayback(
  contents: PlaybackEvents,
  refresh: () => void,
  schedule: (run: () => void, delayMs: number) => void = (run, delayMs) => {
    setTimeout(run, delayMs).unref();
  },
): void {
  contents.on("media-started-playing", () => {
    refresh();
    schedule(refresh, PLAYBACK_RECHECK_MS);
  });
}
