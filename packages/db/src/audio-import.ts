import { decideSize, GROUPING_VERSION, kindInputsOf, SIZE_TABLE_VERSION } from "@sondine/core";
import { transaction, type Database } from "./database";
import { analysisPriorities, enqueueAnalysisJob } from "./jobs";
import { phoneArrival, PhoneRecordingRefused, phoneTrackKey } from "./phone-recordings";
import { int } from "./rows";

// An audio file the user imported (ADR 021): already decoded by core to
// 16 kHz mono PCM in the archive, it becomes one closed track run of kind
// `phone` (a recording made away from this Mac's capture), its audio as
// archived chunks, one speech region over the whole file, and one closed
// episode of context `imported` holding it, queued for transcription as a
// user request. No grouping ever sees it.
//
// A file that carries the iPhone app's header is a phone recording instead
// (ADR 032): the same rows, but its run's key is `phone:<recordingId>`, its
// episode is `in_person` (Today, the journal, voices), and `phone_recordings`
// remembers its id, so the same file is one recording, other bytes under
// that id are refused, and a deleted one never comes back. Those three are
// checked again here, inside the transaction that publishes it.

/** What the iPhone app's header says of a file, and what the Mac made of it. */
export interface PhoneOrigin {
  readonly recordingId: string;
  readonly deviceId: string;
  /** SHA-256 of the file as received, hex. */
  readonly sha256: string;
  /** The header's time was not plausible: the recording ends when it arrived. */
  readonly timeUncertain: boolean;
}

/** One block of the archive file, as written: 2 s, with its CRC. */
export interface ImportedChunk {
  readonly sampleStart: number;
  readonly sampleCount: number;
  readonly byteOffset: number;
  readonly crc32: number;
}

export interface ImportRecordingInput {
  /** The track run's id, also in its track key and paths. */
  readonly uid: string;
  /** The file's name, the episode's label. */
  readonly fileName: string;
  readonly sampleRate: number;
  readonly sampleCount: number;
  /** When the recording started, as far as the file tells. */
  readonly startedWallMs: number;
  /** The archive file, and the spool path it mirrors (archive recovery keeps a file a spool row names). */
  readonly archiveRelPath: string;
  readonly spoolRelPath: string;
  readonly chunks: readonly ImportedChunk[];
  readonly nowMs: number;
  /** Set when the file carries the iPhone app's header. */
  readonly phone?: PhoneOrigin;
}

/** The track key of an imported recording. */
export const importTrackKey = (uid: string): string => `phone:${uid}`;

