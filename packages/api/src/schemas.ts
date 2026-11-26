import {
  PauseScope,
  PermissionEvidence,
  PermissionStatus,
  StreamState,
  UsageReport,
} from "@sondine/protocol";
import * as z from "zod";

// Wire shapes of the app API. Times are wall-clock milliseconds since the Unix
// epoch, durations are nanoseconds where the helper measured them, and no
// field carries bigint values (MCP clients read plain JSON). Audio never
// appears: `EpisodePlayback` gives the app a `sondine-media:` URL its audio
// element streams from, never offered to agents.
// Transcript text appears only in the episode and search outputs, never in
// the status.

const WallMs = z.int().min(0);
const Count = z.int().min(0);

export const ListeningIntent = z.enum(["listening", "paused"]);
export type ListeningIntent = z.output<typeof ListeningIntent>;

export const EffectiveListening = z.enum(["listening", "paused", "partial", "unknown"]);
export type EffectiveListening = z.output<typeof EffectiveListening>;

// Private zones (ADR 029)

export const ZoneOutcome = z.enum([
  "nothing",
  "text_only",
  "audio_only",
  "delete_week",
  "delete_day",
]);
export type ZoneOutcome = z.output<typeof ZoneOutcome>;

export const RecordingType = z.enum([
  "calls",
  "conversations",
  "moments",
  "traces",
  "media",
  "dictations",
]);
export type RecordingType = z.output<typeof RecordingType>;

/** Days of the Mac's local week (0 is Sunday), from a minute of the day to another; an end at or before the start crosses midnight. */
export const ScheduleWindow = z.strictObject({
  days: z.array(z.int().min(0).max(6)).min(1).max(7),
  startMinute: z.int().min(0).max(1439),
  endMinute: z.int().min(0).max(1440),
});
export type ScheduleWindow = z.output<typeof ScheduleWindow>;

const ZoneName = z.string().trim().min(1).max(80);

/** A zone's situation as Settings shows it. */
export const ZoneSituationView = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("app"),
    bundleId: z.string().max(255),
    name: z.string().max(255),
  }),
  z.strictObject({ kind: z.literal("site"), site: z.string().max(253) }),
  z.strictObject({
    kind: z.literal("media_sites"),
    /** The ten films, series and music sites, each left out or kept. */
    sites: z.array(z.strictObject({ site: z.string().max(253), kept: z.boolean() })).max(32),
  }),
  z.strictObject({
    kind: z.literal("network"),
    name: z.string().max(80),
    /** The Mac is on this network now. */
    here: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("hours"),
    name: z.string().max(80),
    windows: z.array(ScheduleWindow).max(32),
  }),
  z.strictObject({ kind: z.literal("calls") }),
  z.strictObject({ kind: z.literal("screen") }),
]);
export type ZoneSituationView = z.output<typeof ZoneSituationView>;

export const PrivacyZone = z.strictObject({
  id: z.string().max(64),
  /** Built in (films, series and music; calls; the screen; the night): switched off, never removed. */
  builtin: z.boolean(),
  on: z.boolean(),
  outcome: ZoneOutcome,
  situation: ZoneSituationView,
});
export type PrivacyZone = z.output<typeof PrivacyZone>;

export const PrivacyDurations = z.strictObject({
  /** Audio days by type. */
  audioDays: z.record(RecordingType, z.int().min(1).max(3650)),
  /** « Effacé après » by type, in days; null: never. */
  deleteDays: z.record(RecordingType, z.int().min(1).max(3650).nullable()),
});
export type PrivacyDurations = z.output<typeof PrivacyDurations>;

export const PrivacyStatus = z.strictObject({
  zones: z.array(PrivacyZone).max(256),
  durations: PrivacyDurations,
  /** Apps heard playing, calling or listening, the latest first, for « Une app… ». */
  appsHeard: z
    .array(
      z.strictObject({
        bundleId: z.string().max(255),
        name: z.string().max(255),
        lastHeardAtMs: WallMs,
      }),
    )
    .max(50),
  /** Sites a browser played, the latest first, for « Un site… ». */
  sitesHeard: z
    .array(z.strictObject({ site: z.string().max(253), lastPlayedAtMs: WallMs }))
    .max(50),
  /** The Mac is on a network Sondine can recognise, not yet a zone: « Ce réseau » can be added. */
  networkHere: z.boolean(),
  /** Sites are known only while the browser link is on (ADR 023). */
  browserLink: z.boolean(),
});
export type PrivacyStatus = z.output<typeof PrivacyStatus>;

export const PrivacyAddZoneInput = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("app"),
    bundleId: z.string().min(1).max(255),
    /** For an app picked in the open panel, before Sondine heard it. */
    name: z.string().trim().min(1).max(255).optional(),
  }),
  /** A site (« netflix.com ») or any address on it; anything else is `invalid-input`. */
  z.strictObject({ kind: z.literal("site"), site: z.string().min(1).max(2048) }),
  /** The network the Mac is on now, under the user's name for it. */
  z.strictObject({ kind: z.literal("network"), name: ZoneName }),
  z.strictObject({
    kind: z.literal("hours"),
    name: ZoneName,
    windows: z.array(ScheduleWindow).min(1).max(32),
  }),
]);
export type PrivacyAddZoneInput = z.input<typeof PrivacyAddZoneInput>;

export const PrivacyUpdateZoneInput = z.strictObject({
  id: z.string().min(1).max(64),
  on: z.boolean().optional(),
  outcome: ZoneOutcome.optional(),
  /** Hours and networks only. */
  name: ZoneName.optional(),
  /** Hours only. */
  windows: z.array(ScheduleWindow).min(1).max(32).optional(),
});
export type PrivacyUpdateZoneInput = z.input<typeof PrivacyUpdateZoneInput>;

export const PrivacyZoneIdInput = z.strictObject({ id: z.string().min(1).max(64) });
export type PrivacyZoneIdInput = z.input<typeof PrivacyZoneIdInput>;

export const PrivacyMediaSiteInput = z.strictObject({
  site: z.string().min(1).max(253),
  kept: z.boolean(),
});
export type PrivacyMediaSiteInput = z.input<typeof PrivacyMediaSiteInput>;

export const PrivacyDurationInput = z.strictObject({
  type: RecordingType,
  audioDays: z.int().min(1).max(3650).optional(),
  deleteDays: z.int().min(1).max(3650).nullable().optional(),
  /** Apply even when it deletes or expires something now; false only reports what would go. */
  confirm: z.boolean(),
});
export type PrivacyDurationInput = z.input<typeof PrivacyDurationInput>;

export const PrivacyDurationResult = z.strictObject({
  applied: z.boolean(),
  /** Recordings that would go whole now (« Effacé après »). */
  deletes: Count,
  /** Recordings whose audio would go now. */
  silences: Count,
  status: PrivacyStatus,
});
export type PrivacyDurationResult = z.output<typeof PrivacyDurationResult>;

/** A private zone holding capture now (ADR 029). */
export const CaptureHold = z.strictObject({
  occurrenceId: z.string().max(64),
  reason: z.enum(["app", "calls", "screen", "schedule", "network"]),
  /** `microphone`: only the microphone, while an app left out calls or listens. */
  scope: z.enum(["all", "microphone"]),
  /** What to name: the app, the network or the hours' name; null for calls and the screen. */
  name: z.string().max(255).nullable(),
  /** The zone's id when one matches. */
  zoneId: z.string().max(64).nullable(),
  sinceMs: WallMs,
  /** When it ends on its own, for hours; null otherwise. */
  untilMs: WallMs.nullable(),
  /** « Écouter quand même »: lifted until it ends. */
  lifted: z.boolean(),
});
export type CaptureHold = z.output<typeof CaptureHold>;

export const PrivacyLiftInput = z.strictObject({ occurrenceId: z.string().min(1).max(64) });
export type PrivacyLiftInput = z.input<typeof PrivacyLiftInput>;

/**
 * What a call notice offers (ADR 036): `listen` to a call during a pause, or
 * `skip` (not listen to) a call Sondine is listening to.
 */
export const CallOfferKind = z.enum(["listen", "skip"]);
export type CallOfferKind = z.output<typeof CallOfferKind>;

/** A call that starts, offered to listen to during a pause or not to listen to otherwise (ADR 036). */
export const CallOffer = z.strictObject({
  kind: CallOfferKind,
  /** The helper's id for the call as seen; actions name it. */
  callId: z.string().min(1).max(64),
  bundleId: z.string().max(255),
  /** The app's name, else its bundle ID. */
  name: z.string().max(255),
  sinceMs: WallMs,
});
export type CallOffer = z.output<typeof CallOffer>;

/**
 * One call answered: « Écouter cet appel » listens for it during a pause
 * (`listen`), « Ne pas écouter cet appel » pauses for it (`skip`); the intent
 * before comes back 10 s after it ends.
 */
export const CallListen = z.strictObject({
  kind: CallOfferKind,
  bundleId: z.string().max(255),
  name: z.string().max(255),
  sinceMs: WallMs,
});
export type CallListen = z.output<typeof CallListen>;

/**
 * The call going on (ADR 036), for the island and its switch: the latest one
 * seen, of an app that is not muted, unless a private zone holds capture.
 */
export const ListeningCall = z.strictObject({
  /** Stays the same when the app drops its microphone for a moment. */
  callId: z.string().min(1).max(64),
  bundleId: z.string().max(255),
  /** The app's name, else its bundle ID. */
  name: z.string().max(255),
  sinceMs: WallMs,
  /** Its open episode; null until speech joined it, or once the user ended it. */
  episodeId: z.int().positive().nullable(),
});
export type ListeningCall = z.output<typeof ListeningCall>;

/** The last call that ended, when it left a recording or an intent came back with its end. */
export const EndedCall = z.strictObject({
  callId: z.string().min(1).max(64),
  bundleId: z.string().max(255),
  name: z.string().max(255),
  endedAtMs: WallMs,
  /** What was recorded of it, and for how long; null when nothing was. */
  recording: z
    .strictObject({
      episodeId: z.int().positive(),
      durationMs: z.int().min(0),
      /** Still open: « Terminer » may end it now. */
      open: z.boolean(),
    })
    .nullable(),
  /** The intent that came back with its end (« Écouter » or « Ne pas écouter cet appel »). */
  restored: ListeningIntent.nullable(),
});
export type EndedCall = z.output<typeof EndedCall>;

export const ListeningStatus = z.strictObject({
  /** What the user asked for; persisted across restarts. */
  desired: ListeningIntent,
  /** What the helper last confirmed; `unknown` while it is not connected. */
  effective: EffectiveListening,
  microphonePaused: z.boolean().nullable(),
  systemAudioPaused: z.boolean().nullable(),
  changedAtMs: WallMs,
  /** When a timed pause ends and listening resumes on its own; null for an open-ended pause or while listening. */
  pausedUntilMs: WallMs.nullable(),
  /**
   * Private zones holding capture now (ADR 029); never part of the pause. A
   * lifted one (« Écouter quand même ») is listed with `lifted`.
   */
  holds: z.array(CaptureHold).max(64),
  /** A call to notify (ADR 036); null when there is none. */
  callOffer: CallOffer.nullable(),
  /** Listening, or paused, for one call only; null otherwise. */
  forCall: CallListen.nullable(),
  call: ListeningCall.nullable(),
  callEnded: EndedCall.nullable(),
  /** An open-ended pause that lasts (ADR 036), said once per pause: since when. */
  pauseReminder: z.strictObject({ sinceMs: WallMs }).nullable(),
});
export type ListeningStatus = z.output<typeof ListeningStatus>;

export const CallOfferInput = z.strictObject({ callId: z.string().min(1).max(64) });
export type CallOfferInput = z.input<typeof CallOfferInput>;

export const CallOfferDeclineInput = z.strictObject({
  callId: z.string().min(1).max(64),
  /** « Pas pour cette app »: never offer this app's calls again (Settings can undo it). */
  forApp: z.boolean(),
});
export type CallOfferDeclineInput = z.input<typeof CallOfferDeclineInput>;

/** Settings ▸ Écoute: a notification when a call starts (ADR 036). */
export const CallOfferSettings = z.strictObject({
  enabled: z.boolean(),
  /** The apps whose calls are never notified, the latest first. */
  mutedApps: z
    .array(z.strictObject({ bundleId: z.string().max(255), name: z.string().max(255) }))
    .max(200),
});
export type CallOfferSettings = z.output<typeof CallOfferSettings>;

export const CallOfferEnabledInput = z.strictObject({ enabled: z.boolean() });
export type CallOfferEnabledInput = z.input<typeof CallOfferEnabledInput>;

export const EpisodeKeepAudioInput = z.strictObject({
  episodeId: z.int().positive(),
  /** True: « Garder l'audio »; false: « Ne plus garder ». */
  keep: z.boolean(),
});
export type EpisodeKeepAudioInput = z.input<typeof EpisodeKeepAudioInput>;

/** What zones and retention did to a recording (ADR 029), for its one line. */
export const EpisodePrivacy = z.strictObject({
  /** The zones that took something from it. */
  zones: z
    .array(
      z.strictObject({
        id: z.string().max(64),
        outcome: ZoneOutcome,
        situation: ZoneSituationView,
      }),
    )
    .max(32),
  /** « Garder l'audio ». */
  kept: z.boolean(),
  /** Its audio is gone (a zone, or its time); its text stays. */
  audioGone: z.boolean(),
  /** A zone keeps its text from being made (« Transcrire » still can). */
  noText: z.boolean(),
});
export type EpisodePrivacy = z.output<typeof EpisodePrivacy>;

export const HelperConnection = z.enum(["connecting", "connected", "disconnected", "incompatible"]);
export type HelperConnection = z.output<typeof HelperConnection>;

export const HelperProcessState = z.enum([
  "unknown",
  "starting",
  "running",
  "restarting",
  "crash-loop",
  "missing",
  "stopped",
]);
export type HelperProcessState = z.output<typeof HelperProcessState>;

export const Problem = z.strictObject({
  code: z.string().max(64),
  message: z.string().max(1024),
  atMs: WallMs,
});
export type Problem = z.output<typeof Problem>;

export const HelperStatus = z.strictObject({
  connection: HelperConnection,
  process: HelperProcessState,
  pid: z.int().positive().nullable(),
  restarts: Count,
  sessionId: z.string().nullable(),
  version: z.string().nullable(),
  connectedAtMs: WallMs.nullable(),
  lastError: Problem.nullable(),
});
export type HelperStatus = z.output<typeof HelperStatus>;

export const PermissionState = z.strictObject({
  status: PermissionStatus,
  evidence: PermissionEvidence,
});
export type PermissionState = z.output<typeof PermissionState>;

export const Permissions = z.strictObject({
  microphone: PermissionState,
  systemAudio: PermissionState,
});
export type Permissions = z.output<typeof Permissions>;

export const TrackKind = z.enum(["input", "app", "system"]);
export type TrackKind = z.output<typeof TrackKind>;

export const Track = z.strictObject({
  trackKey: z.string(),
  runId: z.string(),
  kind: TrackKind,
  name: z.string().nullable(),
  stream: StreamState,
  measuredRate: z.number().nullable(),
  /** Mean dBFS over the last health window; null before the first one. */
  level: z.number().nullable(),
  /** The VAD hears speech on it now (a speech region is open): the top bar's wave moves. */
  speaking: z.boolean(),
  ringOverflows: Count,
  droppedSamples: Count,
  openedAtMs: WallMs,
});
export type Track = z.output<typeof Track>;

export const HealthSummary = z.strictObject({
  atMs: WallMs,
  windowMs: Count,
  footprintBytes: Count,
  cpuNs: Count,
  wakeups: Count,
});
export type HealthSummary = z.output<typeof HealthSummary>;

export const PowerStatus = z.strictObject({
  onBattery: z.boolean().nullable(),
  suspended: z.boolean(),
  thermalState: z.string().nullable(),
});
export type PowerStatus = z.output<typeof PowerStatus>;

export const SpoolProblemCode = z.enum(["disk.full", "spool.io"]);
export type SpoolProblemCode = z.output<typeof SpoolProblemCode>;

