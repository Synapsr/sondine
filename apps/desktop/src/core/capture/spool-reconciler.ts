import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  closeEarlierSpoolFiles,
  closeRecoveredTrackRun,
  dropTruncatedChunks,
  closeSpeechRegion,
  openSpeechRegion,
  recordGap,
  recordSpoolCommit,
  recordSpoolFile,
  samplesToMs,
  transaction,
  upsertTrackRun,
  type Database,
  type ImportStatus,
  type TrackSourceKind,
} from "@sondine/db";
import {
  BYTES_PER_SAMPLE,
  decodeJsonLines,
  ManifestRecord,
  SAMPLE_RATE,
  type ManifestCommit,
  type ManifestGap,
  type ManifestHeader,
  type ManifestRegion,
} from "@sondine/protocol";
import { anchorWallMs, continuousUs, wallMsAt } from "./clock";
import { gapReasons, regionEndReasons } from "./capture-mapping";

// The helper's manifests are the durable record of capture; helper events are
// only their low-latency copy. Events can be lost: a helper killed before core
// read them, a core killed with events in its socket, a backlog that overflowed
// while core was away. After each snapshot, core reads the manifests of every
// run it cannot vouch for, imports what the database lacks (idempotently, with
// the same functions as the live importer), closes the runs whose helper is
// gone, and records the outage as an explicit gap.

export interface ReconcileInput {
  /** Absolute path of the spool (`<data>/spool`). */
  readonly spoolRoot: string;
  /** The spool relative to the data directory, as stored in `spool_files.rel_path`. */
  readonly spoolDir: string;
  /** The connected helper's session: runs it wrote may still be growing. */
  readonly sessionId: string;
  /** Runs the connected helper reported open since its `ready`. */
  readonly liveRuns: ReadonlySet<string>;
  readonly vadVersion: string;
  readonly nowMs: number;
  /** When this Mac last booted: a run that ended before it ended with the power. */
  readonly bootWallMs: number;
  /** Read every manifest of the runs below, not only the newest files (`events.dropped`). */
  readonly full?: boolean;
}

export interface ReconcileReport {
  /** Runs closed because their helper is gone or core missed their close. */
  readonly runsClosed: number;
  /** Runs known only from their manifests. */
  readonly runsImported: number;
  readonly chunks: number;
  readonly gaps: number;
  readonly regions: number;
  /** Manifests or records that could not be used; ids and error names only. */
  readonly problems: readonly string[];
}

export interface ManifestFile {
  readonly seq: number;
  readonly header: ManifestHeader;
  readonly commits: readonly ManifestCommit[];
  readonly gaps: readonly ManifestGap[];
  readonly regions: readonly ManifestRegion[];
}

interface RunOnDisk {
  readonly runId: string;
  readonly trackDir: string;
  readonly path: string;
  readonly manifests: readonly { readonly seq: number; readonly path: string }[];
}

