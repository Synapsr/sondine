import { GROUPING_V4 } from "@sondine/core";
import { transaction, type Database } from "./database";
import { cancelJobs, mergeEpisodes, splitEpisode } from "./episode-boundaries";
import { deleteEnd, insertEnd, type StoredEnd } from "./episode-ends";
import { episodeKindOverride } from "./episode-kind";
import { bumpInputGeneration } from "./publish";
import { int, intOrNull, str, strOrNull, type Row } from "./rows";
import type { UndoRefusal } from "./undo";

// ⌘Z on « Terminer » (ADR 044, ADR 017). Speech goes on arriving, so no
// snapshot could be compared: the end is taken back, and what was heard since
// joins the episode again as if it had never been ended. An episode still
// open, or closed while its continuation is open, is grouped again by the
// next pass; closed ones are merged.

/** How far an episode's last sentence may read past the end it was cut at. */
const END_SLACK_MS = 1_000;

const gapMs = (context: string | null): number =>
  Number(
    (context === "call"
      ? GROUPING_V4.callSilenceGapNs
      : context === "media"
        ? GROUPING_V4.mediaGapNs
        : GROUPING_V4.inPersonGapNs) / 1_000_000n,
  );

export type EndUndone =
  | {
      readonly ok: true;
      /** The episode that was ended. */
      readonly episodeId: number;
      /** The episode merged into it; null when a pass joins them, or nothing followed. */
      readonly mergedId: number | null;
    }
  | { readonly ok: false; readonly reason: UndoRefusal };

const CHANGED = { ok: false, reason: "changed" } as const;

/** The episode an end is the end of, from its anchor. */
function endedEpisode(db: Database, end: StoredEnd): Row | null {
  return (
    db
      .statement(
        `SELECT e.* FROM episodes e
         JOIN episode_regions m ON m.episode_id = e.id
         JOIN speech_regions r ON r.id = m.speech_region_id
         WHERE r.track_run_id = ? AND m.slice_sample_start <= ?
           AND coalesce(m.slice_sample_end, r.sample_end, ${Number.MAX_SAFE_INTEGER}) > ?
         ORDER BY e.id LIMIT 1`,
      )
      .get(end.trackRunId, end.sampleStart, end.sampleStart) ?? null
  );
}

/** The episode an end is the end of; null once its audio is in none. */
export function endedEpisodeId(db: Database, end: StoredEnd): number | null {
  const episode = endedEpisode(db, end);
  return episode === null ? null : int(episode, "id");
}

const endedPast = (episode: Row, end: StoredEnd): boolean =>
  (intOrNull(episode, "ended_at_ms") ?? 0) > end.atWallMs + END_SLACK_MS;

/** What goes on from an ended episode: the rest of its last sentence, else what followed before the gap. */
function continuation(db: Database, episode: Row, end: StoredEnd): Row | null {
  const id = int(episode, "id");
  const context = strOrNull(episode, "context");
  const endedAt = intOrNull(episode, "ended_at_ms") ?? int(episode, "started_at_ms");
  return (
    db
      .statement(
        `SELECT e.* FROM episode_regions m
         JOIN episode_regions o ON o.speech_region_id = m.speech_region_id
           AND o.slice_sample_start = m.slice_sample_end
         JOIN episodes e ON e.id = o.episode_id
         WHERE m.episode_id = ? LIMIT 1`,
      )
      .get(id) ??
    db
      .statement(
        `SELECT * FROM episodes
         WHERE started_at_ms >= ? AND started_at_ms < ? AND id <> ? AND context IS ?
           AND (context = 'in_person' OR primary_app_id IS ?) AND page_key IS ?
         ORDER BY started_at_ms, id LIMIT 1`,
      )
      .get(
        end.atWallMs - END_SLACK_MS,
        endedAt + gapMs(context),
        id,
        context,
        intOrNull(episode, "primary_app_id"),
        strOrNull(episode, "page_key"),
      ) ??
    null
  );
}

/** Takes an end back; the caller runs a grouping pass. */
export function undoEnd(db: Database, end: StoredEnd, nowMs: number): EndUndone {
  return transaction(db, (): EndUndone => {
    const episode = endedEpisode(db, end);
    if (episode === null) return CHANGED;
    const episodeId = int(episode, "id");
    if (str(episode, "state") === "open") {
      return deleteEnd(db, end.id) ? { ok: true, episodeId, mergedId: null } : CHANGED;
    }
    // Merged since, its audio gone, or its type set: no longer what the end left.
    if (
      endedPast(episode, end) ||
      intOrNull(episode, "audio_gone_at_ms") !== null ||
      episodeKindOverride(db, episodeId) !== null
    ) {
      return CHANGED;
    }
    const next = continuation(db, episode, end);
    if (next !== null && str(next, "state") === "closed") {
      const mergedId = int(next, "id");
      const merged = mergeEpisodes(db, { episodeId, otherId: mergedId, continues: true, nowMs });
      if (!merged.ok) return CHANGED;
      if (!deleteEnd(db, end.id)) throw new Error(`end ${end.id} vanished`);
      return { ok: true, episodeId, mergedId };
    }
    if (!deleteEnd(db, end.id)) return CHANGED;
    const endedAt = intOrNull(episode, "ended_at_ms") ?? nowMs;
    // Nothing followed and its silence is past the gap: it would be closed anyway.
    if (next !== null || nowMs - endedAt < gapMs(strOrNull(episode, "context"))) {
      cancelJobs(db, episodeId, nowMs);
      db.statement(
        `UPDATE episodes SET state = 'open', analysis_state = 'pending', size_state = 'provisional'
         WHERE id = ?`,
      ).run(episodeId);
      // What was running for it is refused, and it is due again when it closes.
      bumpInputGeneration(db, episodeId, nowMs);
    }
    return { ok: true, episodeId, mergedId: null };
  });
}

export type EndRedone =
  | {
      readonly ok: true;
      readonly episodeId: number;
      /** The part after the end, when the episode had closed across it. */
      readonly newEpisodeId: number | null;
    }
  | { readonly ok: false; readonly reason: UndoRefusal };

/** Puts an end back; the caller runs a grouping pass. */
export function redoEnd(db: Database, end: StoredEnd, nowMs: number): EndRedone {
  return transaction(db, (): EndRedone => {
    const episode = endedEpisode(db, end);
    if (episode === null) return CHANGED;
    const episodeId = int(episode, "id");
    const taken = db.statement("SELECT 1 FROM user_assertions WHERE id = ?").get(end.id);
    if (taken !== undefined) return CHANGED;
    let newEpisodeId: number | null = null;
    if (str(episode, "state") === "closed" && endedPast(episode, end)) {
      const split = splitEpisode(db, { episodeId, atMs: end.atWallMs, nowMs });
      if (!split.ok) return CHANGED;
      newEpisodeId = split.value.newEpisodeId;
    }
    insertEnd(db, end);
    return { ok: true, episodeId, newEpisodeId };
  });
}
