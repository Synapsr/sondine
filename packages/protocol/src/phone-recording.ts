import * as z from "zod";
import { Uuid, WallMs } from "./primitives";
import { described, named } from "./registry";

// The header the iPhone app writes in each recording's comment tag, before
// the first sample (ADR 032). The Mac's import reads it with `afinfo -i`: a
// file that carries a valid one is a phone recording, whichever way it came.
// It names no person and no device, only random ids.

/** The value of the header's `sondine` field. */
export const PHONE_RECORDING_FORMAT = "phone-recording";
/** The header's version. A change to its fields bumps it; the Mac keeps reading older ones. */
export const PHONE_RECORDING_HEADER_VERSION = 1;
/** Longest header accepted, in bytes. */
export const MAX_PHONE_HEADER_BYTES = 4096;

export const PhoneInputKind = named(
  "PhoneInputKind",
  "The kind of microphone iOS routed: the phone's own, a wired headset, a Bluetooth one, or another (USB, CarPlay…).",
  z.enum(["built-in", "wired", "bluetooth", "other"]),
);

export const PhonePartEnd = named(
  "PhonePartEnd",
  "Why the session's previous file ended: an interruption (a call, another app's microphone), or the 3 hour rotation.",
  z.enum(["interruption", "rotation"]),
);

export const PhoneAppVersion = named(
  "PhoneAppVersion",
  "The app's version and build, as `0.1.0 (12)`.",
  z.string().regex(/^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4} \([0-9]{1,9}\)$/),
);

export const PhoneRecordingHeader = named(
  "PhoneRecordingHeader",
  "The header of one file the iPhone app recorded, in its comment tag.",
  z
    .strictObject({
      sondine: z.literal(PHONE_RECORDING_FORMAT),
      v: z.literal(PHONE_RECORDING_HEADER_VERSION),
      recordingId: described("This file's id; the Mac's track run is `phone:<recordingId>`.", Uuid),
      sessionId: described("The session the file belongs to: one tap on « Enregistrer ».", Uuid),
      part: described("This file's place in its session, from 1.", z.int().min(1).max(10_000)),
      startedWallMs: described(
        "The phone's wall clock at the file's first sample.",
        WallMs.clone(),
      ),
      utcOffsetMin: described(
        "The phone's UTC offset then, in minutes.",
        z.int().min(-840).max(840),
      ),
      deviceId: described("The app's random install id (not the phone's name).", Uuid),
      input: PhoneInputKind,
      previous: PhonePartEnd.nullable(),
      app: PhoneAppVersion,
    })
    .superRefine((header, context) => {
      // The first file of a session follows nothing; every later one says why the previous ended.
      if ((header.part === 1) !== (header.previous === null)) {
        context.addIssue({
          code: "custom",
          path: ["previous"],
          message: "`previous` is null exactly for part 1",
        });
      }
    }),
);
export type PhoneRecordingHeader = z.output<typeof PhoneRecordingHeader>;

/**
 * Reads a header from the comment tag's text: the header, or null when the
 * text is not one (absent, not JSON, another app's comment, a newer version).
 */
export function parsePhoneRecordingHeader(text: string | null): PhoneRecordingHeader | null {
  if (text === null || new TextEncoder().encode(text).length > MAX_PHONE_HEADER_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = PhoneRecordingHeader.safeParse(value);
  return parsed.success ? parsed.data : null;
}
