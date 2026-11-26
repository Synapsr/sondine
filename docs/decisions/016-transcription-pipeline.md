# 016 — Transcription pipeline (M1)

Status: Proposed — 2026-11-05; amended 2026-11-06 (M1 step 2: calls, traces)

## Context

M1 step 1 turns captured speech into published, searchable text with the
reference engine, before any screen: spool retention, episodes, a job queue,
engine contracts, a model manager, and the Nemotron worker. Half of the logic
exists and is tested in `packages/core` (grouping, size table, `fr-norm`) and
`packages/db` (publish, search), but nothing calls it. Nothing evicts the
spool either: it grows by about 5.5 GB a day of listening (two tracks).

Spike, 2026-11-05, Téo's Mac (MacBook Air M5, 32 GB, macOS 27.0.1), speech.cpp
0.9.3 with Nemotron 3.5 Transcribe 30B IQ4_NL:

- `speech worker MODEL` speaks protocol 3 (JSON lines; `ready`, `chunk`,
  `transcribe`, `progress`, one terminal `end` | `error` | `cancelled` per
  request, `cancel`). On stdin EOF it answers the requests it already has,
  then exits. Ready after 27 to 34 s (load and GPU warmup), then 16 s of
  French in 2.5 to 3.2 s, peak RSS 17.1 GB. With `timestamps` and `speakers`
  the `end` carries segments with a 0-based `speaker` and per-token times.
  Same text as the one-shot CLI.
- Under App Sandbox a bare command-line binary dies in `libsecinit` (no bundle
  identity). Wrapped in a minimal app bundle (`Contents/Info.plist`,
  `CFBundleIdentifier`), signed with Developer ID, hardened runtime, and
  sandbox entitlements, it runs, reads the weights through a read-only
  home-relative exception, uses Metal, fails to resolve hosts, and cannot read
  outside its exceptions.

A Codex Astra review of the first draft found unsafe eviction, an archive
format the chunk rows could not describe, no crash protocol, unstable episode
identity, and publish and worker gaps; this version answers them.

## Decision

### Retention

- **Unit.** Archiving copies whole committed chunks (2 s blocks), bytes and
  CRC unchanged, so a chunk row keeps describing its audio. A chunk is
  archived when it intersects a closed speech region widened by 1.5 s
  pre-roll and 0.8 s post-roll. The archive of a spool file is one file,
  `<data>/archive/<trackDir>/<runId>/NNNN.pcm`, holding its archived chunks in
  order; the chunk row gets `archive_rel_path` and a new
  `archive_byte_offset`.
- **When a spool file may go.** Only a closed spool file (`closed`, not the
  file being written) past 24 h, or the oldest ones past the 4 GiB cap, and
  only when all of these hold: core has reconciled its track run since the
  last snapshot with no problem; the run is closed, or the file ends before
  the start of the run's open region, if any, minus pre-roll; every region
  intersecting the file is closed and imported; and every chunk the rule
  above selects is archived. Anything else waits and is reported.
- **Crash protocol.** Read each selected chunk from the spool and check its
  CRC; write `NNNN.pcm.tmp`, `fsync`, rename, `fsync` the directory; then
  commit the chunk updates with `synchronous=FULL` for that transaction; then
  set the other chunks `expired` and the file `expired`, and unlink the PCM.
  The `.jsonl` manifest stays (envelopes and gaps). At startup: an archive
  file no row points to is deleted; a row that points to a missing or
  corrupt archive is re-archived if its spool bytes still exist, otherwise
  marked `expired` and reported. Reads check every chunk's CRC.
- **Deletion.** `deleteEpisode` already marks whole overlapping chunks
  `deleted`; for archived ones the scrubber overwrites their archive bytes
  with zeros and syncs. A chunk shared with a neighbouring episode goes with
  the deleted one (at most 2 s).
- Lossless compression, the 30-day / 20 GiB archive expiry (ADR 015), and the
  7 days of gated audio come later in M1. Raw PCM costs about 0.6 GB a day
  of speech until then.

### Episodes

- An episode builder in core regroups after each import batch that touched
  regions or started or ended a call, and every 15 s while an episode is
  open. Its window is every region not in a closed episode, minus deleted
  ranges.
- **Time.** Region times come from `continuous_*_us`; a region without them
  takes the clock of the chunk holding its first sample. Continuous time
  restarts at boot, so regions are partitioned by boot and an episode never
  spans one.