/** A track whose audio is not being stored (the spool cannot write), until the helper resumes it. */
export const SpoolProblem = z.strictObject({
  /** Null when the helper named no track. */
  trackKey: z.string().nullable(),
  code: SpoolProblemCode,
  sinceMs: WallMs,
});
export type SpoolProblem = z.output<typeof SpoolProblem>;

export const ImporterStatus = z.strictObject({
  imported: Count,
  errors: Count,
  lastError: Problem.nullable(),
});
export type ImporterStatus = z.output<typeof ImporterStatus>;

export const AnalysisWorkerState = z.enum(["absent", "loading", "ready", "busy", "unloading"]);
export type AnalysisWorkerState = z.output<typeof AnalysisWorkerState>;

/** Why automatic analysis is not running now (ADR 016 admission). */
export const AnalysisWaitReason = z.enum([
  "no-model",
  "on-battery",
  "not-idle",
  "thermal",
  "memory",
  "swap",
  "retry-later",
  /** The compute server does not answer; the next try is at `retryAtMs`. */
  "server-offline",
  "server-busy",
  /** It does not know this Mac any more, or runs another version. */
  "server-refused",
  "server-quota",
]);
export type AnalysisWaitReason = z.output<typeof AnalysisWaitReason>;

export const AnalysisJobSummary = z.strictObject({
  jobId: Count,
  episodeId: Count,
  /** 0 to 1, from the engine's progress messages; null before the first one. */
  progress: z.number().min(0).max(1).nullable(),
  startedAtMs: WallMs,
});
export type AnalysisJobSummary = z.output<typeof AnalysisJobSummary>;

export const InstalledModel = z.strictObject({
  artifactId: z.string(),
  version: z.string(),
  verified: z.boolean(),
});
export type InstalledModel = z.output<typeof InstalledModel>;

/**
 * A transcription the user asked for (« Transcrire maintenant »), while it
 * waits or runs, or once it failed and nothing replaced it: what its row says.
 */
export const AnalysisRequest = z.strictObject({
  episodeId: Count,
  state: z.enum(["queued", "running", "failed"]),
  /** The last failed attempt's code (`invalid_output`, `model_limit`…); null before any failed. */
  failure: z.string().max(64).nullable(),
});
export type AnalysisRequest = z.output<typeof AnalysisRequest>;

export const AnalysisStatus = z.strictObject({
  worker: AnalysisWorkerState,
  /**
   * Jobs waiting, by what they analyse. Traces run only while the engine is
   * already loaded for other work, after everything else (ADR 016, "Jobs").
   */
  queued: z.strictObject({
    requested: Count,
    conversations: Count,
    moments: Count,
    media: Count,
    traces: Count,
  }),
  /** The compute server's job rather than this Mac's, while both run (ADR 040). */
  running: AnalysisJobSummary.nullable(),
  /** Empty while the queue is empty, or runs and nothing else waits for the Mac. */
  waitingFor: z.array(AnalysisWaitReason),
  /** The episode whose job `waitingFor` holds back; the others wait behind it. */
  waitingEpisodeId: Count.nullable(),
  /**
   * What holds back a compute server's jobs, and the dictations this Mac still
   * transcribes, each on its own (ADR 040); null while this Mac transcribes everything.
   */
  server: z
    .strictObject({
      waitingFor: z.array(AnalysisWaitReason),
      dictationsWaitingFor: z.array(AnalysisWaitReason),
    })
    .nullable(),
  /** The user's requests, newest first. */
  requests: z.array(AnalysisRequest).max(20),
  /** While it waits for `retry-later`: when the next attempt may start. */
  retryAtMs: WallMs.nullable(),
  lastError: Problem.nullable(),
  models: z.array(InstalledModel),
});
export type AnalysisStatus = z.output<typeof AnalysisStatus>;

/**
 * What the next job would wait for now, read on demand the way the queue
 * reads it (ADR 016 admission), with what the Mac reports.
 */
/** What automatic transcription waits for, as the user set it; heat always counts. */
export const AnalysisWaitFor = z.strictObject({
  power: z.boolean(),
  idle: z.boolean(),
  /** Off: automatic jobs load at warn pressure, as a request does (never at critical). */
  memory: z.boolean(),
});
export type AnalysisWaitFor = z.output<typeof AnalysisWaitFor>;

export const AnalysisWaitForInput = z.strictObject({
  condition: z.enum(["power", "idle", "memory"]),
  wait: z.boolean(),
});
export type AnalysisWaitForInput = z.input<typeof AnalysisWaitForInput>;

export const AnalysisCheck = z.strictObject({
  /**
   * The next job is the user's request: it skips power and idle, and loads
   * at warn pressure. False with no job queued: the automatic terms.
   */
  requested: z.boolean(),
  waitFor: AnalysisWaitFor,
  /** A compute server transcribes: no model here, so nothing waits for power, idle or memory. */
  remote: z.boolean(),
  /** Empty: the next job would start now. */
  reasons: z.array(AnalysisWaitReason),
  onBattery: z.boolean().nullable(),
  /** Seconds since the last keyboard or pointer input; null when main did not answer. */
  idleSeconds: Count.nullable(),
  idleRequiredSeconds: Count,
  locked: z.boolean(),
  /** Electron's thermal state (`nominal`, `fair`, `serious`, `critical`, `unknown`). */
  thermalState: z.string().nullable(),
  memoryPressure: z.enum(["normal", "warn", "critical"]).nullable(),
  /** Free space for swap, and what loading the engine needs; both null while it is loaded. */
  swapRoomBytes: Count.nullable(),
  swapRoomNeededBytes: Count.nullable(),
  /**
   * While the pressure level refuses the job: the RAM the compressor holds
   * and where the level falls back far enough (macOS counts compressed
   * against uncompressed memory), and the apps holding it, the most first.
   */
  memoryUse: z
    .strictObject({
      /** Compressed plus uncompressed: the memory the level is computed on. */
      countedBytes: Count,
      compressedBytes: Count,
      /** The job is no longer refused once the compressor holds less than this. */
      limitBytes: Count,
      /** `appPath`: the app's bundle, for its icon; null for macOS and command-line tools. */
      apps: z.array(
        z.strictObject({ name: z.string(), appPath: z.string().nullable(), bytes: Count }),
      ),
    })
    .nullable(),
});
export type AnalysisCheck = z.output<typeof AnalysisCheck>;

/**
 * Near-live text (architecture §10): `ready` while it runs; otherwise why
 * not: turned off, its model missing, the final pass's recovery blocked, on
 * battery, the Mac hot, or memory critical.
 */
export const LiveState = z.enum([
  "off",
  "no-model",
  "blocked",
  "on-battery",
  "hot",
  "memory",
  "ready",
]);
export type LiveState = z.output<typeof LiveState>;

export const LiveStatus = z.strictObject({
  enabled: z.boolean(),
  state: LiveState,
  /** Grows with every live publish: windows read the open episodes again. */
  revision: Count,
});
export type LiveStatus = z.output<typeof LiveStatus>;

export const LiveEnabledInput = z.strictObject({ enabled: z.boolean() });
export type LiveEnabledInput = z.input<typeof LiveEnabledInput>;

/** The window's player plays now, or stopped (ADR 020, "Sondine's own sound"). */
export const PlayerStateInput = z.strictObject({ playing: z.boolean() });
export type PlayerStateInput = z.input<typeof PlayerStateInput>;

export const PlayerStateResult = z.strictObject({
  /**
   * Where the playback goes, as core recorded it: over the speakers the mic
   * speech heard meanwhile is left out of episodes. Null once stopped.
   */
  route: z.enum(["speakers", "headphones"]).nullable(),
});
export type PlayerStateResult = z.output<typeof PlayerStateResult>;

/** An app's bundle identifier, as macOS and the helper spell it. */
export const BundleId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/);

/** « Prévenir à nouveau »: notifies this app's calls again (ADR 036). */
export const CallOfferAppInput = z.strictObject({ bundleId: BundleId });
export type CallOfferAppInput = z.input<typeof CallOfferAppInput>;

/** An app seen listening to the microphone outside a call, and whether it counts as dictation. */
export const ListeningApp = z.strictObject({
  bundleId: z.string().min(1).max(255),
  /** The app's name, else its bundle ID. */
  name: z.string().max(120),
  /** `speech`: the system's speech recognition (Siri, accessibility). */
  via: z.enum(["app", "speech"]),
  /** Null: a known dictation app installed here that has not listened yet. */
  lastListenedAtMs: WallMs.nullable(),
  /** Mic speech while it listens is a dictation (ADR 020). */
  dictation: z.boolean(),
  /** What it typed is taken in place of a transcription; null when Sondine cannot read its history. */
  text: z.boolean().nullable(),
});
export type ListeningApp = z.output<typeof ListeningApp>;

export const DictationApps = z.strictObject({
  /** The latest to listen first, then the dictation apps installed that have not listened yet. */
  apps: z.array(ListeningApp).max(200),
});
export type DictationApps = z.output<typeof DictationApps>;

export const DictationAppInput = z.strictObject({
  bundleId: BundleId,
  dictation: z.boolean(),
  /** For an app the user added from the open panel: its name, shown before it listens. */
  name: z.string().min(1).max(120).optional(),
});
export type DictationAppInput = z.input<typeof DictationAppInput>;

export const DictationTextInput = z.strictObject({ bundleId: BundleId, on: z.boolean() });
export type DictationTextInput = z.input<typeof DictationTextInput>;

/** The sentence an open episode is hearing now, transcribed again at each commit; never stored. */
export const LivePartial = z.strictObject({ text: z.string().max(4000), atMs: WallMs }).nullable();
export type LivePartial = z.output<typeof LivePartial>;

/**
 * Why Sondine does not install its updates itself here (ADR 045): a
 * development build, one that is not a signed release, a release under
 * another name than Sondine.app, or an app to move to Applications first.
 */
export const UpdateBlock = z.enum(["development", "unreleased", "test-copy", "move"]);
export type UpdateBlock = z.output<typeof UpdateBlock>;

/** What a ready update waits for, so that nothing is cut. */
export const UpdateWait = z.enum([
  "call",
  "dictation",
  "conversation",
  "transcription",
  "sync",
  /** The journal, the agent's answer, a file being imported or exported, a model, a playback. */
  "task",
  /** The Mac is in use: it waits for a few idle minutes. */
  "in-use",
]);
export type UpdateWait = z.output<typeof UpdateWait>;

export const UpdateProblem = z.enum([
  /** No connection, or no answer. */
  "network",
  /** GitHub refuses to answer for now (too many requests, or blocked). */
  "refused",
  /** GitHub answered something Sondine cannot read. */
  "bad_response",
  "disk_full",
  /** The file received is not the one published. */
  "corrupt",
  /** Not signed by Sondine's developer, or as another app. */
  "signature",
  /** Not notarized by Apple. */
  "notarization",
  /** It asks for a later macOS. */
  "macos",
  /** Not the version announced, or not a later one. */
  "version",
  /** The app could not be replaced, or the new one did not start. */
  "install",
]);
export type UpdateProblem = z.output<typeof UpdateProblem>;

/**
 * Updates (ADR 045): GitHub Releases, asked at most every other day with the
 * user's yes, or when they ask. With the yes, Sondine downloads, checks and
 * installs them too.
 */
export const UpdatesStatus = z.strictObject({
  /** « Mettre Sondine à jour automatiquement »: the answer, or null before one. */
  automatic: z.boolean().nullable(),
  /** Sondine asks by itself: with the yes, or an earlier one to the check alone. */
  searches: z.boolean(),
  /** Why this app cannot replace itself; null when it can. */
  blocked: UpdateBlock.nullable(),
  /** This app's version. */
  current: z.string(),
  /** The newest published release, when it is later than this one; its page on GitHub. */
  available: z.strictObject({ version: z.string(), url: z.url() }).nullable(),
  /** `ready`: downloaded and checked, it installs when nothing is cut. */
  phase: z.enum(["idle", "checking", "downloading", "verifying", "ready", "installing"]),
  /** Of the download, 0 to 1. */
  progress: z.number().min(0).max(1).nullable(),
  /** What a ready update waits for now. */
  waitingFor: z.array(UpdateWait),
  /** The user asked for it now: it no longer waits for an idle Mac. */
  requested: z.boolean(),
  /** When the last check got an answer. */
  checkedAtMs: WallMs.nullable(),
  /** The last check, download, verification or installation failed. */
  problem: UpdateProblem.nullable(),
  /** The version an update just brought, until the user closes the note. */
  updated: z.string().nullable(),
});
export type UpdatesStatus = z.output<typeof UpdatesStatus>;

export const UpdatesAutomaticInput = z.strictObject({ automatic: z.boolean() });
export type UpdatesAutomaticInput = z.input<typeof UpdatesAutomaticInput>;

/** The anonymous statistics (ADR 042): the user's answer, and the reports as they would leave. */
export const UsageStatus = z.strictObject({
  /** Null before an answer to the question asked now: nothing is counted. */
  answer: z.enum(["yes", "no"]).nullable(),
  /** False in a build without the endpoint: nothing ever leaves it. */
  sends: z.boolean(),
  /** Today's report so far; null without a yes. */
  today: UsageReport.nullable(),
  /** Past days' reports that have not left yet. */
  waiting: z.array(UsageReport).max(16),
});
export type UsageStatus = z.output<typeof UsageStatus>;

export const UsageSharingInput = z.strictObject({ share: z.boolean() });
export type UsageSharingInput = z.input<typeof UsageSharingInput>;

export const UsageCrashInput = z.strictObject({ process: z.enum(["core", "renderer"]) });
export type UsageCrashInput = z.input<typeof UsageCrashInput>;

/** « Envoyer un diagnostic » (ADR 042): a text from a closed list, for the user to read and send. */
export const DiagnosticReport = z.strictObject({ text: z.string().max(8_000) });
export type DiagnosticReport = z.output<typeof DiagnosticReport>;

export const RetentionStatus = z.strictObject({
  /** Spool bytes still on disk. */
  spoolBytes: Count,
  archivedBytes: Count,
  /** Spool files past retention that cannot go yet, with the first reason. */
  blocked: Count,
  lastProblem: Problem.nullable(),
});
export type RetentionStatus = z.output<typeof RetentionStatus>;

export const Status = z.strictObject({
  listening: ListeningStatus,
  helper: HelperStatus,
  /** Null until the helper reports permissions. */
  permissions: Permissions.nullable(),
  tracks: z.array(Track),
  /** Tracks whose audio is not being stored; empty while every spool writes. */
  spool: z.array(SpoolProblem),
  lastHealth: HealthSummary.nullable(),
  power: PowerStatus,
  importer: ImporterStatus,
  analysis: AnalysisStatus,
  live: LiveStatus,
  updates: UpdatesStatus,
  retention: RetentionStatus,
  /**
   * Grows with every deletion since core started (a recording or a range,
   * from any window or the menu bar): windows drop what they show of it.
   */
  deletions: Count,
  /**
   * Grows with every « Garder les 2 dernières minutes » that kept something
   * (the menu bar, ⌃⌥⌘K, a window): windows read their recordings again.
   */
  kept: Count,
  /**
   * Grows when tags change, or the phone names a voice (ADR 039): windows
   * read their recordings, searches and tags again.
   */
  changes: Count,
  updatedAtMs: WallMs,
});
export type Status = z.output<typeof Status>;

export const ListeningInput = z.strictObject({ scope: PauseScope.default("all") }).prefault({});
export type ListeningInput = z.input<typeof ListeningInput>;

export const PauseInput = z
  .strictObject({
    scope: PauseScope.default("all"),
    /** Resume on its own at this wall-clock time; omitted, the pause lasts until a resume. Must be in the future. */
    untilMs: WallMs.optional(),
  })
  .prefault({});
export type PauseInput = z.input<typeof PauseInput>;

export const PermissionKind = z.enum(["microphone", "systemAudio"]);
export type PermissionKind = z.output<typeof PermissionKind>;

export const PermissionRequestInput = z.strictObject({ kind: PermissionKind });

