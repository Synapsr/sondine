import { selfSpeakerLabel } from "@sondine/core";
import type { Database } from "./database";
import { resolveSpeakers } from "./people";
import { int, num, oneOfValues, str, strOrNull, type Row } from "./rows";
import {
  episodeContexts,
  trackSourceKinds,
  type EpisodeContext,
  type TrackSourceKind,
} from "./schema/enums";

// Who and what an episode heard, derived at read time from capture facts and
// the published transcript: the apps (dictation apps, calls and attributed
// tracks) and the speaker the sources point to as the user. Nothing here is
// stored.

/** Most apps an episode summary names. */
export const EPISODE_APPS_MAX = 8;
const APP_NAME_MAX = 120;

/** An app's display name, cut to what the window shows. */
export const appDisplayName = (name: string): string =>
  name.length > APP_NAME_MAX ? `${name.slice(0, APP_NAME_MAX - 1)}…` : name;

/** An app an episode heard: its bundle ID (for its icon) and its display name. */
export interface EpisodeApp {
  readonly bundleId: string;
  /** The app's name, else its bundle ID. */
  readonly name: string;
}

export interface EpisodeAppsInput {
  readonly id: number;
  readonly context: EpisodeContext | null;
  readonly startedAtMs: number;
  /** Null while the episode is open: it reaches `nowMs`. */
  readonly endedAtMs: number | null;
}

/**
 * The apps heard in each episode, with their display names (the app's name,
 * else its bundle ID): in a dictation, the app it was said to (the episode's
 * primary app, from the grouping); in a call, the call apps first, by time
 * shared with the episode; then the apps of its app tracks and attributed
 * `system:other` regions, most voiced first. In person, none.
 */
export function loadEpisodeApps(
  db: Database,
  episodes: readonly EpisodeAppsInput[],
  nowMs: number,
  /** How many apps per episode; a summary names at most `EPISODE_APPS_MAX`. */
  max = EPISODE_APPS_MAX,
): Map<number, EpisodeApp[]> {
  const out = new Map<number, EpisodeApp[]>();
  const wanted = episodes.filter((episode) => episode.context !== "in_person");
  if (wanted.length === 0) return out;
  const ids = JSON.stringify(wanted.map((episode) => episode.id));
  const ranked = new Map<
    number,
    { said: Map<string, number>; calls: Map<string, number>; regions: Map<string, number> }
  >();
  /** Display names by bundle id: the app's, or the bundle id for an app without one. */
  const names = new Map<string, string>();
  const entry = (episodeId: number) => {
    let value = ranked.get(episodeId);
    if (value === undefined) {
      value = { said: new Map(), calls: new Map(), regions: new Map() };
      ranked.set(episodeId, value);
    }
    return value;
  };
  const add = (map: Map<string, number>, row: Row, weight: number) => {
    const bundleId = str(row, "bundle_id");
    names.set(bundleId, str(row, "name"));
    map.set(bundleId, (map.get(bundleId) ?? 0) + weight);
  };

  const dictationRows = db
    .statement(
      `SELECT e.id AS episode_id, a.bundle_id, coalesce(a.name, a.bundle_id) AS name
       FROM episodes e JOIN apps a ON a.id = e.primary_app_id
       WHERE e.id IN (SELECT value FROM json_each(?)) AND e.context = 'dictation'`,
    )
    .all(ids);
  for (const row of dictationRows) add(entry(int(row, "episode_id")).said, row, 1);

  const callRows = db
    .statement(
      `SELECT e.id AS episode_id, c.bundle_id, coalesce(a.name, c.bundle_id) AS name,
         min(coalesce(e.ended_at_ms, ?), coalesce(c.ended_wall_ms, ?))
           - max(e.started_at_ms, c.started_wall_ms) AS shared_ms
       FROM episodes e
       JOIN calls c ON c.started_wall_ms <= coalesce(e.ended_at_ms, ?)
         AND coalesce(c.ended_wall_ms, ?) >= e.started_at_ms
       LEFT JOIN apps a ON a.id = c.app_id
       WHERE e.id IN (SELECT value FROM json_each(?)) AND e.context IN ('call', 'mixed')`,
    )
    .all(nowMs, nowMs, nowMs, nowMs, ids);
  for (const row of callRows) {
    add(entry(int(row, "episode_id")).calls, row, num(row, "shared_ms"));
  }

  const regionRows = db
    .statement(
      `SELECT er.episode_id AS episode_id, a.bundle_id, coalesce(a.name, a.bundle_id) AS name,
         sum((coalesce(er.slice_sample_end, r.sample_end, er.slice_sample_start)
           - er.slice_sample_start)
           * coalesce(r.voiced_samples * 1.0 / nullif(r.sample_end - r.sample_start, 0), 1.0)
           * 1000.0 / t.sample_rate) AS voiced_ms
       FROM episode_regions er
       JOIN speech_regions r ON r.id = er.speech_region_id
       JOIN track_runs t ON t.id = r.track_run_id
       JOIN apps a ON a.id = coalesce(t.app_id, r.attributed_app_id)
       WHERE er.episode_id IN (SELECT value FROM json_each(?))
       GROUP BY er.episode_id, a.id`,
    )
    .all(ids);
  for (const row of regionRows) {
    add(entry(int(row, "episode_id")).regions, row, num(row, "voiced_ms"));
  }

  const nameOf = (bundleId: string) => names.get(bundleId) ?? bundleId;
  const byWeight = (map: Map<string, number>) =>
    [...map.entries()]
      .toSorted(([idA, a], [idB, b]) => {
        const [nameA, nameB] = [nameOf(idA), nameOf(idB)];
        return b - a || (nameA < nameB ? -1 : nameA > nameB ? 1 : 0);
      })
      .map(([bundleId]) => bundleId);
  for (const [episodeId, { said, calls, regions }] of ranked) {
    const apps = [...new Set([...byWeight(said), ...byWeight(calls), ...byWeight(regions)])]
      .slice(0, max)
      .map((bundleId) => ({ bundleId, name: appDisplayName(nameOf(bundleId)) }));
    out.set(episodeId, apps);
  }
  return out;
}

