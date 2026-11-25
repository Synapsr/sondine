import type { Database } from "./database";
import { int, intOrNull, str, type Row } from "./rows";
import type { PhoneOperationKind, PhonePath } from "./schema/enums";

// The phones paired with this Mac and what they send (ADR 008): their rows
// (a credential's SHA-256, never the credential), the operations of their
// outbox already done, the recordings on their way in, and each recording's
// state as a phone reads it, derived at read from the database.

export interface PhoneDevice {
  readonly deviceId: string;
  readonly name: string;
  readonly pairedAtMs: number;
  readonly lastContactAtMs: number | null;
  /** The path of its last request (M5.5); null before one. */
  readonly lastVia: PhonePath | null;
  readonly revokedAtMs: number | null;
  readonly uploads: number;
  readonly reads: number;
  readonly deletions: number;
  /** The sync version its last `hello` spoke (ADR 039). */
  readonly syncVersion: number;
}

const deviceOf = (row: Row): PhoneDevice => ({
  deviceId: str(row, "device_id"),
  name: str(row, "name"),
  pairedAtMs: int(row, "paired_at_ms"),
  lastContactAtMs: intOrNull(row, "last_contact_at_ms"),
  lastVia: pathOf(row["last_via"]),
  revokedAtMs: intOrNull(row, "revoked_at_ms"),
  uploads: int(row, "uploads"),
  reads: int(row, "reads"),
  deletions: int(row, "deletions"),
  syncVersion: int(row, "sync_version"),
});

const pathOf = (value: unknown): PhonePath | null =>
  value === "lan" || value === "tailnet" || value === "loopback" ? value : null;

const DEVICE_COLUMNS = `device_id, name, paired_at_ms, last_contact_at_ms, last_via, revoked_at_ms,
  uploads, reads, deletions, sync_version`;

/**
 * Pairs a phone: a device id that pairs again replaces its row (a new
 * credential, its name, its counts from zero), so an answer lost on the way
 * costs nothing but a new QR. Its done operations stay, a retry still does
 * nothing twice.
 */
export function pairPhoneDevice(
  db: Database,
  input: {
    readonly deviceId: string;
    readonly name: string;
    readonly credentialHash: Uint8Array;
    readonly nowMs: number;
  },
): void {
  db.statement(
    `INSERT INTO phone_devices (device_id, name, credential_hash, paired_at_ms)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (device_id) DO UPDATE SET name = excluded.name,
       credential_hash = excluded.credential_hash, paired_at_ms = excluded.paired_at_ms,
       last_contact_at_ms = NULL, last_via = NULL, revoked_at_ms = NULL, uploads = 0, reads = 0, deletions = 0`,
  ).run(input.deviceId, input.name, input.credentialHash, input.nowMs);
}

/** The phone a credential's SHA-256 names, revoked or not; null for none. */
export function phoneDeviceByCredential(
  db: Database,
  credentialHash: Uint8Array,
): PhoneDevice | null {
  const row = db
    .statement(`SELECT ${DEVICE_COLUMNS} FROM phone_devices WHERE credential_hash = ?`)
    .get(credentialHash);
  return row === undefined ? null : deviceOf(row);
}

export function phoneDevice(db: Database, deviceId: string): PhoneDevice | null {
  const row = db
    .statement(`SELECT ${DEVICE_COLUMNS} FROM phone_devices WHERE device_id = ?`)
    .get(deviceId);
  return row === undefined ? null : deviceOf(row);
}

/** Every phone, the paired ones first, newest pairing first. */
export function listPhoneDevices(db: Database): PhoneDevice[] {
  return db
    .statement(
      `SELECT ${DEVICE_COLUMNS} FROM phone_devices
       ORDER BY revoked_at_ms IS NOT NULL, paired_at_ms DESC, device_id`,
    )
    .all()
    .map(deviceOf);
}

/** How many phones are paired and not revoked. */
export function pairedPhoneCount(db: Database): number {
  return int(
    db.statement("SELECT count(*) AS n FROM phone_devices WHERE revoked_at_ms IS NULL").get() ?? {},
    "n",
  );
}

