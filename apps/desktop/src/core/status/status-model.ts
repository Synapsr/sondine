import type {
  HealthWindow,
  HelperProcessState,
  ListeningIntent,
  ListeningStatus,
  Problem,
  Status,
  Track,
} from "@sondine/api";
import type { ClockAnchor, HealthEvent, HelperEvent, TrackOpenEvent } from "@sondine/protocol";
import { wallMsAt } from "../capture/clock";
import type { HelperProcessInfo } from "../../shared/core-messages";

// Pure reducers from helper events and main's reports to the API status.

export interface PausedFlags {
  readonly microphone: boolean;
  readonly systemAudio: boolean;
}

export function intentOf(flags: PausedFlags): ListeningIntent {
  return flags.microphone && flags.systemAudio ? "paused" : "listening";
}

export function listeningStatus(
  desired: PausedFlags,
  confirmed: PausedFlags | null,
  changedAtMs: number,
  pausedUntilMs: number | null = null,
  holds: ListeningStatus["holds"] = [],
): ListeningStatus {
  let effective: ListeningStatus["effective"] = "unknown";
  if (confirmed !== null) {
    if (confirmed.microphone && confirmed.systemAudio) effective = "paused";
    else if (!confirmed.microphone && !confirmed.systemAudio) effective = "listening";
    else effective = "partial";
  }
  return {
    desired: intentOf(desired),
    effective,
    microphonePaused: confirmed?.microphone ?? null,
    systemAudioPaused: confirmed?.systemAudio ?? null,
    changedAtMs,
    pausedUntilMs,
    holds,
    callOffer: null,
    forCall: null,
    call: null,
    callEnded: null,
    pauseReminder: null,
  };
}

export function initialStatus(nowMs: number, desired: PausedFlags): Status {
  return {
    listening: listeningStatus(desired, null, nowMs),
    helper: {
      connection: "connecting",
      process: "unknown",
      pid: null,
      restarts: 0,
      sessionId: null,
      version: null,
      connectedAtMs: null,
      lastError: null,
    },
    permissions: null,
    tracks: [],
    spool: [],
    lastHealth: null,
    power: { onBattery: null, suspended: false, thermalState: null },
    importer: { imported: 0, errors: 0, lastError: null },
    analysis: {
      worker: "absent",
      queued: { requested: 0, conversations: 0, moments: 0, media: 0, traces: 0 },
      running: null,
      waitingFor: [],
      waitingEpisodeId: null,
      server: null,
      requests: [],
      retryAtMs: null,
      lastError: null,
      models: [],
    },
    live: { enabled: false, state: "off", revision: 0 },
    updates: {
      automatic: null,
      searches: false,
      blocked: null,
      current: "",
      available: null,
      phase: "idle",
      progress: null,
      waitingFor: [],
      requested: false,
      checkedAtMs: null,
      problem: null,
      updated: null,
    },
    retention: { spoolBytes: 0, archivedBytes: 0, blocked: 0, lastProblem: null },
    deletions: 0,
    kept: 0,
    changes: 0,
    updatedAtMs: nowMs,
  };
}

function trackOf(event: TrackOpenEvent, nowMs: number): Track {
  const source = event.source;
  return {
    trackKey: event.trackKey,
    runId: event.runId,
    kind: source.kind,
    name: source.kind === "input" ? source.name : source.kind === "app" ? source.name : null,
    stream: event.stream,
    measuredRate: event.measuredRate,
    level: null,
    speaking: false,
    ringOverflows: 0,
    droppedSamples: 0,
    openedAtMs: (() => {
      try {
        return wallMsAt(event.start, event.anchor);
      } catch {
        return nowMs;
      }
    })(),
  };
}

const truncate = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);

export function problem(code: string, message: string, atMs: number): Problem {
  return { code: truncate(code, 64), message: truncate(message, 1024), atMs };
}

