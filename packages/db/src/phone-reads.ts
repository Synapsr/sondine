import type { Database } from "./database";
import { int, str } from "./rows";

// What the phone's reads of the Mac's memory need beside the app's own
// procedures (ADR 008, M5.4): which episodes hold a phone recording, and
// whose, so a phone sees its own recordings' ids and no other phone's.

export interface EpisodePhoneRecording {
  readonly recordingId: string;
  readonly deviceId: string;
}

/** The stored phone recordings among these episodes, by episode. */
export function phoneRecordingsOfEpisodes(
  db: Database,
  episodeIds: readonly number[],
): Map<number, EpisodePhoneRecording> {
  const found = new Map<number, EpisodePhoneRecording>();
  if (episodeIds.length === 0) return found;
  const rows = db
    .statement(
      `SELECT DISTINCT er.episode_id, p.recording_id, p.device_id FROM phone_recordings p
       JOIN speech_regions r ON r.track_run_id = p.track_run_id
       JOIN episode_regions er ON er.speech_region_id = r.id
       WHERE p.state = 'stored' AND er.episode_id IN (SELECT value FROM json_each(?))
       ORDER BY er.episode_id, p.recording_id`,
    )
    .all(JSON.stringify([...new Set(episodeIds)]));
  for (const row of rows) {
    const episodeId = int(row, "episode_id");
    if (found.has(episodeId)) continue;
    found.set(episodeId, {
      recordingId: str(row, "recording_id"),
      deviceId: str(row, "device_id"),
    });
  }
  return found;
}