export const PermissionRequestOutcome = z.enum([
  /** The helper showed the system prompt. */
  "requested",
  /** Nothing to do: the permission is already granted. */
  "already-granted",
  /** System Settings opened at the right privacy pane; the user grants it there. */
  "opened-settings",
]);
export type PermissionRequestOutcome = z.output<typeof PermissionRequestOutcome>;

export const PermissionRequestResult = z.strictObject({
  outcome: PermissionRequestOutcome,
  permissions: Permissions.nullable(),
});
export type PermissionRequestResult = z.output<typeof PermissionRequestResult>;

export const StageHistogram = z.strictObject({
  stage: z.string(),
  trackKey: z.string().nullable(),
  count: Count,
  sumNs: Count,
  p50Ns: Count,
  p95Ns: Count,
  maxNs: Count,
});
export type StageHistogram = z.output<typeof StageHistogram>;

export const TrackHealth = z.strictObject({
  trackKey: z.string(),
  runId: z.string(),
  stream: StreamState,
  measuredRate: z.number().nullable(),
  level: z.number().nullable(),
  zeroRunMs: Count,
  ringHighWaterMs: Count,
  ringOverflows: Count,
  droppedSamples: Count,
  overloads: Count,
});
export type TrackHealth = z.output<typeof TrackHealth>;

export const HealthWindow = z.strictObject({
  ...HealthSummary.shape,
  tracks: z.array(TrackHealth),
  stages: z.array(StageHistogram),
});
export type HealthWindow = z.output<typeof HealthWindow>;

export const HealthInput = z
  .strictObject({ limit: z.int().min(1).max(240).default(60) })
  .prefault({});
export type HealthInput = z.input<typeof HealthInput>;

export const HealthOutput = z.strictObject({ windows: z.array(HealthWindow) });
export type HealthOutput = z.output<typeof HealthOutput>;

export const SpanAttribute = z.union([z.string().max(256), z.number(), z.boolean()]);

export const Span = z.strictObject({
  name: z.string(),
  traceId: z.string(),
  spanId: z.string(),
  parentSpanId: z.string().nullable(),
  startMs: z.number().min(0),
  durationMs: z.number().min(0),
  status: z.enum(["ok", "error", "interrupted"]),
  attributes: z.record(z.string(), SpanAttribute),
});
export type Span = z.output<typeof Span>;

export const SpansInput = z
  .strictObject({
    limit: z.int().min(1).max(2000).default(200),
    /** Keeps spans whose name starts with this prefix. */
    name: z.string().min(1).max(128).optional(),
  })
  .prefault({});
export type SpansInput = z.input<typeof SpansInput>;

export const SpansOutput = z.strictObject({ spans: z.array(Span) });
export type SpansOutput = z.output<typeof SpansOutput>;

// Episodes, transcripts and search (ADR 016)

export const EpisodeState = z.enum(["open", "closed"]);
export type EpisodeState = z.output<typeof EpisodeState>;

export const EpisodeContext = z.enum([
  "call",
  "in_person",
  "media",
  "mixed",
  "dictation",
  "imported",
]);
export type EpisodeContext = z.output<typeof EpisodeContext>;

/** An app an episode heard: its bundle ID names its icon, and stands in for the name of an app without one. */
export const EpisodeApp = z.strictObject({
  bundleId: z.string().max(255),
  name: z.string().max(120),
});
export type EpisodeApp = z.output<typeof EpisodeApp>;

export const EpisodeSize = z.enum(["trace", "moment", "conversation"]);
export type EpisodeSize = z.output<typeof EpisodeSize>;

export const EpisodeAnalysisState = z.enum([
  "pending",
  "queued",
  "running",
  "complete",
  "failed",
  "stale",
]);
export type EpisodeAnalysisState = z.output<typeof EpisodeAnalysisState>;

/** A person the user named; `self` is the user. */
export const PersonRef = z.strictObject({
  id: z.int().positive(),
  name: z.string().min(1).max(80),
  self: z.boolean(),
});
export type PersonRef = z.output<typeof PersonRef>;

/**
 * Who a voice may be (ADR 030): the person whose named voices it is most like,
 * never a name the user gave. The confidence comes from the cosine with the
 * centroid of the voices the user named as that person, calibrated on the
 * user's voices and public meetings; it is not a certainty.
 */
export const VoiceMatch = z.strictObject({
  person: PersonRef,
  /** Cosine with the centroid of the person's named voices, -1 to 1. */
  similarity: z.number().min(-1).max(1),
  /** Calibrated confidence that the voice is this person, 0 to 1. */
  confidence: z.number().min(0).max(1),
  /** How many voices of the person it was compared with… */
  references: z.int().positive(),
  /**
   * …of which the user's own dictations, when « Apprendre ma voix depuis mes
   * dictées » is on (ADR 030)…
   */
  dictations: z.int().min(0),
  /** …and their voice read (ADR 034), 0 or 1; the others are voices the user named. */
  reads: z.int().min(0).max(1),
});
export type VoiceMatch = z.output<typeof VoiceMatch>;

/**
 * The web page an episode's media came from, as its browser reported it
 * (ADR 023): the browser says which tab played, nothing is guessed.
 */
export const EpisodeWebPage = z.strictObject({
  /** The host without `www.` or `m.`: what a site's rule applies to. */
  site: z.string().min(1).max(253),
  /** The site's name (« YouTube », « Netflix »), else its host. */
  name: z.string().min(1).max(253),
  /** The tab's title without the site's name; empty when none is kept. */
  title: z.string().max(300),
  /** The page's address, which `episodes.openPage` opens in the browser. */
  url: z.string().max(2048),
  /** A video whose position Sondine follows (YouTube): sentences carry `mediaMs`. */
  video: z.boolean(),
});
export type EpisodeWebPage = z.output<typeof EpisodeWebPage>;

export const EpisodeSummary = z.strictObject({
  id: z.int().positive(),
  /** Open while more speech may still join it; closed as soon as the user ends it (ADR 044). */
  state: EpisodeState,
  /** Null until the first grouping pass. */
  context: EpisodeContext.nullable(),
  size: EpisodeSize.nullable(),
  /** The size may still change (the episode is open, or awaits speakers). */
  sizeProvisional: z.boolean(),
  analysisState: EpisodeAnalysisState,
  startedAtMs: WallMs,
  /** Null while speech is ongoing. */
  endedAtMs: WallMs.nullable(),
  voicedMs: Count,
  /** The first words of the transcript, at most 120 characters. */
  firstWords: z.string().max(120).nullable(),
  speakerCount: Count,
  /**
   * The apps heard in it, most voiced first: the app a dictation was said to,
   * the call app, or what played the media; empty in person.
   */
  apps: z.array(EpisodeApp).max(8),
  /** The people the user named among its voices, the user first; empty when none. */
  people: z.array(PersonRef).max(64),
  /**
   * The people Sondine recognized from their voice among its other voices
   * (ADR 030), not named by the user: unconfirmed, never a fact. Empty when none.
   */
  recognized: z.array(PersonRef).max(64),
  /** Its text is near-live: approximate, until the final transcript replaces it. */
  live: z.boolean(),
  /** Media from a browser tab: the page that played it; null otherwise. */
  page: EpisodeWebPage.nullable(),
  /**
   * Recorded by the iPhone app (ADR 032), shown with a phone mark; null
   * otherwise. `timeUncertain`: the phone's clock was not plausible, so it
   * is placed when it reached the Mac (« heure incertaine »). `name`: the
   * name typed on the phone (ADR 008, M5.3); null shows its hour.
   */
  phone: z.strictObject({ timeUncertain: z.boolean(), name: z.string().nullable() }).nullable(),
  /**
   * The same meeting was recorded by the other device too (ADR 032): `mac`
   * on a phone recording, `phone` on the Mac's; null otherwise.
   */
  alsoRecordedBy: z.enum(["mac", "phone"]).nullable(),
  /**
   * « Garder les 2 dernières minutes » reached it (plan.md, Later 1): when the
   * user kept it, shown « Gardé à 14:32 »; null otherwise.
   */
  keptAtMs: WallMs.nullable(),
  /**
   * A recording the iPhone app made whose voices are all the user's, named
   * or confirmed (ADR 039): shown « Note » instead of « En personne ». Its
   * context stays `in_person` for everything else.
   */
  note: z.boolean(),
  /**
   * The user's tags on it (ADR 039), in the order they were put; empty when
   * none. Twenty at most are put on one, but a merge keeps both sets.
   */
  tags: z.array(z.string().max(400)).max(400),
});
export type EpisodeSummary = z.output<typeof EpisodeSummary>;

/** What came of « Importer un audio… » (ADR 021). */
export const ImportPickResult = z.discriminatedUnion("outcome", [
  /** Imported and queued for transcription with its voices. */
  z.strictObject({ outcome: z.literal("imported"), episodeId: z.int().positive() }),
  /**
   * A file the iPhone app recorded (ADR 032): a conversation in Today at the
   * hour it was recorded, not in « Importés », queued like an import.
   */
  z.strictObject({ outcome: z.literal("phone"), episodeId: z.int().positive() }),
  /** That phone recording is already here, with the same bytes: nothing new. */
  z.strictObject({ outcome: z.literal("already"), episodeId: z.int().positive() }),
  /** The open panel was closed. */
  z.strictObject({ outcome: z.literal("cancelled") }),
  z.strictObject({
    outcome: z.literal("failed"),
    /**
     * `unreadable`: not audio macOS reads; `too-long`: over 4 h; `empty`: no
     * sound; `disk-full`; `conflict`: another phone recording is here under
     * its id; `deleted`: that phone recording was deleted here, and stays so.
     */
    problem: z.enum([
      "unreadable",
      "too-long",
      "empty",
      "disk-full",
      "conflict",
      "deleted",
      "internal",
    ]),
  }),
]);
export type ImportPickResult = z.output<typeof ImportPickResult>;

/** Files the user dropped or pasted on « Importés »: their paths on this Mac. */
export const ImportsAddInput = z.strictObject({
  paths: z.array(z.string().min(1).max(4096)).min(1).max(20),
});
export type ImportsAddInput = z.input<typeof ImportsAddInput>;

/** One result per file, in order (never `cancelled`). */
export const ImportsAddResult = z.strictObject({ results: z.array(ImportPickResult).max(20) });
export type ImportsAddResult = z.output<typeof ImportsAddResult>;

export const ImportsListInput = z
  .strictObject({
    /** `nextCursor` of the previous page. */
    cursor: z
      .string()
      .regex(/^\d{1,16}:\d{1,16}$/)
      .optional(),
  })
  .prefault({});
export type ImportsListInput = z.input<typeof ImportsListInput>;

/** The imported recordings, newest import first. */
export const ImportsListOutput = z.strictObject({
  imports: z
    .array(
      z.strictObject({
        episode: EpisodeSummary,
        /** The file's name. */
        fileName: z.string().max(200),
        importedAtMs: WallMs,
      }),
    )
    .max(100),
  nextCursor: z.string().nullable(),
});
export type ImportsListOutput = z.output<typeof ImportsListOutput>;

// Today, paging and highlights (M1 step 2)

/**
 * Where an episode shows in the timeline (ADR 007): media and dictations each
 * in their own lane whatever their size (ADR 020); everything else by size,
 * `mixed` included like in-person speech; an episode with no size yet is a
 * moment.
 */
export const TimelineLane = z.enum(["conversations", "moments", "media", "dictations", "traces"]);
export type TimelineLane = z.output<typeof TimelineLane>;

/** Where the next page of a newest-first episode list starts (opaque). */
export const EpisodeCursor = z.string().regex(/^\d{1,16}:\d{1,16}$/);
export type EpisodeCursor = z.output<typeof EpisodeCursor>;

export const EpisodePage = z.strictObject({
  /** Newest first. */
  episodes: z.array(EpisodeSummary),
  /** Episodes in the lane that day, all pages together. */
  total: Count,
  /** For `episodes.list` with the same day and lane; null on the last page. */
  nextCursor: EpisodeCursor.nullable(),
});
export type EpisodePage = z.output<typeof EpisodePage>;

export const MomentPreview = z.strictObject({
  episodeId: z.int().positive(),
  /** At most 120 characters. */
  firstWords: z.string().max(120),
});
export type MomentPreview = z.output<typeof MomentPreview>;

/** The moments that started in one local hour, collapsed into one row. */
export const MomentHour = z.strictObject({
  /** 0 to 23, as the clock shows it. */
  hour: z.int().min(0).max(23),
  /** Wall-clock start of the hour. */
  startMs: WallMs,
  moments: z.int().positive(),
  /** Moments without a transcript yet (still open, waiting, or failed). */
  untranscribed: Count,
  /** The first words of the newest moments that have text, newest first. */
  previews: z.array(MomentPreview).max(3),
  /** The apps its moments heard (calls, what played, dictation apps), the most named first. */
  apps: z.array(EpisodeApp).max(4),
});
export type MomentHour = z.output<typeof MomentHour>;

export const EpisodesDayInput = z
  .strictObject({
    /** A calendar day in the Mac's time zone; today when omitted. */
    day: z.iso.date().optional(),
  })
  .prefault({});
export type EpisodesDayInput = z.input<typeof EpisodesDayInput>;

export const EpisodesDayOutput = z.strictObject({
  day: z.iso.date(),
  /**
   * Changes whenever an episode of the day is added, changed or removed.
   * Equal revisions mean equal days; key lazily loaded pages on it.
   */
  revision: z.string(),
  /** Conversations, open ones included with their provisional size; first 100. */
  conversations: EpisodePage,
  /** Hours with moments, newest first. */
  momentHours: z.array(MomentHour),
  /** Media of any size, for the lane hidden by default; first 100. */
  media: EpisodePage,
  /** What the user said to a dictation app, for the lane hidden by default; first 100. */
  dictations: EpisodePage,
  /** Traces outside media and dictations (under 1.5 s of voice), counted only. */
  traces: Count,
  /**
   * Open episodes outside media and dictations, whatever their size so far,
   * newest first: what is being said now.
   */
  ongoing: z.array(EpisodeSummary).max(4),
});
export type EpisodesDayOutput = z.output<typeof EpisodesDayOutput>;

/** A stretch of a segment's text, in UTF-16 code units: `text.slice(start, end)`. */
export const TextRange = z.strictObject({ start: Count, end: Count });
export type TextRange = z.output<typeof TextRange>;

export const EpisodesListInput = z
  .strictObject({
    /** A calendar day in the Mac's time zone; today when omitted. */
    day: z.iso.date().optional(),
    /** Only episodes that started in this local hour of the day (0 to 23). */
    hour: z.int().min(0).max(23).optional(),
    /** Only this timeline lane. */
    lane: TimelineLane.optional(),
    /** Continue after a previous page of the same day, hour and lane. */
    cursor: EpisodeCursor.optional(),
    limit: z.int().min(1).max(500).default(200),
  })
  .prefault({});
export type EpisodesListInput = z.input<typeof EpisodesListInput>;

export const EpisodesListOutput = z.strictObject({
  /** The day listed, `YYYY-MM-DD`. */
  day: z.iso.date(),
  /** Newest first. */
  episodes: z.array(EpisodeSummary),
  /** Null on the last page. */
  nextCursor: EpisodeCursor.nullable(),
});
export type EpisodesListOutput = z.output<typeof EpisodesListOutput>;

export const EpisodeInput = z.strictObject({ episodeId: z.int().positive() });
export type EpisodeInput = z.input<typeof EpisodeInput>;

/** The longest window `episodes.get` reads with `fromMs` and `toMs`. */
export const EPISODE_WINDOW_MAX_MS = 30 * 60_000;

export const EpisodeGetInput = z
  .strictObject({
    episodeId: z.int().positive(),
    /** A search to highlight in the transcript, read as `search.query` reads it. */
    q: z.string().trim().min(1).max(200).optional(),
    /**
     * Only the segments that overlap `[fromMs, toMs)` (wall clock, at most
     * 30 min apart): an excerpt of a long transcript. Both or neither.
     */
    fromMs: WallMs.optional(),
    toMs: WallMs.optional(),
  })
  .refine((input) => (input.fromMs === undefined) === (input.toMs === undefined), {
    message: "fromMs and toMs go together",
  })
  .refine(
    (input) =>
      input.fromMs === undefined ||
      input.toMs === undefined ||
      (input.toMs > input.fromMs && input.toMs - input.fromMs <= EPISODE_WINDOW_MAX_MS),
    { message: "toMs must be after fromMs, at most 30 minutes later" },
  );