interface RunRow {
  readonly id: number;
  readonly uid: string;
  readonly trackKey: string;
  readonly state: string;
  readonly startedWallMs: number;
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MANIFEST = /^(\d{4,})\.jsonl$/;
// Envelopes are most of a manifest and carry nothing the database stores. The
// helper sorts keys, so `type` comes last; JSON escapes quotes inside strings,
// so no other record can contain this text.
const ENVELOPE_TYPE = '"type":"envelope"';

// The spool keeps 24 h (architecture §3): older runs have no manifests to read.
const SPOOL_RETENTION_MS = 24 * 60 * 60 * 1_000;

const sourceKinds: Record<string, TrackSourceKind> = {
  input: "input",
  app: "app",
  system: "system",
  phone: "phone",
};

export function reconcileSpool(db: Database, input: ReconcileInput): ReconcileReport {
  const problems: string[] = [];
  const counts = { chunks: 0, gaps: 0, regions: 0, runsClosed: 0, runsImported: 0 };
  const onDisk = new Map(listRuns(input.spoolRoot, problems).map((run) => [run.runId, run]));
  const rows = new Map(
    (
      db
        .statement(
          "SELECT id, uid, track_key AS trackKey, state, started_wall_ms AS startedWallMs FROM track_runs",
        )
        .all() as unknown as RunRow[]
    ).map((row) => [row.uid, row]),
  );

  // Runs to close: open in the database but not reported by the connected
  // helper (it closed them, or they belong to a helper that is gone), and runs
  // of a previous helper that only their manifests know.
  const toClose: { row: RunRow; files: readonly ManifestFile[]; ownSession: boolean }[] = [];
  for (const row of rows.values()) {
    if (row.state !== "open" || input.liveRuns.has(row.uid)) continue;
    const disk = onDisk.get(row.uid);
    const files = disk === undefined ? [] : readManifests(disk, problems);
    importFiles(db, row, disk, files, input, counts, problems);
    const ownSession = files.some((file) => file.header.sessionId === input.sessionId);
    toClose.push({ row, files, ownSession });
  }
  for (const disk of onDisk.values()) {
    if (rows.has(disk.runId) || input.liveRuns.has(disk.runId)) continue;
    const files = readManifests(disk, problems);
    const first = files[0];
    // A run of the connected helper may have opened after its snapshot.
    if (first === undefined || first.header.sessionId === input.sessionId) continue;
    const row = createRun(db, first, input.nowMs, problems);
    if (row === null) continue;
    counts.runsImported += 1;
    importFiles(db, row, disk, files, input, counts, problems);
    toClose.push({ row, files, ownSession: false });
  }

  // Live runs: fill in commits, gaps and regions whose events were lost.
  for (const runId of input.liveRuns) {
    const row = rows.get(runId);
    const disk = onDisk.get(runId);
    if (row === undefined || disk === undefined) continue;
    const files = readManifests(disk, problems, input.full === true ? 0 : newestKnownSeq(db, row));
    importFiles(db, row, disk, files, input, counts, problems);
    const newest = files.at(-1);
    if (newest !== undefined) {
      closeEarlierSpoolFiles(db, {
        trackRunId: row.id,
        beforeSeq: newest.header.sequence,
        closedWallMs: anchorWallMs(newest.header.anchor),
      });
    }
  }

  // Runs closed within the spool's retention whose samples chunks and gaps do
  // not all cover (closed while their spool could not write, events lost, or
  // closed before core accounted for them). Older runs have no manifests left.
  const recent = db
    .statement(
      "SELECT uid FROM track_runs WHERE state <> 'open' AND sample_end > 0 AND ended_wall_ms >= ?",
    )
    .all(input.nowMs - SPOOL_RETENTION_MS) as unknown as { uid: string }[];
  for (const { uid } of recent) {
    const accounted = accountForClosedRun(db, input, uid);
    counts.chunks += accounted.chunks;
    counts.gaps += accounted.gaps;
    counts.regions += accounted.regions;
    problems.push(...accounted.problems);
  }

  // Close last, once every run is in the database, so each outage ends where
  // the next run of its track starts.
  for (const { row, files, ownSession } of toClose) {
    try {
      // The close and its outage land together, or not at all.
      transaction(db, () => {
        const end = runEnd(db, row, files);
        const closed = closeRecoveredTrackRun(db, {
          trackRunId: row.id,
          sampleEnd: end.sample,
          endedWallMs: end.wallMs,
          endReason: ownSession ? "recovered" : "helper_exit",
          nowMs: input.nowMs,
        });
        if (closed.status !== "updated") return;
        counts.runsClosed += 1;
        if (!ownSession && recordOutage(db, row, end, input)) counts.gaps += 1;
      });
    } catch (error) {
      problems.push(`${row.uid}: close ${errorName(error)}`);
    }
  }
  return { ...counts, problems };
}

/**
 * The helper died: from the run's end (its last stored or gap-recorded
 * sample) to the next run of this track, nothing was captured.
 */
function recordOutage(
  db: Database,
  row: RunRow,
  end: { sample: number; wallMs: number },
  input: ReconcileInput,
): boolean {
  const wallStartMs = end.wallMs;
  const next = db
    .statement(
      "SELECT min(started_wall_ms) AS next FROM track_runs WHERE track_key = ? AND uid <> ? AND started_wall_ms >= ?",
    )
    .get(row.trackKey, row.uid, wallStartMs)?.["next"];
  const wallEndMs = Math.max(wallStartMs, typeof next === "number" ? next : input.nowMs);
  const gap = recordGap(db, {
    trackRunId: row.id,
    trackKey: row.trackKey,
    reason: wallStartMs < input.bootWallMs ? "power_loss" : "helper_exit",
    wallStartMs,
    wallEndMs,
    sampleStart: end.sample,
    detail: "capture-stopped",
  });
  return gap.status === "inserted";
}

export interface ClosedRunInput {
  readonly spoolRoot: string;
  readonly spoolDir: string;
  readonly vadVersion: string;
}

/**
 * Accounts for every sample of a closed run: chunks and gaps must cover
 * [0, sample_end). What is missing is read from the run's manifests (gaps
 * written after the last commit reach core with no commit event; events lost
 * on the way); a span that no record covers becomes a gap itself. Deleted
 * ranges stay deleted: every import function refuses them.
 */
export function accountForClosedRun(
  db: Database,
  input: ClosedRunInput,
  runUid: string,
): ReconcileReport {
  const problems: string[] = [];
  const counts = { chunks: 0, gaps: 0, regions: 0, runsClosed: 0, runsImported: 0 };
  const row = db
    .statement(
      "SELECT id, uid, track_key AS trackKey, state, started_wall_ms AS startedWallMs, sample_end AS sampleEnd FROM track_runs WHERE uid = ?",
    )
    .get(runUid) as (RunRow & { sampleEnd: number | null }) | undefined;
  if (row === undefined || row.sampleEnd === null) return { ...counts, problems };
  const sampleEnd = row.sampleEnd;
  if (uncovered(db, row.id, sampleEnd).length === 0) return { ...counts, problems };
  const disk = findRun(input.spoolRoot, runUid, problems);
  const files = disk === undefined ? [] : readManifests(disk, problems);
  importFiles(db, row, disk, files, input, counts, problems);
  const reasons = files.flatMap((file) => file.gaps);
  const wallAt = (sample: number) => row.startedWallMs + samplesToMs(sample, SAMPLE_RATE);
  for (const hole of uncovered(db, row.id, sampleEnd)) {
    // The manifest's own reason for the outage the hole belongs to, if it gave one.
    const near = reasons.findLast((gap) => gap.fromSample <= hole.from) ?? reasons.at(-1);
    const gap = recordGap(db, {
      trackRunId: row.id,
      trackKey: row.trackKey,
      reason: near === undefined ? "write_error" : gapReasons[near.reason],
      wallStartMs: wallAt(hole.from),
      wallEndMs: wallAt(hole.to),
      sampleStart: hole.from,
      sampleEnd: hole.to,
      lostBytes: (hole.to - hole.from) * BYTES_PER_SAMPLE,
      detail: "unrecorded",
    });
    if (gap.status === "inserted") counts.gaps += 1;
  }
  return { ...counts, problems };
}

/** Spans of [0, sampleEnd) that no chunk or gap of the run covers, in order. */
function uncovered(
  db: Database,
  trackRunId: number,
  sampleEnd: number,
): { from: number; to: number }[] {
  const spans = db
    .statement(
      `SELECT sample_start AS s, sample_start + sample_count AS e FROM chunks WHERE track_run_id = ?1
       UNION ALL
       SELECT sample_start, sample_end FROM gaps
       WHERE track_run_id = ?1 AND sample_start IS NOT NULL AND sample_end IS NOT NULL
       ORDER BY s, e`,
    )
    .all(trackRunId) as unknown as { s: number; e: number }[];
  const holes: { from: number; to: number }[] = [];
  let covered = 0;
  for (const span of spans) {
    if (span.s > covered) holes.push({ from: covered, to: Math.min(span.s, sampleEnd) });
    covered = Math.max(covered, span.e);
    if (covered >= sampleEnd) break;
  }
  if (covered < sampleEnd) holes.push({ from: covered, to: sampleEnd });
  return holes.filter((hole) => hole.to > hole.from);
}

function findRun(spoolRoot: string, runUid: string, problems: string[]): RunOnDisk | undefined {
  if (!RUN_ID.test(runUid)) return undefined;
  for (const trackDir of entries(spoolRoot, problems)) {
    if (!trackDir.isDirectory()) continue;
    const path = join(spoolRoot, trackDir.name, runUid);
    if (existsSync(path)) {
      return {
        runId: runUid,
        trackDir: trackDir.name,
        path,
        manifests: manifestsIn(path, problems),
      };
    }
  }
  return undefined;
}

/** `<spool>/<track directory>/<run id>/NNNN.jsonl`, as the helper's SpoolLayout writes them. */
function listRuns(spoolRoot: string, problems: string[]): RunOnDisk[] {
  const runs: RunOnDisk[] = [];
  for (const trackDir of entries(spoolRoot, problems)) {
    if (!trackDir.isDirectory()) continue;
    const trackPath = join(spoolRoot, trackDir.name);
    for (const runDir of entries(trackPath, problems)) {
      if (!runDir.isDirectory() || !RUN_ID.test(runDir.name)) continue;
      const path = join(trackPath, runDir.name);
      runs.push({
        runId: runDir.name,
        trackDir: trackDir.name,
        path,
        manifests: manifestsIn(path, problems),
      });
    }
  }
  return runs;
}

function manifestsIn(path: string, problems: string[]): RunOnDisk["manifests"] {
  return entries(path, problems)
    .flatMap((file) => {
      const match = file.isFile() ? MANIFEST.exec(file.name) : null;
      return match?.[1] === undefined
        ? []
        : [{ seq: Number.parseInt(match[1], 10), path: join(path, file.name) }];
    })
    .toSorted((a, b) => a.seq - b.seq);
}

function entries(path: string, problems: string[]) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch (error) {
    // A missing spool is normal before the first capture.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      problems.push(`list ${errorName(error)}`);
    return [];
  }
}

