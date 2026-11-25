export interface RestartPolicyOptions {
  readonly minDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Crashes counted toward a crash loop. */
  readonly windowMs?: number;
  readonly crashLoopThreshold?: number;
  /** A run at least this long resets the backoff. */
  readonly healthyAfterMs?: number;
}

export interface RestartDecision {
  readonly delayMs: number;
  /** At least `crashLoopThreshold` crashes within `windowMs`: surface it to the user. */
  readonly crashLoop: boolean;
  /** Crashes inside the window, this one included. */
  readonly recentCrashes: number;
}

export interface RestartPolicy {
  /** Records an unexpected exit and returns when to start again. */
  onCrash(atMs: number, uptimeMs: number): RestartDecision;
  reset(): void;
}

/** Backoff 1 s, 2 s, 4 s … capped at 30 s; three crashes in five minutes is a loop. */
export function createRestartPolicy(options: RestartPolicyOptions = {}): RestartPolicy {
  const minDelayMs = options.minDelayMs ?? 1_000;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const windowMs = options.windowMs ?? 5 * 60_000;
  const threshold = options.crashLoopThreshold ?? 3;
  const healthyAfterMs = options.healthyAfterMs ?? 60_000;
  let attempt = 0;
  let crashes: number[] = [];

  return {
    onCrash(atMs, uptimeMs) {
      if (uptimeMs >= healthyAfterMs) attempt = 0;
      crashes = [...crashes.filter((at) => atMs - at < windowMs), atMs];
      const delayMs = Math.min(maxDelayMs, minDelayMs * 2 ** attempt);
      attempt += 1;
      return { delayMs, crashLoop: crashes.length >= threshold, recentCrashes: crashes.length };
    },
    reset() {
      attempt = 0;
      crashes = [];
    },
  };
}