export type PhoneCount = "uploads" | "reads" | "deletions";

const COUNTED: Record<PhoneCount, string> = {
  uploads: ", uploads = uploads + 1",
  reads: ", reads = reads + 1",
  deletions: ", deletions = deletions + 1",
};

/**
 * Records a phone's contact, the path it came by when known (the relay's
 * `via`; the last request's wins), and counts what it did.
 */
export function touchPhoneDevice(
  db: Database,
  deviceId: string,
  nowMs: number,
  count?: PhoneCount,
  via?: PhonePath,
): void {
  const counted = count === undefined ? "" : COUNTED[count];
  db.statement(
    `UPDATE phone_devices SET last_contact_at_ms = max(coalesce(last_contact_at_ms, 0), ?),
       last_via = coalesce(?, last_via)${counted}
     WHERE device_id = ?`,
  ).run(nowMs, via ?? null, deviceId);
}

/** Revokes one phone; false when it was not paired (unknown, or revoked already). */
export function revokePhoneDevice(db: Database, deviceId: string, nowMs: number): boolean {
  const result = db
    .statement(
      "UPDATE phone_devices SET revoked_at_ms = ? WHERE device_id = ? AND revoked_at_ms IS NULL",
    )
    .run(nowMs, deviceId);
  return Number(result.changes) > 0;
}

/** Revokes every phone (« Réinitialiser l'appairage »); the ids revoked now. */
export function revokeAllPhoneDevices(db: Database, nowMs: number): string[] {
  return db
    .statement(
      "UPDATE phone_devices SET revoked_at_ms = ? WHERE revoked_at_ms IS NULL RETURNING device_id",
    )
    .all(nowMs)
    .map((row) => str(row, "device_id"));
}

// Operations of a phone's outbox

/** Whether this phone's operation was done already. */
export function phoneOperationDone(db: Database, deviceId: string, operationId: string): boolean {
  return (
    db
      .statement("SELECT 1 AS hit FROM phone_operations WHERE device_id = ? AND operation_id = ?")
      .get(deviceId, operationId) !== undefined
  );
}

