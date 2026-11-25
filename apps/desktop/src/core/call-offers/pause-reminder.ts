import { Context, Effect, Layer, Queue, Stream, SubscriptionRef } from "effect";
import { SystemSignals } from "../analysis/analysis-layer";
import { Database } from "../database";
import { Listening } from "../listening";
import { log } from "../log";
import { Onboarding } from "../onboarding";
import { CoreState } from "../status/core-state";
import { reminderDue, USED_WITHIN_S } from "./pause-reminder-model";

// A pause forgotten (ADR 036): once per pause with no end, when it has lasted
// 3 h and someone is at the Mac, `ListeningStatus.pauseReminder` says since
// when; main shows it, beside the notch or as a notification. It changes
// nothing on its own. The pause it was said for is stored before it is said,
// so a restart never says it twice. One timer, only during such a pause.

/** The pause already said: when it was taken. */
const SAID_KEY = "capture.pause-reminded";

export class PauseReminder extends Context.Service<PauseReminder, { readonly started: true }>()(
  "sondine/core/PauseReminder",
) {}

export interface PauseReminderOptions {
  readonly now?: () => number;
  readonly afterMs?: number;
  /** Once due, how often it looks whether someone is there. */
  readonly checkIntervalMs?: number;
}

export const REMIND_AFTER_MS = 3 * 60 * 60_000;
/** Longer than any wait before a pause is due; a clock set back never makes a timer overflow. */
const MAX_TIMER_MS = REMIND_AFTER_MS;

export const pauseReminderLayer = (options: PauseReminderOptions = {}) =>
  Layer.effect(
    PauseReminder,
    Effect.gen(function* () {
      const db = yield* Database;
      const listening = yield* Listening;
      const onboarding = yield* Onboarding;
      const signals = yield* SystemSignals;
      const state = yield* CoreState;
      const now = options.now ?? Date.now;
      const afterMs = options.afterMs ?? REMIND_AFTER_MS;
      const checkIntervalMs = options.checkIntervalMs ?? 60_000;
      const wake = yield* Queue.sliding<void>(1);

      const said = (): number | null => {
        const raw = db.statement("SELECT value FROM settings WHERE key = ?").get(SAID_KEY)?.[
          "value"
        ];
        const value = typeof raw === "string" ? Number(raw) : Number.NaN;
        return Number.isFinite(value) ? value : null;
      };

      const publish = (sinceMs: number | null) =>
        state.update((status) =>
          (status.listening.pauseReminder?.sinceMs ?? null) === sinceMs
            ? status
            : {
                ...status,
                listening: {
                  ...status.listening,
                  pauseReminder: sinceMs === null ? null : { sinceMs },
                },
              },
        );

      /** The open-ended pause to say, and when; null when there is none. */
      const due = Effect.gen(function* () {
        const { flags, changedAtMs, forCall } = yield* listening.intent;
        const status = yield* SubscriptionRef.get(state.status);
        return reminderDue({
          flags,
          pausedSinceMs: changedAtMs,
          pausedUntilMs: status.listening.pausedUntilMs,
          forCall: forCall !== null,
          onboarded: onboarding.get().completed,
          saidForMs: said(),
          afterMs,
        });
      });

      yield* Effect.gen(function* () {
        for (;;) {
          const pause = yield* due;
          if (pause === null) {
            yield* Queue.take(wake);
            continue;
          }
          if (now() >= pause.atMs) {
            const sample = yield* Effect.promise(() => signals.cheap().catch(() => null));
            const status = yield* SubscriptionRef.get(state.status);
            const used =
              sample !== null &&
              !sample.locked &&
              sample.idleSeconds !== null &&
              sample.idleSeconds < USED_WITHIN_S;
            // Asked again: the intent may have changed while main answered.
            const still = yield* due;
            // Confirmed: « Rien n'est enregistré » is never said of a pause the helper refused.
            const paused = status.listening.effective === "paused";
            if (used && paused && !status.power.suspended && still?.sinceMs === pause.sinceMs) {
              db.statement(
                `INSERT INTO settings (key, value, updated_at_ms) VALUES (?, ?, ?)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms`,
              ).run(SAID_KEY, String(pause.sinceMs), now());
              log.info("listening.pause-reminder", {
                hours: Math.floor((now() - pause.sinceMs) / 3_600_000),
              });
              yield* publish(pause.sinceMs);
              continue;
            }
          }
          // A wake of the Mac looks again at once; once due, until someone is there.
          const waitMs = Math.min(
            pause.atMs > now() ? pause.atMs - now() : checkIntervalMs,
            MAX_TIMER_MS,
          );
          yield* Queue.take(wake).pipe(
            Effect.timeoutOrElse({ duration: `${waitMs} millis`, orElse: () => Effect.void }),
          );
        }
      }).pipe(Effect.forkScoped);

      // The intent changed, or the Mac woke: look again, and take back what no longer holds.
      yield* SubscriptionRef.changes(state.status).pipe(
        Stream.map(
          ({ listening: l, power }) =>
            `${l.desired}:${l.effective}:${l.changedAtMs}:${l.pausedUntilMs}:${l.forCall === null}:${power.suspended}`,
        ),
        Stream.changes,
        Stream.runForEach(() =>
          Effect.gen(function* () {
            const { flags, changedAtMs } = yield* listening.intent;
            const { pauseReminder: shown, effective } = (yield* SubscriptionRef.get(state.status))
              .listening;
            const holds =
              flags.microphone &&
              flags.systemAudio &&
              effective === "paused" &&
              shown?.sinceMs === changedAtMs;
            if (shown !== null && !holds) yield* publish(null);
            yield* Queue.offer(wake, undefined);
          }),
        ),
        Effect.forkScoped,
      );
      return PauseReminder.of({ started: true });
    }),
  );