/** A speaker of a published run, with the kind of track it was heard on. */
export interface RunSpeaker {
  readonly label: string;
  readonly ordinal: number;
  readonly voicedMs: number;
  readonly trackKind: TrackSourceKind;
}

/**
 * The speakers of a run in ordinal order. A label belongs to one request of
 * one track (`<trackKey>/<request>/<n>`), so its turns and segments name its
 * track; a speaker with neither falls back on the label's track key, and
 * counts as `system` when even that is unknown (never the user).
 */
export function loadRunSpeakers(db: Database, runId: number): RunSpeaker[] {
  const kinds = new Map<number, TrackSourceKind>();
  for (const table of ["segments", "speaker_turns"] as const) {
    const rows = db
      .statement(
        `SELECT DISTINCT x.episode_speaker_id, t.source_kind FROM ${table} x
         JOIN track_runs t ON t.id = x.track_run_id
         WHERE x.run_id = ? AND x.episode_speaker_id IS NOT NULL`,
      )
      .all(runId);
    for (const row of rows) {
      kinds.set(int(row, "episode_speaker_id"), oneOfValues(row, "source_kind", trackSourceKinds));
    }
  }
  return db
    .statement(
      "SELECT id, label, ordinal, voiced_ms FROM episode_speakers WHERE run_id = ? ORDER BY ordinal",
    )
    .all(runId)
    .map((row) => {
      const label = str(row, "label");
      return {
        label,
        ordinal: int(row, "ordinal"),
        voicedMs: int(row, "voiced_ms"),
        trackKind: kinds.get(int(row, "id")) ?? kindFromLabel(label) ?? "system",
      };
    });
}

function kindFromLabel(label: string): TrackSourceKind | null {
  const kind = label.slice(0, label.indexOf(":"));
  return trackSourceKinds.find((value) => value === kind) ?? null;
}

/** An episode's `self` speaker: its label and its number among the episode's speakers. */
export interface SelfSpeaker {
  readonly label: string;
  readonly ordinal: number;
}

/**
 * The `self` speaker of each episode in its current transcript: the voice the
 * user named as themselves, else, in a call or a dictation, the microphone
 * voice that speaks most (`selfSpeakerLabel` in @sondine/core) unless the
 * user named that voice as someone else. A guess never names anyone. Episodes without one are
 * absent. For readers that mark the user's words and number the other
 * voices, such as search.
 */
export function loadSelfSpeakers(
  db: Database,
  episodeIds: readonly number[],
): Map<number, SelfSpeaker> {
  const out = new Map<number, SelfSpeaker>();
  if (episodeIds.length === 0) return out;
  const rows = db
    .statement(
      `SELECT e.id, e.context, ea.run_id FROM episodes e
       JOIN episode_analysis ea ON ea.episode_id = e.id AND ea.stage = 'asr'
       WHERE e.id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(episodeIds));
  for (const row of rows) {
    const context = strOrNull(row, "context");
    const runId = int(row, "run_id");
    const speakers = loadRunSpeakers(db, runId);
    const people = resolveSpeakers(db, runId);
    const named = speakers.find((speaker) => people.get(speaker.label)?.isSelf === true);
    const guess = selfSpeakerLabel(
      context === null ? null : oneOfValues(row, "context", episodeContexts),
      speakers,
    );
    const label = named?.label ?? (guess !== null && !people.has(guess) ? guess : null);
    const self = speakers.find((speaker) => speaker.label === label);
    if (self !== undefined) out.set(int(row, "id"), { label: self.label, ordinal: self.ordinal });
  }
  return out;
}
