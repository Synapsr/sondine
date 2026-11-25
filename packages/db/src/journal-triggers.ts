import type { Database } from "./database";
import { otherIdSql, sourceHoleSql, sourceIdSql } from "./same-moment-sql";

/**
 * The journal's deletion rules, kept by the database itself so no path that
 * removes text (a recording, a passage, « oublier », a retranscription, a
 * split) can leave a generated line behind. Created at every open, not in a
 * migration: drizzle-kit rebuilds a table to alter it, which drops its
 * triggers (see the search migration); one whose text changed is replaced.
 *
 * - Deleting any sentence of an episode deletes the episode's journal runs,
 *   and with them every line and citation: a line may draw on a sentence it
 *   does not cite.
 * - Changing a sentence (a correction, a voice relabelled) marks them stale:
 *   still shown, written again by the queue.
 * - A tombstone deletes the marks whose cited audio it meets, with the same
 *   rules as `findDeletedRanges` (half-open spans, a point is `[t, t + 1)`,
 *   imported recordings take no `all` tombstone), and empties the model's
 *   words kept in any mark of a conversation it reaches: they may draw on a
 *   sentence they did not cite. A conversation is found by wall time, except
 *   one recorded by the phone or imported (track run kind `phone`), which only
 *   a tombstone on its own run reaches: a forget of the Mac's audio at the
 *   same minutes keeps its journal (ADR 032).
 * - Over the time two recordings of the same meeting share (ADR 032), what
 *   the journal leaves out of the one that does not feed it depends on the
 *   link (made, gone, its source, offset or shared time), on whether the
 *   journal reads the source (its state, type, size, transcript) and on the
 *   source's holes (a tombstone over the shared time). Any change to one of
 *   them deletes the runs of the other recording, before and after, so it is
 *   written again with exactly what it should hold now.
 */
export const JOURNAL_TRIGGERS: readonly string[] = [
  `CREATE TRIGGER IF NOT EXISTS journal_segment_deleted BEFORE DELETE ON segments
   BEGIN
     DELETE FROM journal_runs WHERE episode_id = old.episode_id;
   END`,
  `CREATE TRIGGER IF NOT EXISTS journal_segment_moved BEFORE UPDATE OF episode_id, run_id ON segments
   BEGIN
     DELETE FROM journal_runs WHERE episode_id IN (old.episode_id, new.episode_id);
   END`,
  `CREATE TRIGGER IF NOT EXISTS journal_segment_changed
   AFTER UPDATE OF text, speaker_label, start_ms, track_run_id, sample_start, sample_end ON segments
   BEGIN
     UPDATE journal_runs SET stale = 1 WHERE episode_id = new.episode_id AND stale = 0;
   END`,
  `CREATE TRIGGER IF NOT EXISTS journal_mark_tombstone AFTER INSERT ON deleted_ranges
   BEGIN
     UPDATE journal_marks SET generated_text = ''
     WHERE generated_text <> '' AND source_start_ms < new.wall_end_ms
       AND max(source_end_ms, source_start_ms + 1) > new.wall_start_ms
       AND (
         -- A mark from the Mac's audio: any tombstone in its time.
         EXISTS (SELECT 1 FROM journal_mark_spans s JOIN track_runs t ON t.id = s.track_run_id
                 WHERE s.mark_id = journal_marks.id AND t.source_kind <> 'phone')
         OR NOT EXISTS (SELECT 1 FROM journal_mark_spans s WHERE s.mark_id = journal_marks.id)
         -- A phone recording's or an import's: only a tombstone on its own run;
         -- what the Mac forgot at the same minutes is another conversation.
         OR (new.scope = 'track_run' AND EXISTS (SELECT 1 FROM journal_mark_spans s
                 WHERE s.mark_id = journal_marks.id AND s.track_run_id = new.track_run_id)));
     DELETE FROM journal_marks WHERE id IN (
       SELECT s.mark_id FROM journal_mark_spans s
       WHERE (new.scope = 'track_run' AND s.track_run_id = new.track_run_id
              AND s.sample_start < new.sample_end
              AND max(s.sample_end, s.sample_start + 1) > new.sample_start)
          OR (new.scope = 'all'
              AND s.wall_start_ms < new.wall_end_ms
              AND max(s.wall_end_ms, s.wall_start_ms + 1) > new.wall_start_ms
              AND NOT EXISTS (SELECT 1 FROM track_runs t
                              WHERE t.id = s.track_run_id AND t.source_kind = 'phone')));
   END`,
  `CREATE TRIGGER IF NOT EXISTS journal_same_moment_linked AFTER INSERT ON same_moment_links
   WHEN new.linked = 1
   BEGIN
     DELETE FROM journal_runs WHERE episode_id = ${otherIdSql("new")};
   END`,
  `CREATE TRIGGER IF NOT EXISTS journal_same_moment_unlinked AFTER DELETE ON same_moment_links
   WHEN old.linked = 1
   BEGIN
     DELETE FROM journal_runs WHERE episode_id = ${otherIdSql("old")};
   END`,
  `CREATE TRIGGER IF NOT EXISTS journal_same_moment_changed AFTER UPDATE ON same_moment_links
   WHEN old.linked IS NOT new.linked OR old.journal_source IS NOT new.journal_source
     OR old.offset_ms IS NOT new.offset_ms OR old.shared_from_ms IS NOT new.shared_from_ms
     OR old.shared_to_ms IS NOT new.shared_to_ms
   BEGIN
     DELETE FROM journal_runs WHERE old.linked = 1 AND episode_id = ${otherIdSql("old")};
     DELETE FROM journal_runs WHERE new.linked = 1 AND episode_id = ${otherIdSql("new")};
   END`,
  `CREATE TRIGGER IF NOT EXISTS journal_same_moment_hole AFTER INSERT ON deleted_ranges
   BEGIN
     DELETE FROM journal_runs WHERE episode_id IN (
       SELECT ${otherIdSql("l")} FROM same_moment_links l
       WHERE l.linked = 1 AND ${sourceHoleSql("l", "new")});
   END`,
  `CREATE TRIGGER IF NOT EXISTS journal_same_moment_source_kind AFTER UPDATE OF state, context, size, voiced_ms ON episodes
   WHEN old.state IS NOT new.state OR old.context IS NOT new.context OR old.size IS NOT new.size
     OR old.voiced_ms IS NOT new.voiced_ms
   BEGIN
     DELETE FROM journal_runs WHERE episode_id IN (
       SELECT ${otherIdSql("l")} FROM same_moment_links l
       WHERE l.linked = 1 AND ${sourceIdSql("l")} = new.id);
   END`,
  `CREATE TRIGGER IF NOT EXISTS journal_same_moment_source_transcribed AFTER INSERT ON episode_analysis
   WHEN new.stage = 'asr'
   BEGIN
     DELETE FROM journal_runs WHERE episode_id IN (
       SELECT ${otherIdSql("l")} FROM same_moment_links l
       WHERE l.linked = 1 AND ${sourceIdSql("l")} = new.episode_id);
   END`,
  `CREATE TRIGGER IF NOT EXISTS journal_same_moment_source_untranscribed AFTER DELETE ON episode_analysis
   WHEN old.stage = 'asr'
   BEGIN
     DELETE FROM journal_runs WHERE episode_id IN (
       SELECT ${otherIdSql("l")} FROM same_moment_links l
       WHERE l.linked = 1 AND ${sourceIdSql("l")} = old.episode_id);
   END`,
];

