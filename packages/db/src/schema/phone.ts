import { sql } from "drizzle-orm";
import {
  blob,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { trackRuns } from "./capture";
import { oneOf } from "./check";
import { phoneOperationKinds, phonePaths, phoneRecordingStates } from "./enums";

/**
 * Each recording the iPhone app made that reached this Mac (ADR 032,
 * ADR 008), by the id in its header: the same file twice is one recording,
 * the same id with other bytes is refused, and a deleted one stays as a
 * tombstone (its id, its device, two times; no audio, no text, no hash) so
 * it never comes back. Its name goes with its text.
 */
export const phoneRecordings = sqliteTable(
  "phone_recordings",
  {
    /** The header's `recordingId`; the track run's key is `phone:<recordingId>`. */
    recordingId: text("recording_id").primaryKey(),
    /** The app's random install id, from the header. */
    deviceId: text("device_id").notNull(),
    state: text("state", { enum: phoneRecordingStates }).notNull().default("stored"),
    /** The recording's run while it is stored; null once deleted. */
    trackRunId: integer("track_run_id").references(() => trackRuns.id),
    /** SHA-256 of the file's bytes as received (hex), while stored. */
    sha256: text("sha256"),
    /**
     * The header's time was not plausible (after the Mac received it, or
     * before 2025): the recording ends when it arrived, « heure incertaine ».
     */
    timeUncertain: integer("time_uncertain", { mode: "boolean" }).notNull().default(false),
    /**
     * The name the user typed on the phone (M5.3), while stored; null shows
     * its hour. Of two names, the later one typed wins: `nameTypedAtMs` is
     * the phone's time of typing it.
     */
    name: text("name"),
    nameTypedAtMs: integer("name_typed_at_ms"),
    receivedAtMs: integer("received_at_ms").notNull(),
    deletedAtMs: integer("deleted_at_ms"),
  },
  (t) => [
    uniqueIndex("phone_recordings_track_run_idx").on(t.trackRunId),
    check("phone_recordings_state_check", oneOf(t.state, phoneRecordingStates)),
    check(
      "phone_recordings_tombstone_check",
      sql`(${t.state} = 'stored' and ${t.trackRunId} is not null and ${t.sha256} is not null and ${t.deletedAtMs} is null)
        or (${t.state} = 'deleted' and ${t.trackRunId} is null and ${t.sha256} is null and ${t.deletedAtMs} is not null
          and ${t.name} is null and ${t.nameTypedAtMs} is null)`,
    ),
    check(
      "phone_recordings_name_check",
      sql`${t.name} is null or length(${t.name}) between 1 and 200`,
    ),
  ],
);

/**
 * The phones paired with this Mac (ADR 008), by the device id each made for
 * itself. Only the SHA-256 of a credential is kept. A revoked phone stays,
 * so its credential answers `revoked`; a device id that pairs again
 * replaces its row. Counts say what a phone did, never the words.
 */
export const phoneDevices = sqliteTable(
  "phone_devices",
  {
    deviceId: text("device_id").primaryKey(),
    /** The name the user gave the phone, as it sent it at pairing. */
    name: text("name").notNull(),
    credentialHash: blob("credential_hash", { mode: "buffer" }).notNull(),
    pairedAtMs: integer("paired_at_ms").notNull(),
    lastContactAtMs: integer("last_contact_at_ms"),
    /** The path of its last request (M5.5): at home, through Tailscale, or loopback in development. */
    lastVia: text("last_via", { enum: phonePaths }),
    revokedAtMs: integer("revoked_at_ms"),
    /** Recordings it sent that the Mac stored. */
    uploads: integer("uploads").notNull().default(0),
    /** Reads it made (states, and from M5.3 results and the Mac's memory). */
    reads: integer("reads").notNull().default(0),
    /** Recordings it deleted. */
    deletions: integer("deletions").notNull().default(0),
    /** The sync version its last `hello` spoke (ADR 039): results carry tags from 2. */
    syncVersion: integer("sync_version").notNull().default(1),
  },
  (t) => [
    uniqueIndex("phone_devices_credential_unique").on(t.credentialHash),
    check("phone_devices_name_check", sql`length(${t.name}) between 1 and 64`),
    check("phone_devices_credential_check", sql`length(${t.credentialHash}) = 32`),
    check("phone_devices_last_via_check", oneOf(t.lastVia, phonePaths)),
    check(
      "phone_devices_counts_check",
      sql`${t.uploads} >= 0 and ${t.reads} >= 0 and ${t.deletions} >= 0`,
    ),
  ],
);

/**
 * The operations of a phone's outbox the Mac has done, by the id the phone
 * gave each, so a retry does nothing twice. Kept while the phone's row is.
 */
export const phoneOperations = sqliteTable(
  "phone_operations",
  {
    deviceId: text("device_id")
      .notNull()
      .references(() => phoneDevices.deviceId, { onDelete: "cascade" }),
    operationId: text("operation_id").notNull(),
    kind: text("kind", { enum: phoneOperationKinds }).notNull(),
    recordingId: text("recording_id").notNull(),
    doneAtMs: integer("done_at_ms").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.deviceId, t.operationId] }),
    check("phone_operations_kind_check", oneOf(t.kind, phoneOperationKinds)),
  ],
);

/**
 * Recordings on their way in from a phone (ADR 008): what the phone
 * announced (length and SHA-256), its bytes in `phone-inbox/<id>.part`.
 * The row goes when the recording is stored, deleted, refused for good, or
 * left untouched for 7 days.
 */
export const phoneUploads = sqliteTable(
  "phone_uploads",
  {
    recordingId: text("recording_id").primaryKey(),
    deviceId: text("device_id").notNull(),
    bytes: integer("bytes").notNull(),
    sha256: text("sha256").notNull(),
    announcedAtMs: integer("announced_at_ms").notNull(),
  },
  (t) => [
    index("phone_uploads_device_idx").on(t.deviceId),
    check("phone_uploads_bytes_check", sql`${t.bytes} > 0`),
    check("phone_uploads_sha_check", sql`length(${t.sha256}) = 64`),
  ],
);
