import {
  checkpointTruncate,
  endOfEpisode,
  loadEpisodeSizeInput,
  recordEnd,
  type DroppedEpisodes,
  type StoredEnd,
} from "@sondine/db";
import { Context, Effect, Layer, Stream, SubscriptionRef } from "effect";
import { AnalysisQueue } from "../analysis/analysis-layer";
import { Importer } from "../capture/importer";
import { Database } from "../database";
import { log } from "../log";
import { runEpisodePass, type PassReport } from "./episode-pass";

// Runs the grouping pass (ADR 016, "Episodes") after each import batch that
// wrote regions or started or ended a call, and every 15 s while an episode
// is open. The importer bumps its counter after its transaction commits, so a
// pass never reads before the rows it was woken for.

export type EndOutcome =
  /** The end is kept; the episode closes within seconds. */
  | { readonly outcome: "ended"; readonly end: StoredEnd }
  /** It was already over, or already ended. */
  | { readonly outcome: "over" }
  | { readonly outcome: "missing" }
  | { readonly outcome: "failed" };

export interface EpisodeBuilderService {
  /** One pass now; null when it failed (logged, retried on the next tick). */
  readonly pass: Effect.Effect<PassReport | null>;
  /**
   * « Terminer » (ADR 044): the open episode ends now, and what is said next
   * opens another. It never touches what Sondine listens to.
   */
  readonly end: (episodeId: number) => Effect.Effect<EndOutcome>;
  /** Passes until the ended episode is closed, a few seconds at most. */
  readonly settled: (episodeId: number) => Effect.Effect<void>;
  /** The same, in the background; `onEnded` tells when. */
  readonly follow: (episodeId: number) => Effect.Effect<void>;
  /** Called once an ended episode closed. */
  readonly onEnded: (listener: () => void) => () => void;
  /** The wall clock episodes are built on (capture time), for ranges such as « the last 5 min ». */
  readonly now: () => number;
  /**
   * Called in the turn a pass deleted episodes of a site the user leaves out
   * (ADR 023), after the WAL was truncated: what a deletion owes the rest
   * (undo history, agents' answers, the audio's scrub) is the listener's.
   */
  readonly onDropped: (listener: (dropped: DroppedEpisodes) => void) => () => void;
}

export class EpisodeBuilder extends Context.Service<EpisodeBuilder, EpisodeBuilderService>()(
  "sondine/core/EpisodeBuilder",
) {}

/** Passes in a row before the usual pace takes over (audio that does not come). */
const END_TRIES = 40;

export interface EpisodeBuilderOptions {
  /** Passes while an episode is open. */
  readonly intervalMs?: number;
  /** Passes while an episode the user ended waits for its audio. */
  readonly endIntervalMs?: number;
  /** Coalesces bursts of region writes. */
  readonly debounceMs?: number;
  /** Wall clock; tests run it ahead. */
  readonly now?: () => number;
}

export const episodeBuilderLayer = (options: EpisodeBuilderOptions = {}) =>
  Layer.effect(
    EpisodeBuilder,
    Effect.gen(function* () {
      const db = yield* Database;
      const importer = yield* Importer;
      const queue = yield* AnalysisQueue;
      const now = options.now ?? Date.now;
      // Startup scans everything: late regions may have arrived while core was down.
      let fullScan = true;
      let openAfter = 0;
      let lastReconciled = (yield* SubscriptionRef.get(importer.regionWrites)).reconciled;
      const droppedListeners = new Set<(dropped: DroppedEpisodes) => void>();
      const endedListeners = new Set<() => void>();
      const scope = yield* Effect.scope;

      const pass = Effect.sync((): PassReport | null => {
        try {
          const report = runEpisodePass(db, { nowMs: now(), fullScan });
          fullScan = false;
          openAfter = report.openAfter;
          // Context whose audio left every episode went too (ADR 024): a deletion as well.
          if (report.dropped.episodeIds.length > 0 || report.contextRemoved > 0) {
            checkpointTruncate(db);
            log.info("episodes.dropped", {
              episodes: report.dropped.episodeIds.length,
              chunks: report.dropped.chunks.length,
              context: report.contextRemoved,
            });
            for (const listener of droppedListeners) listener(report.dropped);
          }
          if (report.enqueued.length > 0) queue.wake();
          const changes =
            report.created.length +
            report.closed.length +
            report.bumped.length +
            report.deleted.length +
            report.repaired.length;
          if (changes > 0) {
            log.info("episodes.pass", {
              created: report.created.length,
              closed: report.closed.length,
              bumped: report.bumped.length,
              deleted: report.deleted.length,
              repaired: report.repaired.length,
              enqueued: report.enqueued.length,
              open: report.openAfter,
              unplaced: report.unplaced,
            });
          }
          return report;
        } catch (error) {
          // Try again on the next tick.
          openAfter = Math.max(openAfter, 1);
          log.warn("episodes.pass-failed", {
            message: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      }).pipe(Effect.withSpan("episodes.pass"));

      yield* pass;
      yield* SubscriptionRef.changes(importer.regionWrites).pipe(
        Stream.debounce(`${options.debounceMs ?? 250} millis`),
        Stream.runForEach((writes) =>
          Effect.suspend(() => {
            if (writes.reconciled !== lastReconciled) {
              lastReconciled = writes.reconciled;
              fullScan = true;
            }
            return pass;
          }),
        ),
        Effect.forkScoped,
      );
      // Closing needs time to pass (the gap) and the import watermark to move.
      yield* Effect.suspend(() => (openAfter > 0 ? pass : Effect.void)).pipe(
        Effect.delay(`${options.intervalMs ?? 15_000} millis`),
        Effect.forever,
        Effect.forkScoped,
      );
      const stateOf = (episodeId: number) => loadEpisodeSizeInput(db, episodeId)?.state ?? null;
      const settled = (episodeId: number): Effect.Effect<void> =>
        Effect.gen(function* () {
          for (let tries = 0; tries < END_TRIES && stateOf(episodeId) === "open"; tries += 1) {
            yield* Effect.sleep(`${options.endIntervalMs ?? 500} millis`);
            yield* pass;
          }
        });
      const follow = (episodeId: number): Effect.Effect<void> =>
        settled(episodeId).pipe(
          Effect.andThen(
            Effect.sync(() => {
              for (const listener of endedListeners) listener();
            }),
          ),
          Effect.forkIn(scope),
          Effect.asVoid,
        );
      const end = (episodeId: number): Effect.Effect<EndOutcome> =>
        Effect.gen(function* () {
          // First what is known now: it may be over on its own.
          const report = yield* pass;
          const state = stateOf(episodeId);
          if (state === null) return { outcome: "missing" } as const;
          if (state === "closed" || endOfEpisode(db, episodeId) !== null) {
            return { outcome: "over" } as const;
          }
          const point = report?.endPoints.get(episodeId);
          const nowMs = now();
          const kept = point === undefined ? null : recordEnd(db, { episodeId, ...point, nowMs });
          if (kept === null) return { outcome: "failed" } as const;
          log.info("episodes.ended", { episodeId });
          yield* pass;
          yield* follow(episodeId);
          return { outcome: "ended", end: kept } as const;
        });
      return EpisodeBuilder.of({
        pass,
        end,
        settled,
        follow,
        onEnded(listener) {
          endedListeners.add(listener);
          return () => endedListeners.delete(listener);
        },
        now,
        onDropped(listener) {
          droppedListeners.add(listener);
          return () => droppedListeners.delete(listener);
        },
      });
    }),
  );
