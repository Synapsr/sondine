import * as z from "zod";
import { PROTOCOL_VERSION } from "./constants";
import {
  BundleId,
  DeviceUid,
  NetworkHash,
  PauseScope,
  Pid,
  Probability,
  RequestId,
  ShortText,
  Transport,
  Uuid,
  VersionText,
} from "./primitives";
import { described, named } from "./registry";
import { checkUnique } from "./shapes";

const MAX_APP_TAPS = 8;

const durationMs = (description: string) => described(description, z.int().min(0).max(3_600_000));

export const HelloMessage = named(
  "HelloMessage",
  "First line on every connection. Reply: `ready`, or `error` with code `protocol.unsupported` before the helper closes the connection.",
  z.strictObject({
    type: z.literal("hello"),
    id: RequestId,
    protocol: z.literal(PROTOCOL_VERSION),
    client: z.strictObject({ name: ShortText, version: VersionText }),
  }),
);
export type HelloMessage = z.output<typeof HelloMessage>;

const MINUTES_PER_DAY = 1_440;

export const ScheduleWindow = named(
  "ScheduleWindow",
  "Hours when capture is held, on the Mac's clock and time zone. A window whose end is at or before its start crosses midnight and belongs to its start day; equal start and end are invalid.",
  z
    .strictObject({
      days: described(
        "Days the window starts on: 0 is Sunday … 6 Saturday; unique.",
        z.array(z.int().min(0).max(6)).min(1).max(7),
      ),
      startMinute: described(
        "Minute of the day it starts at.",
        z
          .int()
          .min(0)
          .max(MINUTES_PER_DAY - 1),
      ),
      endMinute: described(
        "Minute of the day it ends at (1440 is midnight after its start day).",
        z.int().min(0).max(MINUTES_PER_DAY),
      ),
    })
    .superRefine((window, ctx) => {
      checkUnique(window.days, (day) => day, ["days"], ctx);
      if (window.endMinute === window.startMinute) {
        ctx.addIssue({
          code: "custom",
          path: ["endMinute"],
          message: "a window ends at another minute than it starts",
        });
      }
    }),
);
export type ScheduleWindow = z.output<typeof ScheduleWindow>;

export const NetworkKey = named(
  "NetworkKey",
  "Base64 of the 32 random bytes core keeps per install to hash networks, or empty: the helper then reads no network.",
  z.string().regex(/^(?:[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=)?$/),
);

export const CaptureHolds = named(
  "CaptureHolds",
  "Private zones at « Rien » the helper enforces itself (ADR 029): while one applies, capture is held. Excluded apps in `excludedBundleIds` also hold the microphone while they are in a call or listen, and 10 s after.",
  z
    .strictObject({
      calls: described(
        "Hold everything while any call is active (call app, call daemon, web call), and 10 s after.",
        z.boolean(),
      ),
      screen: described(
        "Hold everything while the screen is locked, the screen saver runs or the displays sleep.",
        z.boolean(),
      ),
      schedule: z.array(ScheduleWindow).max(32),
      networks: described(
        "Hold everything while the Mac is on one of these networks.",
        z.array(NetworkHash).max(64),
      ),
      networkKey: NetworkKey,
      lifted: described(
        "Hold occurrences the user lifted (« Écouter quand même »): they hold nothing until they end.",
        z.array(Uuid).max(64),
      ),
    })
    .superRefine((holds, ctx) => {
      checkUnique(holds.networks, (hash) => hash, ["networks"], ctx);
      checkUnique(holds.lifted, (id) => id, ["lifted"], ctx);
      if (holds.networkKey === "" && holds.networks.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["networks"],
          message: "network hashes need the key they were made with",
        });
      }
    }),
);
export type CaptureHolds = z.output<typeof CaptureHolds>;

export const ConfigMessage = named(
  "ConfigMessage",
  "The full capture policy; it replaces the previous one. Reply: `ack` once applied, or `error`.",
  z
    .strictObject({
      type: z.literal("config"),
      id: RequestId,
      microphone: z.strictObject({
        enabled: z.boolean(),
        followCalls: described(
          "Open the device a call app is verifiably using, even Bluetooth, while the call lasts.",
          z.boolean(),
        ),
        allowedTransports: described(
          "Transports the automatic mode may open as the default input.",
          z.array(Transport).max(16),
        ),
      }),
      systemAudio: z.strictObject({
        enabled: z.boolean(),
        appTaps: z.strictObject({
          enabled: z.boolean(),
          max: z.int().min(0).max(MAX_APP_TAPS),
          releaseAfterIdleMs: durationMs("Release an app tap after this long without output IO."),
          releaseAfterSilenceMs: durationMs(
            "Release an app tap after this long of exact digital silence.",
          ),
        }),
      }),
      excludedBundleIds: described(
        "Apps never captured on any track; while one is in a call or listens to a microphone, and 10 s after, the microphone is held too.",
        z.array(BundleId).max(1024),
      ),
      holds: CaptureHolds,
      vad: z.strictObject({
        threshold: Probability,
        minSpeechMs: durationMs("Shortest speech that opens a region."),
        minSilenceMs: durationMs("Silence that closes a region."),
      }),
      healthIntervalMs: described(
        "Interval between `health` events.",
        z.int().min(1_000).max(3_600_000),
      ),
    })
    .superRefine((config, ctx) => {
      checkUnique(
        config.microphone.allowedTransports,
        (transport) => transport,
        ["microphone", "allowedTransports"],
        ctx,
      );
      checkUnique(config.excludedBundleIds, (bundleId) => bundleId, ["excludedBundleIds"], ctx);
    }),
);
export type ConfigMessage = z.output<typeof ConfigMessage>;

