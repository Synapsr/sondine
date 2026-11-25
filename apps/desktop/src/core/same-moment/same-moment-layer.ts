import { createEnvelopeDetector } from "@sondine/engines";
import { Context, Effect, Layer } from "effect";
import { AnalysisQueue, TrackAudioSource } from "../analysis/analysis-layer";
import { Database } from "../database";
import { log } from "../log";
import { SameMomentWork } from "./same-moment-work";

// The same meeting on both (ADR 032, M5.7): a phone recording imported, a
// Mac conversation transcribed, and every 10 minutes for what changed
// otherwise (a split, a deletion), the pairs the clocks propose are
// compared, one at a time, in the background.

/** How often waiting pairs are looked for when nothing woke the work. */
export const SAME_MOMENT_INTERVAL_MS = 10 * 60_000;
/** After core starts, before the first look: startup's own work comes first. */
export const SAME_MOMENT_FIRST_DELAY_MS = 30_000;

export class SameMoment extends Context.Service<
  SameMoment,
  {
    /** Looks for pairs to compare now. */
    readonly wake: () => void;
  }
>()("sondine/core/SameMoment") {}

export const sameMomentLayer = Layer.effect(
  SameMoment,
  Effect.gen(function* () {
    const db = yield* Database;
    const audio = yield* TrackAudioSource;
    const queue = yield* AnalysisQueue;
    const work = new SameMomentWork({
      db,
      reader: audio.reader,
      detector: createEnvelopeDetector(),
      log,
    });
    const wake = () => void work.wake();
    // A Mac conversation (or a phone recording) has its transcript: it is closed and settled.
    queue.onPublished(wake);
    const first = setTimeout(wake, SAME_MOMENT_FIRST_DELAY_MS);
    const every = setInterval(wake, SAME_MOMENT_INTERVAL_MS);
    first.unref();
    every.unref();
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => {
        clearTimeout(first);
        clearInterval(every);
        return work.close();
      }),
    );
    return SameMoment.of({ wake });
  }),
);
