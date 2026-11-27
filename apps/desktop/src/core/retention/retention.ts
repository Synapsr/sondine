import { audioExpiryDue, unscrubbedChunks } from "@sondine/db";
import { Cause, Context, Effect, Layer, Semaphore, Stream, SubscriptionRef } from "effect";
import { DATA_LAYOUT } from "../../shared/data-layout";
import { Importer } from "../capture/importer";
import type { ReconciliationState } from "../capture/capture-importer";
import { CoreConfig } from "../config";
import { Database } from "../database";
import { HelperClient } from "../helper/helper-client";
import { log } from "../log";
import { CoreState } from "../status/core-state";
import { problem } from "../status/status-model";
import {
  expireArchivedAudio,
  recoverRetention,
  scrubChunks,
  type ScrubbableChunk,
  type ScrubReport,
} from "./archiver";
import type { RetentionLayout } from "./layout";
import { retentionPass, type RetentionPassReport } from "./pass";

// Spool retention in core (ADR 016): after the first reconciliation of the
// spool, recover what a crash interrupted, then run a pass now and every
// 10 min. Passes, recovery and scrubs never overlap; a pass yields between
// files so helper events keep flowing. Capture itself never waits on this.

const PASS_INTERVAL = "10 minutes";

/** Archived audio above this goes, oldest first (ADR 015). */
export const ARCHIVE_CAP_BYTES = 20 * 1024 ** 3;

export interface AudioExpiryReport {
  readonly episodes: number;
  readonly forCap: number;
  readonly chunks: number;
  readonly bytes: number;
  readonly filesRemoved: number;
}

export interface RetentionService {
  /** Runs one pass now (after startup recovery, once). */
  readonly runPass: Effect.Effect<RetentionPassReport>;
  /**
   * Zeroes the bytes of chunks `deleteEpisode` just marked deleted, in the
   * spool and in the archive, and syncs them. Call it right after the delete.
   */
  scrub(chunks: readonly ScrubbableChunk[]): Effect.Effect<ScrubReport>;
  /**
   * Runs `work` after startup recovery, alone with passes and scrubs: an
   * imported recording publishes its archive file and rows through it, so
   * recovery never takes a file whose rows are not written yet. `archiveBytes`
   * joins the archive's count once `work` returned.
   */
  exclusive<A>(work: () => A, archiveBytes: number): Effect.Effect<A>;
  /**
   * Runs `work` after startup recovery, alone with passes, scrubs and expiry:
   * a backup (ADR 048) copies the archive while no file of it moves. `work`
   * must not throw; a scrub waits for it, so it stops when a deletion comes.
   */
  hold<A>(work: () => Promise<A>): Effect.Effect<A>;
  /**
   * Lets the audio whose time is up go, then the oldest while the archive is
   * over its cap (ADR 015, ADR 029); text stays. Kept audio never goes.
   */
  readonly expireAudio: Effect.Effect<AudioExpiryReport>;
}

export class Retention extends Context.Service<Retention, RetentionService>()(
  "sondine/core/Retention",
) {}

const unreconciled: ReconciliationState = {
  reconciled: false,
  liveRuns: new Set(),
  problemRuns: new Set(),
};

