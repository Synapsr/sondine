import * as z from "zod";
import { PROTOCOL_VERSION } from "./constants";
import type { ControlMessageType } from "./control-messages";
import {
  AttributionConfidence,
  AudioFormat,
  BundleId,
  ClockAnchor,
  ClockPoint,
  ClockValue,
  Count,
  DeviceUid,
  Dbfs,
  DurationNs,
  Epoch,
  GapSpan,
  InputSelection,
  MappingConfidence,
  MappingEvidence,
  NetworkHash,
  ObjectId,
  PermissionEvidence,
  PermissionStatus,
  Pid,
  RequestId,
  SampleIndex,
  SampleRate,
  ShortText,
  SpoolPath,
  StreamState,
  Timebase,
  TrackKey,
  Transport,
  Uuid,
  VersionText,
  WallMs,
  parseTrackKey,
} from "./primitives";
import { described, named } from "./registry";
import { checkCommit, checkRegionSpan, checkUnique, commitShape, regionSpanShape } from "./shapes";

/** Present when the event answers a control message, including snapshot replays. */
const replyTo = described(
  "Id of the control message this event answers; absent on spontaneous events.",
  RequestId,
).optional();

const Message = named(
  "Message",
  "Diagnostic text for logs, one line, 1 to 1024 characters.",
  // oxlint-disable-next-line no-control-regex -- excluding control characters is the point
  z.string().regex(/^[^\u0000-\u001f\u007f]{1,1024}$/),
);

const FourCharCode = named(
  "FourCharCode",
  "Core Audio four-character code as text, for example `bltn` or `usb `.",
  z.string().regex(/^[ -~]{4}$/),
);

// Session

export const ReadyEvent = named(
  "ReadyEvent",
  "Reply to `hello`: the helper speaks this protocol version.",
  z.strictObject({
    type: z.literal("ready"),
    replyTo: RequestId,
    protocol: z.literal(PROTOCOL_VERSION),
    sessionId: described("Id of this helper launch.", Uuid),
    helper: z.strictObject({ version: VersionText, build: VersionText }),
    os: z.strictObject({ version: VersionText, build: VersionText }),
    timebase: Timebase,
    paused: z.strictObject({ microphone: z.boolean(), systemAudio: z.boolean() }),
    capabilities: z.strictObject({
      appTaps: z.boolean(),
      maxAppTaps: z.int().min(0).max(8),
      vad: z.strictObject({ engine: ShortText, version: VersionText }),
    }),
  }),
);
export type ReadyEvent = z.output<typeof ReadyEvent>;

export const AckEvent = named(
  "AckEvent",
  "Terminal success reply to every control message except `hello`.",
  z.strictObject({ type: z.literal("ack"), replyTo: RequestId }),
);
export type AckEvent = z.output<typeof AckEvent>;

// Permissions and discovery

export const PermissionState = named(
  "PermissionState",
  "Permission status and how it was learned. Stream health is reported per track, never here.",
  z
    .strictObject({ status: PermissionStatus, evidence: PermissionEvidence })
    .superRefine((permission, ctx) => {
      if ((permission.status === "granted-verified") !== (permission.evidence === "first-signal")) {
        ctx.addIssue({
          code: "custom",
          path: ["evidence"],
          message: "granted-verified comes only from first-signal, and first-signal only verifies",
        });
      }
      if (permission.evidence === "not-checked" && permission.status !== "unknown") {
        ctx.addIssue({
          code: "custom",
          path: ["status"],
          message: "an unchecked permission is unknown",
        });
      }
    }),
);
export type PermissionState = z.output<typeof PermissionState>;

export const PermissionsEvent = named(
  "PermissionsEvent",
  "Current microphone and system-audio permission state; sent on change.",
  z.strictObject({
    type: z.literal("permissions"),
    replyTo,
    microphone: PermissionState,
    systemAudio: PermissionState,
  }),
);
export type PermissionsEvent = z.output<typeof PermissionsEvent>;

