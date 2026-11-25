import {
  OnboardingGoal,
  OnboardingStep,
  type ListeningStatus,
  type OnboardingCompleteResult,
  type OnboardingStatus,
} from "@sondine/api";
import { Context, Effect, Layer, SubscriptionRef } from "effect";
import * as z from "zod";
import { Database } from "./database";
import type { HelperRequestError } from "./helper/helper-client";
import { Listening } from "./listening";
import { log } from "./log";
import { CoreState } from "./status/core-state";

// The first run (architecture §11). Its progress is durable in the settings
// table, apart from the listening intent (Listening), the permissions (the
// helper's status) and the model (Models), which each keep their own state.
//
// - A fresh install (no setting, nothing ever captured) pauses listening
//   before the helper connects, so nothing is recorded until the user starts
//   listening at the end of the first run (`complete`).
// - An install that already captured audio (any track run in the database)
//   counts as done; its listening intent is left as it was.
// - The step on screen is saved as the user moves (`advance`): granting the
//   microphone may relaunch the app, which then reopens at that step.

const SETTINGS_KEY = "onboarding";

const Stored = z.strictObject({
  origin: z.enum(["first-run", "existing-install"]),
  step: OnboardingStep,
  startedAtMs: z.number(),
  completedAtMs: z.number().nullable(),
  // Added with ADR 037: older rows read as not chosen.
  goal: OnboardingGoal.nullable().default(null),
  cloudNotify: z.boolean().default(false),
});
type Stored = z.output<typeof Stored>;

export interface OnboardingService {
  get(): OnboardingStatus;
  /**
   * Saves the step on screen (ignored once the first run is done), and the
   * goal and « Me prévenir » when given (kept at any time).
   */
  advance(input: {
    readonly step: OnboardingStep;
    readonly goal?: OnboardingGoal | undefined;
    readonly cloudNotify?: boolean | undefined;
  }): OnboardingStatus;
  /**
   * Ends the first run, once: with `startListening`, resumes listening first
   * (the first run stays open if the helper refuses). Later calls change
   * nothing and return the current state.
   */
  complete(
    startListening: boolean,
  ): Effect.Effect<
    OnboardingCompleteResult,
    Exclude<HelperRequestError, { _tag: "HelperUnavailable" }>
  >;
}

export class Onboarding extends Context.Service<Onboarding, OnboardingService>()(
  "sondine/core/Onboarding",
) {}

export interface OnboardingOptions {
  /**
   * Treats an empty database as an install that already captured. For tests
   * that exercise capture, which a first run would keep paused.
   */
  readonly skipFirstRun?: boolean;
  readonly now?: () => number;
}

const toStatus = (stored: Stored): OnboardingStatus => ({
  completed: stored.completedAtMs !== null,
  completedAtMs: stored.completedAtMs,
  origin: stored.origin,
  step: stored.step,
  goal: stored.goal,
  cloudNotify: stored.cloudNotify,
});

export const onboardingLayer = (options: OnboardingOptions = {}) =>
  Layer.effect(
    Onboarding,
    Effect.gen(function* () {
      const db = yield* Database;
      const listening = yield* Listening;
      const state = yield* CoreState;
      const now = options.now ?? Date.now;

      const load = (): Stored | null => {
        const raw = db.statement("SELECT value FROM settings WHERE key = ?").get(SETTINGS_KEY)?.[
          "value"
        ];
        if (typeof raw !== "string") return null;
        try {
          const parsed = Stored.safeParse(JSON.parse(raw));
          return parsed.success ? parsed.data : null;
        } catch {
          return null;
        }
      };
      const persist = (next: Stored) => {
        db.statement(
          "INSERT INTO settings (key, value, updated_at_ms) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms",
        ).run(SETTINGS_KEY, JSON.stringify(next), now());
        return next;
      };

      const firstLaunch = Effect.gen(function* () {
        const captured =
          db.statement("SELECT EXISTS (SELECT 1 FROM track_runs) AS captured").get()?.[
            "captured"
          ] === 1;
        if (captured || options.skipFirstRun === true) {
          log.info("onboarding.existing-install");
          return persist({
            origin: "existing-install",
            step: "start",
            startedAtMs: now(),
            completedAtMs: now(),
            goal: null,
            cloudNotify: false,
          });
        }
        // The pause first: a crash before the setting is written starts over here.
        yield* listening
          .pause("all")
          .pipe(
            Effect.catch((error) =>
              Effect.sync(() => log.warn("onboarding.pause", { error: error._tag })),
            ),
          );
        log.info("onboarding.first-run");
        return persist({
          origin: "first-run",
          step: "welcome",
          startedAtMs: now(),
          completedAtMs: null,
          goal: null,
          cloudNotify: false,
        });
      });

      let current: Stored = load() ?? (yield* firstLaunch);
      const save = (next: Stored) => {
        current = persist(next);
      };

      return Onboarding.of({
        get: () => toStatus(current),
        advance: ({ step, goal, cloudNotify }) => {
          const next = {
            ...current,
            step: current.completedAtMs === null ? step : current.step,
            goal: goal ?? current.goal,
            cloudNotify: cloudNotify ?? current.cloudNotify,
          };
          if (
            next.step !== current.step ||
            next.goal !== current.goal ||
            next.cloudNotify !== current.cloudNotify
          ) {
            save(next);
            log.info("onboarding.step", { step: next.step, goal: next.goal ?? "none" });
          }
          return toStatus(current);
        },
        complete: (startListening) =>
          Effect.gen(function* () {
            const at = current;
            let listened: ListeningStatus = (yield* SubscriptionRef.get(state.status)).listening;
            if (at.completedAtMs !== null) return { onboarding: toStatus(at), listening: listened };
            if (startListening) listened = yield* listening.resume("all");
            save({ ...at, step: "start", completedAtMs: now() });
            log.info("onboarding.completed", { startListening });
            return { onboarding: toStatus(current), listening: listened };
          }).pipe(Effect.withSpan("onboarding.complete")),
      });
    }),
  );