/**
 * The run's manifests from `fromSeq` on. Each keeps its records up to its
 * first invalid line; an incomplete last line (a write in progress) is not one.
 */
function readManifests(run: RunOnDisk, problems: string[], fromSeq = 0): ManifestFile[] {
  const files: ManifestFile[] = [];
  for (const manifest of run.manifests) {
    if (manifest.seq < fromSeq) continue;
    let text: string;
    try {
      text = readFileSync(manifest.path, "utf8");
    } catch (error) {
      problems.push(`${run.runId}/${manifest.seq}: read ${errorName(error)}`);
      continue;
    }
    const file = parseManifest(text, run.runId, manifest.seq, problems);
    if (file !== null) files.push(file);
  }
  return files;
}

/**
 * One manifest's header, commits, gaps and regions (envelopes skipped), up to
 * its first invalid line; an incomplete last line (a write in progress) is not
 * one. Null when it has no usable header for `runId` (a problem says why,
 * unless the file is still empty).
 */
export function parseManifest(
  text: string,
  runId: string,
  seq: number,
  problems: string[],
): ManifestFile | null {
  const complete = text.slice(0, text.lastIndexOf("\n") + 1);
  const kept = complete
    .split("\n")
    .filter((line) => line !== "" && !line.includes(ENVELOPE_TYPE))
    .join("\n");
  let header: ManifestHeader | null = null;
  const commits: ManifestCommit[] = [];
  const gaps: ManifestGap[] = [];
  const regions: ManifestRegion[] = [];
  for (const result of decodeJsonLines(ManifestRecord, `${kept}\n`)) {
    if (!result.ok) {
      problems.push(`${runId}/${seq}: line ${result.error.kind}`);
      break;
    }
    const record = result.value;
    if (header === null) {
      if (record.type !== "header") {
        problems.push(`${runId}/${seq}: no header`);
        break;
      }
      header = record;
      continue;
    }
    if (record.type === "commit") commits.push(record);
    else if (record.type === "gap") gaps.push(record);
    else if (record.type === "region") regions.push(record);
    else if (record.type === "header") break;
  }
  if (header === null) return null;
  if (header.runId !== runId) {
    problems.push(`${runId}/${seq}: header names another run`);
    return null;
  }
  return { seq, header, commits, gaps, regions };
}