export const AudioDevice = named(
  "AudioDevice",
  "One Core Audio device.",
  z.strictObject({
    uid: DeviceUid,
    name: ShortText,
    transport: Transport,
    transportCode: FourCharCode.nullable(),
    input: described("Has input streams.", z.boolean()),
    output: described("Has output streams.", z.boolean()),
    alive: z.boolean(),
    nominalRate: SampleRate.nullable(),
    dataSource: described(
      "Current data source code, for example `ispk` (built-in speakers) or `hdpn` (headphones).",
      FourCharCode,
    ).nullable(),
    loopback: described(
      "A known loopback or virtual device that carries system audio; never a microphone candidate.",
      z.boolean(),
    ),
  }),
);
export type AudioDevice = z.output<typeof AudioDevice>;

export const DevicesEvent = named(
  "DevicesEvent",
  "The complete device list; sent on change.",
  z
    .strictObject({
      type: z.literal("devices"),
      replyTo,
      defaultInputUid: DeviceUid.nullable(),
      defaultOutputUid: DeviceUid.nullable(),
      devices: z.array(AudioDevice).max(256),
    })
    .superRefine((event, ctx) => {
      checkUnique(event.devices, (device) => device.uid, ["devices"], ctx);
    }),
);
export type DevicesEvent = z.output<typeof DevicesEvent>;

export const AppIdentity = named(
  "AppIdentity",
  "The app a process belongs to.",
  z.strictObject({ bundleId: BundleId, name: ShortText.nullable() }),
);

export const ProcessMapping = named(
  "ProcessMapping",
  "Evidence and confidence of a process-to-app mapping.",
  z.strictObject({
    evidence: MappingEvidence,
    confidence: MappingConfidence,
    viaTerminal: described("A command-line process resolved to its terminal.", z.boolean()),
  }),
);

export const AudioProcess = named(
  "AudioProcess",
  "One Core Audio process object. A process incarnation is (pid, startWallNs).",
  z
    .strictObject({
      objectId: ObjectId,
      pid: Pid,
      startWallNs: described("Process start time, wall-clock ns.", ClockValue).nullable(),
      halBundleId: described(
        "kAudioProcessPropertyBundleID, for example `com.apple.WebKit.GPU`.",
        BundleId,
      ).nullable(),
      app: AppIdentity.nullable(),
      mapping: ProcessMapping.nullable(),
      trackKey: described(
        "Track that captures this process: `app:<bundleID>` or `system:other`; null when excluded.",
        TrackKey,
      ).nullable(),
      excluded: described(
        "Why the process is in no tap: one of Sondine's own, or an app the user excluded.",
        z.enum(["own", "user"]),
      ).nullable(),
    })
    .superRefine((process, ctx) => {
      if ((process.app === null) !== (process.mapping === null)) {
        ctx.addIssue({
          code: "custom",
          path: ["mapping"],
          message: "app and mapping are both set or both null",
        });
      }
      if ((process.trackKey === null) !== (process.excluded !== null)) {
        ctx.addIssue({
          code: "custom",
          path: ["trackKey"],
          message: "trackKey is null exactly when the process is excluded",
        });
      }
      if (process.trackKey !== null && parseTrackKey(process.trackKey).kind === "input") {
        ctx.addIssue({
          code: "custom",
          path: ["trackKey"],
          message: "a process is captured by an app or system track",
        });
      }
    }),
);
export type AudioProcess = z.output<typeof AudioProcess>;

export const ProcessesEvent = named(
  "ProcessesEvent",
  "The complete list of Core Audio process objects with their mapping; sent on change.",
  z
    .strictObject({
      type: z.literal("processes"),
      replyTo,
      processes: z.array(AudioProcess).max(1024),
    })
    .superRefine((event, ctx) => {
      checkUnique(event.processes, (process) => process.objectId, ["processes"], ctx);
    }),
);
export type ProcessesEvent = z.output<typeof ProcessesEvent>;

