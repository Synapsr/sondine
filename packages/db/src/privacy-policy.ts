import {
  DAY_MS,
  TRANSCRIPT_GRACE_MS,
  keepingOf,
  keepsNothing,
  pageUrlOf,
  recordingTypeOf,
  scheduleSpans,
  webPageOf,
  type Keeping,
  type RecordingType,
  type ZoneOutcome,
  type ZoneSituation,
} from "@sondine/core";
import { transaction, type Database } from "./database";
import { deleteEpisode, deletedChunks, type DeletedChunk } from "./delete-episode";
import { currentRunId, retireRun } from "./publish";
import { loadEpisodeApps } from "./episode-sources";
import {
  durations,
  durationsSince,
  episodeAudioKept,
  episodeAudioRanges,
  situationSpansBetween,
  zoneSpansBetween,
  type StoredSituationSpan,
  type StoredZoneSpan,
} from "./privacy-zones";
import { phoneHeldSql, phoneRecordingSql } from "./phone-recordings";
import { int, intOrNull, str, strOrNull } from "./rows";
import type { EpisodeContext } from "./schema/enums";
import { forgetPlayedAudio, type DroppedEpisodes } from "./web-plays";

// What each recording keeps (ADR 029), read from stored facts, never a
// snapshot: the zones on while it was recorded, the situations the helper
// reported, its apps, page and type, and the user's « Garder l'audio ». Then
// what applies it: deleting at close what keeps nothing, holding text back,
// taking the audio once the text exists, expiring audio by type, and deleting
// recordings whose time is up.

/**
 * A recording touches a zone when they share this long, or all of a shorter
 * recording: enough to ignore a recording that only meets a zone at its edge
 * (a hold stops capture as its situation starts, clocks a few ms apart).
 */
export const TOUCH_MS = 250;

export interface TouchingZone {
  readonly zoneId: string;
  readonly outcome: ZoneOutcome;
  readonly situation: ZoneSituation;
}

export interface EpisodePrivacy {
  readonly episodeId: number;
  readonly type: RecordingType;
  /** What the zones touching it leave. */
  readonly keeping: Keeping;
  /** The zones touching it, once each (the latest span of each). */
  readonly zones: readonly TouchingZone[];
  /** « Garder l'audio »: no automatic removal applies. */
  readonly kept: boolean;
  readonly audioDays: number;
  /** The type's « Effacé après », in days; null: never. */
  readonly deleteDays: number | null;
}

interface Span {
  readonly startMs: number;
  readonly endMs: number;
}

const intersect = (a: Span, b: Span): Span | null => {
  const startMs = Math.max(a.startMs, b.startMs);
  const endMs = Math.min(a.endMs, b.endMs);
  return endMs < startMs ? null : { startMs, endMs };
};

const touches = (episode: Span, shared: Span): boolean => {
  const length = episode.endMs - episode.startMs;
  const overlap = shared.endMs - shared.startMs;
  if (length <= 0) return true; // a point recording inside the span
  return overlap > 0 && overlap >= Math.min(TOUCH_MS, length);
};

interface Facts {
  readonly id: number;
  readonly span: Span;
  readonly context: EpisodeContext | null;
  readonly size: string | null;
  readonly site: string | null;
  readonly apps: ReadonlySet<string>;
  /**
   * Recorded by the phone, or imported (track run kind `phone`): no zone
   * applies. Zones are situations the Mac observes; a recording started by
   * hand comes before them (ADR 032).
   */
  readonly phone: boolean;
}

