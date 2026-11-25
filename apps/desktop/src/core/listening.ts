import type { CallListen, ListeningStatus } from "@sondine/api";
import { transaction } from "@sondine/db";
import { PauseScope } from "@sondine/protocol";
import {
  Context,
  Data,
  Effect,
  Layer,
  Queue,
  Ref,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";
import * as z from "zod";
import { Database } from "./database";
import { HelperClient, HelperUnavailable, type HelperRequestError } from "./helper/helper-client";
import { log } from "./log";
import { CoreState } from "./status/core-state";
import { listeningStatus, type PausedFlags } from "./status/status-model";

// The user's listening intent is durable (settings table); the helper's
// confirmed state is learned from `ready` and each `ack`. On every connection
// the helper client pauses the paused sources before `config`, and core then
// re-applies the whole intent, so a helper restart never silently resumes.
//
// A timed pause stores its deadline next to the flags, in one transaction.
// One fiber compares it with the wall clock: at the deadline, or every
// `checkIntervalMs`, and at once when the Mac wakes. Node's timers stop
// while the Mac sleeps, so a pause that ended during sleep resumes at wake,
// and one that ended while Sondine was off resumes at launch. Any newer pause
// or resume replaces the deadline, so an older one never fires.
//
// While the user reads a text for Sondine to learn their voice (ADR 034), the
// helper's microphone is paused whatever the intent (`holdMicrophone`): the
// read records on its own and never becomes a memory. The hold lives in
// memory only, so a core that dies during a read gives the microphone back to
// the intent on its next connection; the stored intent never changes.
//
// « Écouter cet appel » (ADR 036) resumes what the pause covered and stores,
// in the same transaction, the call it is for with the pause it replaced
// (flags and deadline). « Ne pas écouter cet appel » is its mirror: it pauses
// everything and stores what Sondine was listening to. When that call ends,
// `endCallListen` reads the stored intent again and puts back what was there,
// unless the user paused or resumed since: any user change drops the record,
// and the stored flags must still be the ones the call set, so a newer intent
// is never rewritten. A timed pause whose end has passed meanwhile is not
// restored. The record is durable, so a restart during the call still ends it
// (`call-offers.ts`): Sondine never stays paused for a call that is over.

const PAUSED_KEY = "capture.paused";
const DEADLINE_KEY = "capture.pause-deadline";
const CALL_LISTEN_KEY = "capture.call-listen";
const StoredFlags = z.strictObject({ microphone: z.boolean(), systemAudio: z.boolean() });
const StoredDeadline = z.strictObject({ untilMs: z.number(), scope: PauseScope });
/** Listening, or paused, for one call: the intent it replaced, to restore when the call ends. */
const StoredCallListen = z.strictObject({
  /** Records from before `skip` existed are `listen`. */
  kind: z.enum(["listen", "skip"]).default("listen"),
  bundleId: z.string(),
  name: z.string(),
  sinceMs: z.number(),
  flags: StoredFlags,
  deadline: StoredDeadline.nullable(),
  /** When that pause was taken: it comes back as old as it was. */
  pausedAtMs: z.number().nullable(),
});
type StoredCallListen = z.output<typeof StoredCallListen>;

type Scope = z.output<typeof PauseScope>;
type Deadline = z.output<typeof StoredDeadline>;
type ChangeError = Exclude<HelperRequestError, { _tag: "HelperUnavailable" }>;

/** A timed pause whose end has already passed. */
export class PauseInPast extends Data.TaggedError("PauseInPast")<{
  readonly untilMs: number;
  readonly nowMs: number;
}> {}

export interface ListeningService {
  /** With `untilMs`, listening resumes on its own at that wall-clock time (the same scope). */
  pause(scope: Scope, untilMs?: number): Effect.Effect<ListeningStatus, ChangeError | PauseInPast>;
  resume(scope: Scope): Effect.Effect<ListeningStatus, ChangeError>;
  /**
   * On: the helper's microphone pauses until `holdMicrophone(false)`, the
   * intent untouched (ADR 034). Resolves once the helper confirmed it; fails
   * with `HelperUnavailable` when the helper is away, since a helper with no
   * client keeps capturing as it was.
   */
  holdMicrophone(on: boolean): Effect.Effect<void, HelperRequestError>;
  /** The stored intent, when it last changed, and the call listened to, if any. */
  readonly intent: Effect.Effect<ListeningIntentNow>;
  /**
   * « Écouter cet appel »: resumes what is paused until `endCallListen` for
   * this app (ADR 036), or takes « Ne pas écouter cet appel » back. Nothing
   * paused: changes nothing.
   */
  listenForCall(call: CallApp): Effect.Effect<ListeningStatus, ChangeError>;
  /**
   * « Ne pas écouter cet appel »: pauses everything until `endCallListen` for
   * this app (ADR 036); takes « Écouter cet appel » back first. Everything
   * already paused: changes nothing.
   */
  skipCall(call: CallApp): Effect.Effect<ListeningStatus, ChangeError>;
  /**
   * The call answered has ended: puts back the intent before it, from the
   * stored record, unless the user changed it since or a timed pause's end
   * has passed. `stillOver` is asked again once the change may start (another
   * change may have held it back meanwhile); the record must still be the one
   * of `call`.
   */
  endCallListen(
    call: { readonly bundleId: string; readonly sinceMs: number },
    stillOver: Effect.Effect<boolean>,
  ): Effect.Effect<void>;
}

export interface CallApp {
  readonly bundleId: string;
  readonly name: string;
}

export interface ListeningIntentNow {
  readonly flags: PausedFlags;
  /** When the paused flags were last written; null when never. */
  readonly changedAtMs: number | null;
  readonly forCall: CallListen | null;
}

export class Listening extends Context.Service<Listening, ListeningService>()(
  "sondine/core/Listening",
) {}

export interface ListeningOptions {
  readonly now?: () => number;
  /** How often a timed pause looks at the wall clock (30 s); a nearer deadline is waited for exactly. */
  readonly checkIntervalMs?: number;
}

/** The scope that pauses exactly `flags`; null when nothing is paused. */
function scopeOf(flags: PausedFlags): Scope | null {
  if (flags.microphone && flags.systemAudio) return "all";
  if (flags.microphone) return "microphone";
  return flags.systemAudio ? "system-audio" : null;
}

function withScope(flags: PausedFlags, scope: Scope, paused: boolean): PausedFlags {
  return {
    microphone: scope === "system-audio" ? flags.microphone : paused,
    systemAudio: scope === "microphone" ? flags.systemAudio : paused,
  };
}

const UPSERT =
  "INSERT INTO settings (key, value, updated_at_ms) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms";

export const listeningLayer = (options: ListeningOptions = {}) =>
  Layer.effect(
    Listening,
    Effect.gen(function* () {
      const db = yield* Database;
      const helper = yield* HelperClient;
      const state = yield* CoreState;
      const now = options.now ?? Date.now;
      const checkIntervalMs = options.checkIntervalMs ?? 30_000;

      const stored = (key: string): unknown => {
        const raw = db.statement("SELECT value FROM settings WHERE key = ?").get(key)?.["value"];
        if (typeof raw !== "string") return undefined;
        try {
          return JSON.parse(raw);
        } catch {
          return undefined;
        }
      };
      const loadFlags = (): PausedFlags => {
        const parsed = StoredFlags.safeParse(stored(PAUSED_KEY));
        return parsed.success ? parsed.data : { microphone: false, systemAudio: false };
      };
      const loadDeadline = (): Deadline | null => {
        const parsed = StoredDeadline.safeParse(stored(DEADLINE_KEY));
        return parsed.success ? parsed.data : null;
      };
      const loadCallListen = (): StoredCallListen | null => {
        const parsed = StoredCallListen.safeParse(stored(CALL_LISTEN_KEY));
        return parsed.success ? parsed.data : null;
      };
      const loadChangedAt = (): number | null => {
        const at = db
          .statement("SELECT updated_at_ms FROM settings WHERE key = ?")
          .get(PAUSED_KEY)?.["updated_at_ms"];
        return typeof at === "number" ? at : null;
      };
      const optional = (key: string, at: number, value: object | null) => {
        if (value === null) db.statement("DELETE FROM settings WHERE key = ?").run(key);
        else db.statement(UPSERT).run(key, JSON.stringify(value), at);
      };
      const save = (
        flags: PausedFlags,
        deadline: Deadline | null,
        callListen: StoredCallListen | null,
        /** When the flags count as changed; now unless a pause comes back as it was. */
        changedAtMs: number = now(),
      ) =>
        transaction(db, () => {
          const at = now();
          db.statement(UPSERT).run(PAUSED_KEY, JSON.stringify(flags), changedAtMs);
          optional(DEADLINE_KEY, at, deadline);
          optional(CALL_LISTEN_KEY, at, callListen);
          return changedAtMs;
        });

      const desired = yield* Ref.make(loadFlags());
      const deadline = yield* Ref.make(loadDeadline());
      const callListen = yield* Ref.make(loadCallListen());
      const changedAt = yield* Ref.make(loadChangedAt());
      const forCallOf = (record: StoredCallListen | null): CallListen | null =>
        record === null
          ? null
          : {
              kind: record.kind,
              bundleId: record.bundleId,
              name: record.name,
              sinceMs: record.sinceMs,
            };
      const confirmed = yield* Ref.make<PausedFlags | null>(null);
      /** A voice read holds the microphone (ADR 034). */
      const held = yield* Ref.make(false);
      /** What the helper must do: the intent, the microphone paused while held. */
      const effective = Effect.gen(function* () {
        const flags = yield* Ref.get(desired);
        return (yield* Ref.get(held)) ? { ...flags, microphone: true } : flags;
      });
      const lock = yield* Semaphore.make(1);
      // Wakes the deadline fiber: a new deadline, or the Mac waking up.
      const wake = yield* Queue.sliding<void>(1);
      yield* helper.setPausedSources(yield* Ref.get(desired));

      // The holds of private zones are the privacy service's (ADR 029): kept as they are.
      const publish = Effect.gen(function* () {
        const wanted = yield* Ref.get(desired);
        const actual = yield* Ref.get(confirmed);
        const untilMs = (yield* Ref.get(deadline))?.untilMs ?? null;
        const forCall = forCallOf(yield* Ref.get(callListen));
        let listening = listeningStatus(wanted, actual, now(), untilMs);
        yield* state.update((status, nowMs) => {
          // The offer is the call offers service's (ADR 036); one that no
          // longer fits the intent goes at once, before it decides again.
          const offer = status.listening.callOffer;
          const kind = wanted.microphone || wanted.systemAudio ? "listen" : "skip";
          listening = {
            ...listening,
            holds: status.listening.holds,
            callOffer: forCall === null && offer?.kind === kind ? offer : null,
            forCall,
            call: status.listening.call,
            callEnded: status.listening.callEnded,
            pauseReminder: status.listening.pauseReminder,
          };
          return { ...status, listening, updatedAtMs: nowMs };
        });
        return listening;
      });
      yield* publish;

      /** Sends one pause or resume and records what the helper confirmed. */
      const apply = (scope: Scope, paused: boolean) =>
        helper
          .request({ type: paused ? "pause" : "resume", scope })
          .pipe(
            Effect.andThen(
              Ref.update(confirmed, (flags) =>
                withScope(flags ?? { microphone: !paused, systemAudio: !paused }, scope, paused),
              ),
            ),
          );

      /**
       * Asks the helper for a change already recorded. A voice read holds the
       * microphone: only the rest resumes now. The intent is stored either
       * way; a disconnected helper gets it on reconnect.
       */
      const send = (scope: Scope, paused: boolean) =>
        Effect.gen(function* () {
          const sent: Scope | null =
            paused || !(yield* Ref.get(held))
              ? scope
              : scope === "all"
                ? "system-audio"
                : scope === "microphone"
                  ? null
                  : scope;
          if (sent !== null) {
            yield* apply(sent, paused).pipe(
              Effect.catchTag("HelperUnavailable", () => Effect.void),
            );
          }
        });

      /**
       * Records the intent, replacing any deadline and any call listened to
       * (`forCall` sets one), then asks the helper. Callers hold `lock`.
       */
      const change = (
        scope: Scope,
        paused: boolean,
        untilMs: number | null,
        forCall: StoredCallListen | null = null,
      ) =>
        Effect.gen(function* () {
          const next = withScope(yield* Ref.get(desired), scope, paused);
          const nextDeadline = paused && untilMs !== null ? { untilMs, scope } : null;
          yield* Ref.set(desired, next);
          yield* Ref.set(deadline, nextDeadline);
          yield* Ref.set(callListen, forCall);
          yield* Ref.set(changedAt, save(next, nextDeadline, forCall));
          yield* helper.setPausedSources(yield* effective);
          yield* Queue.offer(wake, undefined);
          yield* publish;
          yield* send(scope, paused);
          return yield* publish;
        }).pipe(
          Effect.withSpan(paused ? "listening.pause" : "listening.resume", {
            attributes: { scope, timed: untilMs !== null },
          }),
        );

      /** Ends a timed pause whose deadline passed; a newer change has already replaced an older one. */
      const expire = Effect.gen(function* () {
        const current = yield* Ref.get(deadline);
        const nowMs = now();
        if (current === null || nowMs < current.untilMs) return;
        log.info("listening.pause-ended", {
          scope: current.scope,
          lateMs: nowMs - current.untilMs,
        });
        yield* change(current.scope, false, null).pipe(
          Effect.catch((error) =>
            Effect.sync(() => log.warn("listening.pause-end", { error: error._tag })),
          ),
        );
      }).pipe(lock.withPermits(1));

      yield* Effect.gen(function* () {
        for (;;) {
          yield* expire;
          const current = yield* Ref.get(deadline);
          if (current === null) {
            yield* Queue.take(wake);
            continue;
          }
          const waitMs = Math.max(0, Math.min(current.untilMs - now(), checkIntervalMs));
          yield* Queue.take(wake).pipe(
            Effect.timeoutOrElse({ duration: `${waitMs} millis`, orElse: () => Effect.void }),
          );
        }
      }).pipe(Effect.forkScoped);

      // An intent restored on its own at a call's end that the helper refused
      // is tried again until it holds: nobody stays paused for a call that is
      // over. A newer change of the user's is what gets reconciled then.
      const retry = yield* Queue.sliding<void>(1);
      yield* Effect.gen(function* () {
        for (;;) {
          yield* Queue.take(retry);
          for (;;) {
            yield* Effect.sleep(`${checkIntervalMs} millis`);
            if (yield* reconcile) break;
          }
        }
      }).pipe(Effect.forkScoped);

      // Timers do not run while the Mac sleeps: look again as soon as it wakes.
      yield* SubscriptionRef.changes(state.status).pipe(
        Stream.map((status) => status.power.suspended),
        Stream.changes,
        Stream.filter((suspended) => !suspended),
        Stream.runForEach(() => Queue.offer(wake, undefined)),
        Effect.forkScoped,
      );

      /** Brings the helper to the intent; false when a step failed. */
      const reconcile = Effect.gen(function* () {
        const wanted = yield* effective;
        const actual = yield* Ref.get(confirmed);
        // Away: the next connection is told the intent.
        if (actual === null) return true;
        const steps: [Scope, boolean][] = [];
        if (wanted.microphone && wanted.systemAudio && !(actual.microphone && actual.systemAudio)) {
          steps.push(["all", true]);
        } else if (
          !wanted.microphone &&
          !wanted.systemAudio &&
          (actual.microphone || actual.systemAudio)
        ) {
          steps.push(["all", false]);
        } else {
          if (wanted.microphone !== actual.microphone)
            steps.push(["microphone", wanted.microphone]);
          if (wanted.systemAudio !== actual.systemAudio)
            steps.push(["system-audio", wanted.systemAudio]);
        }
        let ok = true;
        for (const [scope, paused] of steps) {
          yield* apply(scope, paused).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                ok = false;
                log.warn("listening.reconcile", { scope, paused, error: error._tag });
              }),
            ),
          );
        }
        yield* publish;
        // Under the lock: a hold or a change never interleaves with what a new
        // connection is told (a resume in flight must not undo a hold, ADR 034).
        return ok;
      }).pipe(lock.withPermits(1), Effect.withSpan("listening.reconcile"));

      yield* SubscriptionRef.changes(helper.connection).pipe(
        Stream.runForEach((connection) =>
          Effect.gen(function* () {
            yield* Ref.set(
              confirmed,
              connection.state === "connected" && connection.ready !== null
                ? { ...connection.ready.paused }
                : null,
            );
            if (connection.state === "connected") yield* reconcile;
            else yield* publish;
          }),
        ),
        Effect.forkScoped,
      );

      const holdMicrophone = (on: boolean) =>
        Effect.gen(function* () {
          yield* Ref.set(held, on);
          yield* helper.setPausedSources(yield* effective);
          const actual = yield* Ref.get(confirmed);
          const intent = yield* Ref.get(desired);
          if (actual === null) {
            // Away: the next connection pauses what `effective` says before
            // `config`, but a helper with no client keeps capturing as it was,
            // whatever the intent says since: only its word counts.
            if (on)
              return yield* Effect.fail(new HelperUnavailable({ reason: "the helper is away" }));
            return;
          }
          const paused = on || intent.microphone;
          if (actual.microphone !== paused) yield* apply("microphone", paused);
          yield* publish;
        }).pipe(
          lock.withPermits(1),
          Effect.withSpan("listening.hold-microphone", { attributes: { on } }),
        );

      /**
       * Puts back what `record` replaced, unless the user changed it since or
       * a timed pause's end has passed. Callers hold `lock`.
       */
      const putBack = (record: StoredCallListen) =>
        Effect.gen(function* () {
          const flags = loadFlags();
          // What the call set: everything listened to, or everything paused.
          const skip = record.kind === "skip";
          const unchanged = skip
            ? flags.microphone && flags.systemAudio
            : !flags.microphone && !flags.systemAudio;
          // A timed part of the pause whose end has passed is over: only the rest comes back.
          const expired = record.deadline !== null && record.deadline.untilMs <= now();
          const restored =
            expired && record.deadline !== null
              ? withScope(record.flags, record.deadline.scope, false)
              : record.flags;
          const scope = scopeOf(restored);
          if (!unchanged || (!skip && scope === null)) {
            // Changed since, or nothing of the pause is left: nothing to restore.
            log.info("listening.call-ended", { kind: record.kind, restored: false, expired });
            yield* Ref.set(callListen, null);
            optional(CALL_LISTEN_KEY, now(), null);
            yield* publish;
            return;
          }
          const nextDeadline = expired ? null : record.deadline;
          log.info("listening.call-ended", {
            kind: record.kind,
            restored: true,
            scope: scope ?? "none",
            expired,
            timed: nextDeadline !== null,
          });
          // The flags and the deadline as they were, each with its own scope.
          yield* Ref.set(desired, restored);
          yield* Ref.set(deadline, nextDeadline);
          yield* Ref.set(callListen, null);
          yield* Ref.set(changedAt, save(restored, nextDeadline, null, record.pausedAtMs ?? now()));
          yield* helper.setPausedSources(yield* effective);
          yield* Queue.offer(wake, undefined);
          yield* publish;
          // Paused for the call: what was listened to resumes. Listened to: the pause comes back.
          const changed = skip
            ? scopeOf({ microphone: !restored.microphone, systemAudio: !restored.systemAudio })
            : scope;
          yield* (changed === null ? Effect.void : send(changed, !skip)).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                log.warn("listening.call-end-refused", { error: error._tag });
                yield* Queue.offer(retry, undefined);
              }),
            ),
          );
          yield* publish;
        });

      // One lock for both steps: a resume or pause of the user's that comes
      // while an answer is taken back is applied after it, and wins.
      const listenForCall: ListeningService["listenForCall"] = (call) =>
        Effect.gen(function* () {
          const record = loadCallListen();
          if (record?.kind === "skip") {
            yield* putBack(record);
            return yield* publish;
          }
          const flags = yield* Ref.get(desired);
          const scope = scopeOf(flags);
          if (scope === null) return yield* publish;
          log.info("listening.call-listen", { scope, timed: (yield* Ref.get(deadline)) !== null });
          return yield* change(scope, false, null, {
            kind: "listen",
            bundleId: call.bundleId,
            name: call.name,
            sinceMs: now(),
            flags,
            deadline: yield* Ref.get(deadline),
            pausedAtMs: yield* Ref.get(changedAt),
          });
        }).pipe(lock.withPermits(1));

      const skipCall: ListeningService["skipCall"] = (call) =>
        Effect.gen(function* () {
          const record = loadCallListen();
          if (record?.kind === "listen") yield* putBack(record);
          const flags = yield* Ref.get(desired);
          // Already so, or the pause that came back covers everything.
          if (scopeOf(flags) === "all") return yield* publish;
          log.info("listening.call-skip", {});
          return yield* change("all", true, null, {
            kind: "skip",
            bundleId: call.bundleId,
            name: call.name,
            sinceMs: now(),
            flags,
            // Part of it may be paused already, for a while.
            deadline: yield* Ref.get(deadline),
            pausedAtMs: yield* Ref.get(changedAt),
          });
        }).pipe(lock.withPermits(1));

      const endCallListen: ListeningService["endCallListen"] = (call, stillOver) =>
        Effect.gen(function* () {
          // Read again from the database: only what is stored now counts.
          const record = loadCallListen();
          if (record === null || record.bundleId !== call.bundleId) return;
          if (record.sinceMs !== call.sinceMs || !(yield* stillOver)) return;
          yield* putBack(record);
        }).pipe(lock.withPermits(1), Effect.withSpan("listening.call-ended"));

      return Listening.of({
        holdMicrophone,
        intent: Effect.gen(function* () {
          return {
            flags: yield* Ref.get(desired),
            changedAtMs: yield* Ref.get(changedAt),
            forCall: forCallOf(yield* Ref.get(callListen)),
          };
        }),
        listenForCall,
        skipCall,
        endCallListen,
        pause: (scope, untilMs) =>
          Effect.suspend((): Effect.Effect<ListeningStatus, ChangeError | PauseInPast> => {
            const nowMs = now();
            if (untilMs !== undefined && untilMs <= nowMs) {
              return Effect.fail(new PauseInPast({ untilMs, nowMs }));
            }
            return change(scope, true, untilMs ?? null).pipe(lock.withPermits(1));
          }),
        resume: (scope) => change(scope, false, null).pipe(lock.withPermits(1)),
      });
    }),
  );
