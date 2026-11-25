import { knownVoices, namedRuns, voiceChannel, voiceMatches, type Database } from "@sondine/db";
import { sameMomentEpisodes, type BenchVoice, type PhoneInventory } from "./phone.ts";

// Reads what the phone's report needs from a copy of Sondine's database:
// every embedded voice of a current transcript the app may identify, with the
// name the app resolves for it now (`namedRuns`), and what is known of the
// phone's recordings. Nothing is written.

const pad = (value: number) => String(value).padStart(2, "0");

/** A local day, `YYYY-MM-DD`, in the Mac's time zone. */
export const localDay = (ms: number): string => {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const fromBlob = (blob: Uint8Array): Float32Array => {
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  return Float32Array.from({ length: blob.byteLength / 4 }, (_, index) =>
    view.getFloat32(index * 4, true),
  );
};

const number = (row: Record<string, unknown>, key: string) => Number(row[key] ?? 0);

export function readBenchVoices(db: Database): {
  readonly voices: BenchVoice[];
  readonly sameMoment: Map<number, Set<number>>;
  readonly inventory: PhoneInventory;
  /** The embedder whose voices are read (at most one). */
  readonly embedders: string[];
} {
  const runs = namedRuns(db);
  const named = new Map(runs.map((run) => [run.runId, run.speakers]));
  const rows = db
    .statement(
      `SELECT v.run_id, v.episode_id, v.label, v.embedder_version, v.vector, v.speech_ms,
              e.started_at_ms,
              EXISTS (SELECT 1 FROM phone_recordings p
                      JOIN speech_regions r ON r.track_run_id = p.track_run_id
                      JOIN episode_regions m ON m.speech_region_id = r.id
                      WHERE m.episode_id = e.id) AS phone_app
       FROM speaker_embeddings v
       JOIN episode_analysis ea ON ea.run_id = v.run_id AND ea.stage = 'asr'
       JOIN episodes e ON e.id = v.episode_id
       WHERE e.context IN ('call', 'in_person', 'mixed')`,
    )
    .all();
  const read = rows.flatMap((row) => {
    const label = String(row["label"]);
    const runId = number(row, "run_id");
    const blob = row["vector"];
    if (!(blob instanceof Uint8Array)) return [];
    const voice: BenchVoice = {
      episodeId: number(row, "episode_id"),
      day: localDay(number(row, "started_at_ms")),
      channel: voiceChannel(label),
      phoneApp: number(row, "phone_app") === 1,
      person: named.get(runId)?.get(label) ?? null,
      version: String(row["embedder_version"]),
      vector: fromBlob(blob),
      speechMs: number(row, "speech_ms"),
    };
    return [{ runId, label, voice }];
  });
  // One embedder: the one most voices have (a voice embedded twice during an
  // upgrade would otherwise count twice).
  const versions = Map.groupBy(read, (entry) => entry.voice.version);
  const embedder = [...versions].toSorted((a, b) => b[1].length - a[1].length)[0]?.[0];
  const voices = read
    .filter((entry) => entry.voice.version === embedder)
    .map((entry) => entry.voice);

  const links = db
    .statement("SELECT phone_episode_id, mac_episode_id FROM same_moment_links WHERE linked = 1")
    .all()
    .map((row) => [number(row, "phone_episode_id"), number(row, "mac_episode_id")] as const);
  // Every episode with a voice embedded, on the wall clock.
  const spans = db
    .statement(
      `SELECT e.id, e.started_at_ms, coalesce(e.ended_at_ms, e.started_at_ms) AS ended_at_ms,
              EXISTS (SELECT 1 FROM phone_recordings p
                      JOIN speech_regions r ON r.track_run_id = p.track_run_id
                      JOIN episode_regions m ON m.speech_region_id = r.id
                      WHERE m.episode_id = e.id) AS phone_app,
              EXISTS (SELECT 1 FROM phone_recordings p
                      JOIN speech_regions r ON r.track_run_id = p.track_run_id
                      JOIN episode_regions m ON m.speech_region_id = r.id
                      WHERE m.episode_id = e.id AND p.time_uncertain = 1) AS time_uncertain
       FROM episodes e WHERE e.id IN (SELECT episode_id FROM speaker_embeddings)`,
    )
    .all()
    .map((row) => ({
      episodeId: number(row, "id"),
      startedAtMs: number(row, "started_at_ms"),
      endedAtMs: number(row, "ended_at_ms"),
      phoneApp: number(row, "phone_app") === 1,
      timeUncertain: number(row, "time_uncertain") === 1,
    }));
  const sameMoment = sameMomentEpisodes(spans, links);

  const recordings = db
    .statement(
      `SELECT t.started_wall_ms, t.sample_end, t.sample_rate FROM phone_recordings p
       JOIN track_runs t ON t.id = p.track_run_id WHERE p.state = 'stored'`,
    )
    .all();
  const deleted = db
    .statement("SELECT count(*) AS n FROM phone_recordings WHERE state = 'deleted'")
    .get();
  const imported = db
    .statement(
      `SELECT count(*) AS n FROM track_runs t WHERE t.source_kind = 'phone'
         AND NOT EXISTS (SELECT 1 FROM phone_recordings p WHERE p.track_run_id = t.id)`,
    )
    .get();

  // What the app shows today for the phone voices nobody named.
  const known = knownVoices(db, runs);
  const unnamedToday = { recognized: 0, suggested: 0, none: 0 };
  const phoneRuns = new Map<number, Set<string>>();
  for (const { runId, label, voice } of read.filter((entry) => entry.voice.version === embedder)) {
    if (voice.channel !== "phone" || !voice.phoneApp || voice.person !== null) continue;
    phoneRuns.set(runId, (phoneRuns.get(runId) ?? new Set()).add(label));
  }
  for (const [runId, labels] of phoneRuns) {
    const matches = voiceMatches(db, runId, known);
    for (const label of labels) {
      const zone = matches.get(label)?.zone;
      unnamedToday[zone === "likely" ? "suggested" : (zone ?? "none")] += 1;
    }
  }

  return {
    voices,
    sameMoment,
    embedders: embedder === undefined ? [] : [embedder],
    inventory: {
      appRecordings: recordings.length,
      appRecordingDays: new Set(recordings.map((row) => localDay(number(row, "started_wall_ms"))))
        .size,
      appRecordingMinutes: recordings.reduce(
        (sum, row) =>
          sum + number(row, "sample_end") / Math.max(1, number(row, "sample_rate")) / 60,
        0,
      ),
      appRecordingsDeleted: number(deleted ?? {}, "n"),
      importedFiles: number(imported ?? {}, "n"),
      unnamedToday,
      sameMomentPairs: [...sameMoment.values()].reduce((sum, set) => sum + set.size, 0) / 2,
      sameMomentLinks: links.length,
    },
  };
}