export type EpisodeGetInput = z.input<typeof EpisodeGetInput>;

export const EpisodeTrackKind = z.enum(["input", "app", "system", "phone"]);
export type EpisodeTrackKind = z.output<typeof EpisodeTrackKind>;

export const EpisodeTrack = z.strictObject({
  trackRunId: z.int().positive(),
  trackKey: z.string(),
  kind: EpisodeTrackKind,
});
export type EpisodeTrack = z.output<typeof EpisodeTrack>;

export const EpisodeSpeaker = z.strictObject({
  /** `<trackKey>/<request>/<n>` until speakers are identified (M3). */
  label: z.string(),
  ordinal: z.int().positive(),
  voicedMs: Count,
  /** The kind of track the speaker was heard on. */
  trackKind: EpisodeTrackKind,
  /**
   * The user as far as the sources tell: in a call, the microphone voice that
   * speaks most. Derived at each read, never stored as an identity;
   * identities come in M3. At most one speaker per episode. A voice the
   * user named takes over: it is `self` only when named as the user; then a
   * voice Sondine recognized as the user (ADR 030), and a guess Sondine
   * recognized as someone else is not `self`.
   */
  self: z.boolean(),
  /** The person the user named this voice as (anchored to its speech); null when unnamed. */
  person: PersonRef.nullable(),
  /**
   * An unnamed voice Sondine recognized, at 99 % or more (ADR 030): shown as
   * this person, marked « Marie* », until the user confirms or corrects it.
   * Unconfirmed: never a name the user gave. Null when the voice is named or
   * not recognized.
   */
  recognized: VoiceMatch.nullable(),
  /**
   * Who an unnamed voice may be, less surely: « Marie ? », for the user to
   * confirm. Null when there is none, the voice is named or recognized, or
   * voices are not identified here.
   */
  suggestion: VoiceMatch.nullable(),
});
export type EpisodeSpeaker = z.output<typeof EpisodeSpeaker>;

export const TranscriptSegment = z.strictObject({
  id: z.int().positive(),
  trackRunId: z.int().positive(),
  startMs: WallMs,
  endMs: WallMs,
  speakerLabel: z.string().nullable(),
  /** Said by the episode's `self` speaker (see `EpisodeSpeaker.self`). */
  self: z.boolean(),
  text: z.string(),
  lang: z.string().nullable(),
  /** The user corrected `text`; the engine's text is kept for `transcript.restore`. */
  edited: z.boolean(),
  /** Where `q` matched in `text`, in order; empty without `q` or when it does not match. */
  highlights: z.array(TextRange),
  /**
   * The app in front on the Mac when it was said (at its middle), Sondine
   * included: never a window or what was on screen (ADR 022). Null when no
   * app was (the screen locked, an app excluded from capture), for audio
   * recorded before Sondine noted it, and for imported recordings.
   */
  app: EpisodeApp.nullable(),
  /**
   * Where the page's video was when the sentence started (YouTube, ADR 023);
   * null when Sondine does not know.
   */
  mediaMs: Count.nullable(),
});
export type TranscriptSegment = z.output<typeof TranscriptSegment>;

/** An episode beside another, for « Fusionner avec la précédente / la suivante ». */
export const EpisodeNeighbour = z.strictObject({
  id: z.int().positive(),
  startedAtMs: WallMs,
  endedAtMs: WallMs.nullable(),
});
export type EpisodeNeighbour = z.output<typeof EpisodeNeighbour>;

/** What the user said an episode is; null while Sondine decides (ADR 007). */
export const EpisodeKind = z.enum(["conversation", "moment", "media"]);
export type EpisodeKind = z.output<typeof EpisodeKind>;

/** What the user added to a conversation (ADR 024). */
export const ContextKind = z.enum(["note", "link", "image", "file"]);
export type ContextKind = z.output<typeof ContextKind>;

export const ContextItem = z.strictObject({
  id: z.int().positive(),
  kind: ContextKind,
  addedAtMs: WallMs,
  /** Where it sits in the conversation: the sentence it is pinned to, or the conversation's start. */
  atMs: WallMs,
  /** The sentence of the current transcript it is pinned to; null for the whole conversation. */
  segmentId: z.int().positive().nullable(),
  pinned: z.boolean(),
  /** A note's text, or a link's address; empty for an image or a file. */
  text: z.string(),
  /** A link's title the user typed, or a file's name; null when none. */
  title: z.string().nullable(),
  /** An image's or a file's bytes, kept in Sondine; null for a note or a link. */
  file: z
    .strictObject({
      mediaType: z.string(),
      bytes: Count,
      /**
       * `sondine-media://context/<id>?v=<version>`: the image's preview for
       * the window (upright, at most 1,568 px, no metadata); null for a file.
       */
      preview: z
        .string()
        .regex(/^sondine-media:\/\/context\/[1-9]\d*\?v=[0-9a-f]{16}$/)
        .nullable(),
      /**
       * An audio file macOS reads: « Transcrire » makes it an imported
       * recording (ADR 021), its episode here once made (null before, or once
       * deleted). Null for any other file.
       */
      transcript: z.strictObject({ episodeId: z.int().positive().nullable() }).nullable(),
    })
    .nullable(),
});
export type ContextItem = z.output<typeof ContextItem>;

/** Another recording of the same meeting (ADR 032), as this episode sees it. */
export const EpisodeSameMoment = z.strictObject({
  episodeId: z.int().positive(),
  /** Who recorded the other one. */
  by: z.enum(["mac", "phone"]),
  /** The other's wall time minus this one's at `anchorMs`, ms: the same second there. */
  offsetMs: z.int(),
  /** How that offset moves per second of this clock, in millionths. */
  driftPpm: z.number(),
  anchorMs: WallMs,
  /** The time both heard, on this episode's clock. */
  sharedFromMs: WallMs,
  sharedToMs: WallMs,
  /** This one feeds the journal over the shared time; the other's lines there are not written. */
  feedsJournal: z.boolean(),
});
export type EpisodeSameMoment = z.output<typeof EpisodeSameMoment>;

export const EpisodeDetail = z.strictObject({
  episode: EpisodeSummary,
  kindOverride: EpisodeKind.nullable(),
  /**
   * The user asked for its transcript (« Transcrire maintenant », or an
   * import): its job is queued or running as a request.
   */
  requested: z.boolean(),
  /**
   * Whether its voices may be recognised and named (ADR 012): never in media
   * or a dictation, and not where a « ne pas reconnaître » rule applies.
   */
  recognized: z.boolean(),
  /** The closed episodes just before and after, of its kind (media with media, dictations with dictations). */
  neighbours: z.strictObject({
    previous: EpisodeNeighbour.nullable(),
    next: EpisodeNeighbour.nullable(),
  }),
  tracks: z.array(EpisodeTrack),
  speakers: z.array(EpisodeSpeaker),
  /** The published transcript, in time order; empty before analysis. */
  segments: z.array(TranscriptSegment),
  /** What the user added to it, oldest first: notes, links, images, files (ADR 024). */
  context: z.array(ContextItem),
  privacy: EpisodePrivacy,
  /** The other recordings of the same meeting (ADR 032), earliest shared time first. */
  sameMoments: z.array(EpisodeSameMoment),
  analysis: z
    .strictObject({
      /** The transcript's version: naming a voice names it in this one (`speakers.name`). */
      runId: z.int().positive(),
      engineId: z.string(),
      /** Share of the sent audio that was there; below 1 when parts were missing. */
      coverage: z.number().min(0).max(1).nullable(),
      publishedAtMs: WallMs,
    })
    .nullable(),
});
export type EpisodeDetail = z.output<typeof EpisodeDetail>;

export const EpisodePlayback = z.strictObject({
  /**
   * `sondine-media://episode/<id>?g=<generation>`, for the app's audio
   * element: a mono 16 kHz PCM16 WAV of the episode's speech with roll, as
   * transcription reads it, every track mixed on one wall-clock timeline,
   * streamed by byte ranges. Deleted ranges, the time between extents, and
   * audio no longer kept are silent. Once the episode is deleted it answers
   * 404, and 409 once its generation moves on (ask for a new playback).
   */
  src: z.string().regex(/^sondine-media:\/\/episode\/[1-9]\d*\?g=[1-9]\d*$/),
  /**
   * Wall-clock time of the timeline's first sample; null when there is
   * nothing to hear. A segment plays from `(segment.startMs - startedAtMs) /
   * 1000` s into `src`, whatever the track; deleting audio never moves it.
   */
  startedAtMs: WallMs.nullable(),
  /** The timeline's length; silent gaps included. */
  durationMs: Count,
  /** The episode's input generation the timeline was planned from (the URL's `g`). */
  generation: z.int().positive(),
  /**
   * Where the VAD heard speech, without roll and without deleted ranges, by
   * start: known before any transcript. `microphone` is an input track;
   * `computer` is the Mac's own sound (an app or the system).
   */
  speech: z.array(
    z.strictObject({
      startMs: WallMs,
      endMs: WallMs,
      track: z.enum(["microphone", "computer"]),
    }),
  ),
});
export type EpisodePlayback = z.output<typeof EpisodePlayback>;

export const SearchInput = z
  .strictObject({
    /** The words searched; may be left out with `tag`, which then lists that tag's recordings. */
    text: z.string().trim().min(1).max(200).optional(),
    /**
     * Only the recordings with this tag (ADR 039), by name (case and accents
     * do not matter). Without `text`: every recording with it, newest first,
     * with no matches (`foregroundApp` needs text).
     */
    tag: z.string().trim().min(1).max(200).optional(),
    /** First local day searched, inclusive; from the beginning when omitted. */
    from: z.iso.date().optional(),
    /** Last local day searched, inclusive; up to now when omitted. */
    to: z.iso.date().optional(),
    /** Episode sizes kept; all when omitted (an episode with no size yet is a moment). */
    sizes: z.array(EpisodeSize).min(1).max(3).optional(),
    /** Contexts kept; all when omitted, `mixed` and media included. */
    contexts: z.array(EpisodeContext).min(1).max(6).optional(),
    /**
     * Only the segments said while this app (bundle ID) was in front on the
     * Mac, as `TranscriptSegment.app` names it; every app when omitted.
     */
    foregroundApp: BundleId.optional(),
    /** Episodes per page. */
    limit: z.int().min(1).max(50).default(20),
    /** Episodes to skip. */
    offset: z.int().min(0).max(10_000).default(0),
  })
  .refine((input) => input.from === undefined || input.to === undefined || input.from <= input.to, {
    message: "`from` is after `to`",
    path: ["to"],
  })
  .refine((input) => input.text !== undefined || input.tag !== undefined, {
    message: "Give `text`, `tag`, or both",
    path: ["text"],
  });
export type SearchInput = z.input<typeof SearchInput>;

export const SearchHit = z.strictObject({
  segmentId: z.int().positive(),
  startMs: WallMs,
  endMs: WallMs,
  text: z.string(),
  speakerLabel: z.string().nullable(),
  /** The speaker's number in its episode ("Voice 2"), when the segment has one. */
  speakerOrdinal: z.int().positive().nullable(),
  /** Said by the episode's `self` speaker (see `EpisodeSpeaker.self`). */
  self: z.boolean(),
  /** The person the user named the voice as; null when unnamed. */
  person: PersonRef.nullable(),
  /** The person Sondine recognized the voice as, unconfirmed (see `EpisodeSpeaker.recognized`). */
  recognized: PersonRef.nullable(),
  /** Where the query matched in `text`, in order. */
  highlights: z.array(TextRange),
  /** The app in front on the Mac when it was said (see `TranscriptSegment.app`). */
  app: EpisodeApp.nullable(),
});
export type SearchHit = z.output<typeof SearchHit>;

/** The apps something was said in, the latest first: what « Pendant que j'étais dans… » offers. */
export const ForegroundApps = z.strictObject({ apps: z.array(EpisodeApp).max(50) });
export type ForegroundApps = z.output<typeof ForegroundApps>;

/** Context the search matched in an episode (ADR 024). */
export const ContextHit = z.strictObject({
  itemId: z.int().positive(),
  kind: ContextKind,
  /** A note's text (its first 500 characters), a link's title and address, a file's name. */
  text: z.string(),
  highlights: z.array(TextRange),
});
export type ContextHit = z.output<typeof ContextHit>;

export const SearchEpisode = z.strictObject({
  episode: EpisodeSummary,
  /**
   * The ordinal of the episode's `self` speaker (see `EpisodeSpeaker.self`),
   * so the other voices can be numbered as the episode numbers them; null
   * when it has none.
   */
  selfOrdinal: z.int().positive().nullable(),
  /** Matching segments in the episode; 0 when only its context matched. */
  hitCount: Count,
  /** The best matches (at most 5), in time order. */
  hits: z.array(SearchHit).max(5),
  /** Its context that matched (at most 5), oldest first. */
  contextHits: z.array(ContextHit).max(5),
});
export type SearchEpisode = z.output<typeof SearchEpisode>;

export const SearchOutput = z.strictObject({
  /** Newest first. */
  episodes: z.array(SearchEpisode),
  /** Matching episodes, after filters: page with `offset` up to it. */
  total: Count,
  /**
   * Closed episodes in the filtered range without a transcript yet, which
   * the search cannot see. Traces are not counted: they are not transcribed.
   */
  untranscribed: Count,
});
export type SearchOutput = z.output<typeof SearchOutput>;

export const AnalysisRequestOutcome = z.enum([
  /** A job was created at the highest priority. */
  "queued",
  /** A job was waiting; it moved to the highest priority. */
  "already-queued",
  /** The episode is being analysed now. */
  "running",
  /** Analysis starts when the episode closes. */
  "episode-open",
  /** In a private zone that keeps no text, which a compute server never gets. */
  "private-zone",
]);
export type AnalysisRequestOutcome = z.output<typeof AnalysisRequestOutcome>;

/** Where the final transcription runs (ADR 040): this Mac, a machine of the user's, or the beta. */
export const ComputeDestination = z.enum(["device", "own", "beta"]);
export type ComputeDestination = z.output<typeof ComputeDestination>;

export const ComputeStatus = z.strictObject({
  destination: ComputeDestination,
  /** The user's machine, once connected: never its token. */
  own: z.strictObject({ name: z.string(), host: z.string() }).nullable(),
  /** `available`: this build knows a beta. `joined`: this Mac has one of its places. */
  beta: z.strictObject({ available: z.boolean(), joined: z.boolean() }),
});
export type ComputeStatus = z.output<typeof ComputeStatus>;

export const ComputeChooseInput = z.strictObject({ destination: ComputeDestination });
export type ComputeChooseInput = z.input<typeof ComputeChooseInput>;

/** The line `sondine-compute add` prints; it holds a token, so it is never shown again. */
export const ComputeConnectInput = z.strictObject({ link: z.string().max(1024) });
export type ComputeConnectInput = z.input<typeof ComputeConnectInput>;

export const ComputeConnectOutcome = z.enum([
  "connected",
  /** Another choice was made while the machine answered. */
  "cancelled",
  "bad-link",
  "offline",
  /** The machine does not know this link (any more). */
  "refused",
  /** Another machine, or another version. */
  "mismatch",
]);
export type ComputeConnectOutcome = z.output<typeof ComputeConnectOutcome>;

export const ComputeConnectResult = z.strictObject({
  outcome: ComputeConnectOutcome,
  status: ComputeStatus,
});
export type ComputeConnectResult = z.output<typeof ComputeConnectResult>;

export const ComputeJoinOutcome = z.enum([
  "joined",
  "cancelled",
  "full",
  "closed",
  "busy",
  "offline",
  "mismatch",
]);
export type ComputeJoinOutcome = z.output<typeof ComputeJoinOutcome>;

export const ComputeJoinResult = z.strictObject({
  outcome: ComputeJoinOutcome,
  status: ComputeStatus,
});
export type ComputeJoinResult = z.output<typeof ComputeJoinResult>;