/**
 * The runs a reconciliation's problems name, and how many name none (the
 * spool could not be listed): every problem starts with its run id.
 */
export function problemRunIds(problems: readonly string[]): {
  readonly runs: ReadonlySet<string>;
  readonly unattributed: number;
} {
  const runs = new Set<string>();
  let unattributed = 0;
  for (const problem of problems) {
    const runId = problem.slice(0, 36);
    if (RUN_ID.test(runId) && /^[/:]/.test(problem.slice(36))) runs.add(runId);
    else unattributed += 1;
  }
  return { runs, unattributed };
}

function createRun(
  db: Database,
  file: ManifestFile,
  nowMs: number,
  problems: string[],
): RunRow | null {
  const header = file.header;
  const sourceKind = sourceKinds[header.trackKey.split(":")[0] ?? ""];
  if (sourceKind === undefined) {
    problems.push(`${header.runId}: unknown track kind`);
    return null;
  }
  try {
    // The header's anchor is read when the file is created, at its first
    // commit; a commit's own clock places sample 0 exactly.
    const commit = file.commits[0];
    const startedWallMs =
      commit === undefined
        ? anchorWallMs(header.anchor) - samplesToMs(header.startSample, SAMPLE_RATE)
        : wallMsAt(commit.at, header.anchor) - samplesToMs(commit.sampleIndex, SAMPLE_RATE);
    // An app track's key names its app, so app taps and calls find the run;
    // a device stays unlinked (only `track.open` names it).
    const bundleId = sourceKind === "app" ? header.trackKey.slice("app:".length) : null;
    const run = upsertTrackRun(db, {
      uid: header.runId,
      trackKey: header.trackKey,
      sourceKind,
      sampleRate: SAMPLE_RATE,
      startedWallMs,
      nowMs,
      ...(bundleId === null ? {} : { app: { bundleId, seenAtMs: nowMs } }),
    });
    return {
      id: run.trackRunId,
      uid: header.runId,
      trackKey: header.trackKey,
      state: "open",
      startedWallMs,
    };
  } catch (error) {
    problems.push(`${header.runId}: create ${errorName(error)}`);
    return null;
  }
}

