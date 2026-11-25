import type { HealthWindow, Status } from "@sondine/api";
import type { ClockAnchor, HelperEvent } from "@sondine/protocol";
import { Context, Effect, Layer, PubSub, Ref, Stream, SubscriptionRef } from "effect";
import { HelperClient } from "../helper/helper-client";
import { log } from "../log";
import { applyHelperEvent, healthWindow, initialStatus, problem } from "./status-model";

const HEALTH_WINDOWS = 240;

export interface CoreStateService {
  readonly status: SubscriptionRef.SubscriptionRef<Status>;
  /** Newest first, at most four hours of 60 s windows. */
  readonly health: Ref.Ref<readonly HealthWindow[]>;
  update(f: (status: Status, nowMs: number) => Status): Effect.Effect<void>;
  /**
   * The same change from a plain callback (a scheduler, a timer), applied in
   * order. Never `Effect.runSync(update(…))`: while another fiber holds the
   * ref's lock, runSync throws, and on 2026-11-18 that killed the analysis
   * loop at launch, the power event racing its first status.
   */
  publish(f: (status: Status, nowMs: number) => Status): void;
}

export class CoreState extends Context.Service<CoreState, CoreStateService>()(
  "sondine/core/CoreState",
) {}

export const coreStateLayer = Layer.effect(
  CoreState,
  Effect.gen(function* () {
    const status = yield* SubscriptionRef.make(
      initialStatus(Date.now(), { microphone: false, systemAudio: false }),
    );
    const health = yield* Ref.make<readonly HealthWindow[]>([]);
    const update = (f: (status: Status, nowMs: number) => Status) =>
      SubscriptionRef.update(status, (current) => f(current, Date.now()));
    return CoreState.of({
      status,
      health,
      update,
      publish: (f) => {
        Effect.runFork(update(f));
      },
    });
  }),
);

/** Keeps the status in step with the helper's events and connection. */
export class StatusProjection extends Context.Service<
  StatusProjection,
  { readonly started: true }
>()("sondine/core/StatusProjection") {}

export const statusProjectionLayer = Layer.effect(
  StatusProjection,
  Effect.gen(function* () {
    const helper = yield* HelperClient;
    const state = yield* CoreState;
    // Subscribe now, before the connection loop starts, so no event is missed.
    const subscription = yield* PubSub.subscribe(helper.events);
    let anchor: ClockAnchor | null = null;

    const onEvent = (event: HelperEvent) =>
      Effect.gen(function* () {
        if (event.type === "clock" || event.type === "track.open") anchor = event.anchor;
        if (event.type === "health") {
          const window = healthWindow(event, anchor, Date.now());
          yield* Ref.update(state.health, (windows) =>
            [window, ...windows].slice(0, HEALTH_WINDOWS),
          );
        }
        if (event.type === "warning")
          log.warn("helper.warning", { code: event.code, message: event.message });
        if (event.type === "error") {
          log.error("helper.error", {
            code: event.code,
            message: event.message,
            fatal: event.fatal,
          });
        }
        yield* state.update((status, nowMs) => applyHelperEvent(status, event, nowMs, anchor));
      });

    yield* PubSub.take(subscription).pipe(
      Effect.flatMap(onEvent),
      Effect.forever,
      Effect.forkScoped,
    );

    yield* SubscriptionRef.changes(helper.connection).pipe(
      Stream.runForEach((connection) =>
        state.update((status, nowMs) => ({
          ...status,
          helper: {
            ...status.helper,
            connection: connection.state,
            sessionId: connection.ready?.sessionId ?? null,
            version: connection.ready?.helper.version ?? null,
            connectedAtMs: connection.connectedAtMs,
            lastError:
              connection.state === "connected" || connection.error === null
                ? status.helper.lastError
                : problem(`helper.${connection.state}`, connection.error, nowMs),
          },
          // Tracks, permissions and spool problems belong to a session; the next
          // snapshot and the helper's own reports restore them.
          ...(connection.state === "connected" ? {} : { tracks: [], spool: [], permissions: null }),
          updatedAtMs: nowMs,
        })),
      ),
      Effect.forkScoped,
    );
    return StatusProjection.of({ started: true });
  }),
);
