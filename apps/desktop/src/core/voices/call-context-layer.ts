import { Context, Effect, Layer, Stream, SubscriptionRef } from "effect";
import { TrackAudioSource } from "../analysis/analysis-layer";
import { Importer } from "../capture/importer";
import { CoreConfig } from "../config";
import { Database } from "../database";
import { log } from "../log";
import { CoreState } from "../status/core-state";
import { CallVoices, type CallState } from "./call-voices";

// Call context in core (ADR 025): live identity follows the importer's
// commits and region writes (call spans come with them), so it adds no timer
// and no wakeup of its own; a deletion, or
// listening paused, starts the call over. Without `sondine-voice` it stays
// empty.

export class CallContext extends Context.Service<
  CallContext,
  {
    /** The call going on and whom it may be with; null when none. */
    readonly state: SubscriptionRef.SubscriptionRef<CallState | null>;
    readonly dismiss: (callId: number) => CallState | null;
    /** A person was renamed, merged or deleted, or the notch setting changed: main reads the call again. */
    readonly refresh: () => void;
  }
>()("sondine/core/CallContext") {}

export const callContextLayer = Layer.effect(
  CallContext,
  Effect.gen(function* () {
    const config = yield* CoreConfig;
    const db = yield* Database;
    const audio = yield* TrackAudioSource;
    const importer = yield* Importer;
    const core = yield* CoreState;
    const state = yield* SubscriptionRef.make<CallState | null>(null);
    // Forked, not runSync: the ref's lock may be held (see CoreState.publish).
    const refresh = () => {
      Effect.runFork(
        SubscriptionRef.update(state, (current) => (current === null ? null : { ...current })),
      );
    };
    const tool = config.voiceTool;
    if (tool === null) return CallContext.of({ state, dismiss: () => null, refresh });
    const voices = new CallVoices({
      db,
      tool,
      readAudio: () => audio.reader(),
      onChange: (next) => {
        Effect.runFork(SubscriptionRef.set(state, next));
      },
      log,
    });
    // Commits bring speech; region writes bring call spans that start or end.
    yield* Stream.merge(
      SubscriptionRef.changes(importer.commits),
      SubscriptionRef.changes(importer.regionWrites),
    ).pipe(
      Stream.runForEach(() => Effect.sync(() => voices.nudge())),
      Effect.forkScoped,
    );
    let deletions = (yield* SubscriptionRef.get(core.status)).deletions;
    yield* SubscriptionRef.changes(core.status).pipe(
      Stream.runForEach((status) =>
        Effect.sync(() => {
          const deleted = status.deletions !== deletions;
          deletions = status.deletions;
          if (deleted || status.listening.desired !== "listening") voices.reset();
        }),
      ),
      Effect.forkScoped,
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => voices.stop()));
    return CallContext.of({ state, dismiss: (callId) => voices.dismiss(callId), refresh });
  }),
);