- `voicedMs` is the region span (regions are VAD speech without roll).
- **Identity.** Each output episode keeps the id of the open episode it
  shares the most regions with; the others are new, and an existing open
  episode left with no regions is deleted (it has no published analysis:
  analysis starts at close). New column `episodes.grouping_key` records
  `Episode.key` for diagnostics only. `input_generation` bumps only when the
  region set or a slice changes.
- **Closing.** An episode closes once grouping gives it a close reason and
  every track it could still receive regions from has been imported past its
  end plus the grouping gap. Closing and enqueuing its job are one
  transaction.
- **Repair.** A region recovered late inside a closed episode's interval,
  from the same boot, joins it, bumps its generation, and queues it again.
  The boot is compared too because a wall clock can move back across a boot.
- `decideSize` runs at each pass and again after publication (speakers,
  turns).
- **Calls** (M1 step 2, Téo's decision of 2026-11-06: one call is one
  conversation). The helper reports a `call` while a call app (Zoom, Teams,
  FaceTime, WhatsApp…), a call daemon (`avconferenced`, call relay), or a
  browser has microphone input running while the same browser plays sound
  (a web call goes both ways; dictation in a page does not count; Téo,
  2026-11-06), and Sondine listens (not fully
  paused, not asleep, not Sondine's own or an excluded app); each active
  span has its own call id and every snapshot replays the active ones. Core
  stores them in `calls` (call id, session, bundle ID and app, `via`, input
  device, start and end on both wall and continuous clocks, last seen), by
  call id, so replays change nothing. At a snapshot's end the open calls are
  exactly the ones it replayed: the others (an `ended` lost, a helper that
  died) close as `lost` at their last-seen clock; a later `ended` still sets
  the exact end. Last seen moves only where a clock proves the call still
  on: each `clock` event (every 10 s) vouches for the calls its connection
  saw active (live, from the helper's backlog, or replayed) and not ended
  since, and a snapshot's clock, sent before its replays, for the calls it
  replays, at its end. A call stored open before the connection may have
  ended while core was away with its `ended` dropped from the helper's
  backlog, so no clock moves it until a replay confirms it, and one whose
  event failed to import is no longer vouched for. An `ended` for a call
  never seen active is dropped. Bundle IDs serve display and matching only.
- **Grouping `grouping/2`.** Calls join their regions' boot by their clocks.
  A call id's `ended` closes its own `active`, whatever their order: a call
  closed at its start (its helper died before its next clock) is a closed
  instant, which covers only that instant, never an open call. The spans of
  one app that overlap or restart within 45 s are one call (ADR 007). During a call, at each region's midpoint, the mic regions, the
  call app's own track, and `system:other` regions join one `call` episode,
  sized `conversation` unless it is a trace: `system:other` joins when its
  attribution at the region's start names the call app, or names no app
  (ambiguous or unknown) while the call app has no tap of its own. M1 taps
  no app, so the far side of a call is on `system:other`; a region
  attributed to another app (a video in Safari) stays media. `activity`
  attribution is stamped on each new `system:other` region
  (`speech_regions.attributed_app_id`) for this and for display; it never
  changes the media lane. Outside calls grouping is unchanged. Closed
  episodes keep `grouping/1`: no call was stored before this version, so
  regrouping them would give the same episodes; open ones take `grouping/2`
  at the next pass.
- **Grouping `grouping/3`.** Mic speech while a dictation app listens is a
  dictation, in its own lane, transcribed by Parakeet with one voice (ADR
  020). Closed episodes keep their version; open ones take `grouping/3` at
  the next pass.
- **Grouping `grouping/4`.** A call episode closes after 5 min without
  speech on any of its tracks, the call still on, and the next speech opens
  another episode of the same call; a mic region in a dictation is a
  dictation during a call too (Téo, 2026-11-09: a Discord channel kept open
  for hours made one episode, with his dictations in it). Late regions are
  repaired by the same rule. Closed episodes keep their version; open ones
  take `grouping/4` at the next pass.

### Jobs

- A closed episode gets one `analysis` job (`dedupe_key`
  `analysis:<episodeId>`). A queued job takes the new generation instead of
  a second job. At startup, every closed episode without a published `asr`
  at its current generation and without an active job gets one.
- **Order.** One heavy job at a time: user requests first, then
  conversations, then moments, then media, then traces, oldest first in
  each. A job refused memory or swap, or paused after such a refusal, lets
  the first dictation (Parakeet, ADR 020) go through its own admission: one
  long call at the head held 96 jobs, every dictation among them, for 16 hours
  (2026-11-18). The pause after a memory refusal holds engines as
  heavy as the one refused only, and a dictation behind it is looked at
  every 10 s; the requests a stopped job finished stay by job, so a
  dictation in between does not erase them. Heat, power and idle refuse
  every job alike, so they hold the queue.
- **Traces** (voiced < 1.5 s) are transcribed so short answers such as
  « oui » or « non » are not lost (Téo, 2026-11-06), but only on an engine
  already loaded for other work: the scheduler never loads it for a trace,
  takes traces after every other runnable job, applies the automatic
  admission rules to them (AC, idle, memory), and runs at most 50 per load.
  Traces never extend the idle window: the 90 s unload counts from the last
  job that was not a trace, and no trace starts after it; one that started
  before may finish (a few seconds) before the engine unloads. A user
  request on a trace is a normal request. Each trace costs its request's compute (about 1 s warm, not yet
  measured per trace); a backlog waits for the next warm session and shows
  in the status queue counts.
- **Admission**, before each job and every 10 s during one: AC power and
  thermal state nominal or fair. Before a cold load, memory pressure normal
  and free disk for swap at least the engine's measured peak for the
  request's duration plus 10 GB. Loading Nemotron on Téo's Mac (17 GB of
  footprint, weights copied into GPU buffers) pushed about 10 GB of other
  apps to swap, with 7.5 GB free beforehand (2026-11-05): free memory is
  never the gate on a busy 32 GB Mac, which is why automatic loads wait for
  idle. While the engine is loaded or loading (warm), in a job or between
  two, its own weights hold pressure at warn: only critical pressure counts,
  and swap may grow by at most 2 GB over the baseline taken 3 min after the
  load finished, kept until the engine unloads; until then swap growth is
  not judged (critical pressure and heat still are). Nemotron's weights are
  mapped at load and paged in by its first minutes of work: judged from the
  load, swap grew 2.3 to 2.6 GB within 40 s each time and every request Téo
  made on a Mac in use stopped there (64 admission cancellations in 14 days,
  none followed by a success, 2026-11-19). Asking for normal pressure
  between jobs unloaded and reloaded the engine for every job (8 loads for
  8 jobs, swap from 19.5 to 24.9 GB, 2026-11-05). Automatic jobs also need
  idle: 2 min without input, or the screen locked or asleep. A user request
  skips idle and AC, and loads at warn pressure, not critical, with the same
  swap room: Téo's Mac sat at warn with 16.7 GB of swap for hours, so a
  request he made never started (Téo chose to load anyway, 2026-11-07). Pressure is not read while the
  engine loads: the load's own spike reached critical in 2 of 5 loads
  (2026-11-05), and each cancelled load then loaded fine 15 s later, paying
  the spike twice. Admission is checked again once the engine is ready,
  before inference, after up to 20 s for critical pressure to fall back: on
  2026-11-07 a requested job loaded, read critical at once, and was
  cancelled, paying a 10 s load for nothing. When a condition fails mid-job, the job is
  cancelled and queued again without counting a failure; idle and power
  refusals alone allow a finite ETA below 60 s to finish. Memory, swap and
  heat refusals receive no grace. Then, or when a condition fails between
  jobs, the worker unloads. A memory or swap refusal while warm postpones
  the next load by 60 s, doubled at each refusal in a row up to 30 min and
  back to 60 s once a job publishes, including explicit requests and queue
  wakeups; admission is checked again afterwards. Téo's 3 h 22 import was
  cancelled 9 times in an hour on a Mac with 15 GB of swap, reloading 17 GB
  each time (2026-11-08). This delay lives in the scheduler, uses the
  existing `retry-later` status with its time (`retryAtMs`, « prochain
  essai : 18:42 »), and resets on restart. The requests a cancelled attempt
  finished stay in memory for the job's next attempt on the same input and
  engine, so a long recording resumes after its finished parts instead of
  starting again (lost on restart).
  An empty queue retains its worker for at most 90 s, checking automatic
  admission every 10 s and unloading on refusal. The status block always
  says why the queue waits; the log says which conditions failed, with the
  readings. `analysis.check` reads every condition on demand, as the next
  job would, with what the Mac reports: the window lists them, met or not,
  from the sidebar's queue line and on the status screen. There the user may
  stop automatic jobs waiting for power, idle, or normal memory pressure
  (warn then suffices, as for a request); heat, critical pressure and swap
  room always count (Téo, 2026-11-08: start now rather than wait for idle). While pressure
  refuses, it adds what holds the memory: with the compressor on a Mac above
  3 GB, macOS (XNU `vm_pageout.c`) leaves warning once the RAM the
  compressor occupies is under 40 % of it plus the uncompressed pages, and
  leaves critical under 60 % (critical also follows the compressor's own
  capacity), so an app's compressed memory is what mostly moves the level.
  The panel draws that memory app by app, as an estimate (`top`'s CMPRS,
  original page sizes, each process under its app bundle or its nearest
  ancestor's, scaled to the compressor's RAM, read at most every 15 s), with
  the line to get under; macOS's level stays the authority.
- **Claim**, in one transaction: job `running`, a `job_attempts` row
  numbered after the job's last one (attempt numbers only grow), and an
  `asr` analysis run at the episode's current generation; the attempt
  stores that run and the worker's pid.
- **Publish**, in one transaction with the job and attempt `succeeded`: a
  refusal rolls the whole transaction back, then a second transaction marks
  the run `discarded` and handles the reason: a stale generation queues the
  job at the new one; anything else fails the attempt.
- **Attempts** (2026-11-19). `jobs.attempts` counts failed attempts only
  and never passes `jobs.max_attempts` (3); the job fails when it reaches
  it. Cancelled attempts (admission, shutdown, a new generation) and
  abandoned ones stay in `job_attempts` and never count: they say nothing
  about the job. A failure the same input would give again (`model_limit`
  or `untimed` at the smallest split and without speakers, audio gone)
  fails the job at once. A
  user request on a failed job starts a new job, counted from zero. Before,
  each claim counted, so a request cancelled five times by admission read
  « 5 of 3 » while still queued; startup recovery recounts queued jobs.
- **Failure.** Retries after 1 min, then 10 min; the job fails after 3
  failed attempts. An engine
  error carries a fixed reason code (e.g. `text-mismatch`), logged and
  stored on the attempt, never its message, which may quote the output. A
  refused request or output (`rejected`, `invalid_output`) keeps the worker
  loaded; any other engine error unloads it.
- **Restart.** At startup, before any new worker: every process whose
  executable is our speech binary gets SIGTERM, then SIGKILL after 5 s (only
  core spawns it, so each is an orphan, recorded or not, such as a worker
  killed with its core during a cold load); then each recorded worker pid
  still running it is killed; only then each `running` attempt becomes
  `abandoned` (keeping its pid), its run `cancelled`, its job `queued`. If a
  process survives, nothing changes and the queue does not start before the
  next launch; `status.analysis.lastError` says so.

### Engines and the Nemotron worker

- `packages/engines` holds the contracts (manifest, capabilities, resources,
  typed results with coverage and provenance), a fake engine, the model
  manager, and the worker clients. Core owns scheduling and supervision.
- **Runtime.** speech.cpp ships inside Sondine as
  `Contents/Helpers/Sondine Speech.app` (`app.sondine.speech`, App Sandbox,
  read-only models exception, no network entitlement, Developer ID, hardened
  runtime), staged from the pinned release archive (sha256) with its MIT
  notices and signed by our build like `sondine-audio`. Weights are
  model-manager artifacts; `pull` and `update` are never called.
- **Worker.** Core spawns `speech worker <weights> --device gpu --threads 4`
  when an admitted job needs it and checks `ready.protocol === 3`. Request
  ids carry the attempt id; a message for another id is dropped. Deadlines:
  ready 180 s; a request 120 s + 4 × its audio; a cancel 10 s, then SIGKILL.
  At most one worker per model exists: a new one starts only after the
  previous one exited, and only when no process runs the speech binary on
  those weights, checked before every spawn (else the load fails as
  `worker_running`); near-live text has its own (ADR 019). Idle exit: stdin
  closed 90 s after the queue drains, SIGKILL 10 s later.
- **Requests.** ASR runs per source track of an episode. A request is a list
  of extents (`trackRunId`, `sampleStart`, `sampleEnd`) built from the
  track's region slices widened by roll, merged when closer than the
  grouping gap, cut where a capture restart changes the run and around
  deleted ranges, which are never sent. Inside an extent, samples the spool
  and archive do not have (gaps, expired chunks, CRC failures) are
  zero-filled and lower coverage. A request holds at most 55 min, cut at the
  longest silence between regions, else at 55 min. Audio goes as base64
  PCM16 `chunk` lines of at most 10 s, then one `transcribe` with
  `timestamps` and `speakers`.
- **Word times.** speech.cpp's multi-speaker aligner (NeMo's) searches each
  voice's words over the frames where that voice is active; where the voice
  is weak, a sentence's words land minutes away, on its earlier or later
  speech (segments covered 1.13 times the audio on SUMM-RE, 2.2 on a 3 h 22
  import). The text order stays right, so the adapter keeps the time of
  every word that follows it within 2 s and puts the others back between
  their neighbours, 0.1 to 0.4 s a word; segment bounds then come from
  their words (`nemotron-times.ts`, adapter version 2). On SUMM-RE every
  moved word that could be checked got closer to where it was said, and
  tcpWER went from 19.0 % to 17.9 % (`bench/results/word-times-2026-11-09.md`).
  Transcripts made before keep their times.
