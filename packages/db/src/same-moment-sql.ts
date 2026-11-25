// SQL over a `same_moment_links` row (ADR 032), shared by the journal's
// input and its triggers. No imports: the triggers are built when the
// database module loads.

/** The id of the episode a link's `<alias>` row names as the journal's source. */
export const sourceIdSql = (alias: string): string =>
  `CASE ${alias}.journal_source WHEN 'phone' THEN ${alias}.phone_episode_id ELSE ${alias}.mac_episode_id END`;

/** The id of the other one, whose lines over the shared time the journal leaves out. */
export const otherIdSql = (alias: string): string =>
  `CASE ${alias}.journal_source WHEN 'phone' THEN ${alias}.mac_episode_id ELSE ${alias}.phone_episode_id END`;

/**
 * Tombstones `<t>` (a `deleted_ranges` row) that cut what the source of link
 * `<l>` heard over the shared time, on the source's own clock: on the
 * phone's run for a phone source; on any of the Mac's runs (or every run,
 * scope `all`) for the Mac's.
 */
export const sourceHoleSql = (l: string, t: string): string => `(CASE ${l}.journal_source
    WHEN 'phone' THEN ${t}.scope = 'track_run' AND ${t}.track_run_id IN (
        SELECT hr.track_run_id FROM episode_regions her JOIN speech_regions hr ON hr.id = her.speech_region_id
        WHERE her.episode_id = ${l}.phone_episode_id)
      AND ${t}.wall_start_ms < ${l}.shared_to_ms - ${l}.offset_ms
      AND ${t}.wall_end_ms > ${l}.shared_from_ms - ${l}.offset_ms
    ELSE (${t}.scope = 'all' OR EXISTS (SELECT 1 FROM track_runs ht
        WHERE ht.id = ${t}.track_run_id AND ht.source_kind <> 'phone'))
      AND ${t}.wall_start_ms < ${l}.shared_to_ms AND ${t}.wall_end_ms > ${l}.shared_from_ms
  END)`;