/** Status fields that follow helper events. Listening and connection are set by their services. */
export function applyHelperEvent(
  status: Status,
  event: HelperEvent,
  nowMs: number,
  anchor: ClockAnchor | null,
): Status {
  switch (event.type) {
    case "permissions":
      return {
        ...status,
        permissions: { microphone: event.microphone, systemAudio: event.systemAudio },
        updatedAtMs: nowMs,
      };
    case "track.open": {
      const tracks = status.tracks.filter((track) => track.runId !== event.runId);
      tracks.push(trackOf(event, nowMs));
      tracks.sort((a, b) => a.trackKey.localeCompare(b.trackKey));
      // A new run has a new spool: it reports its own failure, if any.
      const spool =
        event.replyTo === undefined
          ? status.spool.filter((entry) => entry.trackKey !== event.trackKey)
          : status.spool;
      return { ...status, tracks, spool, updatedAtMs: nowMs };
    }
    case "track.update":
      return {
        ...status,
        tracks: status.tracks.map((track) =>
          track.runId === event.runId
            ? { ...track, stream: event.stream, measuredRate: event.measuredRate }
            : track,
        ),
        updatedAtMs: nowMs,
      };
    case "track.close":
      return {
        ...status,
        tracks: status.tracks.filter((track) => track.runId !== event.runId),
        updatedAtMs: nowMs,
      };
    case "health": {
      const window = healthWindow(event, anchor, nowMs);
      const byRun = new Map(event.tracks.map((track) => [track.runId, track]));
      return {
        ...status,
        lastHealth: {
          atMs: window.atMs,
          windowMs: window.windowMs,
          footprintBytes: window.footprintBytes,
          cpuNs: window.cpuNs,
          wakeups: window.wakeups,
        },
        tracks: status.tracks.map((track) => {
          const health = byRun.get(track.runId);
          return health === undefined
            ? track
            : {
                ...track,
                stream: health.stream,
                measuredRate: health.measuredRate,
                level: health.level,
                ringOverflows: track.ringOverflows + health.ringOverflows,
                droppedSamples: track.droppedSamples + health.droppedSamples,
              };
        }),
        updatedAtMs: nowMs,
      };
    }
    case "error": {
      const failed = event.code === "disk.full" || event.code === "spool.io";
      const trackKey = event.trackKey ?? null;
      return {
        ...status,
        helper: { ...status.helper, lastError: problem(event.code, event.message, nowMs) },
        // The first report of an outage dates it; a later one only changes its code.
        spool: failed
          ? [
              ...status.spool.filter((entry) => entry.trackKey !== trackKey),
              {
                trackKey,
                code: event.code === "disk.full" ? "disk.full" : "spool.io",
                sinceMs:
                  status.spool.find((entry) => entry.trackKey === trackKey)?.sinceMs ?? nowMs,
              },
            ]
          : status.spool,
        updatedAtMs: nowMs,
      };
    }
    case "region.open":
    case "region.close": {
      const speaking = event.type === "region.open";
      if (
        !status.tracks.some((track) => track.runId === event.runId && track.speaking !== speaking)
      )
        return status;
      return {
        ...status,
        tracks: status.tracks.map((track) =>
          track.runId === event.runId ? { ...track, speaking } : track,
        ),
        updatedAtMs: nowMs,
      };
    }
    case "warning":
      if (event.code !== "spool.resumed") return status;
      return {
        ...status,
        spool: status.spool.filter((entry) => entry.trackKey !== (event.trackKey ?? null)),
        updatedAtMs: nowMs,
      };
    default:
      return status;
  }
}

export function healthWindow(
  event: HealthEvent,
  anchor: ClockAnchor | null,
  nowMs: number,
): HealthWindow {
  let atMs = nowMs;
  if (anchor !== null) {
    try {
      atMs = wallMsAt(event.at, anchor);
    } catch {
      atMs = nowMs;
    }
  }
  return {
    atMs,
    windowMs: event.windowMs,
    footprintBytes: event.process.footprintBytes,
    cpuNs: event.process.cpuNs,
    wakeups: event.process.wakeups,
    tracks: event.tracks.map((track) => ({ ...track })),
    stages: event.stages.map((stage) => ({
      stage: stage.stage,
      trackKey: stage.trackKey,
      count: stage.count,
      sumNs: stage.sum,
      p50Ns: stage.p50,
      p95Ns: stage.p95,
      maxNs: stage.max,
    })),
  };
}

const processStates: Record<HelperProcessInfo["state"], HelperProcessState> = {
  starting: "starting",
  running: "running",
  restarting: "restarting",
  "crash-loop": "crash-loop",
  missing: "missing",
  stopped: "stopped",
};

export function applyHelperProcess(status: Status, info: HelperProcessInfo, nowMs: number): Status {
  return {
    ...status,
    helper: {
      ...status.helper,
      process: processStates[info.state],
      pid: info.pid,
      restarts: info.restarts,
    },
    updatedAtMs: nowMs,
  };
}