function situationMatches(
  zone: StoredZoneSpan,
  facts: Facts,
  shared: Span,
  situations: readonly StoredSituationSpan[],
): boolean {
  const situation = zone.situation;
  const during = (kind: StoredSituationSpan["kind"], hashes: readonly string[] | null) =>
    situations.some((span) => {
      if (span.kind !== kind) return false;
      if (hashes !== null && (span.networkHash === null || !hashes.includes(span.networkHash))) {
        return false;
      }
      const both = intersect(shared, {
        startMs: span.startedWallMs,
        endMs: span.endedWallMs ?? Number.MAX_SAFE_INTEGER,
      });
      return both !== null && touches(facts.span, both);
    });
  switch (situation.kind) {
    case "app":
      return facts.apps.has(situation.bundleId);
    case "site":
      return facts.site === situation.site;
    case "media_sites":
      return facts.site !== null && situation.sites.includes(facts.site);
    case "calls":
      return facts.context === "call";
    case "screen":
      return during("screen_away", null);
    case "network":
      return during("network", situation.hashes);
    case "hours":
      return scheduleSpans(situation.windows, shared.startMs, shared.endMs).some((window) => {
        const both = intersect(shared, window);
        return both !== null && touches(facts.span, both);
      });
  }
}

const siteOf = (pageKey: string | null): string | null =>
  pageKey === null ? null : (webPageOf(pageUrlOf(pageKey))?.site ?? null);

