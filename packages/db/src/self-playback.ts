import { transaction, type Database } from "./database";
import { int, oneOfValues } from "./rows";
import { playbackRoutes, type PlaybackRoute } from "./schema/enums";

// When Sondine played a recording back, and through what (ADR 020,
// "Sondine's own sound"): the player renews a lease every few seconds while
// it plays and ends it when it stops. The grouping leaves out the mic speech
// heard during a playback on the speakers (the room heard Sondine, not a
// person) unless its judgement against the `self:playback` reference found
// someone speaking (ADR 035, `self-echo.ts`).

/** How long one renewal covers: past it, a player that went silent (closed, crashed) stops. */
export const PLAYBACK_LEASE_MS = 6_000;

/**
 * The player plays now through `route`: the current playback's lease is
 * renewed, or a new one starts (after a pause, a gap, or another route).
 */
export function notePlaying(
  db: Database,
  input: { readonly route: PlaybackRoute; readonly nowMs: number },
): void {
  transaction(db, () => {
    const current = db
      .statement(
        `SELECT id, route FROM self_playbacks
         WHERE ended_wall_ms >= ? ORDER BY started_wall_ms DESC, id DESC LIMIT 1`,
      )
      .get(input.nowMs);
    const leaseEnd = input.nowMs + PLAYBACK_LEASE_MS;
    if (current !== undefined && current["route"] === input.route) {
      db.statement(
        "UPDATE self_playbacks SET ended_wall_ms = max(ended_wall_ms, ?), updated_at_ms = ? WHERE id = ?",
      ).run(leaseEnd, input.nowMs, int(current, "id"));
      return;
    }
    // Another route from now on: the playback that went the other way ends here.
    if (current !== undefined) endAt(db, int(current, "id"), input.nowMs);
    db.statement(
      `INSERT INTO self_playbacks (started_wall_ms, ended_wall_ms, route, updated_at_ms)
       VALUES (?, ?, ?, ?)`,
    ).run(input.nowMs, leaseEnd, input.route, input.nowMs);
  });
}

/**
 * The default output changed (`route` now): a playback going on goes the
 * new way from now, without waiting for the player's next renewal.
 */
export function reroutePlayback(
  db: Database,
  input: { readonly route: PlaybackRoute; readonly nowMs: number },
): void {
  transaction(db, () => {
    const current = db
      .statement(
        `SELECT id, route, ended_wall_ms FROM self_playbacks
         WHERE ended_wall_ms > ? ORDER BY started_wall_ms DESC, id DESC LIMIT 1`,
      )
      .get(input.nowMs);
    if (current === undefined || current["route"] === input.route) return;
    endAt(db, int(current, "id"), input.nowMs);
    db.statement(
      `INSERT INTO self_playbacks (started_wall_ms, ended_wall_ms, route, updated_at_ms)
       VALUES (?, ?, ?, ?)`,
    ).run(input.nowMs, int(current, "ended_wall_ms"), input.route, input.nowMs);
  });
}

/** The player stopped (paused, ended, closed): the current playback ends now. */
export function noteStopped(db: Database, nowMs: number): void {
  transaction(db, () => {
    const current = db
      .statement("SELECT id FROM self_playbacks WHERE ended_wall_ms > ? LIMIT 1")
      .get(nowMs);
    if (current !== undefined) endAt(db, int(current, "id"), nowMs);
  });
}

function endAt(db: Database, id: number, nowMs: number): void {
  db.statement(
    `UPDATE self_playbacks SET ended_wall_ms = max(started_wall_ms, ?), updated_at_ms = ?
     WHERE id = ?`,
  ).run(nowMs, nowMs, id);
}

export interface SelfPlayback {
  readonly startedWallMs: number;
  readonly endedWallMs: number;
  readonly route: PlaybackRoute;
}

/** Playbacks that meet `[fromWallMs, toWallMs]`, in start order. */
export function loadSelfPlaybacksBetween(
  db: Database,
  fromWallMs: number,
  toWallMs: number,
): SelfPlayback[] {
  return db
    .statement(
      `SELECT started_wall_ms, ended_wall_ms, route FROM self_playbacks
       WHERE started_wall_ms <= ? AND ended_wall_ms >= ?
       ORDER BY started_wall_ms, id`,
    )
    .all(toWallMs, fromWallMs)
    .map((row) => ({
      startedWallMs: int(row, "started_wall_ms"),
      endedWallMs: int(row, "ended_wall_ms"),
      route: oneOfValues(row, "route", playbackRoutes),
    }));
}
