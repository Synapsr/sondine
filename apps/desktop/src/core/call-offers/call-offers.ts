import type {
  CallListen,
  CallOffer,
  CallOfferSettings,
  EndedCall,
  ListeningCall,
  ListeningStatus,
} from "@sondine/api";
import {
  callOffersEnabled,
  callRecording,
  mutedCallApps,
  muteCallApp,
  ongoingCall,
  setCallOffersEnabled,
  unmuteCallApp,
} from "@sondine/db";
import type { ClockAnchor, ClockPoint, HelperEvent, HoldOccurrence } from "@sondine/protocol";
import { Context, Data, Effect, Layer, PubSub, Queue, Ref, Stream, SubscriptionRef } from "effect";
import { Importer } from "../capture/importer";
import { Database } from "../database";
import { HelperClient, type HelperRequestError } from "../helper/helper-client";
import { Listening } from "../listening";
import { log } from "../log";
import { CoreState } from "../status/core-state";
import {
  CALL_END_GRACE_MS,
  callGoingOn,
  callName,
  joinCall,
  offerFor,
  seenApp,
  type SeenCall,
} from "./call-offer-model";

// A notice when a call starts (ADR 036): during a pause, an offer to listen
// to it; while Sondine listens, an offer not to. The helper says every call it
// sees, paused or not (`call.seen`); this service reads them in socket order
// with the holds of private zones, decides the one offer
// (`ListeningStatus.callOffer`), and carries out the user's answer. Main shows
// the offer in the island beside the notch, as a notification without one,
// and in the menu bar.
//
// A call lasts until its app has not been seen in one for 10 s, so an app
// that drops its microphone for a moment stays in the same call. The call
// going on (`ListeningStatus.call`) says its open episode, read again with the
// importer's commits; once over, `callEnded` says what it left.
//
// « Écouter cet appel » asks Listening to resume for that app's call, « Ne pas
// écouter cet appel » to pause for it. Once no call of that app has been seen
// for 10 s, and only after a snapshot has said what the helper sees (a new
// session forgets the calls until its replay ends), Listening puts back the
// intent from before. The record is durable, so a core or app restart during
// the call ends it the same way once the helper's snapshot shows the call gone.
// Either answer takes the other back while the call goes on.

/** The call named is no longer going on, or Sondine already does what was asked. */
export class CallOfferGone extends Data.TaggedError("CallOfferGone")<{
  readonly callId: string;
}> {}

type ChangeError = Exclude<HelperRequestError, { _tag: "HelperUnavailable" }>;

export interface CallOffersService {
  listen(callId: string): Effect.Effect<ListeningStatus, ChangeError | CallOfferGone>;
  skip(callId: string): Effect.Effect<ListeningStatus, ChangeError | CallOfferGone>;
  decline(callId: string, forApp: boolean): Effect.Effect<ListeningStatus>;
  /** An episode was ended by hand, or came back: the call's is read again. */
  readonly refresh: Effect.Effect<void>;
  readonly settings: Effect.Effect<CallOfferSettings>;
  setEnabled(on: boolean): Effect.Effect<CallOfferSettings>;
  allowApp(bundleId: string): Effect.Effect<CallOfferSettings>;
}

export class CallOffers extends Context.Service<CallOffers, CallOffersService>()(
  "sondine/core/CallOffers",
) {}

export interface CallOffersOptions {
  readonly now?: () => number;
  readonly endGraceMs?: number;
}

/**
 * What came back with the call's end, once the helper has confirmed it; null
 * when the user changed it meanwhile, or the helper has not done it.
 */
const restoredBy = (
  kind: CallOffer["kind"],
  effective: ListeningStatus["effective"],
): EndedCall["restored"] => {
  if (kind === "listen") return effective === "paused" ? "paused" : null;
  return effective === "listening" ? "listening" : null;
};