// Tracks

export const InputSource = named(
  "InputSource",
  "A microphone track.",
  z.strictObject({
    kind: z.literal("input"),
    deviceUid: DeviceUid,
    name: ShortText,
    transport: Transport,
    selection: InputSelection,
  }),
);

export const AppSource = named(
  "AppSource",
  "A private process tap on every process object of one app.",
  z.strictObject({
    kind: z.literal("app"),
    bundleId: BundleId,
    name: ShortText.nullable(),
    objectIds: z.array(ObjectId).min(1).max(64),
  }),
);

export const SystemSource = named(
  "SystemSource",
  "The global tap: everything not on an app track, minus excluded processes.",
  z.strictObject({
    kind: z.literal("system"),
    excludedObjectIds: z.array(ObjectId).max(1024),
  }),
);

export const TrackSource = named(
  "TrackSource",
  "What a track captures.",
  z.discriminatedUnion("kind", [InputSource, AppSource, SystemSource]),
);
export type TrackSource = z.output<typeof TrackSource>;

/** The track key a source must carry. */
export function trackKeyOf(source: TrackSource): TrackKey {
  switch (source.kind) {
    case "input":
      return `input:${source.deviceUid}`;
    case "app":
      return `app:${source.bundleId}`;
    case "system":
      return "system:other";
  }
}

function checkSource(event: { trackKey: TrackKey; source: TrackSource }, ctx: z.RefinementCtx) {
  if (trackKeyOf(event.source) !== event.trackKey) {
    ctx.addIssue({
      code: "custom",
      path: ["source"],
      message: "source does not match trackKey",
    });
  }
}

const trackStateShape = {
  nominalRate: described("Device or aggregate nominal rate.", SampleRate),
  measuredRate: described(
    "Rate measured as frames ÷ Δhost time; null until measured.",
    SampleRate,
  ).nullable(),
  stream: StreamState,
  source: TrackSource,
};

export const TrackOpenEvent = named(
  "TrackOpenEvent",
  "A track run starts. Sample index 0 is the run's first sample.",
  z
    .strictObject({
      type: z.literal("track.open"),
      replyTo,
      trackKey: TrackKey,
      runId: Uuid,
      epoch: Epoch,
      start: described("Clock of sample 0.", ClockPoint),
      anchor: ClockAnchor,
      format: AudioFormat,
      ...trackStateShape,
    })
    .superRefine(checkSource),
);
export type TrackOpenEvent = z.output<typeof TrackOpenEvent>;

export const TrackUpdateEvent = named(
  "TrackUpdateEvent",
  "A run's state changed. A rate or format change starts a new epoch at `sampleIndex`.",
  z
    .strictObject({
      type: z.literal("track.update"),
      replyTo,
      trackKey: TrackKey,
      runId: Uuid,
      epoch: Epoch,
      reason: z.enum(["rate-change", "format-change", "stream", "source"]),
      sampleIndex: described("Run sample index where the change applies.", SampleIndex),
      at: ClockPoint,
      ...trackStateShape,
    })
    .superRefine(checkSource),
);
export type TrackUpdateEvent = z.output<typeof TrackUpdateEvent>;

export const TrackEndReason = named(
  "TrackEndReason",
  "Why a track run ended. `held`: a private zone holds capture (ADR 029); `paused` is only the user's pause.",
  z.enum([
    "paused",
    "held",
    "disabled",
    "excluded",
    "device-removed",
    "device-changed",
    "tap-released",
    "sleep",
    "service-restarted",
    "permission",
    "error",
    "shutdown",
  ]),
);

