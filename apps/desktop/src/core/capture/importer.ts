import { join } from "node:path";
import type { ImportStatus } from "@sondine/db";
import type { HelperEvent } from "@sondine/protocol";
import { Context, Effect, Layer, PubSub, Stream, SubscriptionRef } from "effect";
import { CoreConfig } from "../config";
import { Database } from "../database";
import { HelperClient } from "../helper/helper-client";
import { log } from "../log";
import { CoreState } from "../status/core-state";
import { problem } from "../status/status-model";
import { createCaptureImporter, type CaptureImporter, type ImportResult } from "./capture-importer";

// Events that may carry rows or state the import needs; the others are
// skipped without a span. The snapshot's `ack` and `events.dropped` warnings
// reconcile the spool; `activity` attributes the next `system:other` regions,
// and `clock` places `call` and `listen` events on the wall clock.
const importedTypes = new Set<HelperEvent["type"]>([
  "ack",
  "warning",
  "ready",
  "devices",
  "processes",
  "activity",
  "call",
  "listen",
  "clock",
  "track.open",
  "track.update",
  "track.close",
  "commit",
  "region.open",
  "region.close",
]);

/** Counts of committed imports that wrote speech regions, calls or listens. */
export interface RegionWrites {
  /** Region opens and closes from the event stream, and calls or listens that started or ended. */
  readonly live: number;
  /** Spool reconciliations that imported regions: late regions may be anywhere in time. */
  readonly reconciled: number;
}

const writtenStatuses = new Set<ImportStatus>(["inserted", "updated", "clamped"]);

export interface ImporterService {
  readonly importer: CaptureImporter;
  /** Completes once a snapshot's end has been reconciled with the spool (at least once). */
  readonly reconciledOnce: Effect.Effect<void>;
  /** Bumped after the transaction that wrote regions commits; the episode builder follows it. */
  readonly regionWrites: SubscriptionRef.SubscriptionRef<RegionWrites>;
  /** Bumped after each audio commit is imported; near-live text follows it. */
  readonly commits: SubscriptionRef.SubscriptionRef<number>;
  /**
   * Waits until every event the helper client has received so far is
   * handled: after the `shutdown` ack, the runs' last commits and closes.
   * Succeeds with false after `timeoutMs`.
   */
  drain(timeoutMs: number): Effect.Effect<boolean>;
}

export class Importer extends Context.Service<Importer, ImporterService>()(
  "sondine/core/Importer",
) {}

/** Helper events → capture rows (packages/db import functions, idempotent). */
export const importerLayer = Layer.effect(
  Importer,
  Effect.gen(function* () {
    const config = yield* CoreConfig;
    const db = yield* Database;
    const helper = yield* HelperClient;
    const state = yield* CoreState;
    const importer = createCaptureImporter(db, {
      spoolDir: config.spoolDir,
      spoolRoot: join(config.dataDir, config.spoolDir),
    });
    // Subscribe now, before the connection loop starts, so no event is missed.
    const subscription = yield* PubSub.subscribe(helper.events);
    /** Snapshot ends reconciled so far. */
    const snapshots = yield* SubscriptionRef.make(0);
    const regionWrites = yield* SubscriptionRef.make<RegionWrites>({ live: 0, reconciled: 0 });
    const commits = yield* SubscriptionRef.make(0);
    const noteRegions = (event: HelperEvent, result: ImportResult) => {
      const live =
        (result.spansChanged ?? 0) > 0 ||
        ((event.type === "region.open" || event.type === "region.close") &&
          result.statuses.some((status) => writtenStatuses.has(status)));
      const reconciled = (result.reconciled?.regions ?? 0) > 0;
      if (!live && !reconciled) return Effect.void;
      return SubscriptionRef.update(regionWrites, (writes) => ({
        live: writes.live + (live ? 1 : 0),
        reconciled: writes.reconciled + (reconciled ? 1 : 0),
      }));
    };

    const importOne = (event: HelperEvent) =>
      Effect.try({
        try: () => importer.handle(event),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(
        Effect.tap((result) =>
          Effect.annotateCurrentSpan({
            statuses: result.statuses.join(","),
            skipped: result.skipped ?? "",
          }),
        ),
        Effect.tap((result) =>
          Effect.sync(() => {
            const report = result.reconciled;
            if (report === undefined) return;
            const changed =
              report.runsClosed +
              report.runsImported +
              report.chunks +
              report.gaps +
              report.regions;
            if (changed === 0 && report.problems.length === 0) return;
            (report.problems.length === 0 ? log.info : log.warn)("capture.reconciled", {
              trigger: event.type,
              runsClosed: report.runsClosed,
              runsImported: report.runsImported,
              chunks: report.chunks,
              gaps: report.gaps,
              regions: report.regions,
              problems: report.problems.length,
              firstProblem: report.problems[0] ?? null,
            });
          }),
        ),
        Effect.tap(() =>
          event.type === "ack"
            ? SubscriptionRef.update(snapshots, (count) => count + 1)
            : event.type === "commit"
              ? SubscriptionRef.update(commits, (count) => count + 1)
              : Effect.void,
        ),
        Effect.matchEffect({
          onSuccess: (result) =>
            Effect.andThen(
              noteRegions(event, result),
              result.statuses.length === 0
                ? Effect.void
                : state.update((status, nowMs) => ({
                    ...status,
                    importer: { ...status.importer, imported: status.importer.imported + 1 },
                    updatedAtMs: nowMs,
                  })),
            ),
          onFailure: (error) =>
            Effect.gen(function* () {
              log.warn("import.failed", {
                event: event.type,
                error: error.name,
                message: error.message,
              });
              yield* state.update((status, nowMs) => ({
                ...status,
                importer: {
                  ...status.importer,
                  errors: status.importer.errors + 1,
                  lastError: problem(
                    `import.${event.type}`,
                    `${error.name}: ${error.message}`,
                    nowMs,
                  ),
                },
                updatedAtMs: nowMs,
              }));
            }),
        }),
        Effect.withSpan("capture.import", { attributes: { type: event.type } }),
      );

    // Events taken from the subscription (imported or not), against `helper.received()`.
    const handled = yield* SubscriptionRef.make(0);
    yield* PubSub.take(subscription).pipe(
      Effect.flatMap((event) => (importedTypes.has(event.type) ? importOne(event) : Effect.void)),
      Effect.andThen(SubscriptionRef.update(handled, (count) => count + 1)),
      Effect.forever,
      Effect.forkScoped,
    );
    const drain = (timeoutMs: number) => {
      const target = helper.received();
      return SubscriptionRef.changes(handled).pipe(
        Stream.filter((count) => count >= target),
        Stream.take(1),
        Stream.runDrain,
        Effect.as(true),
        Effect.timeoutOrElse({
          duration: `${timeoutMs} millis`,
          orElse: () => Effect.succeed(false),
        }),
      );
    };
    const reconciledOnce = SubscriptionRef.changes(snapshots).pipe(
      Stream.filter((count) => count > 0),
      Stream.take(1),
      Stream.runDrain,
    );
    return Importer.of({ importer, reconciledOnce, drain, regionWrites, commits });
  }),
);
