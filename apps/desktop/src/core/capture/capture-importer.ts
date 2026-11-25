import { uptime } from "node:os";
import {
  closeEarlierSpoolFiles,
  closeLostSpans,
  closeSpeechRegion,
  closeSpoolFile,
  openSpeechRegion,
  recordCallActive,
  recordEpoch,
  recordForegroundSpans,
  recordGap,
  recordListenActive,
  recordSpanEnded,
  recordSpoolCommit,
  recordSpoolFile,
  reroutePlayback,
  samplesToMs,
  touchSpans,
  transaction,
  upsertApp,
  upsertDevice,
  upsertTrackRun,
  type CallVia,
  type Database,
  type DeviceTransport,
  type ImportStatus,
  type PlaybackRoute,
  type SpanClock,
  type SpanTable,
  type TrackRunEndReason,
  type TrackSourceKind,
} from "@sondine/db";
import {
  BYTES_PER_SAMPLE,
  SAMPLE_RATE,
  type ActivityEvent,
  type CallEvent,
  type ClockAnchor,
  type ClockEvent,
  type ClockPoint,
  type CommitEvent,
  type DevicesEvent,
  type HelperEvent,
  type ListenEvent,
  type ReadyEvent,
  type RegionCloseEvent,
  type RegionOpenEvent,
  type TrackCloseEvent,
  type TrackOpenEvent,
  type TrackUpdateEvent,
} from "@sondine/protocol";
import { outputRoute } from "./output-route";
import { gapReasons, regionEndReasons } from "./capture-mapping";
import { anchorWallMs, continuousUs, wallMsAt } from "./clock";
import {
  accountForClosedRun,
  problemRunIds,
  reconcileSpool,
  type ReconcileReport,
} from "./spool-reconciler";

// Turns helper events into capture rows. Every write goes through the
// idempotent import functions of @sondine/db, so replaying events (a snapshot
// after reconnecting, a restarted core) changes nothing. The end of each
// snapshot (its `ack`) reconciles the database with the spool's manifests,
// which also hold what lost events carried (spool-reconciler.ts), and closes
// the calls it did not replay (calls.ts in @sondine/db).
//
// A `clock` vouches only for the calls this connection saw active (live,
// from the helper's backlog, or replayed) and not ended since. A call stored
// open before the connection may have ended while core was away, its `ended`
// dropped from the helper's backlog (`events.dropped`): no clock moves it,
// and unless the snapshot replays it, the snapshot's end closes it at the
// last clock that vouched for it. Drops only take the oldest events, so a
// call whose `active` arrived on this connection lost none of its later ones.

type ProtocolTransport = Extract<TrackOpenEvent["source"], { kind: "input" }>["transport"];
type ProtocolEndReason = TrackCloseEvent["reason"];

const transports: Record<ProtocolTransport, DeviceTransport> = {
  "built-in": "built_in",
  usb: "usb",
  bluetooth: "bluetooth",
  "bluetooth-le": "bluetooth_le",
  thunderbolt: "thunderbolt",
  pci: "pci",
  firewire: "unknown",
  hdmi: "hdmi",
  displayport: "display_port",
  airplay: "airplay",
  avb: "unknown",
  continuity: "continuity",
  virtual: "virtual",
  aggregate: "aggregate",
  unknown: "unknown",
};

const callVias: Record<CallEvent["via"], CallVia> = {
  "call-app": "call_app",
  "call-daemon": "call_daemon",
  browser: "browser",
};

const spanTables: readonly SpanTable[] = ["calls", "listens"];

function spanOf(event: CallEvent | ListenEvent): { table: SpanTable; uid: string } {
  return event.type === "call"
    ? { table: "calls", uid: event.callId }
    : { table: "listens", uid: event.listenId };
}

const endReasons: Record<ProtocolEndReason, TrackRunEndReason> = {
  paused: "paused",
  held: "stopped",
  disabled: "stopped",
  excluded: "stopped",
  "device-removed": "device_lost",
  "device-changed": "device_changed",
  "tap-released": "released",
  sleep: "sleep",
  "service-restarted": "device_lost",
  permission: "permission_revoked",
  error: "helper_exit",
  shutdown: "stopped",
};