export const TrackCloseEvent = named(
  "TrackCloseEvent",
  "A track run ended. Its spool files are complete once this event is sent.",
  z.strictObject({
    type: z.literal("track.close"),
    replyTo,
    trackKey: TrackKey,
    runId: Uuid,
    epoch: Epoch,
    endSample: described("Samples in the run, gaps included.", SampleIndex),
    at: ClockPoint,
    reason: TrackEndReason,
  }),
);
export type TrackCloseEvent = z.output<typeof TrackCloseEvent>;

// Speech regions and spool commits

export const RegionOpenEvent = named(
  "RegionOpenEvent",
  "The VAD opened a speech region; it stays provisional until `region.close`.",
  z.strictObject({
    type: z.literal("region.open"),
    replyTo,
    regionId: Uuid,
    trackKey: TrackKey,
    runId: Uuid,
    epoch: Epoch,
    startSample: SampleIndex,
    at: ClockPoint,
  }),
);
export type RegionOpenEvent = z.output<typeof RegionOpenEvent>;

export const ForegroundSpan = named(
  "ForegroundSpan",
  "The app in front on the Mac over part of a speech region, in run samples (ADR 022): NSWorkspace's frontmost application, never a window or what is on screen.",
  z
    .strictObject({
      bundleId: BundleId,
      name: described("The app's name, else its bundle ID.", ShortText),
      startSample: SampleIndex,
      endSample: described("After the span's last sample; > startSample.", SampleIndex),
    })
    .refine((span) => span.endSample > span.startSample, {
      message: "endSample must be > startSample",
      path: ["endSample"],
    }),
);
export type ForegroundSpan = z.output<typeof ForegroundSpan>;

export const RegionCloseEvent = named(
  "RegionCloseEvent",
  "A speech region closed; the same span is written as a `region` manifest record (without `foreground`).",
  z
    .strictObject({
      type: z.literal("region.close"),
      replyTo,
      trackKey: TrackKey,
      runId: Uuid,
      ...regionSpanShape,
      at: described("Clock of the region's end.", ClockPoint),
      foreground: described(
        "The apps in front while it lasted, in order, inside the region and apart; a stretch with no app (none, the screen locked, an app the user excluded) has no span.",
        z.array(ForegroundSpan).max(64),
      ),
    })
    .superRefine((region, ctx) => {
      checkRegionSpan(region, ctx);
      let previousEnd = region.startSample;
      region.foreground.forEach((span, index) => {
        if (span.startSample < previousEnd || span.endSample > region.endSample) {
          ctx.addIssue({
            code: "custom",
            path: ["foreground", index],
            message: "spans must be in order, apart, and inside the region",
          });
        }
        previousEnd = span.endSample;
      });
    }),
);
export type RegionCloseEvent = z.output<typeof RegionCloseEvent>;

export const CommitEvent = named(
  "CommitEvent",
  "A spool block became durable: the PCM bytes and the manifest record were both fsynced.",
  z
    .strictObject({
      type: z.literal("commit"),
      replyTo,
      trackKey: TrackKey,
      runId: Uuid,
      file: described("PCM file relative to the spool root.", SpoolPath),
      ...commitShape,
      gaps: described(
        "Gaps recorded since the previous commit of this run, in order, all before sampleIndex.",
        z.array(GapSpan).max(64),
      ),
    })
    .superRefine((commit, ctx) => {
      checkCommit(commit, ctx);
      let previousEnd = 0;
      commit.gaps.forEach((gap, index) => {
        if (gap.fromSample < previousEnd || gap.toSample > commit.sampleIndex) {
          ctx.addIssue({
            code: "custom",
            path: ["gaps", index],
            message: "gaps are ordered, disjoint, and end at or before sampleIndex",
          });
        }
        previousEnd = gap.toSample;
      });
    }),
);
export type CommitEvent = z.output<typeof CommitEvent>;

// Attribution

