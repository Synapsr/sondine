import { execFileSync } from "node:child_process";

// When the packaged app opens its window without being asked by name (ADR
// 003). macOS brings an app the person opens to the front (Dock, Finder,
// Spotlight), whether it starts or already runs; it leaves one opened in the
// background alone (`open -g`, the helper after a crash). At login it opens
// apps on its own, where the window would be in the way. No Electron import,
// so it is unit-tested.

/** macOS brings the app to the front around when it is opened; later, it is another gesture. */
export const ACTIVATION_MS = 5_000;

/** The part of Electron's app this listens to. */
export interface FrontApp {
  isActive(): boolean;
  /** Calls `listener` each time the app comes to the front; returns how to stop. */
  onActive(listener: () => void): () => void;
}

/** Says once whether macOS brings the app, just opened, to the front. */
export function whenInFront(
  app: FrontApp,
  then: (inFront: boolean) => void,
  schedule: (run: () => void, delayMs: number) => void = (run, delayMs) => {
    setTimeout(run, delayMs).unref();
  },
): void {
  if (app.isActive()) {
    then(true);
    return;
  }
  let said = false;
  const say = (inFront: boolean) => {
    if (said) return;
    said = true;
    stop();
    then(inFront);
  };
  const stop = app.onActive(() => say(true));
  schedule(() => say(false), ACTIVATION_MS);
}

export type LaunchReason = "login" | "person" | "background";

/** Whether the launch that just happened opens the window, and why not. */
export function launchReason(
  app: FrontApp,
  openedAtLogin: boolean,
  then: (reason: LaunchReason) => void,
): void {
  if (openedAtLogin) then("login");
  else whenInFront(app, (inFront) => then(inFront ? "person" : "background"));
}

/**
 * Whether macOS's loginwindow opened this process: a login item, or an app
 * open at the last logout, which Electron's `wasOpenedAtLogin` does not tell.
 */
export function openedByLoginwindow(
  read: () => string = () =>
    execFileSync("/usr/bin/lsappinfo", ["info", "-only", "parentASN", String(process.pid)], {
      timeout: 1_000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
): boolean {
  try {
    return read().includes('parentASN="loginwindow"');
  } catch {
    return false;
  }
}
