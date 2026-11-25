import {
  closedSpoolFiles,
  planArchive,
  speechRolls,
  spoolBytes,
  type Database,
  type RetentionRolls,
} from "@sondine/db";
import { errorCode } from "../audio/pcm-io";
import type { ReconciliationState } from "../capture/capture-importer";
import { archiveAndEvict, type ArchiveStep, type FileOutcome } from "./archiver";
import { manifestWait, regionRecordHorizonMs, runWait, type WaitReason } from "./guards";
import type { RetentionLayout } from "./layout";

// One retention pass over the closed spool files, oldest first. A file is due
// once it is 24 h old, or while the spool is over its cap; due files go one at
// a time (the caller yields between them), at most `maxFilesPerPass` per pass.

export interface RetentionPolicy {
  /** A closed spool file older than this is due (architecture §3: 24 h). */
  readonly maxAgeMs: number;
  /** While the spool holds more, its oldest closed files are due (4 GiB). */
  readonly capBytes: number;
  /** Bounded work per pass; the rest waits for the next pass. */
  readonly maxFilesPerPass: number;
  readonly rolls: RetentionRolls;
  /** How far after a file its regions' records may be (see `regionRecordHorizonMs`). */
  readonly regionRecordHorizonMs: number;
}

export const retentionPolicy: RetentionPolicy = {
  maxAgeMs: 24 * 60 * 60 * 1_000,
  capBytes: 4 * 1024 ** 3,
  // Two tracks rotate a file every 10 min each; 48 files is 4 h of backlog per pass.
  maxFilesPerPass: 48,
  rolls: speechRolls,
  regionRecordHorizonMs,
};

export interface RetentionPassInput {
  readonly nowMs: number;
  /** Read before each file: what the last spool reconciliation vouches for. */
  readonly reconciliation: () => ReconciliationState;
  readonly policy?: RetentionPolicy;
  /** Crash tests: called after each protocol step of each file. */
  readonly afterStep?: (step: ArchiveStep, spoolFileId: number) => void;
}

export interface RetentionPassReport {
  /** Closed files past retention (age or cap). */
  readonly due: number;
  readonly evicted: number;
  /** Due files that wait for a guard (see `reasons`). */
  readonly waiting: number;
  /** Due files left for the next pass by the per-pass bound. */
  readonly deferred: number;
  /** Due files whose processing threw. */
  readonly failed: number;
  readonly archivedChunks: number;
  readonly archivedBytes: number;
  readonly expiredChunks: number;
  /** Spool bytes removed. */
  readonly freedBytes: number;
  /** Spool bytes still on disk after the pass. */
  readonly spoolBytes: number;
  readonly reasons: Readonly<Partial<Record<WaitReason, number>>>;
  /** The first file that waited or failed, as a code and a message without paths or content. */
  readonly firstProblem: { readonly code: string; readonly message: string } | null;
}

/** Runs the guards, then the archive protocol, for one due spool file. */
function processSpoolFile(
  db: Database,
  layout: RetentionLayout,
  spoolFileId: number,
  reconciliation: ReconciliationState,
  policy: RetentionPolicy = retentionPolicy,
  afterStep?: (step: ArchiveStep) => void,
): FileOutcome | null {
  const plan = planArchive(db, spoolFileId, policy.rolls);
  // Expired or deleted since the pass listed it.
  if (plan === undefined || plan.file.state !== "closed") return null;
  const reason =
    runWait(reconciliation, plan.file) ??
    (plan.openRegions > 0 ? "open_region" : null) ??
    manifestWait(db, layout, plan, policy.rolls, policy.regionRecordHorizonMs);
  if (reason !== null) return { kind: "waiting", reason };
  return archiveAndEvict(db, layout, plan, policy.rolls, afterStep);
}

/** The pass as steps: it yields after each file it processed and returns the report. */
export function* retentionPass(
  db: Database,
  layout: RetentionLayout,
  input: RetentionPassInput,
): Generator<void, RetentionPassReport, void> {
  const policy = input.policy ?? retentionPolicy;
  const counts = {
    due: 0,
    evicted: 0,
    waiting: 0,
    deferred: 0,
    failed: 0,
    archivedChunks: 0,
    archivedBytes: 0,
    expiredChunks: 0,
    freedBytes: 0,
  };
  const reasons: Partial<Record<WaitReason, number>> = {};
  let firstProblem: RetentionPassReport["firstProblem"] = null;
  let remaining = spoolBytes(db);
  let processed = 0;

  for (const file of closedSpoolFiles(db)) {
    const aged = (file.closedWallMs ?? file.createdWallMs) <= input.nowMs - policy.maxAgeMs;
    if (!aged && remaining <= policy.capBytes) continue;
    counts.due += 1;
    if (processed >= policy.maxFilesPerPass) {
      // Counted as going, so the cap does not make newer files due behind it.
      counts.deferred += 1;
      remaining -= file.committedBytes;
      continue;
    }
    processed += 1;
    let outcome: FileOutcome | null;
    try {
      outcome = processSpoolFile(
        db,
        layout,
        file.id,
        input.reconciliation(),
        policy,
        input.afterStep === undefined ? undefined : (step) => input.afterStep?.(step, file.id),
      );
    } catch (error) {
      counts.failed += 1;
      firstProblem ??= {
        code: "retention.failed",
        message: `spool file ${file.id}: ${errorCode(error)}`,
      };
      yield;
      continue;
    }
    if (outcome === null) {
      counts.due -= 1;
    } else if (outcome.kind === "evicted") {
      counts.evicted += 1;
      counts.archivedChunks += outcome.archivedChunks;
      counts.archivedBytes += outcome.archivedBytes;
      counts.expiredChunks += outcome.expiredChunks;
      counts.freedBytes += outcome.freedBytes;
      remaining -= outcome.freedBytes;
    } else {
      counts.waiting += 1;
      reasons[outcome.reason] = (reasons[outcome.reason] ?? 0) + 1;
      firstProblem ??= {
        code: `retention.${outcome.reason}`,
        message: `spool file ${file.id} waits: ${outcome.reason}`,
      };
    }
    yield;
  }
  return { ...counts, spoolBytes: spoolBytes(db), reasons, firstProblem };
}

/** Runs a whole pass without yielding (tests, tools). */
export function runRetentionPass(
  db: Database,
  layout: RetentionLayout,
  input: RetentionPassInput,
): RetentionPassReport {
  const steps = retentionPass(db, layout, input);
  for (;;) {
    const step = steps.next();
    if (step.done === true) return step.value;
  }
}