interface OpenFile {
  readonly relPath: string;
  readonly spoolFileId: number;
  /** Rotation index: the run's active file is the highest one seen. */
  readonly seq: number;
}

interface RunContext {
  readonly trackRunId: number;
  readonly trackKey: string;
  readonly sourceKind: TrackSourceKind;
  readonly startedWallMs: number;
  readonly anchor: ClockAnchor;
  file: OpenFile | null;
}

export interface ImportResult {
  readonly event: HelperEvent["type"];
  /** Statuses of the rows the event touched; empty when it needs no row. */
  readonly statuses: readonly ImportStatus[];
  /** Calls or listens that started, ended, or closed as lost: the grouping may change. */
  readonly spansChanged?: number;
  /** Why the event was not imported, when it could not be. */
  readonly skipped?: string;
  /** What reconciling the spool changed (the end of a snapshot, `events.dropped`). */
  readonly reconciled?: ReconcileReport;
}

export interface CaptureImporterOptions {
  /** Directory of the spool relative to the data directory. */
  readonly spoolDir: string;
  /** Absolute spool directory. Without it the spool is never reconciled. */
  readonly spoolRoot?: string;
  readonly now?: () => number;
  /** Wall-clock ms of the last boot (default: from the OS uptime). */
  readonly bootWallMs?: () => number;
}

/**
 * What reconciling the spool vouches for since the current helper session's
 * snapshot. Retention evicts a run's audio only when that run is vouched for
 * (ADR 016).
 */
export interface ReconciliationState {
  /** The snapshot's reconciliation ran, and no problem since then failed to name its run. */
  readonly reconciled: boolean;
  /** Runs the connected helper reported open since its `ready`. */
  readonly liveRuns: ReadonlySet<string>;
  /** Runs with a problem in a reconciliation since that snapshot. */
  readonly problemRuns: ReadonlySet<string>;
}

export interface CaptureImporter {
  /** Imports one event in one transaction; throws ImportConflictError or RangeError. */
  handle(event: HelperEvent): ImportResult;
  /** Forgets per-session state; the next `ready` and snapshot rebuild it. */
  resetSession(): void;
  reconciliation(): ReconciliationState;
  /** Where the Mac plays sound now, from the helper's latest device list (`outputRoute`). */
  outputRoute(): PlaybackRoute;
}