/** « Effacer les N dernières minutes »: the choices the app offers. */
export const ForgetInput = z.strictObject({
  minutes: z.union([z.literal(5), z.literal(15), z.literal(60)]),
});
export type ForgetInput = z.input<typeof ForgetInput>;

export const ForgetPreview = z.strictObject({
  fromMs: WallMs,
  toMs: WallMs,
  /** Recordings a forget now deletes whole, those started before the range included. */
  episodes: z.array(
    z.strictObject({
      id: z.int().positive(),
      startedAtMs: WallMs,
      /** Null while it is still recording. */
      endedAtMs: WallMs.nullable(),
    }),
  ),
  /**
   * Phone recordings over the range (ADR 032): a forget erases what the Mac
   * heard and leaves them, so the confirmation names them as staying.
   */
  phoneRecordings: z.array(
    z.strictObject({ id: z.int().positive(), startedAtMs: WallMs, endedAtMs: WallMs.nullable() }),
  ),
});
export type ForgetPreview = z.output<typeof ForgetPreview>;

/** Erases exactly what a preview showed: the `minutes` before its `toMs`. */
export const ForgetRunInput = z.strictObject({
  minutes: ForgetInput.shape.minutes,
  /** The preview's `toMs`; at most an hour old. */
  untilMs: WallMs,
});
export type ForgetRunInput = z.input<typeof ForgetRunInput>;

export const ForgetResult = z.strictObject({
  /** Recordings deleted whole. */
  episodeIds: z.array(z.int().positive()),
});
export type ForgetResult = z.output<typeof ForgetResult>;

/** What « Garder les 2 dernières minutes » kept (plan.md, Later 1; ADR 029). */
export const KeepRecentResult = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("kept"),
    /** When the gesture was made: the moment's « Gardé à 14:32 ». */
    atMs: WallMs,
    /** The audio kept, in ms: less than 2 min when listening started or stopped meanwhile. */
    keptMs: Count,
    /** The recordings it reaches so far; speech still being heard joins later. */
    episodeIds: z.array(z.int().positive()),
  }),
  /** Nothing was captured in the last 2 minutes (paused, a private zone held it, Sondine off). */
  z.strictObject({ outcome: z.literal("nothing") }),
]);
export type KeepRecentResult = z.output<typeof KeepRecentResult>;

export const EpisodeExportResult = z.strictObject({
  /**
   * `saved`: the WAV is where the user chose; `cancelled`: the panel was
   * closed; `empty`: nothing of it is left to hear; `failed`: writing it failed.
   */
  outcome: z.enum(["saved", "cancelled", "empty", "failed"]),
});
export type EpisodeExportResult = z.output<typeof EpisodeExportResult>;

/**
 * A transcript as a file: Markdown, subtitles timed on the exported audio, or
 * versioned JSON (`TranscriptJsonV2`).
 */
export const TranscriptFormat = z.enum(["md", "srt", "vtt", "json"]);
export type TranscriptFormat = z.output<typeof TranscriptFormat>;

export const EpisodeExportTextInput = z.strictObject({
  /**
   * The episodes the text is made of: one, or a day's (the file is then
   * named after the day). The text is refused once any of them is gone.
   */
  episodeIds: z.array(z.int().positive()).min(1).max(500),
  /** Names the file's extension; the clipboard takes the text as it is. */
  format: TranscriptFormat,
  /** `share`: the macOS share sheet (AirDrop, Mail, Messages…), with the text as a file. */
  destination: z.enum(["file", "clipboard", "share"]),
  /**
   * The transcript as the window wrote it, from the episode it read just
   * before (voices named in the user's language).
   */
  text: z.string().min(1).max(16_000_000),
  /**
   * `Status.deletions` when the window read the episode: the text is refused
   * (`stale`) once anything was deleted since, up to the moment it is written.
   */
  deletionsSeen: Count,
});
export type EpisodeExportTextInput = z.input<typeof EpisodeExportTextInput>;

export const EpisodeExportTextResult = z.strictObject({
  /**
   * `saved`: the file is where the user chose; `copied`: the text is on the
   * clipboard; `shared`: the share sheet is open with the file; `cancelled`:
   * the panel was closed; `stale`: something was deleted since the window
   * read the episode, so nothing was written (read it again); `failed`:
   * writing it failed.
   */
  outcome: z.enum(["saved", "copied", "shared", "cancelled", "stale", "failed"]),
});
export type EpisodeExportTextResult = z.output<typeof EpisodeExportTextResult>;

export const EpisodeDeleteResult = z.strictObject({
  /** False when the episode did not exist (already deleted). */
  deleted: z.boolean(),
});
export type EpisodeDeleteResult = z.output<typeof EpisodeDeleteResult>;

/** « Reconnaître les voix ici » for one episode. */
export const EpisodeRecognitionInput = z.strictObject({
  episodeId: z.int().positive(),
  allowed: z.boolean(),
});
export type EpisodeRecognitionInput = z.input<typeof EpisodeRecognitionInput>;

/** « Supprimer ce passage » : what was heard over `[fromMs, toMs)` in a closed episode. */
export const EpisodePassageInput = z
  .strictObject({
    episodeId: z.int().positive(),
    /** Wall clock: the first selected sentence's start. */
    fromMs: z.int().nonnegative(),
    /** Wall clock: the last selected sentence's end. */
    toMs: z.int().positive(),
  })
  .refine((input) => input.fromMs < input.toMs, { message: "The passage is empty." });
export type EpisodePassageInput = z.input<typeof EpisodePassageInput>;

export const EpisodePassageResult = z.strictObject({
  /** Nothing said was left: the whole recording was deleted. */
  episodeDeleted: z.boolean(),
});
export type EpisodePassageResult = z.output<typeof EpisodePassageResult>;

export const AnalysisRequestResult = z.strictObject({
  outcome: AnalysisRequestOutcome,
  jobId: z.int().positive().nullable(),
});
export type AnalysisRequestResult = z.output<typeof AnalysisRequestResult>;

// Models and the first run (M1 step 2, ADR 016 "Models")

/**
 * Where a catalog artifact stands: nothing on disk (`missing`), a file of its
 * size found outside the models folder (`found`), a job in progress
 * (`importing`, `downloading`, `verifying`, which also covers the launch
 * check), installed and verified (`ready`), or the last job failed
 * (`failed`, with a problem).
 */
export const ModelPhase = z.enum([
  "missing",
  "found",
  "importing",
  "downloading",
  "verifying",
  "ready",
  "failed",
]);
export type ModelPhase = z.output<typeof ModelPhase>;

export const ModelProblemCode = z.enum([
  /** The chosen path is not a regular file, or no longer there. */
  "not_a_file",
  /** The file or the server's answer has another size than the catalog's. */
  "size_mismatch",
  /** The complete file is not the pinned artifact. */
  "hash_mismatch",
  /** Not enough free space for the file plus the headroom kept for capture and swap. */
  "disk_full",
  /** The connection failed or dropped, again after the automatic retries; a resume keeps the bytes. */
  "network",
  /** The server refused the download (an HTTP status). */
  "http_status",
  /** A redirect left the hosts allowed for the pinned URL. */
  "redirect_refused",
  /** The server announced or sent more bytes than the catalog's size. */
  "too_large",
  /** A malformed answer, such as a resume range that does not match. */
  "bad_response",
  /** The installed file no longer matches its manifest at launch. */
  "corrupt",
  /** Reading or writing the models folder failed. */
  "io",
]);
export type ModelProblemCode = z.output<typeof ModelProblemCode>;

export const ModelProblem = z.strictObject({
  code: ModelProblemCode,
  /** Diagnostic text in English, without paths; the app shows its own words for the code. */
  message: z.string().max(1024),
  atMs: WallMs,
});
export type ModelProblem = z.output<typeof ModelProblem>;

export const ModelArtifactStatus = z.strictObject({
  artifactId: z.string(),
  version: z.string(),
  displayName: z.string(),
  sizeBytes: Count,
  /** Release 1 targets Macs with at least this much memory (ADR 005). */
  minimumMemoryBytes: Count,
  /**
   * `final`: the transcript, which onboarding asks for; `live`: near-live
   * text, from its setting; `journal`: the daily journal's model (ADR 028).
   */
  role: z.enum(["final", "live", "journal"]),
  phase: ModelPhase,
  /** 0 to 1 within the current phase (importing by copy, downloading, verifying); null otherwise. */
  progress: z.number().min(0).max(1).nullable(),
  /** Bytes of a stopped download kept for resume; 0 when there is none. */
  partialBytes: Count,
  /**
   * A file of the artifact's size outside the models folder, in a known place
   * (the Hugging Face cache, an earlier Sondine), offered for import before any
   * download. `clones`: it sits on the models folder's volume, so the import
   * is an APFS clone and costs no disk space; otherwise it is a copy.
   */
  found: z.strictObject({ path: z.string(), clones: z.boolean() }).nullable(),
  /** Free space a download needs now: what is left to fetch plus the headroom kept for capture and swap. */
  downloadNeedsBytes: Count,
  /** Set while `failed`. */
  problem: ModelProblem.nullable(),
  /** The license to show before a download or import, with its upstream page at the pinned revision. */
  license: z.strictObject({ name: z.string(), url: z.url() }),
});
export type ModelArtifactStatus = z.output<typeof ModelArtifactStatus>;

export const ModelsStatus = z.strictObject({
  /** Every artifact of the catalog. */
  artifacts: z.array(ModelArtifactStatus),
  /** Free bytes on the models folder's volume. */
  freeDiskBytes: Count,
  /** This Mac's memory. */
  memoryBytes: Count,
});
export type ModelsStatus = z.output<typeof ModelsStatus>;

export const ModelInput = z.strictObject({ artifactId: z.string().min(1).max(128) });
export type ModelInput = z.input<typeof ModelInput>;

export const ModelImportInput = z.strictObject({
  artifactId: z.string().min(1).max(128),
  /** A file of the artifact; the found file when omitted. */
  path: z.string().min(1).max(4096).optional(),
});
export type ModelImportInput = z.input<typeof ModelImportInput>;

export const ModelCancelInput = z.strictObject({
  artifactId: z.string().min(1).max(128),
  /** Also delete a download's kept bytes instead of keeping them for resume. */
  discard: z.boolean().default(false),
});
export type ModelCancelInput = z.input<typeof ModelCancelInput>;

export const ModelPickOutcome = z.enum([
  /** The user chose a file; its import started. */
  "importing",
  /** The user closed the panel. */
  "cancelled",
  /** A job or another panel for this artifact is already running; nothing started. */
  "busy",
]);
export type ModelPickOutcome = z.output<typeof ModelPickOutcome>;

export const ModelPickResult = z.strictObject({ outcome: ModelPickOutcome, models: ModelsStatus });
export type ModelPickResult = z.output<typeof ModelPickResult>;

/**
 * The first run's screens, in order; the last one starts listening. `voice`,
 * after the permissions, offers the voice read (ADR 034), which may be passed.
 */
/**
 * The first run's goal (ADR 037). It sets what Today shows first, never what
 * Sondine records: `meetings` conversations alone, `day` and `everything`
 * with media and dictations beside them.
 */
export const OnboardingGoal = z.enum(["meetings", "day", "everything"]);
export type OnboardingGoal = z.output<typeof OnboardingGoal>;

/**
 * In the order the first run shows them (ADR 037): `statistics` asks once
 * whether to share anonymous statistics (ADR 042).
 */
export const OnboardingStep = z.enum([
  "welcome",
  "statistics",
  "permissions",
  "model",
  "voice",
  "start",
]);
export type OnboardingStep = z.output<typeof OnboardingStep>;

export const OnboardingStatus = z.strictObject({
  completed: z.boolean(),
  completedAtMs: WallMs.nullable(),
  /** `existing-install`: Sondine had captured audio before the first run existed, so it never shows. */
  origin: z.enum(["first-run", "existing-install"]),
  /** The step to open the first run at, kept across relaunches (a permission prompt may relaunch the app). */
  step: OnboardingStep,
  /** What the user wants to find again (ADR 037): what Today shows first; null before they chose. */
  goal: OnboardingGoal.nullable(),
  /** « Me prévenir »: tell this Mac's user when a cloud transcription exists; stored here only. */
  cloudNotify: z.boolean(),
});
export type OnboardingStatus = z.output<typeof OnboardingStatus>;

/**
 * How the window shows things, kept across launches (Téo, 2026-11-20). Null
 * is « not chosen yet »: the window then uses its default (Media on,
 * Dictations by the first run's goal), never storing it in the user's place.
 */
export const DisplaySettings = z.strictObject({
  /** Today's commitments folded to one line with their count. */
  commitmentsFolded: z.boolean(),
  /** The day's filter menu: media in the thread. */
  media: z.boolean().nullable(),
  /** The day's filter menu: dictations in the thread. */
  dictations: z.boolean().nullable(),
});
export type DisplaySettings = z.output<typeof DisplaySettings>;

/** Only the fields given change. */
export const DisplayUpdateInput = DisplaySettings.partial();
export type DisplayUpdateInput = z.input<typeof DisplayUpdateInput>;

export const OnboardingAdvanceInput = z.strictObject({
  step: OnboardingStep,
  goal: OnboardingGoal.optional(),
  cloudNotify: z.boolean().optional(),
});
export type OnboardingAdvanceInput = z.input<typeof OnboardingAdvanceInput>;

export const OnboardingCompleteInput = z
  .strictObject({
    /** Resume listening, which a fresh install keeps paused until now. */
    startListening: z.boolean().default(true),
  })
  .prefault({});
export type OnboardingCompleteInput = z.input<typeof OnboardingCompleteInput>;

export const OnboardingCompleteResult = z.strictObject({
  onboarding: OnboardingStatus,
  listening: ListeningStatus,
});
export type OnboardingCompleteResult = z.output<typeof OnboardingCompleteResult>;

/** A person and where their name is heard. */
export const PersonSummary = z.strictObject({
  person: PersonRef,
  /** Episodes whose current transcript names them. */
  episodeCount: Count,
  /** Start of the newest of those episodes; null when none is left. */
  lastHeardMs: WallMs.nullable(),
  /**
   * Other episodes where Sondine recognized their voice (ADR 030), unconfirmed:
   * not in `episodeCount` nor `lastHeardMs`.
   */
  recognizedCount: Count,
});
export type PersonSummary = z.output<typeof PersonSummary>;

export const PeopleListOutput = z.strictObject({
  /** Newest heard first; people no episode names any more last. */
  people: z.array(PersonSummary),
});
export type PeopleListOutput = z.output<typeof PeopleListOutput>;

export const PersonInput = z.strictObject({ personId: z.int().positive() });
export type PersonInput = z.input<typeof PersonInput>;

export const PersonGetInput = z.strictObject({
  personId: z.int().positive(),
  /** The newest episodes kept. */
  limit: z.int().min(1).max(500).default(200),
});
export type PersonGetInput = z.input<typeof PersonGetInput>;

export const PersonDetail = z.strictObject({
  summary: PersonSummary,
  /**
   * Newest first, at most `limit`: the episodes that name them and those
   * where they were only recognized (they are in `EpisodeSummary.recognized`
   * there). `summary.episodeCount` and `summary.recognizedCount` count them all.
   */
  episodes: z.array(EpisodeSummary),
});
export type PersonDetail = z.output<typeof PersonDetail>;

const PersonName = z.string().trim().min(1).max(80);

export const PersonRenameInput = z.strictObject({
  personId: z.int().positive(),
  name: PersonName,
});
export type PersonRenameInput = z.input<typeof PersonRenameInput>;

export const PersonMergeInput = z.strictObject({
  /** The person who stays, with their name. */
  personId: z.int().positive(),
  /** The same person under another name: their voices join `personId`, and the name goes. */
  otherId: z.int().positive(),
});
export type PersonMergeInput = z.input<typeof PersonMergeInput>;

export const PersonDeleteResult = z.strictObject({
  /** False when there was no such person (already deleted). */
  deleted: z.boolean(),
});
export type PersonDeleteResult = z.output<typeof PersonDeleteResult>;