export const ExcludePidsMessage = named(
  "ExcludePidsMessage",
  "The complete set of Sondine's own process ids (main, renderer, GPU and audio services), excluded from every tap. Reply: `ack` or `error`.",
  z
    .strictObject({
      type: z.literal("exclude.pids"),
      id: RequestId,
      pids: z.array(Pid).max(1024),
    })
    .superRefine((message, ctx) => {
      checkUnique(message.pids, (pid) => pid, ["pids"], ctx);
    }),
);
export type ExcludePidsMessage = z.output<typeof ExcludePidsMessage>;

export const PinInputMessage = named(
  "PinInputMessage",
  "Pins a microphone as a hard override, or returns to automatic mode with `deviceUid: null`. Reply: `ack`, or `error` with code `request.rejected` for an unknown device.",
  z.strictObject({
    type: z.literal("pin.input"),
    id: RequestId,
    deviceUid: DeviceUid.nullable(),
    allowBluetooth: described(
      "Explicit consent to open a Bluetooth microphone, which drops the headset to call quality.",
      z.boolean(),
    ),
  }),
);
export type PinInputMessage = z.output<typeof PinInputMessage>;

export const PauseMessage = named(
  "PauseMessage",
  "Stops capture for a scope. Reply: `ack` once IO is stopped or muted and the affected runs are closed.",
  z.strictObject({ type: z.literal("pause"), id: RequestId, scope: PauseScope }),
);
export type PauseMessage = z.output<typeof PauseMessage>;

export const ResumeMessage = named(
  "ResumeMessage",
  "Resumes capture for a scope. Reply: `ack` or `error`.",
  z.strictObject({ type: z.literal("resume"), id: RequestId, scope: PauseScope }),
);
export type ResumeMessage = z.output<typeof ResumeMessage>;

export const SnapshotMessage = named(
  "SnapshotMessage",
  "Asks for the current state. Reply: `permissions`, `devices`, `processes`, `activity`, one `track.open` per open run, one `region.open` per open region, `clock`, one `call` or `listen` per active span, `situation` and `holds`, each with `replyTo`, then `ack`.",
  z.strictObject({ type: z.literal("snapshot"), id: RequestId }),
);
export type SnapshotMessage = z.output<typeof SnapshotMessage>;

export const RequestPermissionsMessage = named(
  "RequestPermissionsMessage",
  "Asks macOS for capture access for a scope: the microphone prompt, then a short system-audio probe tap for `system-audio` or `all`. Reply: `permissions` with `replyTo` once the prompts are answered, then `ack`.",
  z.strictObject({ type: z.literal("request.permissions"), id: RequestId, scope: PauseScope }),
);
export type RequestPermissionsMessage = z.output<typeof RequestPermissionsMessage>;

export const ShutdownMessage = named(
  "ShutdownMessage",
  "Asks the helper to commit, close every run, and exit. Reply: `ack` after the last commit, then the helper closes the socket.",
  z.strictObject({ type: z.literal("shutdown"), id: RequestId }),
);
export type ShutdownMessage = z.output<typeof ShutdownMessage>;

/** Every message core sends to `sondine-audio`, discriminated on `type`. */
export const ControlMessage = z.discriminatedUnion("type", [
  HelloMessage,
  ConfigMessage,
  ExcludePidsMessage,
  PinInputMessage,
  PauseMessage,
  ResumeMessage,
  SnapshotMessage,
  RequestPermissionsMessage,
  ShutdownMessage,
]);
export type ControlMessage = z.output<typeof ControlMessage>;
export type ControlMessageWire = z.input<typeof ControlMessage>;
export type ControlMessageType = ControlMessage["type"];

export const CONTROL_MESSAGE_TYPES: readonly ControlMessageType[] = ControlMessage.options.map(
  (option) => option.shape.type.value,
);