export function createCaptureImporter(
  db: Database,
  options: CaptureImporterOptions,
): CaptureImporter {
  const now = options.now ?? Date.now;
  const bootWallMs = options.bootWallMs ?? (() => Date.now() - Math.round(uptime() * 1_000));
  const runs = new Map<string, RunContext>();
  let session: ReadyEvent | null = null;
  /** Runs the connected helper reported open since its `ready`. */
  const liveRuns = new Set<string>();
  /** An event failed to import (a full database disk): repair from the spool at the next commit. */
  let repairPending = false;
  /** `events.dropped` arrived: the next snapshot's end reads every manifest. */
  let fullPending = false;
  /** The helper's latest device list: where sound plays now. */
  let latestDevices: DevicesEvent | null = null;
  /** The current session's snapshot was reconciled (see ReconciliationState). */
  let reconciled = false;
  const problemRuns = new Set<string>();
  /** The newest clock anchor of the current session: `call` and `listen` events carry no wall time. */
  let latestAnchor: ClockAnchor | null = null;
  /** The app `system:other` was attributed to, by run, from the latest `activity`. */
  const attributions = new Map<string, string>();
  /** Calls and listens each pending snapshot replayed, by snapshot request id. */
  const replayedSpans = new Map<string, Record<SpanTable, Set<string>>>();
  /** The clock each pending snapshot sent before its replays, by snapshot request id. */
  const snapshotClocks = new Map<string, SpanClock>();
  /** Spans this connection saw active and not ended: the ones a `clock` vouches for. */
  const confirmedSpans: Record<SpanTable, Set<string>> = { calls: new Set(), listens: new Set() };

  /** Starts over at a snapshot (`snapshot` true) or adds a later report's problems. */
  function vouch(report: ReconcileReport | undefined, snapshot: boolean): void {
    if (report === undefined) return;
    const named = problemRunIds(report.problems);
    for (const runId of named.runs) problemRuns.add(runId);
    const unattributed = named.unattributed;
    if (unattributed > 0) reconciled = false;
    else if (snapshot) reconciled = true;
  }

  function forgetReconciliation(): void {
    reconciled = false;
    problemRuns.clear();
  }

  function forgetSpans(): void {
    for (const table of spanTables) confirmedSpans[table].clear();
    replayedSpans.clear();
    snapshotClocks.clear();
  }

  const vadVersion = () =>
    session === null
      ? "unknown"
      : `${session.capabilities.vad.engine}/${session.capabilities.vad.version}`;

  function sourceOf(event: TrackOpenEvent): {
    sourceKind: TrackSourceKind;
    device?: Parameters<typeof upsertDevice>[1];
    app?: Parameters<typeof upsertApp>[1];
  } {
    const seenAtMs = now();
    switch (event.source.kind) {
      case "input":
        return {
          sourceKind: "input",
          device: {
            uid: event.source.deviceUid,
            name: event.source.name,
            transport: transports[event.source.transport],
            hasInput: true,
            seenAtMs,
          },
        };
      case "app":
        return {
          sourceKind: "app",
          app: { bundleId: event.source.bundleId, name: event.source.name, seenAtMs },
        };
      case "system":
        return { sourceKind: "system" };
    }
  }

  /** Wall time of a helper instant: through the newest anchor, else the boot. */
  function spanClock(point: ClockPoint): SpanClock {
    const anchor = latestAnchor ?? runs.values().next().value?.anchor ?? null;
    return {
      wallMs:
        anchor === null
          ? bootWallMs() + Number(point.continuousNs / 1_000_000n)
          : wallMsAt(point, anchor),
      continuousUs: continuousUs(point),
    };
  }

  /** A call or a listen span: the same replay rules, each in its own table. */
  function span(event: CallEvent | ListenEvent): ImportResult {
    if (session === null) return { event: event.type, statuses: [], skipped: "no session" };
    const { table, uid } = spanOf(event);
    if (event.replyTo !== undefined) {
      const replayed = replayedSpans.get(event.replyTo) ?? { calls: new Set(), listens: new Set() };
      replayed[table].add(uid);
      replayedSpans.set(event.replyTo, replayed);
    }
    const at = spanClock(event.at);
    const nowMs = now();
    const { sessionId } = session;
    const result =
      event.state === "ended"
        ? recordSpanEnded(db, table, { uid, at, nowMs })
        : event.type === "call"
          ? recordCallActive(db, {
              uid,
              sessionId,
              bundleId: event.bundleId,
              via: callVias[event.via],
              inputDeviceUid: event.inputDeviceUid,
              at,
              nowMs,
            })
          : recordListenActive(db, {
              uid,
              sessionId,
              bundleId: event.bundleId,
              via: event.via,
              at,
              nowMs,
            });
    if (event.state === "active") confirmedSpans[table].add(uid);
    else confirmedSpans[table].delete(uid);
    const changed = result.status === "inserted" || result.status === "updated" ? 1 : 0;
    return { event: event.type, statuses: [result.status], spansChanged: changed };
  }

  /**
   * The newest anchor places later `call` and `listen` events; it also
   * proves the spans this connection confirmed still active. A snapshot's
   * clock comes before its replays: they are confirmed as of it at the
   * snapshot's end.
   */
  function clock(event: ClockEvent): ImportResult {
    latestAnchor = event.anchor;
    if (session === null) return { event: event.type, statuses: [] };
    const at = { wallMs: anchorWallMs(event.anchor), continuousUs: continuousUs(event.anchor) };
    if (event.replyTo !== undefined) snapshotClocks.set(event.replyTo, at);
    let touched = 0;
    for (const table of spanTables)
      touched += touchSpans(db, table, { uids: confirmedSpans[table], at });
    return { event: event.type, statuses: touched > 0 ? ["updated"] : [] };
  }

  function activity(event: ActivityEvent): ImportResult {
    for (const entry of event.attribution) {
      if (entry.bundleId === null) attributions.delete(entry.runId);
      else attributions.set(entry.runId, entry.bundleId);
    }
    return { event: event.type, statuses: [] };
  }

  /** The app a new `system:other` region is attributed to, if the latest activity named one. */
  function attributedAppId(run: RunContext, runId: string): number | null {
    if (run.sourceKind !== "system") return null;
    const bundleId = attributions.get(runId);
    if (bundleId === undefined) return null;
    return upsertApp(db, { bundleId, seenAtMs: now() }).appId;
  }

  function trackOpen(event: TrackOpenEvent): ImportResult {
    if (session === null) return { event: event.type, statuses: [], skipped: "no session" };
    const { sourceKind, device, app } = sourceOf(event);
    const startedWallMs = wallMsAt(event.start, event.anchor);
    const run = upsertTrackRun(db, {
      uid: event.runId,
      trackKey: event.trackKey,
      sourceKind,
      ...(device === undefined ? {} : { device }),
      ...(app === undefined ? {} : { app }),
      sampleRate: SAMPLE_RATE,
      startedWallMs,
      nowMs: now(),
    });
    const epoch = recordEpoch(db, {
      trackRunId: run.trackRunId,
      seq: event.epoch,
      reason: "run_start",
      sampleStart: 0,
      measuredRateHz: event.measuredRate,
      timebaseNumer: session.timebase.numer,
      timebaseDenom: session.timebase.denom,
      anchorHostTicks: event.anchor.hostTicks,
      anchorContinuousUs: continuousUs(event.anchor),
      anchorWallMs: anchorWallMs(event.anchor),
    });
    const previous = runs.get(event.runId);
    liveRuns.add(event.runId);
    runs.set(event.runId, {
      trackRunId: run.trackRunId,
      trackKey: event.trackKey,
      sourceKind,
      startedWallMs,
      anchor: event.anchor,
      file: previous?.file ?? null,
    });
    return { event: event.type, statuses: [run.status, epoch.status] };
  }

  function trackUpdate(event: TrackUpdateEvent, run: RunContext): ImportResult {
    if (session === null) return { event: event.type, statuses: [], skipped: "no session" };
    if (event.reason !== "rate-change" && event.reason !== "format-change") {
      return { event: event.type, statuses: [] };
    }
    const epoch = recordEpoch(db, {
      trackRunId: run.trackRunId,
      seq: event.epoch,
      reason: event.reason === "rate-change" ? "rate_change" : "discontinuity",
      sampleStart: event.sampleIndex,
      measuredRateHz: event.measuredRate,
      timebaseNumer: session.timebase.numer,
      timebaseDenom: session.timebase.denom,
      anchorHostTicks: event.at.hostTicks,
      anchorContinuousUs: continuousUs(event.at),
      anchorWallMs: wallMsAt(event.at, run.anchor),
    });
    return { event: event.type, statuses: [epoch.status] };
  }

  function trackClose(event: TrackCloseEvent, run: RunContext): ImportResult {
    const endedWallMs = wallMsAt(event.at, run.anchor);
    const statuses: ImportStatus[] = [];
    if (run.file !== null) {
      statuses.push(
        closeSpoolFile(db, { spoolFileId: run.file.spoolFileId, closedWallMs: endedWallMs }).status,
      );
      run.file = null;
    }
    const closed = upsertTrackRun(db, {
      uid: event.runId,
      trackKey: run.trackKey,
      sourceKind: run.sourceKind,
      sampleRate: SAMPLE_RATE,
      startedWallMs: run.startedWallMs,
      state: "closed",
      endedWallMs,
      endReason: endReasons[event.reason],
      sampleEnd: event.endSample,
      nowMs: now(),
    });
    statuses.push(closed.status);
    runs.delete(event.runId);
    liveRuns.delete(event.runId);
    attributions.delete(event.runId);
    if (options.spoolRoot === undefined) return { event: event.type, statuses };
    // A tail without chunks (a disk that stayed full) is read from the spool,
    // or recorded as a gap; the close itself never fails for it.
    try {
      const accounted = accountForClosedRun(
        db,
        { spoolRoot: options.spoolRoot, spoolDir: options.spoolDir, vadVersion: vadVersion() },
        event.runId,
      );
      return { event: event.type, statuses, reconciled: accounted };
    } catch (error) {
      const name = error instanceof Error ? error.name : "unknown error";
      return {
        event: event.type,
        statuses,
        reconciled: {
          runsClosed: 0,
          runsImported: 0,
          chunks: 0,
          gaps: 0,
          regions: 0,
          problems: [`${event.runId}: account ${name}`],
        },
      };
    }
  }

  function spoolFileFor(
    event: CommitEvent,
    run: RunContext,
  ): { file: OpenFile; statuses: ImportStatus[] } {
    const relPath = `${options.spoolDir}/${event.file}`;
    if (run.file?.relPath === relPath) return { file: run.file, statuses: [] };
    const statuses: ImportStatus[] = [];
    const commitWallMs = wallMsAt(event.at, run.anchor);
    const seq = spoolSeq(event.file);
    // A replayed commit from an older file: record it there, but the newer
    // file stays the active one and stays open.
    const historical = run.file !== null && seq < run.file.seq;
    if (run.file !== null && !historical) {
      statuses.push(
        closeSpoolFile(db, { spoolFileId: run.file.spoolFileId, closedWallMs: commitWallMs })
          .status,
      );
    }
    // A core that starts mid-run never saw the files before this one: they are complete.
    if (run.file === null) {
      statuses.push(
        ...closeEarlierSpoolFiles(db, {
          trackRunId: run.trackRunId,
          beforeSeq: seq,
          closedWallMs: commitWallMs,
        }).statuses,
      );
    }
    const existing = db
      .statement("SELECT id FROM spool_files WHERE track_run_id = ? AND seq = ?")
      .get(run.trackRunId, seq)?.["id"];
    let spoolFileId: number;
    if (typeof existing !== "number") {
      // Exact for the file's first block; without gaps it is exact for any block.
      const byteOffset = event.committedOffset - event.sampleCount * BYTES_PER_SAMPLE;
      const recorded = recordSpoolFile(db, {
        trackRunId: run.trackRunId,
        seq,
        relPath,
        sampleStart: Math.max(0, event.sampleIndex - byteOffset / BYTES_PER_SAMPLE),
        createdWallMs: commitWallMs,
      });
      spoolFileId = recorded.spoolFileId;
      statuses.push(recorded.status);
      // An older file core never saw: a newer one exists, so it is no longer written.
      if (historical) {
        statuses.push(closeSpoolFile(db, { spoolFileId, closedWallMs: commitWallMs }).status);
      }
    } else {
      spoolFileId = existing;
      statuses.push("duplicate");
    }
    const file = { relPath, spoolFileId, seq };
    if (!historical) run.file = file;
    return { file, statuses };
  }

  function commit(event: CommitEvent, run: RunContext): ImportResult {
    const { file, statuses } = spoolFileFor(event, run);
    const byteLength = event.sampleCount * BYTES_PER_SAMPLE;
    const block = recordSpoolCommit(db, {
      spoolFileId: file.spoolFileId,
      byteOffset: event.committedOffset - byteLength,
      byteLength,
      sampleStart: event.sampleIndex,
      hostTicks: event.at.hostTicks,
      continuousUs: continuousUs(event.at),
      wallMs: wallMsAt(event.at, run.anchor),
      crc32: event.crc32,
    });
    statuses.push(block.status);
    for (const gap of event.gaps) {
      statuses.push(
        recordGap(db, {
          trackRunId: run.trackRunId,
          trackKey: run.trackKey,
          reason: gapReasons[gap.reason],
          wallStartMs: run.startedWallMs + samplesToMs(gap.fromSample, SAMPLE_RATE),
          wallEndMs: run.startedWallMs + samplesToMs(gap.toSample, SAMPLE_RATE),
          sampleStart: gap.fromSample,
          sampleEnd: gap.toSample,
          lostBytes: (gap.toSample - gap.fromSample) * BYTES_PER_SAMPLE,
          detail: gap.reason,
        }).status,
      );
    }
    return { event: event.type, statuses };
  }

  function regionOpen(event: RegionOpenEvent, run: RunContext): ImportResult {
    const opened = openSpeechRegion(db, {
      trackRunId: run.trackRunId,
      sampleStart: event.startSample,
      wallStartMs: wallMsAt(event.at, run.anchor),
      continuousStartUs: continuousUs(event.at),
      vadVersion: vadVersion(),
      attributedAppId: attributedAppId(run, event.runId),
    });
    return { event: event.type, statuses: [opened.status] };
  }

  function regionClose(event: RegionCloseEvent, run: RunContext): ImportResult {
    const close = () =>
      closeSpeechRegion(db, {
        trackRunId: run.trackRunId,
        sampleStart: event.startSample,
        sampleEnd: event.endSample,
        wallEndMs: wallMsAt(event.at, run.anchor),
        continuousEndUs: continuousUs(event.at),
        endReason: regionEndReasons[event.closeReason],
        voicedSamples: event.voicedSamples ?? null,
      });
    // The apps in front while it lasted, within what the region kept (ADR 022).
    const withForeground = (closed: ReturnType<typeof close>) => {
      if (closed.speechRegionId !== null) {
        recordForegroundSpans(db, {
          speechRegionId: closed.speechRegionId,
          spans: event.foreground.map((front) => ({
            bundleId: front.bundleId,
            name: front.name,
            sampleStart: front.startSample,
            sampleEnd: front.endSample,
          })),
          seenAtMs: now(),
        });
      }
      return closed.status;
    };
    const first = close();
    if (first.status !== "unknown") return { event: event.type, statuses: [withForeground(first)] };
    // Core missed the region's open (it was down): record the start from the run's clock.
    const opened = openSpeechRegion(db, {
      trackRunId: run.trackRunId,
      sampleStart: event.startSample,
      wallStartMs: run.startedWallMs + samplesToMs(event.startSample, SAMPLE_RATE),
      vadVersion: vadVersion(),
      attributedAppId: attributedAppId(run, event.runId),
    });
    return { event: event.type, statuses: [opened.status, withForeground(close())] };
  }

  function withRun(
    event: { type: HelperEvent["type"]; runId: string },
    importInto: (run: RunContext) => ImportResult,
  ): ImportResult {
    const run = runs.get(event.runId);
    // A run opened while core was down: the snapshot that follows every
    // connection replays its track.open, and the helper's manifests keep the
    // rest for recovery.
    if (run === undefined) return { event: event.type, statuses: [], skipped: "unknown run" };
    return importInto(run);
  }

  function reconcile(event: HelperEvent["type"], full: boolean): ImportResult {
    if (options.spoolRoot === undefined || session === null) return { event, statuses: [] };
    const report = reconcileSpool(db, {
      spoolRoot: options.spoolRoot,
      spoolDir: options.spoolDir,
      sessionId: session.sessionId,
      liveRuns,
      vadVersion: vadVersion(),
      nowMs: now(),
      bootWallMs: bootWallMs(),
      full,
    });
    const changed =
      report.runsClosed + report.runsImported + report.chunks + report.gaps + report.regions > 0;
    return { event, statuses: changed ? ["updated"] : [], reconciled: report };
  }

  function apply(event: HelperEvent): ImportResult {
    switch (event.type) {
      case "ready":
        // A new helper: the previous one's runs are over, and reconciliation closes them.
        if (session?.sessionId !== event.sessionId) {
          runs.clear();
          attributions.clear();
          latestAnchor = null;
        }
        session = event;
        liveRuns.clear();
        forgetReconciliation();
        // A new connection: events may have been dropped while core was away.
        forgetSpans();
        return { event: event.type, statuses: [] };
      case "devices": {
        const before = outputRoute(latestDevices);
        latestDevices = event;
        const seenAtMs = now();
        // Headphones plugged or unplugged while Sondine plays: its playback changes way now.
        const after = outputRoute(event);
        if (after !== before) reroutePlayback(db, { route: after, nowMs: seenAtMs });
        const statuses = event.devices.map(
          (device) =>
            upsertDevice(db, {
              uid: device.uid,
              name: device.name,
              transport: transports[device.transport],
              hasInput: device.input,
              hasOutput: device.output,
              seenAtMs,
            }).status,
        );
        return { event: event.type, statuses };
      }
      case "processes": {
        const seenAtMs = now();
        const statuses = event.processes.flatMap((process) =>
          process.app === null
            ? []
            : [
                upsertApp(db, { bundleId: process.app.bundleId, name: process.app.name, seenAtMs })
                  .status,
              ],
        );
        return { event: event.type, statuses };
      }
      case "track.open":
        return trackOpen(event);
      case "track.update":
        return withRun(event, (run) => trackUpdate(event, run));
      case "track.close":
        return withRun(event, (run) => trackClose(event, run));
      case "commit":
        return withRun(event, (run) => commit(event, run));
      case "region.open":
        return withRun(event, (run) => regionOpen(event, run));
      case "region.close":
        return withRun(event, (run) => regionClose(event, run));
      case "call":
      case "listen":
        return span(event);
      case "clock":
        return clock(event);
      default:
        // permissions, activity (handled before the transaction), health,
        // warning, error and ack carry no capture rows.
        return { event: event.type, statuses: [] };
    }
  }

  return {
    handle(event) {
      // The helper client publishes only the `ack` that ends a snapshot. Each
      // run is reconciled in its own transactions, outside the event's.
      if (event.type === "ack") {
        const full = fullPending;
        fullPending = false;
        forgetReconciliation();
        const result = reconcile(event.type, full);
        vouch(result.reconciled, true);
        // The snapshot replayed every active call and listen span, as of its clock: the other
        // open ones are over.
        const replayed = replayedSpans.get(event.replyTo);
        const at = snapshotClocks.get(event.replyTo) ?? null;
        replayedSpans.delete(event.replyTo);
        snapshotClocks.delete(event.replyTo);
        if (session === null) return result;
        let lost = 0;
        for (const table of spanTables) {
          lost += closeLostSpans(db, table, {
            replayed: replayed?.[table] ?? new Set(),
            at,
            nowMs: now(),
          });
        }
        return lost === 0 ? result : { ...result, spansChanged: lost };
      }
      // The helper's backlog overflowed: any run may miss events, old files
      // included. It can arrive before the snapshot that says which runs are
      // live, so the reconciliation waits for that snapshot's end.
      if (event.type === "warning" && event.code === "events.dropped") {
        fullPending = true;
        return { event: event.type, statuses: [] };
      }
      // Attribution only stays in memory (for the next regions): no transaction.
      if (event.type === "activity") return activity(event);
      // The per-run state must match the database: a rolled-back event leaves
      // neither rows nor in-memory changes behind.
      const savedSession = session;
      const savedRuns = [...runs].map(([runId, run]) => [runId, { ...run }] as const);
      const savedLive = [...liveRuns];
      const savedAnchor = latestAnchor;
      const savedAttributions = [...attributions];
      const savedConfirmed = spanTables.map(
        (table) => [table, [...confirmedSpans[table]]] as const,
      );
      const savedSnapshotClocks = [...snapshotClocks];
      try {
        const result = transaction(db, () => apply(event));
        vouch(result.reconciled, false);
        if (!repairPending || event.type !== "commit") return result;
        repairPending = false;
        // Files may have rotated since the failure: read them all.
        const repaired = reconcile(event.type, true).reconciled;
        vouch(repaired, false);
        return repaired === undefined ? result : { ...result, reconciled: repaired };
      } catch (error) {
        repairPending = true;
        session = savedSession;
        runs.clear();
        for (const [runId, run] of savedRuns) runs.set(runId, run);
        liveRuns.clear();
        for (const runId of savedLive) liveRuns.add(runId);
        latestAnchor = savedAnchor;
        attributions.clear();
        for (const [runId, bundleId] of savedAttributions) attributions.set(runId, bundleId);
        snapshotClocks.clear();
        for (const [id, at] of savedSnapshotClocks) snapshotClocks.set(id, at);
        for (const [table, uids] of savedConfirmed) confirmedSpans[table] = new Set(uids);
        // A span whose event did not import may have lost its `ended`: no clock vouches for it.
        if (event.type === "call" || event.type === "listen") {
          const { table, uid } = spanOf(event);
          confirmedSpans[table].delete(uid);
        }
        throw error;
      }
    },
    resetSession() {
      session = null;
      runs.clear();
      liveRuns.clear();
      attributions.clear();
      forgetSpans();
      latestAnchor = null;
      forgetReconciliation();
    },
    reconciliation() {
      return { reconciled, liveRuns: new Set(liveRuns), problemRuns: new Set(problemRuns) };
    },
    outputRoute: () => outputRoute(latestDevices),
  };
}

/** Rotation index from a spool file name such as `<track>/<run>/0003.pcm`. */
export function spoolSeq(file: string): number {
  const match = /(\d+)\.pcm$/.exec(file);
  if (match?.[1] === undefined) throw new RangeError(`Spool file ${file} has no rotation index`);
  return Number.parseInt(match[1], 10);
}