/**
 * Creates the triggers, replacing those an older build made: a trigger whose
 * rule changed (ADR 032 moved the tombstone's to the track run's kind) must
 * not survive under its old body. A trigger on a table this database does
 * not have yet, or reading the links of ADR 032 before their table exists
 * (opened with older migrations, as a restore test does), waits for the open
 * that creates it: a later migration rebuilding a table it reads would fail.
 */
export function ensureJournalTriggers(db: Database): void {
  for (const trigger of JOURNAL_TRIGGERS) {
    const name = /CREATE TRIGGER IF NOT EXISTS (\w+)/.exec(trigger)?.[1];
    if (name === undefined) throw new Error("a journal trigger has no name");
    const table = / ON (\w+)\s/.exec(trigger)?.[1];
    if (table === undefined) throw new Error(`the journal trigger ${name} names no table`);
    const needs = trigger.includes("same_moment_links") ? [table, "same_moment_links"] : [table];
    const missing = needs.some(
      (needed) =>
        db.client
          .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get(needed) === undefined,
    );
    if (missing) continue;
    const stored = db.client
      .prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?")
      .get(name)?.["sql"];
    // SQLite stores the statement without `IF NOT EXISTS`.
    if (stored === trigger.replace("IF NOT EXISTS ", "")) continue;
    db.client.exec(`DROP TRIGGER IF EXISTS ${name}`);
    db.client.exec(trigger);
  }
}

/** Drops every journal trigger; `ensureJournalTriggers` makes them again. */
export function dropJournalTriggers(db: Database): void {
  for (const trigger of JOURNAL_TRIGGERS) {
    const name = /CREATE TRIGGER IF NOT EXISTS (\w+)/.exec(trigger)?.[1];
    if (name !== undefined) db.client.exec(`DROP TRIGGER IF EXISTS ${name}`);
  }
}
