import type { LivePartial, LiveStatus, Status } from "@sondine/api";
import { liveEnabled, setLiveEnabled } from "@sondine/db";
import { Context, Effect, Layer, Stream, SubscriptionRef } from "effect";
import {
  AnalysisQueue,
  ParakeetEngineProvider,
  SystemSignals,
  TrackAudioSource,
} from "../analysis/analysis-layer";
import { Importer } from "../capture/importer";
import { Database } from "../database";
import { log } from "../log";
import { Models } from "../models/models-layer";
import { CoreState } from "../status/core-state";
import { LiveTranscriber, type LiveTiming } from "./live-transcriber";

// Near-live text in core (architecture §10, ADR 019): the user's switch, and
// the transcriber on its handle of Parakeet (analysis-layer.ts), started after
// the analysis queue recovered the speech workers.

export class LiveText extends Context.Service<
  LiveText,
  {
    readonly setEnabled: (enabled: boolean) => LiveStatus;
    /** The sentence an open episode is hearing now; null when none. */
    readonly partial: (episodeId: number) => LivePartial;
  }
>()("sondine/core/LiveText") {}

export interface LiveOptions {
  readonly timing?: Partial<LiveTiming>;
  readonly now?: () => number;
}

export const liveTextLayer = (options: LiveOptions = {}) =>
  Layer.effect(
    LiveText,
    Effect.gen(function* () {
      const db = yield* Database;
      const state = yield* CoreState;
      const engines = yield* ParakeetEngineProvider;
      const audio = yield* TrackAudioSource;
      const signals = yield* SystemSignals;
      const models = yield* Models;
      const queue = yield* AnalysisQueue;
      const importer = yield* Importer;
      let status: Status = yield* SubscriptionRef.get(state.status);
      // Unplugged or hot: the running request stops now, not at the next tick;
      // something deleted: what was read goes too.
      let wake = () => undefined as void;
      let deleted = () => undefined as void;
      yield* SubscriptionRef.changes(state.status).pipe(
        Stream.runForEach((next) =>
          Effect.sync(() => {
            const changed =
              next.power.onBattery !== status.power.onBattery ||
              next.power.thermalState !== status.power.thermalState;
            const gone = next.deletions !== status.deletions;
            status = next;
            if (gone) deleted();
            else if (changed) wake();
          }),
        ),
        Effect.forkScoped,
      );
      const update = (live: Partial<LiveStatus>) =>
        state.publish((current, nowMs) => ({
          ...current,
          live: { ...current.live, ...live },
          updatedAtMs: nowMs,
        }));
      update({ enabled: liveEnabled(db) });
      const transcriber = new LiveTranscriber({
        db,
        engine: engines.live,
        readAudio: audio.reader,
        conditions: async () => ({
          onBattery: status.power.onBattery,
          thermalState: status.power.thermalState,
          memoryPressure: (await signals.memory()).memoryPressure,
        }),
        deletions: () => status.deletions,
        blocked: () => queue.blocked(),
        onState: (live, revision) => update({ state: live, revision }),
        log,
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.timing === undefined ? {} : { timing: options.timing }),
      });
      wake = () => transcriber.wake();
      // Each 2 s commit, at once rather than at the next tick: a second less on average.
      yield* SubscriptionRef.changes(importer.commits).pipe(
        Stream.runForEach(() => Effect.sync(() => transcriber.nudge())),
        Effect.forkScoped,
      );
      deleted = () => transcriber.deleted();
      models.onInstalled(() => transcriber.wake());
      transcriber.start();
      yield* Effect.addFinalizer(() => Effect.promise(() => transcriber.stop()));
      return LiveText.of({
        partial: (episodeId) => transcriber.partial(episodeId),
        setEnabled: (enabled) => {
          setLiveEnabled(db, enabled, Date.now());
          update({ enabled });
          transcriber.wake();
          return { ...status.live, enabled };
        },
      });
    }),
  );