export const RunningProcess = named(
  "RunningProcess",
  "A process object with IO running.",
  z
    .strictObject({
      objectId: ObjectId,
      output: z.boolean(),
      input: z.boolean(),
      inputDeviceUids: z.array(DeviceUid).max(16),
    })
    .superRefine((process, ctx) => {
      if (!process.output && !process.input) {
        ctx.addIssue({ code: "custom", path: [], message: "input or output must be running" });
      }
      if (!process.input && process.inputDeviceUids.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["inputDeviceUids"],
          message: "input devices are listed only while input runs",
        });
      }
    }),
);

export const TrackAttribution = named(
  "TrackAttribution",
  "Who the audio on an app or system track belongs to from `at` on. App tracks are `exact`; `system:other` is `single-active` (one app, all its process objects, or one process without an app) or `ambiguous`.",
  z
    .strictObject({
      trackKey: TrackKey,
      runId: Uuid,
      confidence: AttributionConfidence,
      bundleId: BundleId.nullable(),
      candidateObjectIds: described(
        "Process objects with output running in this track's scope.",
        z.array(ObjectId).max(1024),
      ),
    })
    .superRefine((attribution, ctx) => {
      const key = parseTrackKey(attribution.trackKey);
      const allowed: readonly string[] =
        key.kind === "app"
          ? ["exact"]
          : key.kind === "system"
            ? ["single-active", "ambiguous"]
            : [];
      if (!allowed.includes(attribution.confidence)) {
        ctx.addIssue({
          code: "custom",
          path: ["confidence"],
          message: `confidence ${attribution.confidence} does not apply to ${key.kind} tracks`,
        });
      }
      if (key.kind === "app" && attribution.bundleId !== key.bundleId) {
        ctx.addIssue({
          code: "custom",
          path: ["bundleId"],
          message: "an app track is attributed to its own app",
        });
      }
      if (
        attribution.confidence === "single-active" &&
        attribution.candidateObjectIds.length === 0
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["candidateObjectIds"],
          message: "single-active has a candidate",
        });
      }
      if (attribution.confidence === "ambiguous" && attribution.bundleId !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["bundleId"],
          message: "ambiguous audio has no app",
        });
      }
    }),
);
export type TrackAttribution = z.output<typeof TrackAttribution>;

export const ActivityEvent = named(
  "ActivityEvent",
  "IO activity and attribution from `at` on; sent on change, debounced 500 ms.",
  z
    .strictObject({
      type: z.literal("activity"),
      replyTo,
      at: ClockPoint,
      running: z.array(RunningProcess).max(1024),
      attribution: z.array(TrackAttribution).max(64),
    })
    .superRefine((event, ctx) => {
      checkUnique(event.running, (process) => process.objectId, ["running"], ctx);
      checkUnique(event.attribution, (entry) => entry.trackKey, ["attribution"], ctx);
    }),
);
export type ActivityEvent = z.output<typeof ActivityEvent>;

export const CallEvent = named(
  "CallEvent",
  "A call app, a call daemon, or a browser started or stopped using a microphone.",
  z.strictObject({
    type: z.literal("call"),
    replyTo,
    callId: Uuid,
    state: z.enum(["active", "ended"]),
    at: ClockPoint,
    bundleId: BundleId,
    via: z.enum(["call-app", "call-daemon", "browser"]),
    inputDeviceUid: DeviceUid.nullable(),
  }),
);
export type CallEvent = z.output<typeof CallEvent>;

export const ListenEvent = named(
  "ListenEvent",
  "An app other than a call started or stopped listening to a microphone: a dictation app, a browser page, or the system's speech recognition (`speech`).",
  z.strictObject({
    type: z.literal("listen"),
    replyTo,
    listenId: Uuid,
    state: z.enum(["active", "ended"]),
    at: ClockPoint,
    bundleId: BundleId,
    via: z.enum(["app", "speech"]),
  }),
);
export type ListenEvent = z.output<typeof ListenEvent>;