function importFiles(
  db: Database,
  row: RunRow,
  disk: RunOnDisk | undefined,
  files: readonly ManifestFile[],
  input: Pick<ReconcileInput, "spoolDir" | "vadVersion">,
  counts: { chunks: number; gaps: number; regions: number },
  problems: string[],
): void {
  if (disk === undefined) return;
  for (const file of files) {
    const where = `${row.uid}/${file.seq}`;
    // One savepoint per record: a record that conflicts is reported, the others still land.
    const attempt = (what: string, write: () => void) => {
      try {
        write();
      } catch (error) {
        problems.push(`${where}: ${what} ${errorName(error)}`);
      }
    };
    try {
      transaction(db, () => {
        const relPath = `${input.spoolDir}/${disk.trackDir}/${disk.runId}/${file.header.file}`;
        const existing = db
          .statement("SELECT id FROM spool_files WHERE track_run_id = ? AND seq = ?")
          .get(row.id, file.header.sequence)?.["id"];
        const spoolFileId =
          typeof existing === "number"
            ? existing
            : recordSpoolFile(db, {
                trackRunId: row.id,
                seq: file.header.sequence,
                relPath,
                sampleStart: file.header.startSample,
                createdWallMs: anchorWallMs(file.header.anchor),
              }).spoolFileId;
        for (const commit of file.commits) {
          attempt("commit", () => {
            const byteLength = commit.sampleCount * BYTES_PER_SAMPLE;
            const chunk = recordSpoolCommit(db, {
              spoolFileId,
              byteOffset: commit.committedOffset - byteLength,
              byteLength,
              sampleStart: commit.sampleIndex,
              hostTicks: commit.at.hostTicks,
              continuousUs: continuousUs(commit.at),
              wallMs: wallMsAt(commit.at, file.header.anchor),
              crc32: commit.crc32,
            });
            if (inserted(chunk.status)) counts.chunks += 1;
          });
        }
        // Same placement as the live importer, so a replay is a duplicate.
        const wallAt = (sample: number) => row.startedWallMs + samplesToMs(sample, SAMPLE_RATE);
        for (const gap of file.gaps) {
          attempt("gap", () => {
            // Recovery cut these samples from the file: chunks core recorded
            // for them point at bytes that are gone.
            if (gap.reason === "recovery-truncated") {
              dropTruncatedChunks(db, {
                trackRunId: row.id,
                fromSample: gap.fromSample,
                toSample: gap.toSample,
              });
            }
            const recorded = recordGap(db, {
              trackRunId: row.id,
              trackKey: row.trackKey,
              reason: gapReasons[gap.reason],
              wallStartMs: wallAt(gap.fromSample),
              wallEndMs: wallAt(gap.toSample),
              sampleStart: gap.fromSample,
              sampleEnd: gap.toSample,
              lostBytes: (gap.toSample - gap.fromSample) * BYTES_PER_SAMPLE,
              detail: gap.reason,
            });
            if (inserted(recorded.status)) counts.gaps += 1;
          });
        }
        for (const region of file.regions) {
          attempt("region", () => {
            const opened = openSpeechRegion(db, {
              trackRunId: row.id,
              sampleStart: region.startSample,
              wallStartMs: wallAt(region.startSample),
              vadVersion: input.vadVersion,
            });
            if (opened.status === "skipped_deleted") return;
            const closed = closeSpeechRegion(db, {
              trackRunId: row.id,
              sampleStart: region.startSample,
              sampleEnd: region.endSample,
              wallEndMs: wallAt(region.endSample),
              endReason: regionEndReasons[region.closeReason],
              voicedSamples: region.voicedSamples ?? null,
            });
            if (inserted(opened.status) || closed.status === "updated") counts.regions += 1;
          });
        }
      });
    } catch (error) {
      problems.push(`${where}: file ${errorName(error)}`);
    }
  }
}