export function importRecording(
  db: Database,
  input: ImportRecordingInput,
): { readonly episodeId: number; readonly trackRunId: number } {
  const covered = input.chunks.reduce((sum, chunk) => sum + chunk.sampleCount, 0);
  if (input.sampleCount <= 0 || covered !== input.sampleCount) {
    throw new RangeError("the chunks must cover the recording exactly");
  }
  const durationMs = Math.round((input.sampleCount * 1000) / input.sampleRate);
  const endedWallMs = input.startedWallMs + durationMs;
  const wallAt = (sample: number) =>
    input.startedWallMs + Math.round((sample * 1000) / input.sampleRate);
  const phone = input.phone;
  const context = phone === undefined ? "imported" : "in_person";
  return transaction(db, () => {
    if (phone !== undefined) {
      // Checked again here: another import may have published it meanwhile.
      const arrival = phoneArrival(db, phone);
      if (arrival.kind !== "new") throw new PhoneRecordingRefused(arrival);
    }
    const trackRunId = int(
      db
        .statement(
          `INSERT INTO track_runs (uid, track_key, source_kind, sample_rate, state, end_reason,
             started_wall_ms, ended_wall_ms, sample_end, updated_at_ms)
           VALUES (?, ?, 'phone', ?, 'closed', 'stopped', ?, ?, ?, ?) RETURNING id`,
        )
        .get(
          input.uid,
          phone === undefined ? importTrackKey(input.uid) : phoneTrackKey(phone.recordingId),
          input.sampleRate,
          input.startedWallMs,
          endedWallMs,
          input.sampleCount,
          input.nowMs,
        ) ?? {},
      "id",
    );
    const spoolFileId = int(
      db
        .statement(
          `INSERT INTO spool_files (track_run_id, seq, rel_path, sample_start, committed_bytes,
             state, created_wall_ms, closed_wall_ms)
           VALUES (?, 1, ?, 0, ?, 'expired', ?, ?) RETURNING id`,
        )
        .get(trackRunId, input.spoolRelPath, input.sampleCount * 2, input.nowMs, input.nowMs) ?? {},
      "id",
    );
    const chunk = db.statement(
      `INSERT INTO chunks (spool_file_id, track_run_id, byte_offset, byte_length, sample_start,
         sample_count, wall_ms, crc32, audio_state, archive_rel_path, archive_byte_offset)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'archived', ?, ?)`,
    );
    for (const block of input.chunks) {
      chunk.run(
        spoolFileId,
        trackRunId,
        block.byteOffset,
        block.sampleCount * 2,
        block.sampleStart,
        block.sampleCount,
        wallAt(block.sampleStart),
        block.crc32,
        input.archiveRelPath,
        block.byteOffset,
      );
    }
    const regionId = int(
      db
        .statement(
          `INSERT INTO speech_regions (track_run_id, sample_start, sample_end, wall_start_ms,
             wall_end_ms, state, end_reason, vad_version)
           VALUES (?, 0, ?, ?, ?, 'closed', 'track_closed', 'import') RETURNING id`,
        )
        .get(trackRunId, input.sampleCount, input.startedWallMs, endedWallMs) ?? {},
      "id",
    );
    if (phone !== undefined) {
      db.statement(
        `INSERT INTO phone_recordings (recording_id, device_id, state, track_run_id, sha256,
           time_uncertain, received_at_ms)
         VALUES (?, ?, 'stored', ?, ?, ?, ?)`,
      ).run(
        phone.recordingId,
        phone.deviceId,
        trackRunId,
        phone.sha256,
        phone.timeUncertain ? 1 : 0,
        input.nowMs,
      );
    }
    const decision = decideSize({
      context,
      voicedMs: durationMs,
      elapsedMs: durationMs,
      episodeOpen: false,
      diarization: null,
    });
    const episodeId = int(
      db
        .statement(
          `INSERT INTO episodes (state, context, size, size_state, analysis_state, started_at_ms,
             ended_at_ms, voiced_ms, label, grouping_version, grouping_key, classifier_version,
             kind_inputs, created_at_ms, updated_at_ms)
           VALUES ('closed', ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        )
        .get(
          context,
          decision.size,
          decision.provisional ? "provisional" : "final",
          input.startedWallMs,
          endedWallMs,
          durationMs,
          // A phone recording is a conversation like the Mac's: no file name.
          phone === undefined ? input.fileName : null,
          GROUPING_VERSION,
          String(regionId),
          SIZE_TABLE_VERSION,
          JSON.stringify(kindInputsOf(decision)),
          input.nowMs,
          input.nowMs,
        ) ?? {},
      "id",
    );
    db.statement(
      `INSERT INTO episode_regions (episode_id, speech_region_id, grouping_version, slice_sample_start)
       VALUES (?, ?, ?, 0)`,
    ).run(episodeId, regionId, GROUPING_VERSION);
    // The user asked for it: transcribed like « Transcrire maintenant », power and idle aside.
    enqueueAnalysisJob(db, {
      episodeId,
      inputGeneration: 1,
      priority: analysisPriorities.requested,
      requested: true,
      nowMs: input.nowMs,
    });
    return { episodeId, trackRunId };
  });
}

/** An imported recording as its list shows it: newest import first. */
export interface ImportedRecording {
  readonly episodeId: number;
  /** The episode's label: the file's name unless the user renamed it. */
  readonly fileName: string;
  readonly importedAtMs: number;
}

/** Where the next page of imports starts: after this one. */
export interface ImportCursor {
  readonly importedAtMs: number;
  readonly episodeId: number;
}

/** Imported recordings, newest import first, `limit` at a time. */
export function listImports(
  db: Database,
  input: { readonly limit: number; readonly after?: ImportCursor },
): { readonly imports: ImportedRecording[]; readonly next: ImportCursor | null } {
  const rows = db
    .statement(
      `SELECT id, coalesce(label, '') AS label, created_at_ms FROM episodes
       WHERE context = 'imported'
         AND (:afterAt IS NULL OR created_at_ms < :afterAt
           OR (created_at_ms = :afterAt AND id < :afterId))
       ORDER BY created_at_ms DESC, id DESC LIMIT :limit`,
    )
    .all({
      afterAt: input.after?.importedAtMs ?? null,
      afterId: input.after?.episodeId ?? null,
      limit: input.limit + 1,
    })
    .map((row) => ({
      episodeId: int(row, "id"),
      fileName: String(row["label"]),
      importedAtMs: int(row, "created_at_ms"),
    }));
  const imports = rows.slice(0, input.limit);
  const last = imports.at(-1);
  return {
    imports,
    next:
      rows.length > input.limit && last !== undefined
        ? { importedAtMs: last.importedAtMs, episodeId: last.episodeId }
        : null,
  };
}
