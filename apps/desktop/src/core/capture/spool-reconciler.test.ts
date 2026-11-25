import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDatabase,
  openSpeechRegion,
  recordSpoolCommit,
  recordSpoolFile,
  upsertTrackRun,
  type OpenedDatabase,
} from "@sondine/db";
import {
  encodeJsonLine,
  ManifestRecord,
  type ManifestHeader,
  type ManifestRecordWire,
} from "@sondine/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrationsDir } from "../../../test/support";
import { accountForClosedRun, reconcileSpool, type ReconcileInput } from "./spool-reconciler";

const t0 = 1_793_610_000_000;
const RATE = 16_000;
const BLOCK = 2 * RATE;
const DEAD = "6f1c2a4e-8b3d-4c5e-9f10-2a3b4c5d6e7f";
const LIVE = "0a1b2c3d-4e5f-4061-8273-8495a6b7c8d9";
const MIC: ManifestHeader["trackKey"] = "input:BuiltInMicrophoneDevice";
const anchor = { hostTicks: "1000000", continuousNs: "5000000000", wallNs: `${t0}000000` };
// 16 kHz: one sample is 62.5 µs; host ticks at 24 MHz are 1.5 per µs.
const at = (sample: number) => ({
  hostTicks: String(1_000_000 + sample * 1_500),
  continuousNs: String(5_000_000_000 + sample * 62_500),
});

interface RunSpec {
  readonly runId: string;
  readonly sessionId: string;
  readonly trackKey?: ManifestHeader["trackKey"];
  /** Committed 2 s blocks, from sample 0. */
  readonly blocks: number;
  readonly tail?: readonly ManifestRecordWire[];
  /** Seconds after t0 at which the run started. */
  readonly startS?: number;
}

const trackDir = (trackKey: string) => trackKey.replace(":", "-");

function line(record: ManifestRecordWire): string {
  const parsed = ManifestRecord.parse(record);
  const encoded = encodeJsonLine(ManifestRecord, parsed);
  if (!encoded.ok) throw new Error(encoded.error.message);
  return encoded.line;
}