const inserted = (status: ImportStatus) => status === "inserted";

/** The run's newest spool file the database knows: older ones were complete when it rotated. */
function newestKnownSeq(db: Database, row: RunRow): number {
  const seq = db
    .statement("SELECT max(seq) AS seq FROM spool_files WHERE track_run_id = ?")
    .get(row.id)?.["seq"];
  return typeof seq === "number" ? seq : 0;
}

/** After the run's last committed sample, from its manifests or the database, whichever is later. */
function runEnd(
  db: Database,
  row: RunRow,
  files: readonly ManifestFile[],
): { sample: number; wallMs: number } {
  let end = { sample: 0, wallMs: row.startedWallMs };
  const stored = db
    .statement(
      "SELECT sample_start + sample_count AS sample, wall_ms AS wall, sample_count AS count FROM chunks WHERE track_run_id = ? ORDER BY sample_start DESC LIMIT 1",
    )
    .get(row.id) as { sample?: unknown; wall?: unknown; count?: unknown } | undefined;
  if (
    typeof stored?.sample === "number" &&
    typeof stored.wall === "number" &&
    typeof stored.count === "number"
  ) {
    end = { sample: stored.sample, wallMs: stored.wall + samplesToMs(stored.count, SAMPLE_RATE) };
  }
  for (const file of files) {
    for (const commit of file.commits) {
      const sample = commit.sampleIndex + commit.sampleCount;
      if (sample <= end.sample) continue;
      end = {
        sample,
        wallMs:
          wallMsAt(commit.at, file.header.anchor) + samplesToMs(commit.sampleCount, SAMPLE_RATE),
      };
    }
  }
  // Samples the helper counted but could not store (a disk that stayed full,
  // a recovery cut) still belong to the run: it ends after its last gap too.
  const recorded = db
    .statement("SELECT max(sample_end) AS sample FROM gaps WHERE track_run_id = ?")
    .get(row.id)?.["sample"];
  const gapEnd = Math.max(
    typeof recorded === "number" ? recorded : 0,
    ...files.flatMap((file) => file.gaps.map((gap) => gap.toSample)),
  );
  if (gapEnd > end.sample) {
    end = { sample: gapEnd, wallMs: end.wallMs + samplesToMs(gapEnd - end.sample, SAMPLE_RATE) };
  }
  return end;
}

/** Our own errors name ids and columns, never content; others give only their name. */
function errorName(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";
  const own = error.name === "ImportConflictError" || error.name === "RangeError";
  return own ? `${error.name}: ${error.message.slice(0, 160)}` : error.name;
}