/** One voice of one transcript version, as the window showed it. */
const SpeakerTarget = {
  episodeId: z.int().positive(),
  /** `EpisodeDetail.analysis.runId`: refused (INVALID_INPUT) once a newer transcript replaced it. */
  runId: z.int().positive(),
  /** `EpisodeSpeaker.label`. */
  label: z.string().min(1).max(200),
};

export const SpeakerNameInput = z.strictObject({
  ...SpeakerTarget,
  person: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("existing"), personId: z.int().positive() }),
    z.strictObject({ kind: z.literal("new"), name: PersonName }),
    /** The user; `name` names their row the first time only. */
    z.strictObject({ kind: z.literal("self"), name: PersonName }),
  ]),
});
export type SpeakerNameInput = z.input<typeof SpeakerNameInput>;

export const SpeakerNameResult = z.strictObject({ person: PersonRef });
export type SpeakerNameResult = z.output<typeof SpeakerNameResult>;

export const SpeakerUnnameInput = z.strictObject(SpeakerTarget);
export type SpeakerUnnameInput = z.input<typeof SpeakerUnnameInput>;

export const SpeakerRefuseInput = z.strictObject({
  ...SpeakerTarget,
  /** The person suggested for this voice, who it is not. */
  personId: z.int().positive(),
});
export type SpeakerRefuseInput = z.input<typeof SpeakerRefuseInput>;

/** How much a voice sounds like each person with reference voices (ADR 030), likeliest first. */
export const SpeakerLikenessOutput = z.strictObject({
  people: z.array(
    z.strictObject({
      person: PersonRef,
      /** Calibrated confidence that the voice is this person, 0 to 1. */
      confidence: z.number().min(0).max(1),
      references: z.int().positive(),
      dictations: z.int().min(0),
      reads: z.int().min(0).max(1),
    }),
  ),
});
export type SpeakerLikenessOutput = z.output<typeof SpeakerLikenessOutput>;

export const SpeakerUnnameResult = z.strictObject({});

/**
 * « Fusionner avec… » (ADR 038): two unnamed voices of one transcript are one
 * person; the one that speaks later joins the one that speaks first.
 */
export const SpeakerMergeInput = z.strictObject({
  ...SpeakerTarget,
  /** The other voice's `EpisodeSpeaker.label`. */
  other: z.string().min(1).max(200),
});
export type SpeakerMergeInput = z.input<typeof SpeakerMergeInput>;

/** The voice both are now. */
export const SpeakerMergeResult = z.strictObject({ label: z.string() });
export type SpeakerMergeResult = z.output<typeof SpeakerMergeResult>;
export type SpeakerUnnameResult = z.output<typeof SpeakerUnnameResult>;

/**
 * Someone the far side of the call going on may be (ADR 025): a suggestion
 * from their voice, « Marie ? », never a name the user gave.
 */
export const CallPerson = z.strictObject({
  person: PersonRef,
  /** Cosine with the centroid of their named voices (ADR 030). */
  similarity: z.number().min(-1).max(1),
  /** Calibrated confidence of the window that suggested them, 0 to 1 (ADR 030). */
  confidence: z.number().min(0).max(1),
  recognizedAtMs: WallMs,
  /** Their last conversations before this call, newest first. */
  conversations: z.array(EpisodeSummary).max(3),
});
export type CallPerson = z.output<typeof CallPerson>;

/** The call going on and whom it may be with; null when there is none. */
/** How the notch opens during a call (ADR 025): on hover (the default) or on a click. */
export const NotchSettings = z.strictObject({ openOnHover: z.boolean() });
export type NotchSettings = z.output<typeof NotchSettings>;

export const CallContext = z.strictObject({
  call: z
    .strictObject({
      callId: z.int().positive(),
      /** Its open episode; null until speech joined it. */
      episodeId: z.int().positive().nullable(),
      /** Empty until two stretches of the far side agree on someone. */
      people: z.array(CallPerson).max(4),
      /** The user hid it for this call. */
      dismissed: z.boolean(),
    })
    .nullable(),
  /** The user's choice for the notch, so main shows it as asked. */
  notch: NotchSettings,
});
export type CallContext = z.output<typeof CallContext>;

export const CallDismissInput = z.strictObject({ callId: z.int().positive() });
export type CallDismissInput = z.input<typeof CallDismissInput>;

/** « Reconnaître les voix » (ADR 012): off, no voice reads as a person and voice embeddings are deleted. */
export const Recognition = z.strictObject({ on: z.boolean() });
export type Recognition = z.output<typeof Recognition>;

/**
 * « Apprendre ma voix depuis mes dictées » (ADR 030): the user's dictations
 * join the voices they named as themselves. Off by default; off deletes the
 * dictations' embeddings.
 */
export const DictationLearning = z.strictObject({ on: z.boolean() });
export type DictationLearning = z.output<typeof DictationLearning>;

/**
 * Where the user's voice read is (ADR 034): `idle` before « Commencer » and
 * after « Annuler », `recording` while the microphone records the read (the
 * always-on microphone is paused meanwhile), `embedding` while
 * `sondine-voice` reads it, then `done` (kept as the user's voice) or
 * `failed` with why.
 */
export const VoiceReadPhase = z.enum(["idle", "recording", "embedding", "done", "failed"]);
export type VoiceReadPhase = z.output<typeof VoiceReadPhase>;

/**
 * Why a read failed: `recognition-off` (« Reconnaître les voix » is off),
 * `no-microphone` (no permission, or no microphone), `unavailable` (this
 * build has no recorder or no `sondine-voice`), `busy` (a read already
 * runs), `too-short` (too little voice heard), `failed` (anything else).
 */
export const VoiceReadFailure = z.enum([
  "recognition-off",
  "no-microphone",
  "unavailable",
  "busy",
  "too-short",
  "failed",
]);
export type VoiceReadFailure = z.output<typeof VoiceReadFailure>;

export const VoiceReadSession = z.strictObject({
  phase: VoiceReadPhase,
  /** Since the recording started. */
  elapsedMs: Count,
  /** Voice heard so far: the counter, which ends the read at `targetMs`. */
  voicedMs: Count,
  /** Voice the read asks for; « Terminer » is offered from `minimumMs`. */
  targetMs: Count,
  minimumMs: Count,
  /** The latest level, 0 (silence) to 1 (full scale), for the meter. */
  level: z.number().min(0).max(1),
  failure: VoiceReadFailure.nullable(),
});
export type VoiceReadSession = z.output<typeof VoiceReadSession>;

/** The user's voice read (ADR 034), with the session on screen. */
export const VoiceReadStatus = z.strictObject({
  /** « Reconnaître les voix »: off, the read offers nothing. */
  recognition: z.boolean(),
  /** This build can record and embed a read. */
  available: z.boolean(),
  /** The read kept as the user's voice, if any. */
  read: z.strictObject({ readAtMs: WallMs, speechMs: Count, person: PersonRef }).nullable(),
  session: VoiceReadSession,
});
export type VoiceReadStatus = z.output<typeof VoiceReadStatus>;

export const VoiceReadStartInput = z.strictObject({
  /** The user's name, should their row not exist yet (« Moi »). */
  selfName: z.string().trim().min(1).max(80),
});
export type VoiceReadStartInput = z.input<typeof VoiceReadStartInput>;

/** An unnamed voice of a recent conversation, for « Qui est-ce ? » on People. */
export const UnnamedVoice = z.strictObject({
  episode: EpisodeSummary,
  /** The transcript version, for `speakers.name` and `speakers.refuse`. */
  runId: z.int().positive(),
  label: z.string(),
  ordinal: z.int().positive(),
  voicedMs: Count,
  /** The voice the sources point to as the user (a guess, see `EpisodeSpeaker.self`). */
  self: z.boolean(),
  /** The ordinal of the episode's `self` voice, to number the others as the episode does. */
  selfOrdinal: z.int().positive().nullable(),
  /** See `EpisodeSpeaker.recognized`: « Marie* », on too little evidence to leave this list. */
  recognized: VoiceMatch.nullable(),
  suggestion: VoiceMatch.nullable(),
});
export type UnnamedVoice = z.output<typeof UnnamedVoice>;

export const PeopleUnnamedOutput = z.strictObject({
  /** Voices Sondine takes for someone first, likeliest first, then those that spoke most. */
  voices: z.array(UnnamedVoice),
});
export type PeopleUnnamedOutput = z.output<typeof PeopleUnnamedOutput>;

/**
 * A voice the user named that sounds like someone else (ADR 030): « À
 * vérifier » on People. The name holds until the user changes it.
 */
export const DoubtedName = z.strictObject({
  episode: EpisodeSummary,
  /** The transcript version, for `speakers.name` and `speakers.refuse`. */
  runId: z.int().positive(),
  label: z.string(),
  voicedMs: Count,
  /** Where its longest sentence starts: what to hear first. */
  startMs: WallMs,
  /** Whom the user named it as. */
  person: PersonRef,
  /** How much it sounds like their other voices; null when they have none elsewhere. */
  confidence: z.number().min(0).max(1).nullable(),
  /** Whom it sounds like, at 99 % or more. */
  match: VoiceMatch,
});
export type DoubtedName = z.output<typeof DoubtedName>;

export const PeopleDoubtsOutput = z.strictObject({
  /** Newest conversation first. */
  voices: z.array(DoubtedName),
});
export type PeopleDoubtsOutput = z.output<typeof PeopleDoubtsOutput>;

// Agents (ADR 011): local MCP clients the user connected, each with its own
// token, and the log of what they read.

export const AgentSummary = z.strictObject({
  id: z.int().positive(),
  name: z.string(),
  createdAtMs: WallMs,
  lastUsedAtMs: WallMs.nullable(),
  /** Set once the user revoked its token; its calls stay in the log. */
  revokedAtMs: WallMs.nullable(),
  /** A session of it is open right now. */
  connected: z.boolean(),
});
export type AgentSummary = z.output<typeof AgentSummary>;

export const AgentCallOutcome = z.enum(["ok", "error", "refused"]);
export type AgentCallOutcome = z.output<typeof AgentCallOutcome>;

export const AgentCallEntry = z.strictObject({
  id: z.int().positive(),
  agentId: z.int().positive(),
  agentName: z.string(),
  atMs: WallMs,
  /** The MCP tool, for example `search_transcripts`. */
  tool: z.string(),
  outcome: AgentCallOutcome,
  durationMs: Count,
  // What the call was about, never what was said: the log keeps no words.
  /** The episode it read; its start is null once the episode is deleted. */
  episodeId: z.int().positive().nullable(),
  episodeStartedAtMs: WallMs.nullable(),
  /** The person it read; the name is null once the person is deleted. */
  personId: z.int().positive().nullable(),
  personName: z.string().nullable(),
  /** The local day it read, `YYYY-MM-DD`. */
  day: z.iso.date().nullable(),
  /** How many words its search had. */
  words: Count.nullable(),
  /** How many episodes, segments or people came back. */
  results: Count.nullable(),
});
export type AgentCallEntry = z.output<typeof AgentCallEntry>;

/** An app Sondine connects by writing its own server into the app's config file. */
export const AgentAppId = z.enum(["grok", "claude", "cursor"]);
export type AgentAppId = z.output<typeof AgentAppId>;

/**
 * Why Sondine leaves an app's file alone: it cannot read it, a server of that
 * name is not Sondine's, editing it would change something else, or the disk
 * refused.
 */
export const AgentAppProblem = z.enum(["unreadable", "taken", "unsafe", "unwritable"]);
export type AgentAppProblem = z.output<typeof AgentAppProblem>;

export const AgentApp = z.strictObject({
  id: AgentAppId,
  /** The name its key takes. */
  name: z.string(),
  /** Its config file, `~/…`. */
  path: z.string(),
  /** The agent whose key the file holds, while that key has access. */
  agentId: z.int().positive().nullable(),
  /** Other apps found here that also load this file's servers, and so this key. */
  sharedWith: z.array(z.string()),
  /** Set when Sondine cannot read the file. */
  problem: AgentAppProblem.nullable(),
});
export type AgentApp = z.output<typeof AgentApp>;

export const AgentsStatus = z.strictObject({
  /** The user's switch; off by default. */
  enabled: z.boolean(),
  /** Whether core listens for agents right now (on, and its socket is open). */
  listening: z.boolean(),
  /** The `sondine-mcp` relay agents start; null when this build has none. */
  relayPath: z.string().nullable(),
  /** Agents with access first, newest first; then the revoked ones. */
  agents: z.array(AgentSummary),
  /** The apps found on this Mac that Sondine can connect by itself. */
  apps: z.array(AgentApp),
  /** The latest calls, newest first (at most 50). */
  calls: z.array(AgentCallEntry).max(50),
});
export type AgentsStatus = z.output<typeof AgentsStatus>;

export const AgentsEnabledInput = z.strictObject({ enabled: z.boolean() });
export type AgentsEnabledInput = z.input<typeof AgentsEnabledInput>;

export const AgentCreateInput = z.strictObject({ name: z.string().trim().min(1).max(60) });
export type AgentCreateInput = z.input<typeof AgentCreateInput>;

export const AgentCreateResult = z.strictObject({
  agent: AgentSummary,
  /** Shown once: only its hash is kept. */
  token: z.string(),
  /** The key set up for each kind of client, shown once; null when this build has no relay. */
  setup: z
    .strictObject({
      /** Commands to paste in a terminal. */
      claudeCode: z.string(),
      codex: z.string(),
      /** The server as an `mcpServers` JSON object, and as a TOML `[mcp_servers.…]` table. */
      json: z.string(),
      toml: z.string(),
    })
    .nullable(),
});
export type AgentCreateResult = z.output<typeof AgentCreateResult>;

export const AgentAppInput = z.strictObject({ app: AgentAppId });
export type AgentAppInput = z.input<typeof AgentAppInput>;

export const AgentAppConnectResult = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    agent: AgentSummary,
    /** The file Sondine wrote, `~/…`. */
    path: z.string(),
    /** The server's name in it. */
    serverName: z.string(),
    /** The copy of the file before the write; null when Sondine created it. */
    backupPath: z.string().nullable(),
    /** Another file the app reads whose server of the same name it now ignores. */
    replaces: z.string().nullable(),
  }),
  z.strictObject({
    ok: z.literal(false),
    path: z.string(),
    problem: AgentAppProblem,
  }),
]);
export type AgentAppConnectResult = z.output<typeof AgentAppConnectResult>;

export const AgentInput = z.strictObject({ agentId: z.int().positive() });
export type AgentInput = z.input<typeof AgentInput>;

export const AgentRevokeResult = z.strictObject({
  status: AgentsStatus,
  /** The app files Sondine took its server back from, `~/…`. */
  removedFrom: z.array(z.string()),
  /** The app files it could not take it back from; the key no longer works there anyway. */
  failed: z.array(z.strictObject({ path: z.string(), problem: AgentAppProblem })),
});
export type AgentRevokeResult = z.output<typeof AgentRevokeResult>;

// Corrections (M2): the user's text over a segment of the current transcript.

const SegmentTarget = {
  episodeId: z.int().positive(),
  /** The transcript version the segment is in (`EpisodeDetail.analysis.runId`). */
  runId: z.int().positive(),
  segmentId: z.int().positive(),
};

export const TranscriptEditInput = z.strictObject({
  ...SegmentTarget,
  text: z.string().trim().min(1).max(2_000),
});
export type TranscriptEditInput = z.input<typeof TranscriptEditInput>;

export const TranscriptRestoreInput = z.strictObject(SegmentTarget);
export type TranscriptRestoreInput = z.input<typeof TranscriptRestoreInput>;

export const TranscriptEditResult = z.strictObject({});
export type TranscriptEditResult = z.output<typeof TranscriptEditResult>;

/** What a correction taught the Vocabulary (ADR 046), for the window to say it. */
export const TranscriptCorrectResult = z.strictObject({
  /** Names Sondine now writes the user's way in new transcripts. */
  learned: z.array(z.string().max(200)).max(50),
  /**
   * Names the user wrote that do not sound like what was heard, so nothing
   * was learned (« Sandrine » → « Sondine »): words to offer for the list.
   */
  unheard: z.array(z.string().max(200)).max(50),
});
export type TranscriptCorrectResult = z.output<typeof TranscriptCorrectResult>;

