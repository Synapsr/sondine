# @sondine/db

The SQLite data layer, used by the `core` utility process (the single
writer). It uses `node:sqlite` (`DatabaseSync`) with Drizzle ORM
`1.0.0-rc.5` (`drizzle-orm/node-sqlite`) for ordinary queries, and
hand-reviewed SQL for migrations, full-text search, publication, and
deletion. See architecture §6 and ADR 006.

Everything here is synchronous: `node:sqlite` has no async API, and a
transaction callback must never `await`.

```ts
import { openDatabase, transaction, recordSpoolCommit, publishAnalysis } from "@sondine/db";

const db = openDatabase(`${dataDir}/sondine.db`); // pragmas + pending migrations
transaction(db, () => {
  for (const event of batch) recordSpoolCommit(db, event); // one transaction per tick
});
const result = publishAnalysis(db, {
  episodeId,
  stage: "asr",
  runId,
  inputGeneration,
  segments,
  turns,
});
```

## Connection

`openDatabase(path, { migrationsFolder?, migrate? })` sets, in order:
`journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`,
`busy_timeout=2000`, `secure_delete=ON`, `wal_autocheckpoint=1000`,
`journal_size_limit=67108864`, `temp_store=MEMORY`, `cache_size=-8192`.
`synchronous=NORMAL` is safe because the spool files and idempotent import
are the durability source for capture.

`transaction(db, fn)` runs `BEGIN IMMEDIATE … COMMIT`, or a savepoint when a
transaction is already open, so every import function can run alone or
inside one batch.

## Tables

People and identity (`people`, `voice_profiles`, `exemplars`,
`identity_links`) and the search side tables (`terms`, trigram) are not
created yet; they arrive by migration in M3.