/** Remembers a done operation; false when it was remembered already. */
export function recordPhoneOperation(
  db: Database,
  input: {
    readonly deviceId: string;
    readonly operationId: string;
    readonly kind: PhoneOperationKind;
    readonly recordingId: string;
    readonly nowMs: number;
  },
): boolean {
  const result = db
    .statement(
      `INSERT INTO phone_operations (device_id, operation_id, kind, recording_id, done_at_ms)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    )
    .run(input.deviceId, input.operationId, input.kind, input.recordingId, input.nowMs);
  return Number(result.changes) > 0;
}

// Recordings

/** Which phone a recording id belongs to, as far as this Mac knows: received, deleted or on its way. */
export function phoneRecordingOwner(db: Database, recordingId: string): string | null {
  const row =
    db
      .statement("SELECT device_id FROM phone_recordings WHERE recording_id = ?")
      .get(recordingId) ??
    db.statement("SELECT device_id FROM phone_uploads WHERE recording_id = ?").get(recordingId);
  return row === undefined ? null : str(row, "device_id");
}

/** The episode holding a stored phone recording; null when it is not stored. */
export function phoneRecordingEpisode(db: Database, recordingId: string): number | null {
  const row = db
    .statement(
      `SELECT er.episode_id FROM phone_recordings p
       JOIN speech_regions r ON r.track_run_id = p.track_run_id
       JOIN episode_regions er ON er.speech_region_id = r.id
       WHERE p.recording_id = ? AND p.state = 'stored'
       ORDER BY er.episode_id LIMIT 1`,
    )
    .get(recordingId);
  return row === undefined ? null : int(row, "episode_id");
}

/**
 * Leaves a tombstone for a recording id deleted on its phone before this Mac
 * received it, so the file is refused if it comes later (by sync or by
 * AirDrop). False when the id is known already.
 */
export function tombstoneUnreceivedPhoneRecording(
  db: Database,
  input: { readonly recordingId: string; readonly deviceId: string; readonly nowMs: number },
): boolean {
  const result = db
    .statement(
      `INSERT INTO phone_recordings (recording_id, device_id, state, received_at_ms, deleted_at_ms)
       VALUES (?, ?, 'deleted', ?, ?) ON CONFLICT DO NOTHING`,
    )
    .run(input.recordingId, input.deviceId, input.nowMs, input.nowMs);
  return Number(result.changes) > 0;
}

/**
 * Turns a stored phone recording that no episode holds into a tombstone
 * (none should exist: deleting its episode does it). False when it was not stored.
 */
export function tombstoneStoredPhoneRecording(
  db: Database,
  recordingId: string,
  nowMs: number,
): boolean {
  const result = db
    .statement(
      `UPDATE phone_recordings
       SET state = 'deleted', track_run_id = NULL, sha256 = NULL, name = NULL,
         name_typed_at_ms = NULL, deleted_at_ms = ?
       WHERE recording_id = ? AND state = 'stored'`,
    )
    .run(nowMs, recordingId);
  return Number(result.changes) > 0;
}

// The inbox

export interface PhoneUpload {
  readonly recordingId: string;
  readonly deviceId: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly announcedAtMs: number;
}

const uploadOf = (row: Row): PhoneUpload => ({
  recordingId: str(row, "recording_id"),
  deviceId: str(row, "device_id"),
  bytes: int(row, "bytes"),
  sha256: str(row, "sha256"),
  announcedAtMs: int(row, "announced_at_ms"),
});

export function phoneUpload(db: Database, recordingId: string): PhoneUpload | null {
  const row = db
    .statement(
      "SELECT recording_id, device_id, bytes, sha256, announced_at_ms FROM phone_uploads WHERE recording_id = ?",
    )
    .get(recordingId);
  return row === undefined ? null : uploadOf(row);
}

export function listPhoneUploads(db: Database): PhoneUpload[] {
  return db
    .statement(
      "SELECT recording_id, device_id, bytes, sha256, announced_at_ms FROM phone_uploads ORDER BY recording_id",
    )
    .all()
    .map(uploadOf);
}

/** Starts (or starts again) a recording's upload with what the phone announced. */
export function putPhoneUpload(db: Database, upload: PhoneUpload): void {
  db.statement(
    `INSERT INTO phone_uploads (recording_id, device_id, bytes, sha256, announced_at_ms)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (recording_id) DO UPDATE SET device_id = excluded.device_id,
       bytes = excluded.bytes, sha256 = excluded.sha256, announced_at_ms = excluded.announced_at_ms`,
  ).run(upload.recordingId, upload.deviceId, upload.bytes, upload.sha256, upload.announcedAtMs);
}

export function removePhoneUpload(db: Database, recordingId: string): void {
  db.statement("DELETE FROM phone_uploads WHERE recording_id = ?").run(recordingId);
}

/** What the inbox holds or expects in all, but for one recording: its announced lengths. */
export function phoneInboxBytes(db: Database, exceptRecordingId: string): number {
  return int(
    db
      .statement("SELECT coalesce(sum(bytes), 0) AS n FROM phone_uploads WHERE recording_id <> ?")
      .get(exceptRecordingId) ?? {},
    "n",
  );
}

// States

/** A recording's state as its phone reads it (ADR 008). */
export type PhoneRecordingReading =
  | "unknown"
  | "receiving"
  | "waiting"
  | "transcribing"
  | "ready"
  | "deleted";

/**
 * The state of each id for the phone `deviceId`, derived from the database:
 * deleted (a tombstone), its episode's analysis (stored), receiving (in the
 * inbox), or unknown. An id another phone made reads unknown.
 */
export function phoneRecordingReadings(
  db: Database,
  deviceId: string,
  recordingIds: readonly string[],
): PhoneRecordingReading[] {
  const stored = db.statement(
    `SELECT p.state, (
       SELECT e.analysis_state FROM speech_regions r
       JOIN episode_regions er ON er.speech_region_id = r.id
       JOIN episodes e ON e.id = er.episode_id
       WHERE r.track_run_id = p.track_run_id ORDER BY e.id LIMIT 1
     ) AS analysis_state
     FROM phone_recordings p WHERE p.recording_id = ? AND p.device_id = ?`,
  );
  const inbox = db.statement(
    "SELECT 1 AS hit FROM phone_uploads WHERE recording_id = ? AND device_id = ?",
  );
  return recordingIds.map((recordingId): PhoneRecordingReading => {
    const row = stored.get(recordingId, deviceId);
    if (row !== undefined) {
      if (str(row, "state") === "deleted") return "deleted";
      switch (row["analysis_state"]) {
        case "complete":
          return "ready";
        case "running":
          return "transcribing";
        default:
          // Pending, queued, stale (again), failed (retried when asked).
          return "waiting";
      }
    }
    return inbox.get(recordingId, deviceId) === undefined ? "unknown" : "receiving";
  });
}

// Settings ▸ Téléphone

/** What the Mac keeps for phone sync, besides the phones. */
export interface PhoneSyncSettings {
  /** « Synchronisation avec l'iPhone »; off by default. */
  readonly enabled: boolean;
  /** « Autoriser par Tailscale »; off by default (ADR 008). */
  readonly tailnet: boolean;
  /** The relay's port, chosen at the first pairing and kept; null before. */
  readonly port: number | null;
  /** « Sondine » and four random characters, the Bonjour name; null before the first pairing. */
  readonly serviceName: string | null;
  /** This Mac's id, as phones know it; null before the first pairing. */
  readonly macId: string | null;
}

const PHONE_SETTING_KEYS = {
  enabled: "phone.enabled",
  tailnet: "phone.tailnet",
  port: "phone.port",
  serviceName: "phone.serviceName",
  macId: "phone.macId",
} as const satisfies Record<keyof PhoneSyncSettings, string>;

export function phoneSyncSettings(db: Database): PhoneSyncSettings {
  const read = (key: string): unknown => {
    const row = db.statement("SELECT value FROM settings WHERE key = ?").get(key);
    return row === undefined ? undefined : JSON.parse(str(row, "value"));
  };
  const port = read(PHONE_SETTING_KEYS.port);
  const serviceName = read(PHONE_SETTING_KEYS.serviceName);
  const macId = read(PHONE_SETTING_KEYS.macId);
  return {
    enabled: read(PHONE_SETTING_KEYS.enabled) === true,
    tailnet: read(PHONE_SETTING_KEYS.tailnet) === true,
    port:
      typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65_536 ? port : null,
    serviceName: typeof serviceName === "string" ? serviceName : null,
    macId: typeof macId === "string" ? macId : null,
  };
}

/** Changes some of the phone sync settings. */
export function setPhoneSyncSettings(
  db: Database,
  changes: Partial<PhoneSyncSettings>,
  nowMs: number,
): void {
  const write = db.statement(
    `INSERT INTO settings (key, value, updated_at_ms) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms`,
  );
  const entries: readonly (readonly [string, unknown])[] = [
    [PHONE_SETTING_KEYS.enabled, changes.enabled],
    [PHONE_SETTING_KEYS.tailnet, changes.tailnet],
    [PHONE_SETTING_KEYS.port, changes.port],
    [PHONE_SETTING_KEYS.serviceName, changes.serviceName],
    [PHONE_SETTING_KEYS.macId, changes.macId],
  ];
  for (const [key, value] of entries) {
    if (value !== undefined) write.run(key, JSON.stringify(value), nowMs);
  }
}

/** The sync version a phone's `hello` spoke: what the Mac answers it in from then on (ADR 039). */
export function setPhoneSyncVersion(db: Database, deviceId: string, version: number): void {
  db.statement("UPDATE phone_devices SET sync_version = ? WHERE device_id = ?").run(
    version,
    deviceId,
  );
}