- **Mapping back.** Token times place each word in its extent; a segment that
  crosses an extent boundary is split there by its tokens, so no output
  covers audio that was not sent. Word times are clamped to their segment; a
  token entirely outside it is dropped. Speaker labels are
  `<trackKey>/<request>/<n>`, distinct per request until the voice pass
  links one person's voices (architecture §8, "Linking");
  `<request>` is its index, plus `.1` or `.2` per `model_limit` half (`2.1`).
- **Model limit.** A request the engine stops at its limit (`model_limit`)
  is never published: it is halved at the longest silence between regions in
  its middle half (a capture restart first, the one nearest the middle on a
  tie), else at the middle, and both halves are sent, at most 3 levels deep
  and never below 60 s. A part still truncated then fails the job as
  `model_limit`, without retry, and a published run stays.
- **Untimed.** A request whose text the model cannot time (speech.cpp's
  `untimed`: its CTC alignment, bound by speaker, finds no path through a
  long request) is halved the same way, and its halves sent; text without
  times is never published. One episode lost
  three attempts of 20 min on one 55 min request (2026-11-18). A request
  the split cannot halve (2026-11-26):
  - with less than 1 s of speech (its region slices, without roll) is
    published as no speech: no segment, the episode `complete`. The text is
    dropped, and only a code and durations are logged. From 2026-11-08 to
    2026-11-26 one Mac had 101 episodes fail untimed: 86 held less than 1 s
    of speech, all traces, where the model writes text the request's few
    frames cannot hold;
  - otherwise it is sent once more without speakers, so the alignment has
    the whole request instead of one voice's frames, and its text becomes
    one voice of that request (`<trackKey>/<request>/1`). Still untimed, or
    a dictation (sent without speakers already), the job fails as
    `invalid_output` without retry.