export const CallSeenEvent = named(
  "CallSeenEvent",
  "A call the helper sees, paused or not (ADR 036): a call app, a call daemon, or a browser playing sound started or stopped using a microphone. Never for Sondine's own or an excluded app; never a call span. One call id per active span; snapshots replay the active ones.",
  z.strictObject({
    type: z.literal("call.seen"),
    replyTo,
    callId: Uuid,
    state: z.enum(["active", "ended"]),
    at: ClockPoint,
    bundleId: BundleId,
    name: ShortText.nullable(),
    via: z.enum(["call-app", "call-daemon", "browser"]),
  }),
);
export type CallSeenEvent = z.output<typeof CallSeenEvent>;

// Private zones (ADR 029)

export const SituationEvent = named(
  "SituationEvent",
  "What the Mac's situation is, for core's zones: whether the screen is away, and the networks it is on. Sent on change and replayed in snapshots.",
  z
    .strictObject({
      type: z.literal("situation"),
      replyTo,
      screenAway: described(
        "The screen is locked, the screen saver runs, or the displays sleep.",
        z.boolean(),
      ),
      networks: described(
        "Keyed hashes of the networks the Mac is on now, sorted; empty until a config brings a network key, or when none is readable.",
        z.array(NetworkHash).max(8),
      ),
    })
    .superRefine((event, ctx) => {
      event.networks.forEach((hash, index) => {
        const previous = event.networks[index - 1];
        if (previous !== undefined && previous >= hash) {
          ctx.addIssue({
            code: "custom",
            path: ["networks", index],
            message: "networks are sorted and unique",
          });
        }
      });
    }),
);
export type SituationEvent = z.output<typeof SituationEvent>;

export const HoldReason = named(
  "HoldReason",
  "What holds capture: an excluded app in a call or listening (`app`), a call (`calls`), the screen away, hours (`schedule`), or a network.",
  z.enum(["app", "calls", "screen", "schedule", "network"]),
);
export type HoldReason = z.output<typeof HoldReason>;

export const HoldScope = named(
  "HoldScope",
  "What a hold stops: everything, or the microphone only (an excluded app's call or listen).",
  z.enum(["all", "microphone"]),
);
export type HoldScope = z.output<typeof HoldScope>;