/** What each episode keeps, from the zones on while it was recorded and its type. */
export function episodePrivacy(
  db: Database,
  episodeIds: readonly number[],
  nowMs: number,
): Map<number, EpisodePrivacy> {
  const out = new Map<number, EpisodePrivacy>();
  if (episodeIds.length === 0) return out;
  const rows = db
    .statement(
      `SELECT e.id, e.context, e.size, e.started_at_ms, e.ended_at_ms, e.page_key,
         ${phoneHeldSql("e")} AS phone
       FROM episodes e WHERE e.id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(episodeIds));
  if (rows.length === 0) return out;
  const inputs = rows.map((row) => ({
    id: int(row, "id"),
    context: strOrNull(row, "context") as EpisodeContext | null,
    startedAtMs: int(row, "started_at_ms"),
    endedAtMs: intOrNull(row, "ended_at_ms"),
  }));
  // Every app it heard, not only the ones a summary names.
  const apps = loadEpisodeApps(db, inputs, nowMs, Number.MAX_SAFE_INTEGER);
  const facts: Facts[] = rows.map((row, index) => {
    const input = inputs[index] ?? { id: 0, context: null, startedAtMs: 0, endedAtMs: null };
    return {
      id: input.id,
      span: { startMs: input.startedAtMs, endMs: input.endedAtMs ?? nowMs },
      context: input.context,
      size: strOrNull(row, "size"),
      site: siteOf(strOrNull(row, "page_key")),
      apps: new Set((apps.get(input.id) ?? []).map((app) => app.bundleId)),
      phone: int(row, "phone") === 1,
    };
  });
  const fromMs = Math.min(...facts.map((fact) => fact.span.startMs));
  const toMs = Math.max(...facts.map((fact) => fact.span.endMs));
  const zones = zoneSpansBetween(db, fromMs, toMs);
  const situations = zones.some(
    (zone) => zone.situation.kind === "screen" || zone.situation.kind === "network",
  )
    ? situationSpansBetween(db, fromMs, toMs)
    : [];
  const { audioDays, deleteDays } = durations(db);
  for (const fact of facts) {
    // Every span counts for what is kept (a zone whose outcome changed while it
    // was recorded takes both); the list names each zone once, as it was last.
    const outcomes: ZoneOutcome[] = [];
    const touching = new Map<string, TouchingZone>();
    for (const zone of fact.phone ? [] : zones) {
      const shared = intersect(fact.span, {
        startMs: zone.startedWallMs,
        endMs: zone.endedWallMs ?? Number.MAX_SAFE_INTEGER,
      });
      if (shared === null || !touches(fact.span, shared)) continue;
      if (!situationMatches(zone, fact, shared, situations)) continue;
      outcomes.push(zone.outcome);
      touching.set(zone.zoneId, {
        zoneId: zone.zoneId,
        outcome: zone.outcome,
        situation: zone.situation,
      });
    }
    const list = [...touching.values()];
    const type = recordingTypeOf({ context: fact.context, size: fact.size });
    out.set(fact.id, {
      episodeId: fact.id,
      type,
      keeping: keepingOf(outcomes),
      zones: list,
      kept: episodeAudioKept(db, fact.id),
      audioDays: audioDays[type],
      deleteDays: deleteDays[type],
    });
  }
  return out;
}

/**
 * Whether any zone that keeps no text was on between two times, its situation
 * met or not: the audio around an episode may then be another one's, which
 * never leaves the Mac (ADR 040).
 */
export function textlessZoneOn(db: Database, fromMs: number, toMs: number): boolean {
  return zoneSpansBetween(db, fromMs, toMs).some((zone) => !keepingOf([zone.outcome]).text);
}

/** The episodes among `episodeIds` whose zones keep their text from being made. */
export function episodesWithoutText(
  db: Database,
  episodeIds: readonly number[],
  nowMs: number,
): Set<number> {
  const out = new Set<number>();
  for (const [id, privacy] of episodePrivacy(db, episodeIds, nowMs)) {
    if (!privacy.keeping.text) out.add(id);
  }
  return out;
}

/**
 * Closed episodes that keep nothing go whole, as « Supprimer » would delete
 * them, before anything transcribes them: a site left out (with the audio its
 * tracks heard while the page played, ADR 023), or any zone at « Rien » that
 * capture could not hold back. `episodeIds`: the episodes the pass just closed.
 */
export function dropRecordingsKeepingNothing(
  db: Database,
  episodeIds: readonly number[],
  nowMs: number,
): DroppedEpisodes {
  if (episodeIds.length === 0) return { episodeIds: [], chunks: [] };
  return transaction(db, () => {
    const dropped: number[] = [];
    const chunks: DeletedChunk[] = [];
    for (const privacy of episodePrivacy(db, episodeIds, nowMs).values()) {
      if (privacy.kept || !keepsNothing(privacy.keeping)) continue;
      const episode = db
        .statement(
          "SELECT page_key, started_at_ms, ended_at_ms FROM episodes WHERE id = ? AND state = 'closed'",
        )
        .get(privacy.episodeId);
      if (episode === undefined) continue;
      const pageKey = strOrNull(episode, "page_key");
      const startMs = int(episode, "started_at_ms");
      const endMs = intOrNull(episode, "ended_at_ms") ?? nowMs;
      const bySite = privacy.zones.some(
        (zone) =>
          (zone.situation.kind === "site" || zone.situation.kind === "media_sites") &&
          keepsNothing(keepingOf([zone.outcome])),
      );
      // Read before the episode goes: the deletion takes its plays and regions.
      const spans =
        pageKey !== null && bySite
          ? db
              .statement(
                `SELECT started_wall_ms, coalesce(ended_wall_ms, ?) AS ended_ms FROM web_plays
                 WHERE page_key = ? AND started_wall_ms <= ? AND coalesce(ended_wall_ms, ?) >= ?`,
              )
              .all(nowMs, pageKey, endMs, nowMs, startMs)
              .map((row) => ({ fromMs: int(row, "started_wall_ms"), toMs: int(row, "ended_ms") }))
          : [];
      const runs = db
        .statement(
          `SELECT DISTINCT r.track_run_id FROM episode_regions er
           JOIN speech_regions r ON r.id = er.speech_region_id WHERE er.episode_id = ?`,
        )
        .all(privacy.episodeId)
        .map((row) => int(row, "track_run_id"));
      const removed = deleteEpisode(db, privacy.episodeId, {
        origin: "app",
        nowMs,
        checkpoint: false,
      });
      if (!removed.deleted) continue;
      dropped.push(privacy.episodeId);
      chunks.push(...removed.chunks);
      if (spans.length > 0) chunks.push(...forgetPlayedAudio(db, runs, spans, nowMs));
    }
    return { episodeIds: dropped, chunks };
  });
}

/**
 * Takes the episode's audio when a zone keeps its text alone, once the text
 * exists (or at once when it never will): every block its slices and roll
 * reach is marked deleted, the same transaction as the caller's, and its
 * bytes are left for the scrubber. A block shared with a neighbour goes too.
 * Nothing when the user keeps the audio. Returns the blocks to scrub.
 */
export function takeEpisodeAudio(db: Database, episodeId: number, nowMs: number): DeletedChunk[] {
  return transaction(db, () => {
    const mark = db.statement(
      `UPDATE chunks SET audio_state = 'deleted'
       WHERE track_run_id = ? AND sample_start < ? AND sample_start + sample_count > ?
         AND audio_state IN ('present', 'archived')
       RETURNING id`,
    );
    const ids: number[] = [];
    for (const range of episodeAudioRanges(db, episodeId)) {
      for (const row of mark.all(range.trackRunId, range.to, range.from)) ids.push(int(row, "id"));
    }
    db.statement(
      "UPDATE episodes SET audio_gone_at_ms = coalesce(audio_gone_at_ms, ?), updated_at_ms = ? WHERE id = ?",
    ).run(nowMs, nowMs, episodeId);
    return deletedChunks(db, ids);
  });
}

/** After a final transcript: takes the audio of an episode whose zones keep its text alone. */
export function takeAudioAfterText(db: Database, episodeId: number, nowMs: number): DeletedChunk[] {
  const privacy = episodePrivacy(db, [episodeId], nowMs).get(episodeId);
  if (privacy === undefined || privacy.kept || privacy.keeping.audio) return [];
  return takeEpisodeAudio(db, episodeId, nowMs);
}

// The periodic pass

const TYPE_SQL = `CASE
    WHEN e.context = 'call' THEN 'calls'
    WHEN e.context = 'media' THEN 'media'
    WHEN e.context = 'dictation' THEN 'dictations'
    WHEN e.size = 'conversation' THEN 'conversations'
    WHEN e.size = 'trace' THEN 'traces'
    ELSE 'moments' END`;

const NOT_KEPT_SQL = `NOT EXISTS (
    SELECT 1 FROM episode_regions er
    JOIN speech_regions r ON r.id = er.speech_region_id
    JOIN kept_audio k ON k.track_run_id = r.track_run_id
      AND k.sample_start < coalesce(er.slice_sample_end, r.sample_end, er.slice_sample_start + 1)
      AND k.sample_end > er.slice_sample_start
    WHERE er.episode_id = e.id)`;

const TRANSCRIBED_SQL = `EXISTS (SELECT 1 FROM episode_analysis a
    WHERE a.episode_id = e.id AND a.stage = 'asr')`;

/**
 * Where durations by type count from: the recording's end, or for a phone
 * recording its arrival on the Mac when that is later (its episode's
 * creation), so one synced after two weeks away is not erased unread (ADR 032).
 */
const COUNTED_FROM_SQL = `(CASE WHEN ${phoneRecordingSql("e")}
    THEN max(e.ended_at_ms, e.created_at_ms) ELSE e.ended_at_ms END)`;

/** Where a bounded scan stopped: the next one starts after this episode id (0: from the start). */
export interface ScanResult {
  readonly ids: readonly number[];
  readonly next: number;
}

/**
 * Walks candidates in id order from `afterId`, a page at a time, keeping those
 * `matches` says, until `limit` are found or `budget` candidates were read;
 * `next` is where the next scan goes on (0 once every candidate was read), so
 * candidates that never match cannot hold back newer ones.
 */
function scan(
  db: Database,
  sql: string,
  params: readonly (number | string)[],
  matches: (ids: readonly number[]) => readonly number[],
  afterId: number,
  limit: number,
  budget: number,
): ScanResult {
  const page = db.statement(`${sql} AND e.id > ? ORDER BY e.id LIMIT ?`);
  const ids: number[] = [];
  let cursor = afterId;
  let read = 0;
  while (ids.length < limit && read < budget) {
    const rows = page.all(...params, cursor, 200).map((row) => int(row, "id"));
    if (rows.length === 0) return { ids, next: 0 };
    read += rows.length;
    cursor = rows.at(-1) ?? cursor;
    ids.push(...matches(rows));
  }
  return { ids: ids.slice(0, limit), next: cursor };
}

export interface ScanOptions {
  readonly afterId?: number;
  readonly limit?: number;
  /** Candidates read at most in one scan. */
  readonly budget?: number;
}

/**
 * Episodes whose type's « Effacé après » (counted from their end, or a phone
 * recording's arrival when later), or a zone's, is up: they go whole. The
 * zones' part is a bounded scan from `afterId`.
 */
export function recordingsToDelete(
  db: Database,
  nowMs: number,
  options: ScanOptions = {},
): ScanResult {
  const limit = options.limit ?? 200;
  const { deleteDays } = durations(db);
  const ids = new Set<number>();
  const byType = Object.entries(deleteDays).filter(
    (entry): entry is [RecordingType, number] => entry[1] !== null,
  );
  if (byType.length > 0) {
    // Whole days validated by `durations`: inlined as numbers.
    const days = `(CASE ${TYPE_SQL} ${byType
      .map(([type, count]) => `WHEN '${type}' THEN ${Math.trunc(count)}`)
      .join(" ")} ELSE NULL END)`;
    for (const row of db
      .statement(
        `SELECT e.id FROM episodes e
         WHERE e.state = 'closed' AND e.ended_at_ms IS NOT NULL
           AND ${days} IS NOT NULL AND ${COUNTED_FROM_SQL} + ${days} * ${DAY_MS} < ?
           AND ${NOT_KEPT_SQL}
         ORDER BY e.ended_at_ms, e.id LIMIT ?`,
      )
      .all(nowMs, limit)) {
      ids.add(int(row, "id"));
    }
  }
  // Zones that delete: only recordings made while one was on can be due.
  const zoned = scan(
    db,
    `SELECT e.id FROM episodes e
     WHERE e.state = 'closed' AND e.ended_at_ms IS NOT NULL AND e.ended_at_ms < ?
       AND EXISTS (SELECT 1 FROM privacy_zone_spans z
         WHERE z.outcome IN ('delete_week', 'delete_day')
           AND z.started_wall_ms <= e.ended_at_ms
           AND coalesce(z.ended_wall_ms, ?) >= e.started_at_ms)`,
    [nowMs - DAY_MS, nowMs],
    (candidates) =>
      [...episodePrivacy(db, candidates, nowMs).values()].flatMap((privacy) => {
        const after = privacy.keeping.deleteAfterMs;
        if (after === null || privacy.kept) return [];
        const ended = db
          .statement("SELECT ended_at_ms FROM episodes WHERE id = ?")
          .get(privacy.episodeId);
        const endedMs = ended === undefined ? null : intOrNull(ended, "ended_at_ms");
        return endedMs !== null && endedMs + after < nowMs ? [privacy.episodeId] : [];
      }),
    options.afterId ?? 0,
    limit,
    options.budget ?? 2_000,
  );
  for (const id of zoned.ids) ids.add(id);
  return { ids: [...ids].slice(0, limit), next: zoned.next };
}

/**
 * Episodes whose zones keep the text alone and still have audio: transcribed
 * (a missed hook), or untranscribed past the grace. Their audio goes. A
 * bounded scan from `afterId`.
 */
export function recordingsToSilence(
  db: Database,
  nowMs: number,
  options: ScanOptions = {},
): ScanResult {
  return scan(
    db,
    `SELECT e.id FROM episodes e
     WHERE e.state = 'closed' AND e.audio_gone_at_ms IS NULL AND e.ended_at_ms IS NOT NULL
       AND EXISTS (SELECT 1 FROM privacy_zone_spans z
         WHERE z.outcome IN ('text_only', 'nothing')
           AND z.started_wall_ms <= e.ended_at_ms
           AND coalesce(z.ended_wall_ms, ?) >= e.started_at_ms)
       AND (${TRANSCRIBED_SQL} OR e.ended_at_ms + ? < ?)
       AND ${NOT_KEPT_SQL}`,
    [nowMs, TRANSCRIPT_GRACE_MS, nowMs],
    (candidates) =>
      [...episodePrivacy(db, candidates, nowMs).values()]
        .filter((privacy) => !privacy.keeping.audio && !privacy.kept)
        .map((privacy) => privacy.episodeId),
    options.afterId ?? 0,
    options.limit ?? 200,
    options.budget ?? 2_000,
  );
}

/**
 * Episodes with live text a zone keeps them from having (a zone switched on
 * while it was said, the live pass not running): their live text goes.
 */
export function liveTextToRemove(db: Database, nowMs: number): number[] {
  const candidates = db
    .statement(
      `SELECT DISTINCT e.id FROM episodes e
       JOIN episode_analysis a ON a.episode_id = e.id AND a.stage = 'asr_live'
       WHERE EXISTS (SELECT 1 FROM privacy_zone_spans z
         WHERE z.outcome IN ('audio_only', 'nothing')
           AND z.started_wall_ms <= coalesce(e.ended_at_ms, ?)
           AND coalesce(z.ended_wall_ms, ?) >= e.started_at_ms)
       LIMIT 500`,
    )
    .all(nowMs, nowMs)
    .map((row) => int(row, "id"));
  return [...episodesWithoutText(db, candidates, nowMs)];
}

/** Takes an episode's live text away (a zone keeps it from having text). */
export function removeLiveText(db: Database, episodeId: number): boolean {
  return transaction(db, () => {
    const runId = currentRunId(db, episodeId, "asr_live");
    if (runId === undefined) return false;
    retireRun(db, runId);
    return true;
  });
}

/** An archived block whose audio retention lets go. */
export interface ExpiringChunk {
  readonly chunkId: number;
  readonly archiveRelPath: string;
  readonly archiveByteOffset: number;
  readonly byteLength: number;
  readonly spoolRelPath: string;
}

export interface AudioExpiry {
  /** Episodes whose audio goes: their time is up, or the archive is over its cap. */
  readonly episodeIds: readonly number[];
  /** Their archived blocks no recording still keeping its audio needs. */
  readonly chunks: readonly ExpiringChunk[];
  /** Episodes taken for the cap rather than for their time. */
  readonly forCap: number;
}

export interface AudioExpiryOptions {
  readonly nowMs: number;
  /** Archived audio above this goes, oldest first (ADR 015: 20 GiB). */
  readonly capBytes: number;
  readonly limit?: number;
}

/** Archived audio bytes still held. */
export function archivedAudioBytes(db: Database): number {
  const row = db
    .statement(
      "SELECT coalesce(sum(byte_length), 0) AS bytes FROM chunks WHERE audio_state = 'archived'",
    )
    .get();
  return row === undefined ? 0 : int(row, "bytes");
}

/**
 * Which episodes' audio is due (ADR 015, ADR 029): its type's time counted
 * from its end, or a phone recording's arrival when later (ADR 032; never
 * before the update that started durations), plus the
 * grace while it waits for its first transcript; then, over the cap, the
 * oldest. Kept audio never goes. Read-only: the caller zeroes the bytes, then
 * commits with `commitAudioExpiry`.
 */
export function audioExpiryDue(db: Database, options: AudioExpiryOptions): AudioExpiry {
  const { nowMs, capBytes } = options;
  const limit = options.limit ?? 200;
  const { audioDays } = durations(db);
  const since = durationsSince(db, nowMs);
  // Whole days validated by `durations`: inlined as numbers.
  const days = `(CASE ${TYPE_SQL} ${(
    [
      ["calls", audioDays.calls],
      ["conversations", audioDays.conversations],
      ["moments", audioDays.moments],
      ["traces", audioDays.traces],
      ["media", audioDays.media],
    ] as const
  )
    .map(([type, count]) => `WHEN '${type}' THEN ${Math.trunc(count)}`)
    .join(" ")} ELSE ${Math.trunc(audioDays.dictations)} END)`;
  // Audio recorded before the update keeps at least the 30 days it had then (ADR 015), from then.
  // A phone recording that arrived after the update counts from its arrival.
  const deadline = `(CASE WHEN ${COUNTED_FROM_SQL} < ?
      THEN ? + max(${days}, ${PRE_UPDATE_MIN_DAYS}) * ${DAY_MS}
      ELSE ${COUNTED_FROM_SQL} + ${days} * ${DAY_MS} END)`;
  const due = db
    .statement(
      `SELECT e.id FROM episodes e
       WHERE e.state = 'closed' AND e.audio_gone_at_ms IS NULL AND e.ended_at_ms IS NOT NULL
         AND ${deadline} + (CASE WHEN ${TRANSCRIBED_SQL} THEN 0 ELSE ? END) < ?
         AND ${NOT_KEPT_SQL}
       ORDER BY e.ended_at_ms, e.id LIMIT ?`,
    )
    .all(since, since, TRANSCRIPT_GRACE_MS, nowMs, limit)
    .map((row) => int(row, "id"));
  let forCap = 0;
  const episodeIds = [...due];
  let held = archivedAudioBytes(db);
  if (held > capBytes) {
    const oldest = db
      .statement(
        `SELECT e.id FROM episodes e
         WHERE e.state = 'closed' AND e.audio_gone_at_ms IS NULL AND e.ended_at_ms IS NOT NULL
           AND ${NOT_KEPT_SQL}
         ORDER BY e.ended_at_ms, e.id LIMIT ?`,
      )
      .all(limit)
      .map((row) => int(row, "id"));
    for (const id of oldest) {
      if (held <= capBytes) break;
      if (!episodeIds.includes(id)) {
        episodeIds.push(id);
        forCap += 1;
      }
      held -= episodeArchivedBytes(db, id);
    }
  }
  return { episodeIds, chunks: expiringChunks(db, episodeIds, nowMs), forCap };
}

/** Audio recorded before durations by type keeps at least this many days from the update. */
export const PRE_UPDATE_MIN_DAYS = 30;

function episodeArchivedBytes(db: Database, episodeId: number): number {
  const sum = db.statement(
    `SELECT coalesce(sum(byte_length), 0) AS bytes FROM chunks
     WHERE track_run_id = ? AND sample_start < ? AND sample_start + sample_count > ?
       AND audio_state = 'archived'`,
  );
  return episodeAudioRanges(db, episodeId).reduce(
    (total, range) =>
      total + int(sum.get(range.trackRunId, range.to, range.from) ?? { bytes: 0 }, "bytes"),
    0,
  );
}

/** Rolls widen a region by at most this many samples on each side (16 kHz). */
const ROLL_SAMPLES = 32_000;

/**
 * The archived blocks of these episodes that nothing else needs: no other
 * episode still keeping its audio, no region outside every episode younger
 * than the grace (or open), and no kept range reaches them.
 */
function expiringChunks(
  db: Database,
  episodeIds: readonly number[],
  nowMs: number,
): ExpiringChunk[] {
  const going = new Set(episodeIds);
  const blocks = db.statement(
    `SELECT c.id, c.sample_start, c.sample_count, c.archive_rel_path, c.archive_byte_offset,
       c.byte_length, f.rel_path
     FROM chunks c JOIN spool_files f ON f.id = c.spool_file_id
     WHERE c.track_run_id = ? AND c.sample_start < ? AND c.sample_start + c.sample_count > ?
       AND c.audio_state = 'archived' AND c.archive_rel_path IS NOT NULL`,
  );
  const neighbours = db.statement(
    `SELECT r.id, r.sample_start, r.sample_end, r.wall_end_ms, r.state,
       (SELECT group_concat(er.episode_id) FROM episode_regions er
        WHERE er.speech_region_id = r.id) AS episodes
     FROM speech_regions r
     WHERE r.track_run_id = ? AND r.sample_start < ? AND coalesce(r.sample_end, ?) > ?`,
  );
  const stillHeard = db.statement("SELECT audio_gone_at_ms FROM episodes WHERE id = ?");
  const keptRanges = db.statement(
    `SELECT sample_start, sample_end FROM kept_audio
     WHERE track_run_id = ? AND sample_start < ? AND sample_end > ?`,
  );
  const out = new Map<number, ExpiringChunk>();
  for (const episodeId of episodeIds) {
    for (const range of episodeAudioRanges(db, episodeId)) {
      const candidates = blocks.all(range.trackRunId, range.to, range.from).map((row) => ({
        id: int(row, "id"),
        start: int(row, "sample_start"),
        end: int(row, "sample_start") + int(row, "sample_count"),
        row,
      }));
      if (candidates.length === 0) continue;
      // Judged on the blocks themselves, which reach past the range.
      const from = Math.min(...candidates.map((block) => block.start));
      const to = Math.max(...candidates.map((block) => block.end));
      const needed = neighbours
        .all(range.trackRunId, to + ROLL_SAMPLES, Number.MAX_SAFE_INTEGER, from - ROLL_SAMPLES)
        .filter((row) => {
          const ids = (strOrNull(row, "episodes") ?? "")
            .split(",")
            .filter((id) => id !== "")
            .map(Number);
          if (ids.length === 0) {
            const end = intOrNull(row, "wall_end_ms");
            return (
              str(row, "state") === "open" || end === null || end + TRANSCRIPT_GRACE_MS > nowMs
            );
          }
          return ids.some((id) => {
            if (going.has(id)) return false;
            const episode = stillHeard.get(id);
            return episode !== undefined && intOrNull(episode, "audio_gone_at_ms") === null;
          });
        })
        .map((row) => ({
          from: int(row, "sample_start") - ROLL_SAMPLES,
          to: (intOrNull(row, "sample_end") ?? Number.MAX_SAFE_INTEGER) + ROLL_SAMPLES,
        }));
      const kept = keptRanges
        .all(range.trackRunId, to, from)
        .map((row) => ({ from: int(row, "sample_start"), to: int(row, "sample_end") }));
      for (const block of candidates) {
        const reached = (other: { from: number; to: number }) =>
          block.start < other.to && block.end > other.from;
        if (needed.some(reached) || kept.some(reached)) continue;
        out.set(block.id, {
          chunkId: block.id,
          archiveRelPath: str(block.row, "archive_rel_path"),
          archiveByteOffset: int(block.row, "archive_byte_offset"),
          byteLength: int(block.row, "byte_length"),
          spoolRelPath: str(block.row, "rel_path"),
        });
      }
    }
  }
  return [...out.values()];
}

/**
 * Records an expiry once the bytes are zeroed: the blocks are `expired` with
 * no archive left, and the episodes' audio is gone. Text stays.
 */
export function commitAudioExpiry(
  db: Database,
  expiry: Pick<AudioExpiry, "episodeIds" | "chunks">,
  nowMs: number,
): void {
  transaction(db, () => {
    const expire = db.statement(
      `UPDATE chunks SET audio_state = 'expired', archive_rel_path = NULL, archive_byte_offset = NULL
       WHERE id = ? AND audio_state = 'archived'`,
    );
    for (const chunk of expiry.chunks) expire.run(chunk.chunkId);
    const gone = db.statement(
      "UPDATE episodes SET audio_gone_at_ms = coalesce(audio_gone_at_ms, ?), updated_at_ms = ? WHERE id = ?",
    );
    for (const id of expiry.episodeIds) gone.run(nowMs, nowMs, id);
  });
}