// ⌘Z and ⇧⌘Z (M2): the user's edits of this session, undone and redone by core.

/** What an undo or redo step changed. */
export const UndoAction = z.enum([
  "split",
  "merge",
  "kind",
  "text",
  "name",
  "refusal",
  "people-merge",
  "context",
  "voice-merge",
  "end",
]);
export type UndoAction = z.output<typeof UndoAction>;

const UndoChange = {
  action: UndoAction,
  /** Episodes the step took away: a window showing one opens one of `kept`. */
  removed: z.array(z.int().positive()),
  kept: z.array(z.int().positive()),
  /** People the step took away (a merge redone): a page showing one opens one of `keptPeople`. */
  removedPeople: z.array(z.int().positive()),
  keptPeople: z.array(z.int().positive()),
};

export const UndoStep = z.discriminatedUnion("outcome", [
  /** Nothing to undo (or redo). */
  z.strictObject({ outcome: z.literal("nothing") }),
  z.strictObject({ outcome: z.literal("undone"), ...UndoChange }),
  z.strictObject({ outcome: z.literal("redone"), ...UndoChange }),
  /**
   * The state changed since (`changed`), or a transcript could not be put
   * back (`refused`): nothing was done, and the step is dropped.
   */
  z.strictObject({
    outcome: z.literal("refused"),
    action: UndoAction,
    reason: z.enum(["changed", "refused"]),
  }),
]);
export type UndoStep = z.output<typeof UndoStep>;

// Boundaries (M2): splitting a closed episode, or merging two neighbours.

export const EpisodeSplitInput = z.strictObject({
  episodeId: z.int().positive(),
  /** Wall clock: what starts from here becomes a new episode. */
  atMs: WallMs,
});
export type EpisodeSplitInput = z.input<typeof EpisodeSplitInput>;

export const EpisodeSplitResult = z.strictObject({
  episodeId: z.int().positive(),
  newEpisodeId: z.int().positive(),
});
export type EpisodeSplitResult = z.output<typeof EpisodeSplitResult>;

export const EpisodeEndResult = z.strictObject({
  /** False when it was already over: nothing changed. */
  ended: z.boolean(),
});
export type EpisodeEndResult = z.output<typeof EpisodeEndResult>;

export const EpisodeMergeInput = z.strictObject({
  episodeId: z.int().positive(),
  /** A neighbour (`EpisodeDetail.neighbours`). */
  otherId: z.int().positive(),
});
export type EpisodeMergeInput = z.input<typeof EpisodeMergeInput>;

export const EpisodeMergeResult = z.strictObject({
  /** The episode that remains: the earlier of the two. */
  episodeId: z.int().positive(),
});
export type EpisodeMergeResult = z.output<typeof EpisodeMergeResult>;

export const EpisodeKindInput = z.strictObject({
  episodeId: z.int().positive(),
  /** Null hands the episode back to Sondine's own decision. */
  kind: EpisodeKind.nullable(),
});
export type EpisodeKindInput = z.input<typeof EpisodeKindInput>;

export const EpisodeKindResult = z.strictObject({});
export type EpisodeKindResult = z.output<typeof EpisodeKindResult>;

/** `episodeId` feeds the journal over the time it shares with `otherEpisodeId` (ADR 032). */
export const EpisodeJournalSourceInput = z.strictObject({
  episodeId: z.int().positive(),
  otherEpisodeId: z.int().positive(),
});
export type EpisodeJournalSourceInput = z.input<typeof EpisodeJournalSourceInput>;

export const EpisodeJournalSourceResult = z.strictObject({});
export type EpisodeJournalSourceResult = z.output<typeof EpisodeJournalSourceResult>;

// The browser link (ADR 023)

/** A browser installed here that can run Sondine's extension. */
export const BrowserState = z.strictObject({
  bundleId: z.string().max(255),
  name: z.string().max(120),
  /** Sondine told it where its relay is (only while the link is on). */
  installed: z.boolean(),
  /** Links its extension holds open now (a browser may hold several, ADR 023). */
  links: z.int().min(0).max(64),
  /** When its extension last said something, since Sondine started; null before. */
  lastHeardAtMs: z.int().min(0).nullable(),
  /** The version its extension said, when it said one. */
  extension: z.string().max(32).nullable(),
});
export type BrowserState = z.output<typeof BrowserState>;

export const BrowserStatus = z.strictObject({
  /** The user's switch (Settings ▸ Navigateurs); off by default. */
  enabled: z.boolean(),
  /** This build has the relay and the extension (a development build may lack them). */
  available: z.boolean(),
  /** The extension's version this build carries; null without one. */
  extension: z.string().max(32).nullable(),
  browsers: z.array(BrowserState).max(32),
});
export type BrowserStatus = z.output<typeof BrowserStatus>;

export const BrowserEnabledInput = z.strictObject({ enabled: z.boolean() });
export type BrowserEnabledInput = z.input<typeof BrowserEnabledInput>;

// Settings ▸ Téléphone (ADR 008): the switch, the pairing and the phones.

export const PhoneDeviceState = z.strictObject({
  /** The id the phone made for itself. */
  deviceId: z.string().min(1).max(64),
  /** The name the user gave the phone. */
  name: z.string().min(1).max(64),
  pairedAtMs: WallMs,
  lastContactAtMs: WallMs.nullable(),
  /** How its last request came (M5.5): at home, through Tailscale, or loopback in development. */
  lastVia: z.enum(["lan", "tailnet", "loopback"]).nullable(),
  /** Revoked (« Révoquer », « Oublier ce Mac », a reset): it answers `revoked`. */
  revokedAtMs: WallMs.nullable(),
  /** What it did, never the words: recordings stored, reads, deletions. */
  uploads: Count,
  reads: Count,
  deletions: Count,
});
export type PhoneDeviceState = z.output<typeof PhoneDeviceState>;

export const PhonePairing = z.strictObject({
  /** `waiting` for a phone to scan; `asked`: a phone asked, the user answers. */
  phase: z.enum(["waiting", "asked"]),
  /** The QR's text (`sondine://pair?…`); null until the relay listens. */
  url: z.string().min(1).max(2_000).nullable(),
  /** The token's end while waiting; the answer's while asked. */
  expiresAtMs: WallMs,
  /** Once asked: the phone's name and the six digits both screens show. */
  deviceName: z.string().min(1).max(64).nullable(),
  digits: z
    .string()
    .regex(/^\d{6}$/)
    .nullable(),
});
export type PhonePairing = z.output<typeof PhonePairing>;

export const PhoneStatus = z.strictObject({
  /** « Synchronisation avec l'iPhone »; off by default. */
  enabled: z.boolean(),
  /** « Autoriser par Tailscale »; off by default. */
  tailnet: z.boolean(),
  /** This build has the relay (a development build may lack it). */
  available: z.boolean(),
  /** The relay: off while nothing is paired and no pairing is open. */
  relay: z.strictObject({
    phase: z.enum(["off", "starting", "listening", "failed"]),
    port: z.int().min(1).max(65_535).nullable(),
    problem: z.string().max(300).nullable(),
  }),
  /** The Bonjour name, « Sondine » and four characters; null before the first pairing. */
  serviceName: z.string().max(64).nullable(),
  pairing: PhonePairing.nullable(),
  phones: z.array(PhoneDeviceState).max(256),
});
export type PhoneStatus = z.output<typeof PhoneStatus>;

export const PhoneEnabledInput = z.strictObject({ enabled: z.boolean() });
export type PhoneEnabledInput = z.input<typeof PhoneEnabledInput>;

export const PhoneAnswerInput = z.strictObject({
  /** « Appairer » (true) or « Annuler » (false). */
  accept: z.boolean(),
});
export type PhoneAnswerInput = z.input<typeof PhoneAnswerInput>;

export const PhoneRevokeInput = z.strictObject({ deviceId: z.string().min(1).max(64) });
export type PhoneRevokeInput = z.input<typeof PhoneRevokeInput>;

export const BrowserShowExtensionResult = z.strictObject({
  /** False when this build has no extension to show. */
  shown: z.boolean(),
});
export type BrowserShowExtensionResult = z.output<typeof BrowserShowExtensionResult>;

export const EpisodeOpenPageInput = z.strictObject({
  episodeId: z.int().positive(),
  /** Open the video where this sentence starts (when Sondine knows where it was). */
  segmentId: z.int().positive().optional(),
});
export type EpisodeOpenPageInput = z.input<typeof EpisodeOpenPageInput>;

export const EpisodeOpenPageResult = z.strictObject({
  /** False when the episode has no page. */
  opened: z.boolean(),
});
export type EpisodeOpenPageResult = z.output<typeof EpisodeOpenPageResult>;

// A conversation's context (ADR 024): notes, links, images and files.

const ContextTarget = {
  episodeId: z.int().positive(),
  /** Pin it to this sentence of the current transcript; the whole conversation when absent. */
  segmentId: z.int().positive().optional(),
};

/**
 * Text typed or dropped (a link when it is one `http(s)` address, a note
 * otherwise) and files dropped, by their paths on this Mac.
 */
export const ContextAddInput = z
  .strictObject({
    ...ContextTarget,
    text: z.string().max(1_000_000).optional(),
    paths: z.array(z.string().min(1).max(4096)).max(20).optional(),
  })
  .refine((input) => input.text !== undefined || (input.paths?.length ?? 0) > 0, {
    message: "Give text or files.",
  });
export type ContextAddInput = z.input<typeof ContextAddInput>;

/** ⌘V, or « Choisir des fichiers… »: main reads the clipboard or shows the open panel. */
export const ContextTargetInput = z.strictObject(ContextTarget);
export type ContextTargetInput = z.input<typeof ContextTargetInput>;

export const ContextRefusal = z.strictObject({
  /** The file's name; null for text. */
  name: z.string().nullable(),
  problem: z.enum(["unreadable", "too-large", "disk-full", "too-long", "too-many", "empty"]),
});
export type ContextRefusal = z.output<typeof ContextRefusal>;

export const ContextAddResult = z.strictObject({
  /** The items added, in order. */
  itemIds: z.array(z.int().positive()),
  /** What was not added, and why. */
  refused: z.array(ContextRefusal),
});
export type ContextAddResult = z.output<typeof ContextAddResult>;

export const ContextItemInput = z.strictObject({ itemId: z.int().positive() });
export type ContextItemInput = z.input<typeof ContextItemInput>;

/** A note's new text, or a link's address and title. */
export const ContextEditInput = z.discriminatedUnion("kind", [
  z.strictObject({
    itemId: z.int().positive(),
    kind: z.literal("note"),
    text: z.string().trim().min(1).max(20_000),
  }),
  z.strictObject({
    itemId: z.int().positive(),
    kind: z.literal("link"),
    url: z
      .string()
      .trim()
      .max(4096)
      .regex(/^https?:\/\/\S+$/iu),
    title: z.string().trim().max(4096).nullable(),
  }),
]);
export type ContextEditInput = z.input<typeof ContextEditInput>;

export const ContextOpenResult = z.strictObject({ opened: z.boolean() });
export type ContextOpenResult = z.output<typeof ContextOpenResult>;

/**
 * One item for an agent: what `get_episode` lists, plus an image (its
 * preview, as MCP image content) or a text file's text. Audio never.
 */
export const ContextItemDetail = z.strictObject({
  episodeId: z.int().positive(),
  item: ContextItem,
  /** A text file's text (valid UTF-8 without NUL), at most 100,000 characters. */
  content: z.strictObject({ text: z.string(), truncated: z.boolean() }).nullable(),
  /** An image's preview, base64; the MCP relay sends it as image content. */
  image: z
    .strictObject({ mediaType: z.enum(["image/jpeg", "image/png"]), data: z.string() })
    .nullable(),
  /**
   * A document as it is (a PDF, a word processor's, spreadsheet's or
   * presentation's file), base64, up to 5 MiB; the MCP relay sends it as an
   * embedded resource. Null for anything else: a note, a link, an image (its
   * preview goes), a text file (its text goes), audio or video (a
   * transcription is an episode), a file of unknown type, or a larger one.
   */
  file: z.strictObject({ mediaType: z.string(), data: z.string() }).nullable(),
});
export type ContextItemDetail = z.output<typeof ContextItemDetail>;

/** The menu bar's « Ajouter le presse-papiers » (⌃⌥⌘V): what it added, and where. */
export const ContextOngoingResult = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("added"),
    episodeId: z.int().positive(),
    itemIds: z.array(z.int().positive()),
    refused: z.array(ContextRefusal),
  }),
  /** No conversation going on, nor one that ended within 5 minutes. */
  z.strictObject({ outcome: z.literal("none") }),
]);
export type ContextOngoingResult = z.output<typeof ContextOngoingResult>;

// Discussions with an agent (ADR 027): Téo's own subscriptions, through the
// CLIs he signed in to; the agent reads Sondine with the agent tools only.

/** Codex is not offered yet: its built-in tools cannot all be turned off (ADR 027). */
export const ChatProviderId = z.enum(["claude"]);
export type ChatProviderId = z.output<typeof ChatProviderId>;

export const ChatModel = z.strictObject({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  /** Reasoning effort levels, weakest first; empty when the model takes none. */
  efforts: z.array(z.string()),
  defaultEffort: z.string().nullable(),
  isDefault: z.boolean(),
});
export type ChatModel = z.output<typeof ChatModel>;

export const ChatProvider = z.strictObject({
  id: ChatProviderId,
  state: z.enum(["ready", "missing", "unsupported", "signed-out", "failed"]),
  executable: z.string().nullable(),
  version: z.string().nullable(),
  /** The CLI's own folder, which holds its sign-in (`~/.claude`, or `CLAUDE_CONFIG_DIR`). */
  home: z.string().nullable(),
  account: z
    .strictObject({
      email: z.string().nullable(),
      plan: z.string().nullable(),
      billing: z.enum(["subscription", "api-key"]),
    })
    .nullable(),
  models: z.array(ChatModel),
  problem: z.string().nullable(),
});
export type ChatProvider = z.output<typeof ChatProvider>;

export const ChatChoice = z.strictObject({
  provider: ChatProviderId,
  model: z.string().min(1).max(200),
  effort: z.string().min(1).max(40).nullable(),
});
export type ChatChoice = z.output<typeof ChatChoice>;

export const ChatStatus = z.strictObject({
  enabled: z.boolean(),
  /** Null until the providers were asked, which happens only while discussions are on. */
  providers: z.array(ChatProvider).nullable(),
  /** The last provider, model and effort used. */
  choice: ChatChoice.nullable(),
  /** False when this build has no relay: an agent could not read Sondine. */
  canRead: z.boolean(),
});
export type ChatStatus = z.output<typeof ChatStatus>;

export const ChatStatusInput = z.strictObject({ refresh: z.boolean().optional() }).optional();
export type ChatStatusInput = z.input<typeof ChatStatusInput>;

export const ChatEnabledInput = z.strictObject({ enabled: z.boolean() });
export type ChatEnabledInput = z.input<typeof ChatEnabledInput>;

export const ChatFailure = z.strictObject({
  code: z.enum([
    "signed-out",
    "usage-limit",
    "context-full",
    "unavailable",
    "crashed",
    "refused-tool",
    "protocol",
  ]),
  message: z.string(),
});
export type ChatFailure = z.output<typeof ChatFailure>;

/** One read of the agent, as the discussion shows it. */
export const ChatToolUse = z.strictObject({
  id: z.string(),
  tool: z.string(),
  state: z.enum(["running", "done", "failed"]),
  /** The words searched (`search_transcripts`). */
  query: z.string().nullable(),
  episodeId: z.int().positive().nullable(),
  personId: z.int().positive().nullable(),
  itemId: z.int().positive().nullable(),
  /** A local day, `YYYY-MM-DD`. */
  day: z.string().nullable(),
  /** How many episodes, people or segments came back, when the edge said. */
  results: z.int().nonnegative().nullable(),
});
export type ChatToolUse = z.output<typeof ChatToolUse>;

