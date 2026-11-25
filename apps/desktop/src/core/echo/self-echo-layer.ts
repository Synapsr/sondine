import { createSelfEchoDetector } from "@sondine/engines";
import { Context, Effect, Layer, PubSub, Stream, SubscriptionRef } from "effect";
import { TrackAudioSource } from "../analysis/analysis-layer";
import { Importer } from "../capture/importer";
import { Database } from "../database";
import { EpisodeBuilder } from "../episodes/episode-builder";
import { HelperClient } from "../helper/helper-client";
import { log } from "../log";
import { SelfEchoWork } from "./self-echo-work";
import { SelfReference } from "./self-reference";

// Sondine's own sound (ADR 035): the helper's `self.envelope` events fill
// the in-memory reference, and after each import that wrote regions (and
// every 2 s while some wait for the reference) the regions heard during a
// playback on the speakers are judged. A region someone spoke in joins the
// episodes at once: the grouping passes again.

/** How often waiting regions are looked at again. */
export const SELF_ECHO_RETRY_MS = 2_000;

export class SelfEcho extends Context.Service<
  SelfEcho,
  {
    /** Judges what can be judged now. */
    readonly run: Effect.Effect<void>;
    readonly reference: SelfReference;
  }
>()("sondine/core/SelfEcho") {}

export const selfEchoLayer = Layer.effect(
  SelfEcho,
  Effect.gen(function* () {
    const db = yield* Database;
    const audio = yield* TrackAudioSource;
    const helper = yield* HelperClient;
    const importer = yield* Importer;
    const builder = yield* EpisodeBuilder;
    const reference = new SelfReference();
    const work = new SelfEchoWork({
      db,
      reader: audio.reader,
      reference,
      detector: createSelfEchoDetector(),
      log,
    });
    let waiting = 0;
    const run = Effect.suspend(() => {
      let regrouped = false;
      try {
        const result = work.run();
        waiting = result.waiting;
        regrouped = result.judged.some(({ verdict }) => verdict.kind === "near-end");
      } catch (error) {
        log.warn("self-echo.run-failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return regrouped ? Effect.asVoid(builder.pass) : Effect.void;
    }).pipe(Effect.withSpan("self-echo.run"));

    // Subscribe now, before the connection loop starts, so no frame is missed.
    const subscription = yield* PubSub.subscribe(helper.events);
    yield* PubSub.take(subscription).pipe(
      Effect.tap((event) =>
        Effect.sync(() => {
          if (event.type === "self.envelope") reference.add(event);
        }),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
    yield* SubscriptionRef.changes(importer.regionWrites).pipe(
      Stream.debounce("1 second"),
      Stream.runForEach(() => run),
      Effect.forkScoped,
    );
    yield* Effect.suspend(() => (waiting > 0 ? run : Effect.void)).pipe(
      Effect.delay(`${SELF_ECHO_RETRY_MS} millis`),
      Effect.forever,
      Effect.forkScoped,
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => reference.clear()));
    return SelfEcho.of({ run, reference });
  }),
);
