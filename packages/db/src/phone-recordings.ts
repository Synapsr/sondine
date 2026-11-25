import type { Database } from "./database";
import { int, str, strOrNull } from "./rows";

// Recordings the iPhone app made (ADR 032). An import whose file carries the
// app's header keeps its episode `in_person`, so the rules that keep a file
// apart (forget, split and merge, zones) read where its audio came from: its
// track run's kind, `phone`, which imports have too.

/**
 * `<alias>` (an `episodes` row) holds audio from a track run of kind `phone`:
 * a phone recording, or a file imported before them (ADR 021).
 */
export const phoneHeldSql = (alias: string): string =>
  `EXISTS (SELECT 1 FROM episode_regions pher
     JOIN speech_regions phr ON phr.id = pher.speech_region_id
     JOIN track_runs pht ON pht.id = phr.track_run_id
     WHERE pher.episode_id = ${alias}.id AND pht.source_kind = 'phone')`;

/** `<alias>` (an `episodes` row) is a recording the iPhone app made: the phone mark. */
export const phoneRecordingSql = (alias: string): string =>
  `EXISTS (SELECT 1 FROM episode_regions prer
     JOIN speech_regions prr ON prr.id = prer.speech_region_id
     JOIN phone_recordings prp ON prp.track_run_id = prr.track_run_id
     WHERE prer.episode_id = ${alias}.id)`;

/** Whether an episode holds audio from a `phone` track run. */
export function isPhoneHeld(db: Database, episodeId: number): boolean {
  return (
    db
      .statement(`SELECT 1 AS hit FROM episodes e WHERE e.id = ? AND ${phoneHeldSql("e")}`)
      .get(episodeId) !== undefined
  );
}

/** The track key of a phone recording: its header's id. */
export const phoneTrackKey = (recordingId: string): string => `phone:${recordingId}`;

/** What this Mac already knows of a recording id. */
export type PhoneArrival =
  /** Never seen: import it. */
  | { readonly kind: "new" }
  /** Here with the same bytes: the same recording, not imported twice. */
  | { readonly kind: "duplicate"; readonly episodeId: number | null }
  /** Here with other bytes: refused, the phone keeps its file. */
  | { readonly kind: "conflict" }
  /** Deleted here: refused, so nothing deleted comes back. */
  | { readonly kind: "deleted" };

export function phoneArrival(
  db: Database,
  input: { readonly recordingId: string; readonly sha256: string },
): PhoneArrival {
  const row = db
    .statement("SELECT state, sha256, track_run_id FROM phone_recordings WHERE recording_id = ?")
    .get(input.recordingId);
  if (row === undefined) return { kind: "new" };
  if (str(row, "state") === "deleted") return { kind: "deleted" };
  if (row["sha256"] !== input.sha256) return { kind: "conflict" };
  const episode = db
    .statement(
      `SELECT er.episode_id FROM episode_regions er
       JOIN speech_regions r ON r.id = er.speech_region_id
       WHERE r.track_run_id = ? ORDER BY er.episode_id LIMIT 1`,
    )
    .get(int(row, "track_run_id"));
  return {
    kind: "duplicate",
    episodeId: episode === undefined ? null : int(episode, "episode_id"),
  };
}

/** A phone recording refused inside the transaction that would have published it. */
export class PhoneRecordingRefused extends Error {
  override readonly name = "PhoneRecordingRefused";
  readonly arrival: Exclude<PhoneArrival, { kind: "new" }>;
  constructor(arrival: Exclude<PhoneArrival, { kind: "new" }>) {
    super(`phone recording refused: ${arrival.kind}`);
    this.arrival = arrival;
  }
}

/**
 * Turns the phone recordings among `trackRunIds` into tombstones: the id, the
 * device and two times stay, so the same file is refused if it comes again;
 * its name goes.
 */
export function tombstonePhoneRecordings(
  db: Database,
  trackRunIds: readonly number[],
  nowMs: number,
): number {
  if (trackRunIds.length === 0) return 0;
  const result = db
    .statement(
      `UPDATE phone_recordings
       SET state = 'deleted', track_run_id = NULL, sha256 = NULL, name = NULL,
         name_typed_at_ms = NULL, deleted_at_ms = ?
       WHERE state = 'stored' AND track_run_id IN (SELECT value FROM json_each(?))`,
    )
    .run(nowMs, JSON.stringify(trackRunIds));
  return Number(result.changes);
}

/** What a phone's `rename` did (ADR 008, M5.3). */
export type PhoneRename =
  /** The name is the recording's now. */
  | "named"
  /** A name typed later is already there: this one is dropped. */
  | "superseded"
  /** The Mac does not hold the recording yet: the phone keeps the operation. */
  | "not-stored"
  /** Deleted here: the operation is dropped. */
  | "deleted";

/**
 * Names a stored phone recording, unless a name typed later is already
 * there (the phone's typing times; a tie goes to the last received). A name
 * of blanks only is no name.
 */
export function renamePhoneRecording(
  db: Database,
  input: { readonly recordingId: string; readonly name: string | null; readonly typedAtMs: number },
): PhoneRename {
  const trimmed = input.name?.trim() ?? "";
  const result = db
    .statement(
      `UPDATE phone_recordings SET name = ?, name_typed_at_ms = ?
       WHERE recording_id = ? AND state = 'stored'
         AND (name_typed_at_ms IS NULL OR name_typed_at_ms <= ?)`,
    )
    .run(trimmed === "" ? null : trimmed, input.typedAtMs, input.recordingId, input.typedAtMs);
  if (Number(result.changes) > 0) return "named";
  const row = db
    .statement("SELECT state FROM phone_recordings WHERE recording_id = ?")
    .get(input.recordingId);
  if (row === undefined) return "not-stored";
  return str(row, "state") === "deleted" ? "deleted" : "superseded";
}

/** A stored phone recording as its result names it; null when it is not stored. */
export interface StoredPhoneRecording {
  readonly deviceId: string;
  readonly name: string | null;
  readonly timeUncertain: boolean;
}

export function storedPhoneRecording(
  db: Database,
  recordingId: string,
): StoredPhoneRecording | null {
  const row = db
    .statement(
      `SELECT device_id, name, time_uncertain FROM phone_recordings
       WHERE recording_id = ? AND state = 'stored'`,
    )
    .get(recordingId);
  if (row === undefined) return null;
  return {
    deviceId: str(row, "device_id"),
    name: strOrNull(row, "name"),
    timeUncertain: int(row, "time_uncertain") === 1,
  };
}
