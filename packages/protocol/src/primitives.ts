import * as z from "zod";
import {
  BYTES_PER_SAMPLE,
  CHANNELS,
  DBFS_FLOOR,
  MAX_CLOCK_VALUE,
  SAMPLE_FORMAT,
  SAMPLE_RATE,
} from "./constants";
import { named } from "./registry";

const uint32 = () => z.int().min(0).max(0xffff_ffff);

// Scalars

/** 64-bit clock values travel as decimal strings: JSON numbers lose precision above 2^53. */
export const ClockValue = named(
  "ClockValue",
  "Non-negative 64-bit integer written as a decimal string without leading zeros, at most 2^63 - 1. Decoded to bigint in TypeScript.",
  z.codec(z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/), z.bigint().min(0n).max(MAX_CLOCK_VALUE), {
    decode: (text) => BigInt(text),
    encode: (value) => value.toString(),
  }),
);

export const Count = named(
  "Count",
  "Non-negative integer within the exact range of a double (2^53 - 1).",
  z.int().min(0),
);

export const SampleIndex = named(
  "SampleIndex",
  "Index of a 16 kHz sample since the start of its track run. Samples lost in gaps are counted, so the index tracks time.",
  z.int().min(0),
);

export const DurationNs = named("DurationNs", "Duration in nanoseconds.", z.int().min(0));

export const Uint32 = named("Uint32", "Unsigned 32-bit integer.", uint32());

export const Uuid = named(
  "Uuid",
  "Lowercase canonical UUID.",
  z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
);

export const RequestId = named(
  "RequestId",
  "Client-chosen id of a control message, unique per connection; echoed as `replyTo`.",
  z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
);

export const ShortText = named(
  "ShortText",
  "Human-readable text without control characters, 1 to 256 characters.",
  // oxlint-disable-next-line no-control-regex -- excluding control characters is the point
  z.string().regex(/^[^\u0000-\u001f\u007f]{1,256}$/),
);

export const VersionText = named(
  "VersionText",
  "Version or build string.",
  z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/),
);

export const DeviceUid = named(
  "DeviceUid",
  "Core Audio device UID (kAudioDevicePropertyDeviceUID).",
  // oxlint-disable-next-line no-control-regex -- the class excludes control characters; `\P{Cc}` needs the `u` flag, which zod drops inside template literals
  z.string().regex(/^[^\u0000-\u001f\u007f]{1,512}$/),
);

export const BundleId = named(
  "BundleId",
  "Bundle identifier of an app or daemon.",
  z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/),
);

export const ObjectId = named("ObjectId", "Core Audio AudioObjectID.", uint32());

export const Pid = named("Pid", "Process id.", z.int().min(1).max(0x7fff_ffff));

export const Epoch = named(
  "Epoch",
  "Capture epoch, increasing within one helper session. Each track run starts a new epoch, and so does a rate or format change inside a run; one event (wake, coreaudiod restart) may start the same epoch for several tracks.",
  uint32(),
);

export const SpoolPath = named(
  "SpoolPath",
  "Path of a spool file relative to the spool root, `/`-separated; no segment starts with a dot.",
  z
    .string()
    .max(512)
    .regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/),
);

export const Probability = named("Probability", "Probability in [0, 1].", z.number().min(0).max(1));

export const NetworkHash = named(
  "NetworkHash",
  "A network the Mac is on, as the first 16 bytes of HMAC-SHA256(networkKey, NetworkSignature) in lowercase hex (ADR 029). The raw signature never travels.",
  z.string().regex(/^[0-9a-f]{32}$/),
);

export const WallMs = named(
  "WallMs",
  "Wall-clock milliseconds since the Unix epoch; display and calendar only.",
  z.int().min(0),
);

export const Dbfs = named(
  "Dbfs",
  `Level in dBFS: 10·log10 of mean power with full scale at 0, clamped to ${DBFS_FLOOR}.`,
  z.number().min(DBFS_FLOOR).max(0),
);

export const SampleRate = named(
  "SampleRate",
  "Sample rate in Hz (nominal or measured).",
  z.number().positive().max(768_000),
);

// Track keys

export const InputTrackKey = z.templateLiteral(["input:", DeviceUid]);
export const AppTrackKey = z.templateLiteral(["app:", BundleId]);
export const SystemTrackKey = z.literal("system:other");

export const TrackKey = named(
  "TrackKey",
  "Stable track identity: `input:<deviceUID>`, `app:<bundleID>`, or `system:other`.",
  z.union([InputTrackKey, AppTrackKey, SystemTrackKey]),
);
export type TrackKey = z.output<typeof TrackKey>;

export type ParsedTrackKey =
  | { kind: "input"; deviceUid: string }
  | { kind: "app"; bundleId: string }
  | { kind: "system" };

export function parseTrackKey(key: TrackKey): ParsedTrackKey {
  if (key === "system:other") return { kind: "system" };
  if (key.startsWith("input:")) return { kind: "input", deviceUid: key.slice("input:".length) };
  return { kind: "app", bundleId: key.slice("app:".length) };
}

// Clocks

export const Timebase = named(
  "Timebase",
  "mach_timebase_info: nanoseconds = ticks × numer ÷ denom.",
  z.strictObject({
    numer: z.int().min(1).max(0xffff_ffff),
    denom: z.int().min(1).max(0xffff_ffff),
  }),
);
export type Timebase = z.output<typeof Timebase>;

