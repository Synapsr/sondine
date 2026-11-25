import { transaction, type Database } from "./database";
import { outside, type Interval } from "./people";
import { int, intOrNull, str, strOrNull } from "./rows";

// The user's word on what an episode is (M2; ADR 007): a conversation, a
// moment, or media. It is a `size_override` or `context_override` assertion
// anchored to the episode's longest member slice, so it follows the audio
// through splits and merges. Wherever the size of a closed episode is decided
// again (after a transcript, a repair, a split or a merge), the override is
// applied last; the automatic choice is kept in `kind_inputs` (`autoSize`,
// `autoContext`) for « Automatique ».

export type EpisodeKind = "conversation" | "moment" | "media";

interface Overrides {
  readonly size: "conversation" | "moment" | null;
  readonly context: "media" | "in_person" | null;
  /** The automatic context when the context override was made (no later decision changes it). */
  readonly autoContext: string | null;
}

const KINDS = "('size_override', 'context_override')";

/** The overrides whose anchor lies in the episode's audio, newest first. */
function overridesOf(db: Database, episodeId: number): Overrides {
  const rows = db
    .statement(
      `SELECT a.kind, a.payload FROM user_assertions a
       JOIN speech_regions r ON r.track_run_id = a.track_run_id
       JOIN episode_regions m ON m.speech_region_id = r.id AND m.episode_id = ?
       WHERE a.kind IN ${KINDS} AND a.revoked_at_ms IS NULL
         AND a.sample_start < coalesce(m.slice_sample_end, r.sample_end, a.sample_start + 1)
         AND a.sample_end > m.slice_sample_start
       ORDER BY a.created_at_ms DESC, a.id DESC`,
    )
    .all(episodeId);
  let size: Overrides["size"] = null;
  let context: Overrides["context"] = null;
  let autoContext: string | null = null;
  for (const row of rows) {
    const payload = JSON.parse(str(row, "payload")) as {
      size?: unknown;
      context?: unknown;
      auto?: unknown;
    };
    if (str(row, "kind") === "size_override" && size === null) {
      if (payload.size === "conversation" || payload.size === "moment") size = payload.size;
    } else if (str(row, "kind") === "context_override" && context === null) {
      if (payload.context === "media" || payload.context === "in_person") {
        context = payload.context;
        autoContext = typeof payload.auto === "string" ? payload.auto : null;
      }
    }
  }
  return { size, context, autoContext };
}

/** What the user said the episode is; null when Sondine decides. */
export function episodeKindOverride(db: Database, episodeId: number): EpisodeKind | null {
  const { size, context } = overridesOf(db, episodeId);
  if (context === "media") return "media";
  return size;
}

/**
 * Applies the user's overrides to a closed episode, after any automatic
 * decision wrote its size and context; a no-op without overrides.
 */
export function applyKindOverride(db: Database, episodeId: number, nowMs: number): void {
  const { size, context, autoContext: anchored } = overridesOf(db, episodeId);
  if (size === null && context === null) return;
  const row = db
    .statement("SELECT size, context, kind_inputs FROM episodes WHERE id = ?")
    .get(episodeId);
  if (row === undefined) return;
  const inputs = JSON.parse(str(row, "kind_inputs")) as Record<string, unknown>;
  // The automatic choice: a decision just written holds the size (and drops
  // these keys); the context is never decided again, so it is the one the
  // override recorded.
  const autoSize = "autoSize" in inputs ? inputs["autoSize"] : strOrNull(row, "size");
  const autoContext =
    "autoContext" in inputs ? inputs["autoContext"] : (anchored ?? strOrNull(row, "context"));
  db.statement(
    `UPDATE episodes SET size = ?, context = ?, size_state = 'final', kind_inputs = ?, updated_at_ms = ?
     WHERE id = ?`,
  ).run(
    size ?? (typeof autoSize === "string" ? autoSize : null),
    context ?? (typeof autoContext === "string" ? autoContext : null),
    JSON.stringify({ ...inputs, autoSize, autoContext, rule: "manual-override" }),
    nowMs,
    episodeId,
  );
}

/**
 * Takes the episode's audio out of every override: one that also covers a
 * neighbour (a split leaves it across both) keeps its part there.
 */