| Group      | Table                  | Holds                                                                                                                                                                                                |
| ---------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capture    | `devices`              | Audio devices by CoreAudio UID, transport, input/output                                                                                                                                              |
|            | `apps`                 | Apps by bundle ID                                                                                                                                                                                    |
|            | `process_incarnations` | (pid, start time) with the attribution evidence and confidence                                                                                                                                       |
|            | `track_runs`           | One continuous opening of a track (`input:<uid>`, `app:<bundle>`, `system:other`, `phone:<id>`), keyed by the helper's run id; `open → closed → sealed`                                              |
|            | `epochs`               | Timing epochs within a run: timebase, anchor triple, drift, alignment uncertainty                                                                                                                    |
|            | `spool_files`          | 10-minute PCM16 files of a run and their committed size                                                                                                                                              |
|            | `chunks`               | One committed spool block each (offset, length, first sample, clocks, CRC32); `audio_state: present \| archived \| expired \| deleted`                                                               |
|            | `speech_regions`       | VAD regions per run, by sample range, with the voice the VAD heard in them; `open \| closed`; on `system:other`, the app its attribution named at the open                                           |
|            | `gaps`                 | Explicit holes in capture, with a reason                                                                                                                                                             |
|            | `calls`                | Helper call spans (call app, call daemon, browser) by call id, on wall and continuous clocks; `ended \| lost`                                                                                        |
|            | `listens`              | Helper listen spans (other apps holding a microphone: dictation apps, the system's speech recognition) by listen id, with the calls' replay rules (ADR 020)                                          |
|            | `foreground_spans`     | The app in front over part of a closed speech region, in run samples and wall time (ADR 022); deleted with the region, cut by deletions                                                              |
| Episodes   | `episodes`             | `context: call \| in_person \| media \| mixed`, `size: trace \| moment \| conversation` (+ `size_state`), `analysis_state`, `input_generation`, grouping and classifier versions, `kind_inputs` JSON |
|            | `episode_regions`      | Regions grouped into an episode by sample slice (`slice_sample_start`, `slice_sample_end` null to the region's end); a region cut by a split or the 3 h cap has one slice per episode                |
| Analysis   | `analysis_runs`        | One stage of one engine pass: engine provenance, input hash and generation, status, coverage, metrics JSON                                                                                           |
|            | `episode_analysis`     | Current run per (episode, stage); written only by publish                                                                                                                                            |
|            | `segments`             | Transcript segments of the current runs, words packed in a BLOB                                                                                                                                      |
|            | `speaker_turns`        | Speaker turns (overlaps allowed)                                                                                                                                                                     |
|            | `episode_speakers`     | One row per speaker label of a run, ordered by first appearance                                                                                                                                      |
| Assertions | `user_assertions`      | User corrections anchored to `(track_run_id, sample_start, sample_end)`; `revoked_at_ms` undoes one                                                                                                  |
| Context    | `context_items`        | Notes, links, images and files the user added to a conversation (ADR 024), anchored to `(track_run_id, anchor_sample)` inside a member slice; a pinned one keeps its sentence's span                 |
|            | `context_fts`          | FTS5 over `context_items.search_text` (the fr-norm form of a note, a link's title and address, a file's name), external content, `secure-delete` on                                                  |
|            | `deleted_ranges`       | Deletion tombstones: `all` (wall-clock range) or `track_run` (sample range)                                                                                                                          |
| Work       | `jobs`, `job_attempts` | Durable queue; one active job per `dedupe_key`                                                                                                                                                       |
| Settings   | `settings`             | Key → JSON value                                                                                                                                                                                     |
|            | `identity_rules`       | Recognise voices or not: global, per app, device, or episode                                                                                                                                         |
|            | `privacy_zone_spans`   | When each private zone was on, with its outcome and situation (ADR 029)                                                                                                                              |
|            | `situation_spans`      | Screen away and the networks the Mac was on, from the helper (keyed hashes)                                                                                                                          |
|            | `kept_audio`           | Audio ranges the user keeps past the spool and every duration: « Garder l'audio » (`recording`) and « Garder les 2 dernières minutes » (`moment`)                                                    |
| Phone      | `phone_recordings`     | Recordings the iPhone app made, by their header's id; a deleted one stays as a tombstone (ADR 032)                                                                                                   |
|            | `phone_devices`        | Paired phones: a credential's SHA-256, last contact, counts of uploads, reads and deletions (ADR 008)                                                                                                |
|            | `phone_operations`     | Outbox operations a phone sent and the Mac did, by their id, so a retry does nothing twice                                                                                                           |
|            | `phone_uploads`        | What a phone announced (length, SHA-256) for a part in `phone-inbox/`                                                                                                                                |
| Search     | `segments_fts`         | FTS5 over `segments.search_text` (fr-norm form of `text`, ADR 016), external content, `unicode61 remove_diacritics 2`, `prefix='2 3'`, FTS5 `secure-delete` on                                       |
| —          | `schema_migrations`    | Applied migrations (name, sha256, time); owned by the runner                                                                                                                                         |

Conventions:

- Statuses are `CHECK (… IN (…))` enums built from the lists in
  `src/schema/enums.ts`, which also give the TypeScript unions.
- Wall-clock times are integer milliseconds (`*_ms`); positions inside a
  track run are sample indices at the run's rate (16 kHz). Monotonic clocks
  are microseconds (`*_us`) because nanosecond values exceed 2^53, which
  `node:sqlite` cannot read as numbers.
- Word timings (`segments.words`) use the format in `src/words.ts`
  (`packWords` / `unpackWords`), about 6 bytes per word.

## Migrations

The Drizzle schema in `src/schema/` is the only schema source. drizzle-kit
writes `drizzle/<timestamp>_<name>/migration.sql` and `snapshot.json`:

```bash
pnpm --filter @sondine/db db:generate --name <change>        # from schema changes
pnpm --filter @sondine/db db:generate:custom --name <change> # hand-written SQL (FTS, data)
```

The runner (`migrate`, called by `openDatabase`) applies pending folders in
name order, each in its own transaction, and records them in
`schema_migrations`. It refuses a migration whose file changed after it was
applied and a database that has migrations this build does not know. Foreign
keys are turned off around the batch (drizzle-kit rebuilds SQLite tables to
alter them) and `PRAGMA foreign_key_check` runs before each commit. Never
edit a migration that has shipped; add a new one. A test fails if the schema
and the migrations disagree (`drizzle-kit generate --explain`).

The desktop build must ship the `drizzle/` folder and pass its location as
`migrationsFolder` (the default resolves next to this package's sources).

## Capture import

`upsertDevice`, `upsertApp`, `upsertTrackRun`, `recordEpoch`,
`recordSpoolFile`, `closeSpoolFile`, `recordSpoolCommit`,
`openSpeechRegion`, `closeSpeechRegion`, `recordGap`. Each returns a status
(`inserted`, `updated`, `unchanged`, `duplicate`, `skipped_deleted`,
`clamped`, `unknown`) and throws `ImportConflictError` when a replay
contradicts what is recorded (for example another CRC at the same offset).

- Replaying a manifest or the event stream is safe: commits are keyed by
  (spool file, byte offset), regions by (run, first sample), gaps by (run or
  track key, reason, start).
- Content that intersects a deleted range is refused: chunks, region opens,
  gaps. A region close that crosses a deleted range ends at the range start
  (`clamped`), or the region is removed when the range covers its start.
- Containers (track runs, epochs, spool files) are recorded even inside a
  deleted range; they hold no audio, and later content needs them. A refused
  commit still advances the file's committed size so recovery never
  truncates valid blocks after it.

## Publish rules

`publishAnalysis(db, { episodeId, stage, runId, inputGeneration, segments, turns })`
runs one `BEGIN IMMEDIATE` transaction and returns `{ published: true, … }`
or `{ published: false, reason }`:

1. The episode must exist (`episode_missing`), the run must exist
   (`run_missing`), belong to that episode and stage (`run_mismatch`), and be
   `running` or `succeeded` (`run_not_publishable`; `already_published` for a
   repeat).
2. `inputGeneration` must equal both the episode's current
   `input_generation` and the run's (`stale_generation`). Whoever changes an
   episode's input (regions, boundaries, assertions, deletions) calls
   `bumpInputGeneration` in the same transaction.
3. No segment or turn may intersect a deleted range (`deleted_range`).
4. Near-live text (`asr_live`) cannot publish once a final `asr` run is
   current (`final_exists`).
5. Refusals 2-4 mark the run `discarded`; refusals in 1 leave it untouched.
6. On success: the previous current run of that stage (and of `asr_live`
   when publishing `asr`) loses its index rows, segments, turns, and
   speakers, and becomes `superseded`; the new segments, turns, episode
   speakers, and `segments_fts` rows are inserted; `episode_analysis` points
   at the new run, which becomes `published`; the episode's
   `analysis_state` is set if given.

Only `asr` and `asr_live` publish segments; other stages publish turns.

Near-live text (ADR 019) goes through `publishLive`: it creates the run and
publishes it in one transaction, then deletes the live run it superseded (or
itself when refused), so an episode keeps one live run however long the
call. Taught spellings apply to live text too; corrections do not (it has
none). Regrouping that deletes an open episode retires its live run first.

## Episodes

`episodes-store.ts` is the storage side of core's episode builder (ADR 016).
`loadUngroupedRegions` returns the grouping window: regions no closed
episode holds, minus those a deleted range covers whole, optionally from a
wall-time horizon (`sinceWallMs`, indexed); a region without continuous
times carries the clock of the chunk holding its first sample.
`loadOpenEpisodes`, `loadOpenRunClocks` (each open run's newest chunk, the
import watermark) and `loadClosedEpisodesBetween` (late-region repair) are
the rest of the input. `applyEpisodePlan` writes a pass in one transaction:
it deletes emptied open episodes, replaces a changed region set and bumps
the generation, closes episodes and queues their analysis, and applies
repairs. `listEpisodes`, `getEpisodeDetail` and `loadAnalysisInput` are the
read models of the API and of the analysis requests. `listEpisodes` takes a
timeline lane (`timelineLaneSql`: media apart whatever its size, the rest by
size, `mixed` included) and pages with a keyset cursor on (start, id).

`loadEpisodeDay` (`episode-day.ts`) is the Today read model: one indexed scan
of a day's episodes gives the lane counts, the moments per local hour (the
caller passes the hours, computed in the Mac's time zone) with their
untranscribed count and the newest previews, and a `revision` hashed over
the episodes' ids and `updated_at_ms`; then the first page of conversations
and of media. `deleteEpisode` touches the neighbours whose segments it
removes, so their day's revision changes too.

## Jobs

`jobs.ts` is the analysis queue: one `analysis` job per episode at a time
(`dedupe_key` `analysis:<id>`; `enqueueAnalysisJob` moves a queued job to the
new generation instead of adding one). Priorities: user request 10,
conversation 20, moment 30, media 40, trace 50 (`analysisPriorityClass`;
`nextRunnableJob` leaves traces out unless the caller allows them, which
core's scheduler does only on an engine already loaded), oldest first in
each. `claimAnalysisJob` makes the job `running`,
increments `attempts`, and creates the `job_attempts` row and its `asr` run
in one transaction. `failAttempt` retries after 1 min, then 10 min, and fails
the job after three failed attempts (`retry: false` fails it at once);
`cancelAttempt` requeues without counting. `recoverInterruptedJobs` (startup,
before any worker) abandons running attempts, cancels their runs, requeues
their jobs, and returns the recorded worker pids; `enqueueMissingAnalysis`
queues closed episodes without a current transcript, except a job that
failed at the current generation.

## Context

`context-items.ts` (ADR 024) keeps what the user added to a conversation.
An item belongs to the episode whose member slice holds its anchor
(`listContextItems`, `contextEpisodeOf`); nothing stores an episode id, so
regrouping, splits, merges and reanalyses need no code here.
`planContextAnchor` picks the anchor (the episode's first audio no tombstone
covers, or a sentence's middle clamped into its slice) before files are
copied, and `addContextItems` writes the rows only while that anchor still
holds. `deleteEpisode` deletes the episode's items first and, with
`deletePassage`, drops the items pinned to a sentence a tombstone meets;
`settleContext` moves the items of touched episodes whose point left every
episode or fell under a tombstone (`applyEpisodePlan`, the deletions), and
`deleteOrphanContext` sweeps the rest at start. `context_fts` is maintained
with the rows; `ensureSearchNormalizer` reindexes it too. ⌘Z captures the
items anchored in its window (`contextStatesIn`, `restoreContextStates`),
and `UndoHistory.heldFiles` lists the files its steps could bring back.
`referencedContextFiles` is what core's collection keeps.

## Calls and listens

`calls.ts` stores the helper's `call` and `listen` events by span id, each
in its own table (`calls`, `listens`), idempotently: `recordCallActive` and
`recordListenActive` (a replay of a span closed as `lost` reopens it),
`recordSpanEnded` (an `ended` for an unknown span is dropped), `touchSpans`
(a `clock` vouches for the spans the importer names, the ones its connection
saw active), and `closeLostSpans` (at a snapshot's end, the spans it replayed
were active at its clock; every other open span ends at its last-seen clock,
as `lost`). `loadCallsBetween`, `loadListensBetween` (the dictation apps'
spans, ADR 020) and `loadAppTapsBetween` feed the grouping;
`dictation-apps.ts` keeps which apps are dictation apps. `episode-sources.ts` derives at read
time what an episode heard: `loadEpisodeApps` (a dictation's app, call apps first, then the
apps of app tracks and attributed `system:other` regions, most voiced first;
none in person), `loadRunSpeakers` (speakers with the kind of track they were
heard on), and `loadSelfSpeakers` (the `self` speaker of each call with its
ordinal, for readers such as search).

## Search

`compileSearchQuery` (`search-match.ts`) normalizes a query in French and
in English, as the index was, and turns each typed word into one quoted
phrase of the tokens it normalizes to ("l'image" is `l image`, "22" is
`vingt deux`), so user input cannot inject FTS5 syntax. The phrases of a
form are ANDed, the forms ORed, and the last word is a prefix when it has
two or more letters.

`searchEpisodes(db, text, { fromMs, toMs, sizes, contexts, limit, offset })`
groups matches by episode, newest first, filtering before paging; each
episode gets its match count and its five best segments (bm25) in time
order, with highlights, and the result counts matching episodes (`total`)
and closed non-trace episodes the filters keep that have no transcript
(`untranscribed`). `searchSegments(db, text, { limit, offset, episodeId,
prefix })` returns ranked segments; `matchingSegmentIds` the segments of one
episode a query matches.

`compileSearch(db, text)` (what the app and agents run) adds phonetic
search (M4): each one-word phrase also matches up to 12 words of the index
that share its phonetic key (core's `phoneticKey`, French rules: "kamille"
and "camille"), the most frequent first. They come from `segments_vocab`, an
`fts5vocab` view of `segments_fts`, read live: a word whose last segment was
deleted is never offered. Within an episode, exact matches are its best
excerpts first.

`highlightRanges(text, lang, query)` returns where the query matched in a
segment's original text, as UTF-16 ranges, the way FTS5 matched it: it maps
the text to its indexed tokens with core's `frNormAlign` (a piece of text
per token group, "22" for `vingt deux`, none for a dropped filler), then
finds the phrases on those tokens. `search-match.test.ts` checks that the
segments with highlights are exactly the ones FTS5 returns.
`searchHighlightsId` changes with the alignment or the normalizer.

`segments_fts` is maintained explicitly, not by triggers: drizzle-kit alters
SQLite tables by rebuilding them, and dropping the old table silently drops
its triggers. Every `segments` row is indexed, so all writes go through
`publishAnalysis` and `deleteEpisode`, which delete index entries before the
rows. `segments` uses `ON DELETE RESTRICT` toward its run and episode, so a
delete that bypasses them fails instead of leaving stale index entries.
`checkSearchIndex` runs the FTS5 integrity check.

## Deletion

`deleteEpisode(db, episodeId, { origin })` writes a `track_run` tombstone per
region slice (with the 1.5 s pre-roll and 0.8 s post-roll at the region's own
edges, none at a cut; a cut region stays while another episode of the same
grouping version holds a slice of it), marks overlapping
chunks `deleted` and returns them for the caller to scrub from disk, removes
overlapping assertions, the episode's index rows and segments, its analysis
and regions, cancels its jobs, then truncates the WAL. Segments (with their
index rows and words) and speaker turns that intersect a tombstone are removed
too, whatever episode or grouping version published them. Both
`PRAGMA secure_delete=ON` and FTS5 `secure-delete` are needed for the text to
leave the database file; a test checks the raw `.db` and `-wal` bytes.
`forgetRange(db, { fromWallMs, toWallMs, origin })` erases a wall range:
`deleteEpisode` for every episode it overlaps (whole, an earlier start
included; `episodesInRange` lists them first), one `all` tombstone over the
range, every `present` or `archived` chunk heard in it marked `deleted` and
returned, and ungrouped regions inside it removed, in one transaction.
Retention expiry is different: it removes audio bytes only and sets
`expired`. Core's scrubber (`apps/desktop/src/core/retention/archiver.ts`,
`scrubChunks`) zeroes the returned chunks in the archive and in the spool,
except in a run's newest spool file: the helper's crash recovery checks that
file's CRCs and would cut it at a zeroed block, so those bytes go when
retention evicts the file.

## Retention

ADR 016. A closed spool file past 24 h (or the oldest past the 4 GiB cap)
keeps the chunks that intersect a closed speech region widened by the rolls
(`planArchive`) and loses the rest. Core copies the selected chunks into one
archive file and calls, in order:

1. `recordArchive`: the chunks become `archived` with `archive_rel_path` and
   `archive_byte_offset`, all or none (each must still be `present` with the
   CRC core read back);
2. `expireSpoolFile`: the other chunks and the file become `expired`; it
   refuses while a selected chunk is not archived or an open region reaches
   the file.

Both run with `synchronous=FULL` (`durableTransaction`) before core removes the
bytes they describe. Startup recovery uses `archiveRefs`, `isArchiveReferenced`,
`unarchiveSpoolFile` (back to the spool while it still holds the bytes),
`expireLostArchive`, `unscrubbedChunks` and `markArchiveScrubbed`.
`trackAudioRows` is what the audio reader needs for a sample range.

## Tests

```bash
pnpm --filter @sondine/db test        # real node:sqlite in temp directories
pnpm --filter @sondine/db typecheck
pnpm --filter @sondine/db bench       # SONDINE_BENCH=1: import and publish cost, Today and search reads
```