export const ClockPoint = named(
  "ClockPoint",
  "An instant on the helper's clocks: host ticks (mach_absolute_time, stops in sleep) and continuous nanoseconds (mach_continuous_time converted with the timebase, runs in sleep). Ordering and durations use continuousNs.",
  z.strictObject({ hostTicks: ClockValue, continuousNs: ClockValue }),
);
export type ClockPoint = z.output<typeof ClockPoint>;

export const ClockAnchor = named(
  "ClockAnchor",
  "Anchor triple read together: host ticks, continuous nanoseconds, and wall-clock nanoseconds since the Unix epoch. Wall time is for display only.",
  z.strictObject({ hostTicks: ClockValue, continuousNs: ClockValue, wallNs: ClockValue }),
);
export type ClockAnchor = z.output<typeof ClockAnchor>;

/** Converts host ticks to nanoseconds with a mach timebase. */
export function ticksToNs(ticks: bigint, timebase: Timebase): bigint {
  return (ticks * BigInt(timebase.numer)) / BigInt(timebase.denom);
}

// Audio

export const AudioFormat = named(
  "AudioFormat",
  "Spool sample format: 16 kHz mono signed 16-bit little-endian PCM.",
  z.strictObject({
    rate: z.literal(SAMPLE_RATE),
    channels: z.literal(CHANNELS),
    sampleFormat: z.literal(SAMPLE_FORMAT),
  }),
);
export type AudioFormat = z.output<typeof AudioFormat>;

export const LevelStats = named(
  "LevelStats",
  "Mean and peak level over an interval; peak >= mean.",
  z.strictObject({ mean: Dbfs, peak: Dbfs }).refine((level) => level.peak >= level.mean, {
    path: ["peak"],
    message: "peak must be >= mean",
  }),
);

export const SpeechProbability = named(
  "SpeechProbability",
  "Mean and maximum VAD speech probability over an interval; max >= mean.",
  z
    .strictObject({ mean: Probability, max: Probability })
    .refine((probability) => probability.max >= probability.mean, {
      path: ["max"],
      message: "max must be >= mean",
    }),
);

// Enumerations

export const Transport = named(
  "Transport",
  "Device transport decoded from kAudioDevicePropertyTransportType.",
  z.enum([
    "built-in",
    "usb",
    "bluetooth",
    "bluetooth-le",
    "thunderbolt",
    "pci",
    "firewire",
    "hdmi",
    "displayport",
    "airplay",
    "avb",
    "continuity",
    "virtual",
    "aggregate",
    "unknown",
  ]),
);

export const InputSelection = named(
  "InputSelection",
  "Why this microphone is open: the user's pin, the device a call app is using, or the allowlisted default input.",
  z.enum(["pinned", "call-follow", "default"]),
);

export const PermissionStatus = named(
  "PermissionStatus",
  "Permission state. `granted-verified` only after the first non-zero sample; silence never proves denial.",
  z.enum(["unknown", "not-determined", "restricted", "denied", "granted", "granted-verified"]),
);

export const PermissionEvidence = named(
  "PermissionEvidence",
  "How the status was learned: the public authorization API, the TCC preflight, the first non-zero sample, or not checked yet.",
  z.enum(["authorization-status", "tcc-preflight", "first-signal", "not-checked"]),
);

export const StreamState = named(
  "StreamState",
  "Health of a track's stream, independent of permission: waiting for the first IO cycle, delivering, no IO cycle for over 2 s, or flagged by the zero watchdog.",
  z.enum(["starting", "running", "stalled", "zero-suspect"]),
);

export const AttributionConfidence = named(
  "AttributionConfidence",
  "How audio on a track is attributed to an app: its own tap, the only app (or the only process without one) with output running, or unknown.",
  z.enum(["exact", "single-active", "ambiguous"]),
);

export const MappingEvidence = named(
  "MappingEvidence",
  "How a process object was mapped to an app.",
  z.enum(["responsibility", "ancestry", "path", "daemon-map", "hal-bundle-id"]),
);

export const MappingConfidence = named(
  "MappingConfidence",
  "Confidence in a process-to-app mapping.",
  z.enum(["high", "medium", "low"]),
);

export const GapReason = named(
  "GapReason",
  "Why samples have no stored bytes.",
  z.enum(["ring-overflow", "disk-full", "write-error", "stall", "recovery-truncated"]),
);

export const RegionCloseReason = named(
  "RegionCloseReason",
  "Why a speech region closed.",
  z.enum(["silence", "max-duration", "track-closed"]),
);

export const PauseScope = named(
  "PauseScope",
  "What a pause or resume applies to. `system-audio` covers app taps and `system:other`.",
  z.enum(["all", "microphone", "system-audio"]),
);

// Shapes shared by events and manifest records

export const GapSpan = named(
  "GapSpan",
  "Samples [fromSample, toSample) of a run that have no stored bytes; toSample > fromSample.",
  z
    .strictObject({ reason: GapReason, fromSample: SampleIndex, toSample: SampleIndex })
    .refine((gap) => gap.toSample > gap.fromSample, {
      path: ["toSample"],
      message: "toSample must be > fromSample",
    }),
);
export type GapSpan = z.output<typeof GapSpan>;

/** Byte length of `sampleCount` spool samples. */
export function spoolBytes(sampleCount: number): number {
  return sampleCount * BYTES_PER_SAMPLE;
}