- **Outcome.** One pass covers every track and publishes one `asr` run:
  segments with their `track_run_id`, and turns derived from the segments'
  speakers, which become the episode's speakers. Coverage below 0.5 still
  publishes, with the coverage stored. A request with no audio at all is
  not sent and lowers coverage, unless the episode already has a published
  `asr` run: publishing without it would retire a fuller transcript, so the
  job fails as `audio_unavailable`, without retry (checked before a cold
  load), and the published run stays. No audio left at all fails the same
  way. Echo of played sound on the mic is left out by word evidence since M3
  (architecture §3 "Echo and duplicates").
- `analysis_runs.metrics` records audio ms, coverage, cold load ms, compute
  ms, real-time factor, and the worker's peak RSS, so admission can use the
  measured peak per audio duration; and the requests split, published as no
  speech or sent again without speakers (`modelLimitSplits`,
  `untimedSplits`, `untimedSilent`, `untimedRetries`).

### Models

- A catalog in the repository pins each artifact: URL, size, sha256, license
  id, license text and its upstream page at the pinned revision, notices,
  and the places a copy may already sit. Installed artifacts live in
  `~/Library/Application Support/Sondine/models/<artifact>/<version>/` with the
  license and notices next to the file and a manifest of the verified hash,
  written last. Weights found at their place without a manifest are an
  install a crash cut short: the launch check hashes them once and writes
  the manifest when they match, or removes them, so no second download is
  needed.