function clearOverrides(db: Database, episodeId: number): void {
  const slices = new Map<number, Interval[]>();
  for (const row of db
    .statement(
      `SELECT r.track_run_id, m.slice_sample_start AS start,
         coalesce(m.slice_sample_end, r.sample_end) AS end
       FROM episode_regions m JOIN speech_regions r ON r.id = m.speech_region_id
       WHERE m.episode_id = ? ORDER BY start`,
    )
    .all(episodeId)) {
    const end = intOrNull(row, "end");
    if (end === null) continue;
    const track = slices.get(int(row, "track_run_id")) ?? [];
    track.push([int(row, "start"), end]);
    slices.set(int(row, "track_run_id"), track);
  }
  const remove = db.statement("DELETE FROM user_assertions WHERE id = ?");
  const keep = db.statement(
    `INSERT INTO user_assertions (kind, track_run_id, sample_start, sample_end, payload, origin, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const query = db.statement(
    `SELECT * FROM user_assertions WHERE kind IN ${KINDS} AND revoked_at_ms IS NULL
       AND track_run_id = ? AND sample_start < ? AND max(sample_end, sample_start + 1) > ?`,
  );
  for (const [trackRunId, intervals] of slices) {
    const first = intervals[0]?.[0] ?? 0;
    const last = Math.max(...intervals.map(([, end]) => end));
    for (const row of query.all(trackRunId, last, first)) {
      const anchor: Interval = [
        int(row, "sample_start"),
        Math.max(int(row, "sample_end"), int(row, "sample_start") + 1),
      ];
      const parts = outside(anchor, intervals);
      if (parts.length === 1 && parts[0]?.[0] === anchor[0] && parts[0][1] === anchor[1]) continue;
      remove.run(int(row, "id"));
      for (const [a, b] of parts) {
        keep.run(
          str(row, "kind"),
          trackRunId,
          a,
          b,
          str(row, "payload"),
          str(row, "origin"),
          int(row, "created_at_ms"),
        );
      }
    }
  }
}

/** The longest member slice: where an episode-wide assertion is anchored. */
function anchorOf(db: Database, episodeId: number) {
  return db
    .statement(
      `SELECT r.track_run_id, m.slice_sample_start AS start,
         coalesce(m.slice_sample_end, r.sample_end, m.slice_sample_start + 1) AS end
       FROM episode_regions m JOIN speech_regions r ON r.id = m.speech_region_id
       WHERE m.episode_id = ? ORDER BY end - start DESC, start LIMIT 1`,
    )
    .get(episodeId);
}

/**
 * Says what a closed episode is, or (`null`) hands it back to Sondine.
 * False when there is no such closed episode.
 */
export function setEpisodeKind(
  db: Database,
  input: { readonly episodeId: number; readonly kind: EpisodeKind | null; readonly nowMs: number },
): boolean {
  const { episodeId, kind, nowMs } = input;
  return transaction(db, () => {
    const row = db
      .statement("SELECT context, kind_inputs FROM episodes WHERE id = ? AND state = 'closed'")
      .get(episodeId);
    const anchor = anchorOf(db, episodeId);
    // An imported recording stays one: Today and forget leave it out by its context.
    if (row === undefined || anchor === undefined || row["context"] === "imported") return false;
    const before = overridesOf(db, episodeId);
    clearOverrides(db, episodeId);
    const inputs = JSON.parse(str(row, "kind_inputs")) as Record<string, unknown>;
    const auto = {
      size: "autoSize" in inputs ? inputs["autoSize"] : null,
      context:
        "autoContext" in inputs
          ? inputs["autoContext"]
          : before.context === null
            ? strOrNull(row, "context")
            : before.autoContext,
    };
    if (kind === null) {
      // Back to Sondine's own choice.
      const { autoSize: _size, autoContext: _context, ...rest } = inputs;
      db.statement(
        `UPDATE episodes SET size = coalesce(?, size), context = ?, kind_inputs = ?,
           updated_at_ms = ? WHERE id = ?`,
      ).run(
        typeof auto.size === "string" ? auto.size : null,
        typeof auto.context === "string" ? auto.context : null,
        JSON.stringify(rest),
        nowMs,
        episodeId,
      );
      return true;
    }
    const insert = db.statement(
      `INSERT INTO user_assertions (kind, track_run_id, sample_start, sample_end, payload, origin, created_at_ms)
       VALUES (?, ?, ?, ?, ?, 'app', ?)`,
    );
    const at = [int(anchor, "track_run_id"), int(anchor, "start"), int(anchor, "end")] as const;
    const context = typeof auto.context === "string" ? auto.context : null;
    if (kind === "media") {
      insert.run(
        "context_override",
        ...at,
        JSON.stringify({ context: "media", auto: context }),
        nowMs,
      );
    } else {
      insert.run("size_override", ...at, JSON.stringify({ size: kind }), nowMs);
      // Not media after all: it reads as speech in the room.
      if (context === "media") {
        insert.run(
          "context_override",
          ...at,
          JSON.stringify({ context: "in_person", auto: context }),
          nowMs,
        );
      }
    }
    applyKindOverride(db, episodeId, nowMs);
    return true;
  });
}
