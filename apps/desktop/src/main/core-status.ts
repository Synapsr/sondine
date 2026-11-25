import type { Status } from "@sondine/api";

// Main's copy of what core streams, for the tray: its status, and the call
// going on (ADR 025). It is valid only while the core that sent it runs: when
// core exits the copy is dropped, so the tray never shows a state nobody
// maintains, nor controls nobody answers.

export interface CoreStatusTracker<T = Status> {
  /** The latest value of the running core, or null while core is down or starting. */
  readonly current: () => T | null;
  /** Core exited too often in a short time. Cleared when a core starts. */
  readonly crashLoop: () => boolean;
  /** Follows a newly started core's stream until it ends or core exits. */
  follow(watch: () => Promise<AsyncIterable<T>>): Promise<void>;
  /** Core exited: forget its status until the next one reports. */
  stopped(crashLoop: boolean): void;
}

export function createCoreStatusTracker<T = Status>(options: {
  readonly onChange: () => void;
  readonly onStreamEnd?: (message: string) => void;
  /** Forget the value when its stream ends, not only when core exits. */
  readonly clearOnEnd?: boolean;
}): CoreStatusTracker<T> {
  let status: T | null = null;
  let crashLoop = false;
  // Each core gets a generation; a stream from an older core is ignored.
  let generation = 0;

  return {
    current: () => status,
    crashLoop: () => crashLoop,
    async follow(watch) {
      const mine = ++generation;
      crashLoop = false;
      try {
        for await (const next of await watch()) {
          if (mine !== generation) return;
          status = next;
          options.onChange();
        }
      } catch (error) {
        // The port closes when core exits; the next core is followed again.
        options.onStreamEnd?.(error instanceof Error ? error.message : String(error));
      }
      if (options.clearOnEnd === true && mine === generation && status !== null) {
        status = null;
        options.onChange();
      }
    },
    stopped(loop) {
      generation += 1;
      status = null;
      crashLoop = loop;
      options.onChange();
    },
  };
}
