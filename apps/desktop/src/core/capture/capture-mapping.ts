import type { GapReason as DbGapReason, SpeechRegionEndReason } from "@sondine/db";
import type { GapSpan, RegionCloseEvent } from "@sondine/protocol";

// Protocol reasons (helper events and manifests) to database reasons, shared
// by the live importer and the spool reconciler so both place rows alike.

export const gapReasons: Record<GapSpan["reason"], DbGapReason> = {
  "ring-overflow": "ring_overflow",
  "disk-full": "disk_full",
  "write-error": "write_error",
  stall: "device_lost",
  "recovery-truncated": "recovery_truncated",
};

export const regionEndReasons: Record<
  RegionCloseEvent["closeReason"],
  Exclude<SpeechRegionEndReason, "deleted">
> = {
  silence: "silence",
  "max-duration": "max_length",
  "track-closed": "track_closed",
};