export const callOffersLayer = (options: CallOffersOptions = {}) =>
  Layer.effect(
    CallOffers,
    Effect.gen(function* () {
      const db = yield* Database;
      const helper = yield* HelperClient;
      const listening = yield* Listening;
      const state = yield* CoreState;
      const importer = yield* Importer;
      const now = options.now ?? Date.now;
      const endGraceMs = options.endGraceMs ?? CALL_END_GRACE_MS;

      /** The calls going on, by the helper's latest id for each: those seen, or last seen less than the grace ago. */
      const calls = yield* Ref.make(new Map<string, SeenCall>());
      const holds = yield* Ref.make<readonly HoldOccurrence[]>([]);
      /** The helper's latest clock: places a replayed call's start. */
      const anchor = yield* Ref.make<ClockAnchor | null>(null);
      /** The session's snapshot has ended: `calls` is what the helper sees. */
      const settled = yield* Ref.make(false);
      /** Offers the user declined, by call id. */
      const declined = yield* Ref.make(new Set<string>());
      const current = yield* Ref.make<CallOffer | null>(null);
      const going = yield* Ref.make<ListeningCall | null>(null);
      /** When the call listened to is over, if its app has not been seen again by then. */
      const endAt = yield* Ref.make<number | null>(null);
      const wake = yield* Queue.sliding<void>(1);

      const settings = Effect.sync((): CallOfferSettings => ({
        enabled: callOffersEnabled(db),
        mutedApps: mutedCallApps(db).map((app) => ({ ...app })),
      }));

      /** The open episode of the call going on, if it is the one core records. */
      const episodeOf = (bundleId: string): number | null => {
        const recorded = ongoingCall(db, now());
        return recorded?.bundleId === bundleId ? recorded.episodeId : null;
      };

      const publishCall = (call: ListeningCall | null) =>
        Effect.gen(function* () {
          yield* Ref.set(going, call);
          yield* state.update((status) => {
            const shown = status.listening.call;
            // Another call has started: the one before is past.
            const callEnded = call === null ? status.listening.callEnded : null;
            return shown?.callId === call?.callId &&
              shown?.name === call?.name &&
              shown?.episodeId === call?.episodeId &&
              status.listening.callEnded === callEnded
              ? status
              : { ...status, listening: { ...status.listening, call, callEnded } };
          });
        });

      /** Decides the offer and the call going on again, and whether the call answered has ended. */
      const evaluate = Effect.gen(function* () {
        const intent = yield* listening.intent;
        const seen = [...(yield* Ref.get(calls)).values()];
        const input = {
          enabled: callOffersEnabled(db),
          flags: intent.flags,
          pausedSinceMs: intent.changedAtMs,
          forCall: intent.forCall !== null,
          calls: seen,
          holds: yield* Ref.get(holds),
          mutedBundleIds: new Set(mutedCallApps(db).map((app) => app.bundleId)),
          declinedCallIds: yield* Ref.get(declined),
        };
        // Nothing is said before the snapshot has said the holds as well as the calls.
        const ready = yield* Ref.get(settled);
        const offer = ready ? offerFor(input) : null;
        const call = ready ? callGoingOn(input) : null;
        const previous = yield* Ref.getAndSet(current, offer);
        if (offer?.callId !== previous?.callId || offer?.kind !== previous?.kind) {
          log.info("call-offers.offer", { offered: offer?.kind ?? "none" });
        }
        yield* state.update((status) =>
          status.listening.callOffer?.callId === offer?.callId &&
          status.listening.callOffer?.kind === offer?.kind
            ? status
            : { ...status, listening: { ...status.listening, callOffer: offer } },
        );
        yield* publishCall(call === null ? null : { ...call, episodeId: episodeOf(call.bundleId) });
        // The call answered: its end waits for a settled view of the calls.
        const forCall = intent.forCall;
        const ended =
          forCall !== null && (yield* Ref.get(settled)) && !seenApp(seen, forCall.bundleId);
        const waiting = yield* Ref.get(endAt);
        if (ended && waiting === null) {
          yield* Ref.set(endAt, now() + endGraceMs);
          yield* Queue.offer(wake, undefined);
        } else if (!ended && waiting !== null) {
          yield* Ref.set(endAt, null);
        }
      });

      /**
       * When a call started, on core's clock: a replayed call (a reconnect, a
       * restart) keeps its age, so it stays older than a pause taken during it.
       */
      const startedMs = (at: ClockPoint, clock: ClockAnchor | null) =>
        now() -
        (clock === null ? 0 : Math.max(0, Number(clock.continuousNs - at.continuousNs) / 1e6));

      const onEvent = (event: HelperEvent) =>
        Effect.gen(function* () {
          switch (event.type) {
            case "ready":
              // A new session: what it sees comes with its snapshot, which
              // joins the calls going on or lets them end.
              yield* Ref.set(settled, false);
              yield* Ref.update(calls, (map) => {
                const at = now();
                return new Map(
                  [...map].map(([id, call]) => [id, { ...call, endedMs: call.endedMs ?? at }]),
                );
              });
              yield* Ref.set(holds, []);
              yield* Ref.set(anchor, null);
              break;
            case "clock":
              yield* Ref.set(anchor, event.anchor);
              return;
            case "ack":
              // Only the ack that ends a snapshot is published.
              yield* Ref.set(settled, true);
              yield* Queue.offer(wake, undefined);
              break;
            case "call.seen": {
              const clock = yield* Ref.get(anchor);
              yield* Ref.update(calls, (map) => {
                const next = new Map(map);
                if (event.state === "active") {
                  const call = joinCall(
                    map.values(),
                    {
                      callId: event.callId,
                      bundleId: event.bundleId,
                      name: event.name,
                      sinceMs: startedMs(event.at, clock),
                      endedMs: null,
                    },
                    now(),
                    endGraceMs,
                  );
                  // One entry per app, under the helper's latest id.
                  for (const [id, other] of map)
                    if (other.bundleId === event.bundleId) next.delete(id);
                  next.set(event.callId, call);
                } else {
                  const call = map.get(event.callId);
                  if (call !== undefined) next.set(event.callId, { ...call, endedMs: now() });
                }
                return next;
              });
              yield* Queue.offer(wake, undefined);
              break;
            }
            case "holds":
              yield* Ref.set(holds, event.holds);
              break;
            default:
              return;
          }
          yield* evaluate;
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() =>
              log.warn("call-offers.helper-event", { cause: String(cause).slice(0, 200) }),
            ),
          ),
        );

      // Subscribe now, before the connection loop starts, so no event is missed.
      const events = yield* PubSub.subscribe(helper.events);
      yield* PubSub.take(events).pipe(Effect.flatMap(onEvent), Effect.forever, Effect.forkScoped);

      // The user paused or resumed: the offer follows at once.
      yield* SubscriptionRef.changes(state.status).pipe(
        Stream.map(
          (status) =>
            // Every change of the intent, a new pause with the same flags included.
            `${status.listening.changedAtMs}:${status.listening.desired}:${status.listening.forCall?.kind ?? ""}:${status.listening.forCall?.bundleId ?? ""}:${status.listening.microphonePaused}:${status.listening.systemAudioPaused}`,
        ),
        Stream.changes,
        Stream.runForEach(() => evaluate),
        Effect.forkScoped,
      );

      // Speech joined the call's episode, or it was cut: only while a call goes on.
      yield* Stream.merge(
        SubscriptionRef.changes(importer.commits),
        SubscriptionRef.changes(importer.regionWrites),
      ).pipe(
        Stream.runForEach(() =>
          Effect.gen(function* () {
            const call = yield* Ref.get(going);
            if (call === null) return;
            const episodeId = episodeOf(call.bundleId);
            if (episodeId !== call.episodeId) yield* publishCall({ ...call, episodeId });
          }),
        ),
        Effect.forkScoped,
      );

      /** Says what a call left, once over: its recording, the intent that came back with its end. */
      const sayEnded = (call: SeenCall, restored: EndedCall["restored"]) =>
        Effect.gen(function* () {
          const recording = callRecording(db, {
            bundleId: call.bundleId,
            sinceMs: call.sinceMs,
          });
          if (recording === null && restored === null) return;
          const callEnded: EndedCall = {
            callId: call.callId,
            bundleId: call.bundleId,
            name: callName(call),
            endedAtMs: now(),
            recording,
            restored,
          };
          log.info("call-offers.ended", {
            recorded: recording !== null,
            restored: restored ?? "none",
          });
          yield* state.update((status) => ({
            ...status,
            listening: { ...status.listening, callEnded },
          }));
        });

      /**
       * Forgets the calls last seen more than the grace ago. Before an answer's
       * intent comes back, so a call that is over is never offered again by
       * the pause that returns. Returns them, with the call going on until now.
       */
      const forgetEnded = Effect.gen(function* () {
        const at = now();
        const map = yield* Ref.get(calls);
        const over = [...map.values()].filter(
          (call) => call.endedMs !== null && call.endedMs + endGraceMs <= at,
        );
        if (over.length > 0) {
          yield* Ref.set(calls, new Map([...map].filter(([, call]) => !over.includes(call))));
        }
        const shown = yield* Ref.get(going);
        return over.find((call) => call.callId === shown?.callId) ?? null;
      });

      /**
       * Says the call that was going on and is over, or the one answered whose
       * intent came back: after a restart, only its record says it.
       */
      const sayOver = (
        ended: SeenCall | null,
        answered: { readonly forCall: CallListen; readonly restored: EndedCall["restored"] } | null,
      ) =>
        Effect.gen(function* () {
          if ((yield* Ref.get(going)) !== null || !callOffersEnabled(db)) return;
          if (ended !== null) {
            const same = answered?.forCall.bundleId === ended.bundleId;
            yield* sayEnded(ended, same ? answered.restored : null);
          } else if (answered !== null) {
            const { bundleId, name, sinceMs } = answered.forCall;
            yield* sayEnded(
              { callId: `answered-${sinceMs}`, bundleId, name, sinceMs, endedMs: now() },
              answered.restored,
            );
          }
        });

      // Ends the calls over, and the one answered, once their grace has passed.
      yield* Effect.gen(function* () {
        for (;;) {
          const answeredAt = yield* Ref.get(endAt);
          // Nothing ends on a view of the calls that has not settled.
          const lastSeen = !(yield* Ref.get(settled))
            ? []
            : [...(yield* Ref.get(calls)).values()].flatMap((call) =>
                call.endedMs === null ? [] : [call.endedMs + endGraceMs],
              );
          const next = Math.min(answeredAt ?? Infinity, ...lastSeen);
          if (next === Infinity) {
            yield* Queue.take(wake);
            continue;
          }
          // The call answered ends with its intent, a moment later at most.
          const at = answeredAt === null ? next : Math.max(next, answeredAt);
          const waitMs = at - now();
          if (waitMs > 0) {
            yield* Queue.take(wake).pipe(
              Effect.timeoutOrElse({ duration: `${waitMs} millis`, orElse: () => Effect.void }),
            );
            continue;
          }
          yield* Ref.set(endAt, null);
          const forCall = (yield* listening.intent).forCall;
          let restored: EndedCall["restored"] = null;
          const ended = yield* forgetEnded;
          const seen = [...(yield* Ref.get(calls)).values()];
          if (forCall !== null && (yield* Ref.get(settled)) && !seenApp(seen, forCall.bundleId)) {
            // Asked again under Listening's lock: the call may be back, or a
            // new helper session not yet settled, by the time it is taken.
            const stillOver = Effect.gen(function* () {
              const seenNow = [...(yield* Ref.get(calls)).values()];
              return (yield* Ref.get(settled)) && !seenApp(seenNow, forCall.bundleId);
            });
            yield* listening.endCallListen(forCall, stillOver);
            const after = yield* listening.intent;
            if (after.forCall === null) {
              restored = restoredBy(
                forCall.kind,
                (yield* SubscriptionRef.get(state.status)).listening.effective,
              );
            }
          }
          yield* evaluate;
          yield* sayOver(
            ended,
            forCall === null || restored === null ? null : { forCall, restored },
          );
        }
      }).pipe(Effect.forkScoped);

      /** The call named, still going on; decided again first: a zone or its end may have taken it. */
      const named = (callId: string) =>
        Effect.gen(function* () {
          yield* evaluate;
          const call = yield* Ref.get(going);
          if (call === null || call.callId !== callId) {
            return yield* Effect.fail(new CallOfferGone({ callId }));
          }
          return call;
        });
      const listeningNow = Effect.map(
        SubscriptionRef.get(state.status),
        (status) => status.listening,
      );

      return CallOffers.of({
        listen: (callId) =>
          Effect.gen(function* () {
            const call = yield* named(callId);
            const { flags, forCall } = yield* listening.intent;
            if (!flags.microphone && !flags.systemAudio) {
              return yield* Effect.fail(new CallOfferGone({ callId }));
            }
            log.info("call-offers.listen", { undo: forCall !== null });
            yield* listening.listenForCall(call);
            yield* evaluate;
            return yield* listeningNow;
          }).pipe(Effect.withSpan("call-offers.listen")),
        skip: (callId) =>
          Effect.gen(function* () {
            const call = yield* named(callId);
            const { flags, forCall } = yield* listening.intent;
            if (flags.microphone && flags.systemAudio) {
              return yield* Effect.fail(new CallOfferGone({ callId }));
            }
            log.info("call-offers.skip", { undo: forCall !== null });
            yield* listening.skipCall(call);
            yield* evaluate;
            return yield* listeningNow;
          }).pipe(Effect.withSpan("call-offers.skip")),
        decline: (callId, forApp) =>
          Effect.gen(function* () {
            const call = yield* Ref.get(going);
            yield* Ref.update(declined, (set) => new Set(set).add(callId));
            if (forApp && call !== null && call.callId === callId) {
              muteCallApp(db, { bundleId: call.bundleId, name: call.name }, now());
            }
            log.info("call-offers.decline", { forApp });
            yield* evaluate;
            return yield* listeningNow;
          }).pipe(Effect.withSpan("call-offers.decline")),
        refresh: evaluate,
        settings,
        setEnabled: (on) =>
          Effect.gen(function* () {
            setCallOffersEnabled(db, on, now());
            log.info("call-offers.enabled", { on });
            yield* evaluate;
            return yield* settings;
          }),
        allowApp: (bundleId) =>
          Effect.gen(function* () {
            unmuteCallApp(db, bundleId, now());
            yield* evaluate;
            return yield* settings;
          }),
      });
    }),
  );
