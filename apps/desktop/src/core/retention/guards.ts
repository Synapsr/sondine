import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  commitLeftOut,
  msToSamples,
  regionImportState,
  samplesToMs,
  speechRolls,
  type ArchivePlan,
  type Database,
  type RetentionRolls,
  type RetentionSpoolFile,
} from "@sondine/db";
import { BYTES_PER_SAMPLE } from "@sondine/protocol";
import { isMissing } from "../audio/pcm-io";
import type { ReconciliationState } from "../capture/capture-importer";
import { parseManifest, type ManifestFile } from "../capture/spool-reconciler";
import { parseLayoutPath, type RetentionLayout } from "./layout";

// A spool file may lose its unselected audio only when nothing the database
// does not know yet could select it (ADR 016): the run is vouched for by the
// last reconciliation, no open region reaches the file, and the manifests
// hold no commit or region that the database lacks (a missed event).

/** Why an eligible spool file keeps waiting. Codes only; never paths or content. */
export type WaitReason =
  /** The connected helper's snapshot is not reconciled yet (or no helper is connected). */
  | "not_reconciled"
  /** Reconciling the file's run reported a problem since the snapshot. */
  | "run_problem"
  /** The run is open in the database but the connected helper does not report it. */
  | "run_not_live"
  | "open_region"
  /** The run is open and has not committed far enough past the file for its regions to be closed. */
  | "awaiting_manifests"
  | "manifest_unreadable"
  | "unimported_commit"
  | "unimported_region"
  | "spool_unreadable"
  | "crc_mismatch"
  /** The chunks changed while they were archived; the next pass tries again. */
  | "archive_conflict";

export function runWait(
  state: ReconciliationState,
  file: Pick<RetentionSpoolFile, "runUid" | "runState">,
): WaitReason | null {
  if (!state.reconciled) return "not_reconciled";
  if (state.problemRuns.has(file.runUid)) return "run_problem";
  if (file.runState === "open" && !state.liveRuns.has(file.runUid)) return "run_not_live";
  return null;
}

/**
 * The helper cuts speech regions at 60 s (`maxSegmentMs`) and writes a closed
 * region into the manifest of the file current at its next commit (2 s): every
 * region that can reach a file is recorded within this distance after it.
 */
export const regionRecordHorizonMs = 120_000 + 10_000;

export function manifestWait(
  db: Database,
  layout: RetentionLayout,
  plan: ArchivePlan,
  rolls: RetentionRolls = speechRolls,
  horizonMs = regionRecordHorizonMs,
): WaitReason | null {
  const { file } = plan;
  const name = parseLayoutPath(file.relPath, layout.spoolDir);
  if (name === null) return "manifest_unreadable";
  const runDir = join(layout.dataDir, layout.spoolDir, name.trackDir, name.runId);
  const manifests = listManifests(runDir);
  if (manifests === null) return "manifest_unreadable";

  const own = readManifest(manifests.get(file.seq), file.runUid, file.seq);
  if (own === null) return "manifest_unreadable";
  if (!commitsImported(db, plan, own)) return "unimported_commit";
  if (plan.span === null) return null;

  // Regions that reach the file, widened by roll: start - pre < span end and end + post > span start.
  const rate = file.sampleRate;
  const pre = msToSamples(rolls.preRollMs, rate);
  const post = msToSamples(rolls.postRollMs, rate);
  const span = plan.span;
  const horizon = span.end + pre + msToSamples(horizonMs, rate);
  const firstSeq = span.start - post < file.sampleStart ? file.seq - 1 : file.seq;
  let progress = 0;
  let beyond = false;
  for (const seq of [...manifests.keys()].toSorted((a, b) => a - b)) {
    if (seq < firstSeq) continue;
    const manifest = seq === file.seq ? own : readManifest(manifests.get(seq), file.runUid, seq);
    if (manifest === null) return "manifest_unreadable";
    if (manifest.header.startSample > horizon) {
      beyond = true;
      break;
    }
    for (const commit of manifest.commits) {
      progress = Math.max(progress, commit.sampleIndex + commit.sampleCount);
    }
    for (const gap of manifest.gaps) progress = Math.max(progress, gap.toSample);
    for (const region of manifest.regions) {
      if (region.startSample - pre >= span.end || region.endSample + post <= span.start) continue;
      const state = regionImportState(db, file.trackRunId, region.startSample);
      if (state === "open") return "open_region";
      if (state === "missing") return "unimported_region";
    }
  }
  // An open run may still close a region that reaches the file.
  if (file.runState === "open" && !beyond && progress < horizon) return "awaiting_manifests";
  return null;
}

/** Every commit of the file's manifest is a chunk row with its CRC, or was left out on purpose. */
function commitsImported(db: Database, plan: ArchivePlan, manifest: ManifestFile): boolean {
  const { file } = plan;
  const byOffset = new Map(plan.chunks.map((chunk) => [chunk.byteOffset, chunk]));
  for (const commit of manifest.commits) {
    const length = commit.sampleCount * BYTES_PER_SAMPLE;
    const chunk = byOffset.get(commit.committedOffset - length);
    if (chunk !== undefined) {
      if (chunk.crc32 !== commit.crc32 || chunk.byteLength !== length) return false;
      continue;
    }
    const wallStartMs =
      file.createdWallMs + samplesToMs(commit.sampleIndex - file.sampleStart, file.sampleRate);
    const left = commitLeftOut(db, {
      trackRunId: file.trackRunId,
      sampleStart: commit.sampleIndex,
      sampleEnd: commit.sampleIndex + commit.sampleCount,
      wallStartMs,
      wallEndMs: wallStartMs + samplesToMs(commit.sampleCount, file.sampleRate),
    });
    if (!left) return false;
  }
  return true;
}

/** Manifest paths of a run directory by rotation index; null when it cannot be listed. */
function listManifests(runDir: string): Map<number, string> | null {
  try {
    const manifests = new Map<number, string>();
    for (const entry of readdirSync(runDir, { withFileTypes: true })) {
      const match = entry.isFile() ? /^(\d{4,})\.jsonl$/.exec(entry.name) : null;
      if (match?.[1] !== undefined) {
        manifests.set(Number.parseInt(match[1], 10), join(runDir, entry.name));
      }
    }
    return manifests;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function readManifest(path: string | undefined, runUid: string, seq: number): ManifestFile | null {
  if (path === undefined) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  const problems: string[] = [];
  const manifest = parseManifest(text, runUid, seq, problems);
  // A manifest cut short by a bad line may hide later records.
  return problems.length > 0 ? null : manifest;
}