- **Status.** Core reports each artifact's phase (`missing`, `found`,
  `importing`, `downloading`, `verifying`, `ready`, `failed`), its progress,
  the bytes a stopped download kept, a file found outside the models folder,
  the free space a download needs, and the problem when it failed, with the
  free disk and the Mac's memory (`models.status`, `models.watch`). Progress
  reaches the status at most four times a second; a phase change at once.
- **Found files.** Core looks only in known places, never a disk scan: the
  Hugging Face hub cache at the pinned revision and the catalog's
  `knownLocations` (for Nemotron, the M0 spike's copy). A file of the right
  size there is offered for import before any download; the import checks
  its sha256. Downloads, Desktop and Documents are left out on purpose:
  reading them makes macOS ask for access out of nowhere. A file there is
  chosen with the open panel (`models.pick`: core asks main, which shows it
  limited to the file's extension), which is the user's consent.
- **Import** clones the file (`clonefile`, no extra disk) when it sits on the
  models folder's volume, and copies it otherwise (the status says which in
  advance), then checks its size and sha256 against the catalog. A matching
  hash is the pinned upstream artifact, so the OpenMDW-1.1 rule holds once the
  license and notices are shown and kept. At launch core checks size, inode
  and mtime and rehashes only when they changed.
- **Download**, only when the user starts it (ADR 002); agents cannot
  (`mcp: null` on every model procedure), and nothing resumes on its own at
  the next launch:
  - Only the catalog's pinned URL, over `https`. Redirects may reach only the
    hosts listed for the pinned URL's host, at most 5 hops, on the default
    port, without credentials: for `huggingface.co`, itself and the
    subdomains of `hf.co`, Hugging Face's own domain, where `/resolve/`
    redirects (`us.aws.cdn.hf.co` on 2026-11-06, `cas-bridge.xethub.hf.co`,
    `cdn-lfs*.hf.co`). Anything else is refused (`redirect_refused`).
  - The size is checked against the catalog: a `Content-Length` or a body
    larger than it stops the download (`too_large`); an encoded body is
    refused.
  - Disk: before starting, free space must hold what is left to fetch plus
    14 GiB of headroom, the spool's 4 GiB cap (capture keeps writing) and the
    10 GiB of swap room admission keeps before a cold load; during the
    download it stops when less than the headroom is left. Loading the model
    afterwards still needs admission's own swap room.
  - The bytes go to `.download.partial`, synced every 64 MiB, with
    `.download.json` recording the pinned URL, size, sha256, the strong ETag,
    and the bytes synced so far. A resume truncates the partial to those
    bytes (a crash's unsynced tail is fetched again) and sends `Range` with
    `If-Range`; a `206` must carry the `Content-Range` asked for, else the
    download fails as `bad_response`. A `200` to a resume (no range support,
    or a changed file) starts over from the first byte; a `416` starts over
    once. A partial that describes another URL, size or hash is deleted.
  - Failures that may pass (a dropped or stalled connection, `408`, `429`,
    `5xx`) are retried after 2 s, 15 s and 60 s, counted again from one
    whenever new bytes arrived; past that the job fails and keeps its bytes.
    Cancelling keeps them too; `models.cancel` with `discard` deletes them.
  - The sha256 runs once, over the complete file as it sits on disk, before
    an atomic rename into place (`verifying`). Node cannot save a hash state
    across a restart, and hashing what is on disk (one more read of the
    file, against a download of minutes to hours) also catches a bad write.
    A wrong hash deletes the partial.
  - The log holds artifact ids, phases, byte counts and codes, never a URL,
    a path or a message. The speech worker keeps no network entitlement.
- Core owns one job per artifact id: starting what already runs, or what is
  installed, returns the current status; a request made during the launch
  check waits for it. A model that becomes ready while core runs is used at
  once, and the queue looks again immediately.

### Search

- New column `segments.search_text`: the segment's text through `fr-norm`
  with pinned options (numbers as words, diacritics stripped, fillers
  dropped) in the segment's language (French unless tagged English).
  `segments_fts` is rebuilt to index it; publish, retire, and `deleteEpisode`
  insert and delete with it; secure-delete stays.
- A query is normalized both ways (French and English) and matches either.
  The normalizer id is stored; a new one reindexes.
- Each word typed is one quoted phrase of what it normalizes to ("l'école"
  is `l ecole`, "22" is `vingt deux`, "10h30" is `dix heures trente`), the
  phrases are ANDed, and the last word is a prefix from two letters.
- Results come grouped by episode, newest first, paged by episode after the
  filters (local days `from`/`to` inclusive, sizes, contexts; all by default,
  media, `mixed` and traces included). Each episode gives its match count
  and its five best segments (bm25) in time order, each with its speaker
  and highlights. `total` counts matching episodes; `untranscribed` counts
  closed non-trace episodes in the range without a transcript.
- Highlights are UTF-16 ranges over the original text. `frNormAlign` maps
  the original to the indexed tokens: pieces normalized alone, neighbours
  merged where the whole text normalizes differently (numbers with their
  unit, times, thousands, "quatre vingts"), the whole segment as one unit
  if no grouping within six words agrees. The query is matched on those
  tokens as FTS5 matches it, and each match returns its original span; a
  test checks that highlighted segments are exactly FTS5's. Computed when
  read, versioned by `searchHighlightsId` (alignment version and normalizer
  id). `episodes.get` with `q` highlights a whole transcript, on the
  segments FTS5 finds.

### API and status

- `episodes.list` (a day), `episodes.get` (segments, speakers),
  `search.query`, `analysis.request` (a user request for one episode:
  « Transcrire maintenant », or « Retranscrire » for one already
  transcribed, whose new run supersedes the published one).
- Step 2 adds `episodes.day` for Today: conversations, moments per local
  hour (count, untranscribed, three previews), media, the trace count, and a
  `revision` that changes only when an episode of the day does. Media go to
  their lane whatever their size; other episodes go by size, `mixed`
  included. `episodes.list` takes an hour and a lane, and pages with a
  keyset cursor. Measured on a synthetic day of 2 000 episodes after a month
  of history (16 500 episodes, 55 000 segments): `episodes.day` 3.4 ms
  median, an hour's moments 0.1 ms, a search 3 to 11 ms; every plan uses an
  existing index, so no migration was needed.
- `status` gains an `analysis` block: worker state (absent, loading, ready,
  busy), queue counts (traces apart), the running job, why the queue waits,
  the last error, installed models, and retention problems. Until step 2
  the status screen shows it, with recent episodes and a search field.
  It also names the episode whose job the queue waits on, and lists the
  user's requests (waiting, running, or failed within a week with the last
  failure's code), so a requested row says « En attente » or « Échec » and,
  in a popover, its own reason or what failed and « Réessayer », instead of
  the queue's reason lent to every row (2026-11-19).
- An episode summary names the apps heard in it (`apps`: the call app, or
  what played the media, most voiced first; none in person). Each speaker
  carries the kind of track it was heard on, and `self` marks the user as
  far as the sources tell: in a call, the microphone voice with the most
  voiced time (`selfSpeakerLabel`). It is derived at each read, never stored
  as an identity, marks at most one speaker and merges none, since built-in
  speakers let the mic hear the far side too; segments carry the same mark.

## Consequences

- Transcripts appear when the Mac is on AC and idle, unless Téo asks; capture
  is never slowed by analysis. If idle windows prove too rare, the rule is
  revisited with measurements.
- A call on the built-in speakers was transcribed twice (mic and system)
  until M3's echo evidence (`echo/1`, 2026-11-07), and the mic's copy of the
  far side could outweigh the user's voice in a short call: `self` could
  then mark the wrong voice. Transcripts published before it keep their
  echo until they are transcribed again.
- A browser counts as a call only while it uses the microphone and plays
  sound; a page that listens while a video plays in the same browser is
  still taken for a call.
- Speakers are numbered per request, then linked within the transcript
  after it is published; identity is M3.
- Tests: retention never removes an unarchived speech chunk, including
  regions crossing files, missed events, and a crash at each protocol step;
  episode identity is stable across passes and late regions; fake-engine
  end-to-end through the real core runtime; core killed during load and
  during inference leaves no second worker, one published run, and a
  consistent index (`checkSearchIndex`); mapping across gaps, restarts, and
  deleted ranges; the packaged worker is checked by `check-package`
  (entitlements, Metal init, model read, a denied write, and
  `sandbox_check` refusing outbound network).