export const ChatMessage = z.strictObject({
  id: z.int().positive(),
  role: z.enum(["user", "agent"]),
  text: z.string(),
  atMs: z.int(),
  /** The agent's reads during this answer, in order. */
  tools: z.array(ChatToolUse),
  /** An answer still coming. */
  streaming: z.boolean(),
  /** Téo stopped it. */
  stopped: z.boolean(),
  failure: ChatFailure.nullable(),
});
export type ChatMessage = z.output<typeof ChatMessage>;

/**
 * Where the user opened the agent (ADR 037): the conversation, day or person
 * on screen. The agent starts there and still reads everything else.
 */
export const ChatFocus = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("episode"), episodeId: z.int().positive() }),
  z.strictObject({ kind: z.literal("day"), day: z.iso.date() }),
  z.strictObject({ kind: z.literal("person"), personId: z.int().positive() }),
]);
export type ChatFocus = z.output<typeof ChatFocus>;

export const ChatDiscussionSummary = z.strictObject({
  id: z.int().positive(),
  /** Téo's first message, shortened. */
  title: z.string(),
  provider: ChatProviderId,
  model: z.string(),
  startedAtMs: z.int(),
  updatedAtMs: z.int(),
  running: z.boolean(),
  /** Where it was opened (ADR 037); null for everything. */
  focus: ChatFocus.nullable(),
  /** « Limiter »: core keeps the agent's reads within `focus`. */
  limited: z.boolean(),
});
export type ChatDiscussionSummary = z.output<typeof ChatDiscussionSummary>;

export const ChatDiscussion = z.strictObject({
  ...ChatDiscussionSummary.shape,
  effort: z.string().nullable(),
  messages: z.array(ChatMessage),
});
export type ChatDiscussion = z.output<typeof ChatDiscussion>;

export const ChatView = z.strictObject({
  /** Moves with every change. */
  revision: z.int().nonnegative(),
  /** Newest first. */
  discussions: z.array(ChatDiscussionSummary),
  /** The discussion asked for, or null when it does not exist (any more). */
  discussion: ChatDiscussion.nullable(),
  /** Discussions erased since launch because something was deleted after they read Sondine. */
  erased: z.int().nonnegative(),
});
export type ChatView = z.output<typeof ChatView>;

export const ChatWatchInput = z.strictObject({ discussionId: z.int().positive().nullable() });
export type ChatWatchInput = z.input<typeof ChatWatchInput>;

export const ChatSendInput = z.strictObject({
  /** Null starts a new discussion. */
  discussionId: z.int().positive().nullable(),
  text: z.string().trim().min(1).max(20_000),
  choice: ChatChoice,
  /** A new discussion: where the user is looking; null or absent for everything. Ignored after. */
  focus: ChatFocus.nullable().optional(),
  /** A new discussion: « Limiter » from its first message. Later, `chat.setLimited`. */
  limited: z.boolean().optional(),
});

export const ChatLimitInput = z.strictObject({
  discussionId: z.int().positive(),
  limited: z.boolean(),
});
export type ChatLimitInput = z.input<typeof ChatLimitInput>;
export type ChatSendInput = z.input<typeof ChatSendInput>;

export const ChatSendResult = z.strictObject({ discussionId: z.int().positive() });
export type ChatSendResult = z.output<typeof ChatSendResult>;

export const ChatDiscussionInput = z.strictObject({ discussionId: z.int().positive() });
export type ChatDiscussionInput = z.input<typeof ChatDiscussionInput>;
// The daily journal and commitments (ADR 028).

/** A voice of a journal line, named as the transcript names it now. */
export const JournalVoice = z.strictObject({
  /** How the line refers to it: `P2` in `{P2}`. */
  ref: z.string(),
  /** The person's name when one is read; null otherwise. */
  name: z.string().nullable(),
  /** The user. */
  self: z.boolean(),
  /** Its number among the transcript's voices (« Voix 2 »); null when not known. */
  ordinal: z.int().min(0).nullable(),
  /**
   * Whom Sondine takes an unnamed voice for, from its likeness to the voices
   * the user named (ADR 030), at 80 % or more: unconfirmed, a guess, never a
   * name the user gave. `recognized` at 99 % or more. Null when the voice is
   * named, the user, or nobody is likely.
   */
  guess: z
    .strictObject({
      person: PersonRef,
      confidence: z.number().min(0).max(1),
      recognized: z.boolean(),
    })
    .nullable(),
});
export type JournalVoice = z.output<typeof JournalVoice>;

/** A sentence a line cites: a click opens it at its moment. */
export const JournalCitation = z.strictObject({
  episodeId: z.int().positive(),
  segmentId: z.int().positive(),
  startMs: WallMs,
  endMs: WallMs,
  speaker: JournalVoice.nullable(),
  text: z.string(),
});
export type JournalCitation = z.output<typeof JournalCitation>;

export const JournalStatus = z.enum(["open", "done", "dismissed"]);
export type JournalStatus = z.output<typeof JournalStatus>;

const journalLineFields = {
  /** The model's line; null when only the user's mark is left (the model no longer writes it). */
  itemId: z.int().positive().nullable(),
  /** The user's mark on it, if any. */
  markId: z.int().positive().nullable(),
  episodeId: z.int().positive(),
  /** Written by a model, voices as `{P2}` (see `voices`); the user's words when `edited`. */
  text: z.string(),
  voices: z.array(JournalVoice),
  edited: z.boolean(),
  /** `dismissed`: the user said it is wrong. A line of the journal is `open` otherwise. */
  status: JournalStatus,
  /** A sentence it cites changed since: a new line is on its way. */
  stale: z.boolean(),
  startMs: WallMs,
  /** At least one, in order. */
  citations: z.array(JournalCitation),
};

export const JournalLine = z.strictObject(journalLineFields);
export type JournalLine = z.output<typeof JournalLine>;

export const JournalCommitment = z.strictObject({
  ...journalLineFields,
  /** Who committed and to whom; null when not said. */
  who: JournalVoice.nullable(),
  to: JournalVoice.nullable(),
  /** `YYYY-MM-DD` in the Mac's time zone; null when none was said. */
  due: z.iso.date().nullable(),
  /** The words that gave the date (« jeudi »). */
  dueText: z.string().nullable(),
});
export type JournalCommitment = z.output<typeof JournalCommitment>;

/** One conversation's lines, in time order. */
export const JournalConversation = z.strictObject({
  episodeId: z.int().positive(),
  startedAtMs: WallMs,
  endedAtMs: WallMs.nullable(),
  context: EpisodeContext.nullable(),
  lines: z.array(JournalLine),
});
export type JournalConversation = z.output<typeof JournalConversation>;

/** Whether the journal can be written, and what of the day is still to write. */
/**
 * Who writes the journal (ADR 028): `device`, the model on this Mac, nothing
 * leaves; `device-checked`, then the user's Claude reads each commitment
 * again with the lines around it; `claude`, the user's Claude writes it, the
 * conversations leave the Mac. The user's choice, for what comes next.
 */
export const JournalWriter = z.enum(["device", "device-checked", "claude"]);
export type JournalWriter = z.output<typeof JournalWriter>;

export const JournalState = z.strictObject({
  /** The journal's model is installed (Settings ▸ Journal). */
  installed: z.boolean(),
  /** The user lets Sondine write it. */
  enabled: z.boolean(),
  /** What new lines are written in: the window's language. */
  language: z.enum(["fr", "en"]),
  /** Conversations of the day not written yet. */
  pending: Count,
  /** Conversations its model failed on three times. */
  failed: Count,
  /** One of the day's conversations is being written now. */
  writing: z.boolean(),
  /** The user asked to write the day now. */
  requested: z.boolean(),
  /** Who writes what comes next: this Mac, this Mac read again by the user's Claude, or their Claude. */
  writer: JournalWriter,
  /** The user's Claude did not answer (signed out, offline, limits): the journal waits a few minutes. */
  claudePaused: z.boolean(),
});
export type JournalState = z.output<typeof JournalState>;

export const JournalDayInput = z
  .strictObject({
    /** A calendar day in the Mac's time zone; today when omitted. */
    day: z.iso.date().optional(),
  })
  .prefault({});
export type JournalDayInput = z.input<typeof JournalDayInput>;

export const JournalDay = z.strictObject({
  day: z.iso.date(),
  state: JournalState,
  /** The day's conversations that have lines, in time order. */
  conversations: z.array(JournalConversation),
  /** The commitments made that day, every status. */
  commitments: z.array(JournalCommitment),
});
export type JournalDay = z.output<typeof JournalDay>;

export const JournalCommitmentsInput = z
  .strictObject({
    /** `open` by default; `all` includes done ones and those the user said were not commitments. */
    status: z.enum(["open", "done", "all"]).default("open"),
    /** Commitments made before this time; now when omitted. Page with `nextBeforeMs`. */
    beforeMs: WallMs.optional(),
    /** How far back one page looks, in days (default 30, at most 90). */
    days: z.int().min(1).max(90).default(30),
    /**
     * At most about this many: a page stops after the conversations that
     * started in the same millisecond as the last one it keeps, so none is
     * split and `nextBeforeMs` (that millisecond) skips nothing. All of the
     * window when omitted.
     */
    limit: z.int().min(1).max(500).optional(),
  })
  .prefault({});
export type JournalCommitmentsInput = z.input<typeof JournalCommitmentsInput>;

export const JournalCommitmentsOutput = z.strictObject({
  /** Newest first. */
  commitments: z.array(JournalCommitment),
  /**
   * Ask again with this as `beforeMs` for older ones: the start of the
   * window, or with `limit`, the start of the oldest conversation kept.
   */
  nextBeforeMs: WallMs,
});
export type JournalCommitmentsOutput = z.output<typeof JournalCommitmentsOutput>;

const JournalTarget = {
  itemId: z.int().positive().nullable(),
  markId: z.int().positive().nullable(),
};

export const JournalMarkInput = z.strictObject({
  ...JournalTarget,
  /** One change: a status, the user's text (null: the model's again), or a date (null clears it). */
  change: z.union([
    z.strictObject({ status: JournalStatus }),
    z.strictObject({ text: z.string().trim().min(1).max(400).nullable() }),
    z.strictObject({ due: z.iso.date().nullable() }),
  ]),
});
export type JournalMarkInput = z.input<typeof JournalMarkInput>;

export const JournalMarkResult = z.strictObject({ markId: z.int().positive().nullable() });
export type JournalMarkResult = z.output<typeof JournalMarkResult>;

export const JournalRequestInput = z.strictObject({
  day: z.iso.date(),
  /** « Réécrire ce jour »: what is already written goes again, by whoever writes now. */
  rewrite: z.boolean().optional(),
});
export type JournalRequestInput = z.input<typeof JournalRequestInput>;

export const JournalSettingsInput = z.strictObject({
  enabled: z.boolean().optional(),
  language: z.enum(["fr", "en"]).optional(),
  writer: JournalWriter.optional(),
});
export type JournalSettingsInput = z.input<typeof JournalSettingsInput>;

export const JournalSettings = z.strictObject({
  enabled: z.boolean(),
  language: z.enum(["fr", "en"]),
  writer: JournalWriter,
});
export type JournalSettings = z.output<typeof JournalSettings>;

/** Settings ▸ Statistiques (ADR 037): figures from what the database holds, on this Mac only. */
export const Statistics = z.strictObject({
  /** The last 7 local days, oldest first. */
  days: z.array(
    z.strictObject({
      day: z.iso.date(),
      voicedMs: z.int().nonnegative(),
      conversations: z.int().nonnegative(),
    }),
  ),
  /** The last 30 days: voiced time by context, largest first. */
  contexts: z.array(z.strictObject({ context: EpisodeContext, voicedMs: z.int().nonnegative() })),
  /** The last 30 days: talk time of named people in conversations, not the user, top 5. */
  people: z.array(
    z.strictObject({
      personId: z.int().positive(),
      name: z.string(),
      talkMs: z.int().nonnegative(),
    }),
  ),
  /** Words in the current transcripts. */
  words: z.int().nonnegative(),
  /** The last 7 days: tool calls by outside agents. */
  agentReads: z.int().nonnegative(),
});
export type Statistics = z.output<typeof Statistics>;

export const StatisticsMonthInput = z.strictObject({
  /** A calendar month in the Mac's time zone, `YYYY-MM`. */
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u),
});
export type StatisticsMonthInput = z.input<typeof StatisticsMonthInput>;

/** Each day of a month, for Today's calendar (ADR 037): how much was said, and how many conversations. */
export const StatisticsMonth = z.strictObject({
  month: z.string(),
  /** Every day of the month, first to last; days to come count nothing. */
  days: z.array(
    z.strictObject({
      day: z.iso.date(),
      voicedMs: z.int().nonnegative(),
      conversations: z.int().nonnegative(),
    }),
  ),
});
export type StatisticsMonth = z.output<typeof StatisticsMonth>;

// Tags on recordings (ADR 039): free words the user gives a whole recording.

/** A tag as typed: core cleans it (spaces, a leading « # ») and refuses it empty or over 40 characters. */
const TypedTag = z.string().min(1).max(200);

export const TagSummary = z.strictObject({
  id: z.int().positive(),
  name: z.string().max(400),
  /** Recordings it is on. */
  recordings: Count,
  usedAtMs: WallMs,
});
export type TagSummary = z.output<typeof TagSummary>;

export const TagList = z.strictObject({
  /** Every tag, the latest used first. */
  tags: z.array(TagSummary),
});
export type TagList = z.output<typeof TagList>;

/** Puts a tag on a recording (`on`), creating it, or takes it off. */
export const TagSetInput = z.strictObject({
  episodeId: z.int().positive(),
  name: TypedTag,
  on: z.boolean(),
});
export type TagSetInput = z.input<typeof TagSetInput>;

export const TagSetResult = z.strictObject({
  /** The recording's tags after (a merge may have brought more than 20). */
  tags: z.array(z.string().max(400)).max(400),
});
export type TagSetResult = z.output<typeof TagSetResult>;

/** Renames a tag; to another tag's name, merges into it. */
export const TagRenameInput = z.strictObject({
  tagId: z.int().positive(),
  name: TypedTag,
});
export type TagRenameInput = z.input<typeof TagRenameInput>;

export const TagRenameResult = z.strictObject({
  tag: z.strictObject({ id: z.int().positive(), name: z.string().max(400) }),
  merged: z.boolean(),
});
export type TagRenameResult = z.output<typeof TagRenameResult>;

export const TagDeleteInput = z.strictObject({ tagId: z.int().positive() });
export type TagDeleteInput = z.input<typeof TagDeleteInput>;

export const TagDeleteResult = z.strictObject({
  /** How many recordings had it. */
  recordings: Count,
});
export type TagDeleteResult = z.output<typeof TagDeleteResult>;

// The Vocabulary (ADR 046): the user's words, each with an optional note the
// journal's model reads, and their People's names.

const VocabularyWord = z.string().trim().min(1).max(60);
const VocabularyNote = z.string().trim().max(200).nullable();

export const VocabularyEntry = z.strictObject({
  id: z.int().positive(),
  word: z.string().max(60),
  note: z.string().max(200).nullable(),
});
export type VocabularyEntry = z.output<typeof VocabularyEntry>;

export const VocabularyList = z.strictObject({
  /** The user's words, alphabetical. */
  words: z.array(VocabularyEntry),
  /** Their People's names that are not in the list, alphabetical: in the vocabulary too. */
  people: z.array(z.string().max(80)),
  /** Whether the journal's model is on this Mac to read names that only look like these. */
  modelReads: z.boolean(),
});
export type VocabularyList = z.output<typeof VocabularyList>;

export const VocabularyAddInput = z.strictObject({
  word: VocabularyWord,
  note: VocabularyNote.optional(),
});
export type VocabularyAddInput = z.input<typeof VocabularyAddInput>;

export const VocabularyUpdateInput = z.strictObject({
  id: z.int().positive(),
  word: VocabularyWord,
  note: VocabularyNote.optional(),
});
export type VocabularyUpdateInput = z.input<typeof VocabularyUpdateInput>;

export const VocabularyRemoveInput = z.strictObject({ id: z.int().positive() });
export type VocabularyRemoveInput = z.input<typeof VocabularyRemoveInput>;