export const HoldOccurrence = named(
  "HoldOccurrence",
  "One occurrence of a hold: from its trigger's start to its end (the call or listen and 10 s, the window's end, leaving the network, the screen back). Sleep, wake and a reconnect do not end it. A lifted occurrence holds nothing until it ends; the next one has a new id.",
  z
    .strictObject({
      occurrenceId: Uuid,
      reason: HoldReason,
      scope: HoldScope,
      bundleId: described("The excluded app, for `app`.", BundleId).optional(),
      network: described("The network, for `network`.", NetworkHash).optional(),
      window: described(
        "Index of the window in `holds.schedule`, for `schedule`.",
        z.int().min(0).max(31),
      ).optional(),
      since: described("When its trigger started.", ClockPoint),
      sinceWallMs: WallMs,
      lifted: z.boolean(),
    })
    .superRefine((hold, ctx) => {
      if ((hold.scope === "microphone") !== (hold.reason === "app")) {
        ctx.addIssue({
          code: "custom",
          path: ["scope"],
          message: "an app's hold holds the microphone; every other hold holds everything",
        });
      }
      const detail = [
        { key: "bundleId", reason: "app", present: hold.bundleId !== undefined },
        { key: "network", reason: "network", present: hold.network !== undefined },
        { key: "window", reason: "schedule", present: hold.window !== undefined },
      ] as const;
      for (const { key, reason, present } of detail) {
        if (present !== (hold.reason === reason)) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is set exactly for ${reason} holds`,
          });
        }
      }
    }),
);
export type HoldOccurrence = z.output<typeof HoldOccurrence>;

export const HoldsEvent = named(
  "HoldsEvent",
  "Every hold active now, lifted ones included; sent on change and replayed in snapshots. `ready.paused` stays the user's pause: a hold never changes it.",
  z
    .strictObject({
      type: z.literal("holds"),
      replyTo,
      holds: z.array(HoldOccurrence).max(128),
    })
    .superRefine((event, ctx) => {
      checkUnique(event.holds, (hold) => hold.occurrenceId, ["holds"], ctx);
    }),
);
export type HoldsEvent = z.output<typeof HoldsEvent>;

export const ClockEvent = named(
  "ClockEvent",
  "A fresh anchor triple, every 60 s and on wake; used by the live view only (manifests carry their own anchors).",
  z.strictObject({
    type: z.literal("clock"),
    replyTo,
    reason: z.enum(["periodic", "wake", "request"]),
    anchor: ClockAnchor,
  }),
);
export type ClockEvent = z.output<typeof ClockEvent>;

// Sondine's own sound (ADR 035)

/** Most frames one `self.envelope` carries: 6 s. */
export const MAX_SELF_ENVELOPE_FRAMES = 600;

export const SelfEnvelopeEvent = named(
  "SelfEnvelopeEvent",
  "The private `self:playback` reference (ADR 035): the 10 ms energy of what Sondine itself plays, captured by a tap on its own processes while they run output, and nothing else (no PCM is stored, nothing is transcribed). Frames are contiguous from `start`; a gap starts a new event. Core keeps them in memory only, to tell echo of a playback from someone speaking over it. Never replayed in snapshots: `replyTo` is never set.",
  z.strictObject({
    type: z.literal("self.envelope"),
    replyTo,
    start: described("When the first frame's first sample was played into the tap.", ClockPoint),
    levels: described(
      "One level per 10 ms frame, in tenths of a dBFS: -1200 (digital silence) to 0.",
      z.array(z.int().min(-1_200).max(0)).min(1).max(MAX_SELF_ENVELOPE_FRAMES),
    ),
  }),
);
export type SelfEnvelopeEvent = z.output<typeof SelfEnvelopeEvent>;

// Health

export const HealthStage = named(
  "HealthStage",
  "A helper stage measured with a fixed-bucket histogram; `tap-start` runs from the decision to start a tap to its first block.",
  z.enum([
    "io-callback",
    "drain",
    "resample",
    "energy-gate",
    "vad",
    "envelope",
    "spool-write",
    "spool-fsync",
    "manifest-fsync",
    "tap-start",
  ]),
);

export const StageHistogram = named(
  "StageHistogram",
  "Durations of one stage over the window, in nanoseconds. With count 0 every value is 0; otherwise p50 <= p95 <= max <= sum.",
  z
    .strictObject({
      stage: HealthStage,
      trackKey: TrackKey.nullable(),
      count: Count,
      sum: DurationNs,
      p50: DurationNs,
      p95: DurationNs,
      max: DurationNs,
    })
    .superRefine((histogram, ctx) => {
      const { count, sum, p50, p95, max } = histogram;
      const valid =
        count === 0
          ? sum === 0 && p50 === 0 && p95 === 0 && max === 0
          : p50 <= p95 && p95 <= max && max <= sum;
      if (!valid) {
        ctx.addIssue({
          code: "custom",
          path: [],
          message: "histogram values are inconsistent",
        });
      }
    }),
);
export type StageHistogram = z.output<typeof StageHistogram>;

export const TrackHealth = named(
  "TrackHealth",
  "Stream health of one open run over the window.",
  z.strictObject({
    trackKey: TrackKey,
    runId: Uuid,
    stream: StreamState,
    measuredRate: SampleRate.nullable(),
    level: described("Mean level over the window.", Dbfs).nullable(),
    zeroRunMs: described("Longest run of exact zeros in the window.", Count),
    ringHighWaterMs: described("Fullest the capture ring got, in audio ms.", Count),
    ringOverflows: Count,
    droppedSamples: Count,
    overloads: described("kAudioDeviceProcessorOverload notifications.", Count),
  }),
);
export type TrackHealth = z.output<typeof TrackHealth>;

export const HealthEvent = named(
  "HealthEvent",
  "Histograms and counters for the window that ends at `at`; every 60 s by default.",
  z
    .strictObject({
      type: z.literal("health"),
      replyTo,
      at: ClockPoint,
      windowMs: z.int().min(1).max(3_600_000),
      process: z.strictObject({
        footprintBytes: described("phys_footprint at `at`.", Count),
        cpuNs: described("User and system CPU time in the window.", DurationNs),
        wakeups: described("Idle and interrupt wakeups in the window.", Count),
      }),
      tracks: z.array(TrackHealth).max(64),
      stages: z.array(StageHistogram).max(1024),
    })
    .superRefine((event, ctx) => {
      checkUnique(event.tracks, (track) => track.runId, ["tracks"], ctx);
      checkUnique(
        event.stages,
        (histogram) => `${histogram.stage} ${histogram.trackKey ?? ""}`,
        ["stages"],
        ctx,
      );
    }),
);
export type HealthEvent = z.output<typeof HealthEvent>;

// Problems

export const WarningCode = named(
  "WarningCode",
  "Open set of dotted warning codes, for example `transport.unknown` or `pcm.overflow`.",
  z
    .string()
    .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/)
    .max(64),
);

export const WarningEvent = named(
  "WarningEvent",
  "Something degraded but capture continues.",
  z.strictObject({
    type: z.literal("warning"),
    replyTo,
    code: WarningCode,
    message: Message,
    trackKey: TrackKey.optional(),
  }),
);
export type WarningEvent = z.output<typeof WarningEvent>;

export const ErrorCode = named(
  "ErrorCode",
  "Closed set of error codes core acts on.",
  z.enum([
    "protocol.unsupported",
    "request.invalid",
    "request.rejected",
    "permission.denied",
    "disk.full",
    "spool.io",
    "capture.failed",
    "vad.unavailable",
    "internal",
  ]),
);

export const ErrorEvent = named(
  "ErrorEvent",
  "A failure. With `replyTo` it is the terminal reply to that control message. `fatal` means the helper exits after sending it.",
  z.strictObject({
    type: z.literal("error"),
    replyTo,
    code: ErrorCode,
    message: Message,
    fatal: z.boolean(),
    trackKey: TrackKey.optional(),
  }),
);
export type ErrorEvent = z.output<typeof ErrorEvent>;

/** Every event `sondine-audio` sends to core, discriminated on `type`. */
export const HelperEvent = z.discriminatedUnion("type", [
  ReadyEvent,
  AckEvent,
  PermissionsEvent,
  DevicesEvent,
  ProcessesEvent,
  TrackOpenEvent,
  TrackUpdateEvent,
  TrackCloseEvent,
  RegionOpenEvent,
  RegionCloseEvent,
  CommitEvent,
  ActivityEvent,
  CallEvent,
  ListenEvent,
  CallSeenEvent,
  SituationEvent,
  HoldsEvent,
  ClockEvent,
  SelfEnvelopeEvent,
  HealthEvent,
  WarningEvent,
  ErrorEvent,
]);
export type HelperEvent = z.output<typeof HelperEvent>;
export type HelperEventWire = z.input<typeof HelperEvent>;
export type HelperEventType = HelperEvent["type"];

export const HELPER_EVENT_TYPES: readonly HelperEventType[] = HelperEvent.options.map(
  (option) => option.shape.type.value,
);

/**
 * The success reply that ends each request. Any request may instead end with
 * an `error` carrying its id in `replyTo`.
 */
export const TERMINAL_REPLY = {
  hello: "ready",
  config: "ack",
  "exclude.pids": "ack",
  "pin.input": "ack",
  pause: "ack",
  resume: "ack",
  snapshot: "ack",
  "request.permissions": "ack",
  shutdown: "ack",
} as const satisfies Record<ControlMessageType, HelperEventType>;