export const retentionLayer = Layer.effect(
  Retention,
  Effect.gen(function* () {
    const config = yield* CoreConfig;
    const db = yield* Database;
    const importer = yield* Importer;
    const helper = yield* HelperClient;
    const state = yield* CoreState;
    const layout: RetentionLayout = {
      dataDir: config.dataDir,
      spoolDir: config.spoolDir,
      archiveDir: DATA_LAYOUT.archiveDir,
    };
    const lock = yield* Semaphore.make(1);

    // Reconciliation vouches only for the connected helper's session.
    let connected = false;
    yield* SubscriptionRef.changes(helper.connection).pipe(
      Stream.runForEach((connection) =>
        Effect.sync(() => {
          connected = connection.state === "connected";
        }),
      ),
      Effect.forkScoped,
    );
    const reconciliation = () => (connected ? importer.importer.reconciliation() : unreconciled);

    let recovered = false;
    let archivedBytes = 0;
    /**
     * Deleted chunks left in a run's newest spool file. The run rotates its
     * file every 10 min, so the next passes zero them: deleted audio leaves
     * the disk within about 20 min, not at eviction 24 h later.
     */
    let deferred: readonly ScrubbableChunk[] = [];
    /** Audio startup recovery found lost; shown until core restarts. */
    let lostChunks = 0;

    const recover = Effect.sync(() => {
      if (recovered) return;
      const report = recoverRetention(db, layout);
      recovered = true;
      archivedBytes = report.archivedBytes;
      // A restart before the run rotated: its deleted bytes still wait.
      deferred = report.deferred;
      lostChunks = report.lostChunks;
      (report.lostChunks > 0 ? log.warn : log.info)("retention.recovered", {
        tmpRemoved: report.tmpRemoved,
        orphansRemoved: report.orphansRemoved,
        spoolUnlinked: report.spoolUnlinked,
        rearchive: report.rearchive,
        lostChunks: report.lostChunks,
        rescrubbed: report.rescrubbed,
        deferred: report.deferred.length,
        archivedBytes: report.archivedBytes,
      });
    }).pipe(Effect.withSpan("retention.recover"));

    const pass = Effect.gen(function* () {
      yield* recover;
      const steps = retentionPass(db, layout, { nowMs: Date.now(), reconciliation });
      let step = steps.next();
      while (step.done !== true) {
        yield* Effect.yieldNow;
        step = steps.next();
      }
      const report = step.value;
      archivedBytes += report.archivedBytes;
      if (deferred.length > 0) {
        // A file retention evicted took its bytes along: those leave the list.
        const onDisk = new Set(unscrubbedChunks(db).map((chunk) => chunk.chunkId));
        const retry = scrubChunks(
          db,
          layout,
          deferred.filter((chunk) => onDisk.has(chunk.chunkId)),
        );
        deferred = retry.deferred;
        if (retry.zeroed > 0) log.info("retention.scrubbed-later", { chunks: retry.zeroed });
      }
      const { reasons, firstProblem, ...counts } = report;
      // Quiet while nothing is due.
      if (report.due > 0) {
        (report.waiting + report.failed > 0 ? log.warn : log.info)("retention.pass", {
          ...counts,
          archivedTotalBytes: archivedBytes,
          reasons: Object.entries(reasons)
            .map(([reason, count]) => `${reason}:${count}`)
            .join(","),
        });
      }
      yield* state.update((status, nowMs) => ({
        ...status,
        retention: {
          spoolBytes: report.spoolBytes,
          archivedBytes,
          blocked: report.waiting + report.failed,
          lastProblem:
            firstProblem !== null
              ? problem(firstProblem.code, firstProblem.message, nowMs)
              : lostChunks > 0
                ? problem(
                    "retention.archive_missing",
                    `${lostChunks} archived chunks lost their archive at startup`,
                    nowMs,
                  )
                : null,
        },
        updatedAtMs: nowMs,
      }));
      return report;
    }).pipe(lock.withPermits(1), Effect.withSpan("retention.pass"));

    const scrub = (chunks: readonly ScrubbableChunk[]) =>
      Effect.sync(() => {
        const report = scrubChunks(db, layout, chunks);
        if (recovered) archivedBytes = Math.max(0, archivedBytes - report.archiveBytes);
        deferred = [...deferred, ...report.deferred];
        return report;
      }).pipe(lock.withPermits(1), Effect.withSpan("retention.scrub"));

    const failed = (cause: Cause.Cause<unknown>) =>
      Effect.gen(function* () {
        const error = Cause.squash(cause);
        const name = error instanceof Error ? error.name : "unknown error";
        log.error("retention.failed", { error: name });
        yield* state.update((status, nowMs) => ({
          ...status,
          retention: {
            ...status.retention,
            lastProblem: problem("retention.failed", name, nowMs),
          },
          updatedAtMs: nowMs,
        }));
      });

    yield* importer.reconciledOnce.pipe(
      Effect.andThen(
        pass.pipe(
          Effect.asVoid,
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : failed(cause),
          ),
          Effect.andThen(Effect.sleep(PASS_INTERVAL)),
          Effect.forever,
        ),
      ),
      Effect.forkScoped,
    );

    const exclusive = <A>(work: () => A, archiveBytes: number) =>
      recover.pipe(
        Effect.andThen(
          Effect.sync(() => {
            const result = work();
            archivedBytes += archiveBytes;
            return result;
          }),
        ),
        lock.withPermits(1),
      );

    const hold = <A>(work: () => Promise<A>) =>
      recover.pipe(Effect.andThen(Effect.promise(work)), lock.withPermits(1));

    const expireAudio = recover.pipe(
      Effect.andThen(
        Effect.sync((): AudioExpiryReport => {
          const nowMs = Date.now();
          const expiry = audioExpiryDue(db, { nowMs, capBytes: ARCHIVE_CAP_BYTES });
          if (expiry.episodeIds.length === 0) {
            return { episodes: 0, forCap: 0, chunks: 0, bytes: 0, filesRemoved: 0 };
          }
          const done = expireArchivedAudio(db, layout, expiry, nowMs);
          archivedBytes = Math.max(0, archivedBytes - done.bytes);
          (expiry.forCap > 0 ? log.warn : log.info)("retention.audio-expired", {
            episodes: expiry.episodeIds.length,
            forCap: expiry.forCap,
            chunks: done.chunks,
            bytes: done.bytes,
            filesRemoved: done.filesRemoved,
          });
          return { episodes: expiry.episodeIds.length, forCap: expiry.forCap, ...done };
        }),
      ),
      lock.withPermits(1),
      Effect.withSpan("retention.expire-audio"),
    );

    return Retention.of({ runPass: pass, scrub, exclusive, hold, expireAudio });
  }),
);