describe("spool reconciler", () => {
  let dir: string;
  let db: OpenedDatabase;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sondine-reconcile-"));
    db = openDatabase(":memory:", { migrationsFolder: migrationsDir });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const spoolRoot = () => join(dir, "spool");

  /** Writes a run's manifest as the helper does (envelopes included), and returns it. */
  function writeRun(spec: RunSpec): string {
    const trackKey = spec.trackKey ?? MIC;
    const runAnchor = {
      ...anchor,
      wallNs: `${t0 + (spec.startS ?? 0) * 1_000}000000`,
    };
    const path = join(spoolRoot(), trackDir(trackKey), spec.runId);
    mkdirSync(path, { recursive: true });
    const records: ManifestRecordWire[] = [
      {
        type: "header",
        format: "sondine-spool",
        version: 1,
        sessionId: spec.sessionId,
        trackKey,
        runId: spec.runId,
        epoch: 1,
        file: "0000.pcm",
        sequence: 0,
        startSample: 0,
        rate: 16_000,
        channels: 1,
        sampleFormat: "s16le",
        timebase: { numer: 125, denom: 3 },
        anchor: runAnchor,
        helperVersion: "0.1.0",
      },
    ];
    for (let block = 0; block < spec.blocks; block++) {
      records.push({
        type: "commit",
        seq: block,
        epoch: 1,
        committedOffset: (block + 1) * BLOCK * 2,
        sampleIndex: block * BLOCK,
        sampleCount: BLOCK,
        crc32: 1_000 + block,
        at: at(block * BLOCK),
      });
      records.push({
        type: "envelope",
        sampleIndex: block * BLOCK,
        frameSamples: 160,
        count: 4,
        encoding: "f32le-base64",
        data: "AADwwgAAcsIAAPLBAABAwQ==",
      });
    }
    const text = [...records, ...(spec.tail ?? [])].map(line).join("");
    writeFileSync(join(path, "0000.jsonl"), text);
    return path;
  }

  /** What a live importer would have recorded: the run open, its first `blocks` commits. */
  function importedRun(spec: RunSpec, blocks: number): number {
    const trackKey = spec.trackKey ?? MIC;
    const run = upsertTrackRun(db, {
      uid: spec.runId,
      trackKey,
      sourceKind: trackKey.startsWith("input") ? "input" : "system",
      startedWallMs: t0 + (spec.startS ?? 0) * 1_000,
      nowMs: t0,
    });
    const file = recordSpoolFile(db, {
      trackRunId: run.trackRunId,
      seq: 0,
      relPath: `spool/${trackDir(trackKey)}/${spec.runId}/0000.pcm`,
      sampleStart: 0,
      createdWallMs: t0,
    });
    for (let block = 0; block < blocks; block++) {
      recordSpoolCommit(db, {
        spoolFileId: file.spoolFileId,
        byteOffset: block * BLOCK * 2,
        byteLength: BLOCK * 2,
        sampleStart: block * BLOCK,
        hostTicks: BigInt(at(block * BLOCK).hostTicks),
        continuousUs: Number(BigInt(at(block * BLOCK).continuousNs) / 1_000n),
        wallMs: t0 + block * 2_000,
        crc32: 1_000 + block,
      });
    }
    return run.trackRunId;
  }

  const reconcile = (overrides: Partial<ReconcileInput> = {}) =>
    reconcileSpool(db, {
      spoolRoot: spoolRoot(),
      spoolDir: "spool",
      sessionId: "11111111-2222-4333-8444-555555555555",
      liveRuns: new Set(),
      vadVersion: "silero/6.2",
      nowMs: t0 + 600_000,
      bootWallMs: t0 - 3_600_000,
      ...overrides,
    });

  const rows = (sql: string, ...params: (string | number)[]) => db.statement(sql).all(...params);

  it("closes a dead helper's run after its last recorded sample and records the outage", () => {
    const spec: RunSpec = {
      runId: DEAD,
      sessionId: DEAD,
      blocks: 5,
      // The next helper's recovery cut the uncommitted tail and said so.
      tail: [
        {
          type: "gap",
          reason: "recovery-truncated",
          fromSample: 5 * BLOCK,
          toSample: 5 * BLOCK + 8_000,
        },
      ],
    };
    writeRun(spec);
    const run = importedRun(spec, 3);
    openSpeechRegion(db, {
      trackRunId: run,
      sampleStart: 9 * BLOCK,
      wallStartMs: t0 + 18_000,
      vadVersion: "v",
    });
    // The new helper's run of the same track started 4 s after the cut.
    const next = upsertTrackRun(db, {
      uid: LIVE,
      trackKey: MIC,
      sourceKind: "input",
      startedWallMs: t0 + 14_500,
      nowMs: t0,
    });

    const report = reconcile({ liveRuns: new Set([LIVE]) });
    expect(report).toMatchObject({ runsClosed: 1, runsImported: 0, chunks: 2, problems: [] });
    expect(
      rows("SELECT state, end_reason, sample_end, ended_wall_ms FROM track_runs WHERE id = ?", run),
    ).toEqual([
      {
        state: "closed",
        end_reason: "helper_exit",
        // After the recovery cut, which is part of the run.
        sample_end: 5 * BLOCK + 8_000,
        ended_wall_ms: t0 + 10_500,
      },
    ]);
    expect(rows("SELECT state FROM spool_files WHERE track_run_id = ?", run)).toEqual([
      { state: "closed" },
    ]);
    // The region started after the last stored sample: none of its audio exists.
    expect(rows("SELECT id FROM speech_regions WHERE track_run_id = ?", run)).toEqual([]);
    expect(
      rows(
        "SELECT reason, wall_start_ms, wall_end_ms, sample_start FROM gaps WHERE track_run_id = ? ORDER BY wall_start_ms",
        run,
      ),
    ).toEqual([
      {
        reason: "recovery_truncated",
        wall_start_ms: t0 + 10_000,
        wall_end_ms: t0 + 10_500,
        sample_start: 5 * BLOCK,
      },
      {
        reason: "helper_exit",
        wall_start_ms: t0 + 10_500,
        wall_end_ms: t0 + 14_500,
        sample_start: 5 * BLOCK + 8_000,
      },
    ]);
    expect(next.status).toBe("inserted");

    // Running it again changes nothing.
    expect(reconcile({ liveRuns: new Set([LIVE]) })).toMatchObject({
      runsClosed: 0,
      chunks: 0,
      gaps: 0,
      regions: 0,
      problems: [],
    });
  });

  it("closes a run the connected helper ended while core was away, without an outage", () => {
    const sessionId = "11111111-2222-4333-8444-555555555555";
    const spec: RunSpec = { runId: DEAD, sessionId, blocks: 2 };
    writeRun(spec);
    const run = importedRun(spec, 1);
    expect(reconcile({ sessionId })).toMatchObject({ runsClosed: 1, chunks: 1, gaps: 0 });
    expect(rows("SELECT end_reason, sample_end FROM track_runs WHERE id = ?", run)).toEqual([
      { end_reason: "recovered", sample_end: 2 * BLOCK },
    ]);
    expect(rows("SELECT id FROM gaps")).toEqual([]);
  });

  it("imports a dead helper's run that core never saw, and leaves the connected helper's alone", () => {
    const sessionId = "11111111-2222-4333-8444-555555555555";
    writeRun({
      runId: DEAD,
      sessionId: DEAD,
      trackKey: "system:other",
      blocks: 3,
      tail: [
        {
          type: "region",
          regionId: "5f4cab96-7d8e-41cf-9065-bc9d3e4f5061",
          startSample: 8_000,
          endSample: 40_000,
          closeReason: "silence",
          speechProbability: { mean: 0.8, max: 0.95 },
          level: { mean: -30, peak: -10 },
        },
      ],
    });
    // Opened after the snapshot: its track.open is still on its way.
    writeRun({ runId: LIVE, sessionId, blocks: 1, startS: 60 });

    const report = reconcile({ sessionId });
    expect(report).toMatchObject({
      runsImported: 1,
      runsClosed: 1,
      chunks: 3,
      regions: 1,
      gaps: 1,
      problems: [],
    });
    expect(
      rows(
        "SELECT uid, track_key, source_kind, state, end_reason, started_wall_ms FROM track_runs",
      ),
    ).toEqual([
      {
        uid: DEAD,
        track_key: "system:other",
        source_kind: "system",
        state: "closed",
        end_reason: "helper_exit",
        started_wall_ms: t0,
      },
    ]);
    expect(rows("SELECT sample_start, sample_end, state, end_reason FROM speech_regions")).toEqual([
      { sample_start: 8_000, sample_end: 40_000, state: "closed", end_reason: "silence" },
    ]);
    // No later run of the track: the outage lasts until now.
    expect(rows("SELECT reason, wall_start_ms, wall_end_ms FROM gaps")).toEqual([
      { reason: "helper_exit", wall_start_ms: t0 + 6_000, wall_end_ms: t0 + 600_000 },
    ]);
  });

  it("links a recovered app run to its app, so app taps and calls still find it (ADR 026)", () => {
    writeRun({ runId: DEAD, sessionId: DEAD, trackKey: "app:us.zoom.xos", blocks: 2 });
    expect(reconcile()).toMatchObject({ runsImported: 1, problems: [] });
    expect(
      rows(
        "SELECT t.source_kind, a.bundle_id FROM track_runs t LEFT JOIN apps a ON a.id = t.app_id",
      ),
    ).toEqual([{ source_kind: "app", bundle_id: "us.zoom.xos" }]);
  });

  it("fills a live run's lost commits and keeps it open", () => {
    const spec: RunSpec = {
      runId: LIVE,
      sessionId: "11111111-2222-4333-8444-555555555555",
      blocks: 4,
    };
    writeRun(spec);
    const run = importedRun(spec, 2);
    expect(reconcile({ liveRuns: new Set([LIVE]) })).toMatchObject({
      runsClosed: 0,
      chunks: 2,
      gaps: 0,
    });
    expect(rows("SELECT state FROM track_runs WHERE id = ?", run)).toEqual([{ state: "open" }]);
    expect(rows("SELECT count(*) AS n FROM chunks WHERE track_run_id = ?", run)).toEqual([
      { n: 4 },
    ]);
  });

  it("names a capture that ended before the last boot a power loss", () => {
    const spec: RunSpec = { runId: DEAD, sessionId: DEAD, blocks: 1 };
    writeRun(spec);
    importedRun(spec, 1);
    reconcile({ bootWallMs: t0 + 60_000 });
    expect(rows("SELECT reason FROM gaps")).toEqual([{ reason: "power_loss" }]);
  });

  it("keeps the records before a torn last line and reports a corrupt one", () => {
    const spec: RunSpec = { runId: DEAD, sessionId: DEAD, blocks: 2 };
    const path = writeRun(spec);
    // A write in progress: an incomplete last line is not a problem.
    writeFileSync(join(path, "0000.jsonl"), `${'{"type":"commit","seq":2'}`, { flag: "a" });
    importedRun(spec, 0);
    expect(reconcile()).toMatchObject({ chunks: 2, runsClosed: 1, problems: [] });

    const other = writeRun({ runId: LIVE, sessionId: DEAD, blocks: 1 });
    writeFileSync(join(other, "0000.jsonl"), "not json\n", { flag: "a" });
    const report = reconcile();
    expect(report.runsImported).toBe(1);
    expect(report.problems).toEqual([`${LIVE}/0: line invalid-json`]);
  });

  it("accounts for a closed run's tail: the manifest's last gaps, then what no record covers", () => {
    const spec: RunSpec = {
      runId: DEAD,
      sessionId: DEAD,
      blocks: 2,
      // The disk filled after two blocks; two retries stored only their gap records.
      tail: [
        { type: "gap", reason: "disk-full", fromSample: 2 * BLOCK, toSample: 3 * BLOCK },
        { type: "gap", reason: "disk-full", fromSample: 3 * BLOCK, toSample: 4 * BLOCK },
      ],
    };
    writeRun(spec);
    const run = importedRun(spec, 2);
    // Closed at 5 blocks: the last one has no record at all.
    upsertTrackRun(db, {
      uid: DEAD,
      trackKey: MIC,
      sourceKind: "input",
      startedWallMs: t0,
      state: "closed",
      endedWallMs: t0 + 10_000,
      endReason: "stopped",
      sampleEnd: 5 * BLOCK,
      nowMs: t0,
    });
    const input = { spoolRoot: spoolRoot(), spoolDir: "spool", vadVersion: "silero/6.2" };
    expect(accountForClosedRun(db, input, DEAD)).toMatchObject({ gaps: 3, problems: [] });
    expect(
      rows(
        "SELECT reason, sample_start, sample_end, detail FROM gaps WHERE track_run_id = ? ORDER BY sample_start",
        run,
      ),
    ).toEqual([
      { reason: "disk_full", sample_start: 2 * BLOCK, sample_end: 3 * BLOCK, detail: "disk-full" },
      { reason: "disk_full", sample_start: 3 * BLOCK, sample_end: 4 * BLOCK, detail: "disk-full" },
      { reason: "disk_full", sample_start: 4 * BLOCK, sample_end: 5 * BLOCK, detail: "unrecorded" },
    ]);
    // Now covered: nothing more to do, and an unknown run is ignored.
    expect(accountForClosedRun(db, input, DEAD)).toMatchObject({ gaps: 0, chunks: 0 });
    expect(accountForClosedRun(db, input, LIVE)).toMatchObject({ gaps: 0, problems: [] });
  });

  it("fills a closed run's interior hole from its manifest, and records what no record covers", () => {
    const spec: RunSpec = { runId: DEAD, sessionId: DEAD, blocks: 3 };
    writeRun(spec);
    const run = importedRun(spec, 3);
    // Block 1 never reached the database; block 5 is in no manifest at all.
    db.statement("DELETE FROM chunks WHERE track_run_id = ? AND sample_start = ?").run(run, BLOCK);
    upsertTrackRun(db, {
      uid: DEAD,
      trackKey: MIC,
      sourceKind: "input",
      startedWallMs: t0,
      state: "closed",
      endedWallMs: t0 + 8_000,
      endReason: "stopped",
      sampleEnd: 4 * BLOCK,
      nowMs: t0,
    });
    const input = { spoolRoot: spoolRoot(), spoolDir: "spool", vadVersion: "silero/6.2" };
    expect(accountForClosedRun(db, input, DEAD)).toMatchObject({ chunks: 1, gaps: 1 });
    expect(rows("SELECT sample_start FROM chunks WHERE track_run_id = ? ORDER BY 1", run)).toEqual([
      { sample_start: 0 },
      { sample_start: BLOCK },
      { sample_start: 2 * BLOCK },
    ]);
    expect(rows("SELECT reason, sample_start, sample_end, detail FROM gaps")).toEqual([
      {
        reason: "write_error",
        sample_start: 3 * BLOCK,
        sample_end: 4 * BLOCK,
        detail: "unrecorded",
      },
    ]);
  });

  it("drops chunks whose bytes the helper's recovery cut", () => {
    // The manifest after recovery: two verified commits, then the cut.
    const spec: RunSpec = {
      runId: DEAD,
      sessionId: DEAD,
      blocks: 2,
      tail: [
        { type: "gap", reason: "recovery-truncated", fromSample: 2 * BLOCK, toSample: 3 * BLOCK },
      ],
    };
    writeRun(spec);
    const run = importedRun(spec, 3);
    expect(reconcile()).toMatchObject({ runsClosed: 1, problems: [] });
    expect(rows("SELECT count(*) AS n FROM chunks WHERE track_run_id = ?", run)).toEqual([
      { n: 2 },
    ]);
    expect(rows("SELECT sample_end FROM track_runs WHERE id = ?", run)).toEqual([
      { sample_end: 3 * BLOCK },
    ]);
    expect(rows("SELECT reason, sample_start FROM gaps ORDER BY sample_start")).toEqual([
      { reason: "recovery_truncated", sample_start: 2 * BLOCK },
      { reason: "helper_exit", sample_start: 3 * BLOCK },
    ]);
  });

  it("does nothing without a spool", () => {
    expect(reconcile()).toEqual({
      runsClosed: 0,
      runsImported: 0,
      chunks: 0,
      gaps: 0,
      regions: 0,
      problems: [],
    });
  });
});
