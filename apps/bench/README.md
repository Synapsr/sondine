# @sondine/bench

`sondine-bench` measures Sondine. Today it runs the always-on budget of
`docs/architecture.md` §5: what Sondine costs with its window closed, measured
as the difference between Sondine running and paused, coreaudiod included.

It samples every Sondine process with `sondine-meter`
(`native/Sources/sondine-meter`): `phys_footprint`, CPU time, energy and
wakeups from `proc_pid_rusage` v6. coreaudiod belongs to another user, so the
meter reads it through the setuid `/bin/ps` (CPU time, every interval) and
`/usr/bin/top` (footprint and idle wakeups, every `--privileged-interval`).
Nothing needs root, opens an audio device or triggers a permission prompt.

## Setup

```bash
swift build -c release --product sondine-meter --package-path native
```

The harness looks for the meter in `$SONDINE_METER`, then
`native/.build/release`, then `native/.build/debug` (a debug build is flagged
in the result). Pass `--meter <path>` to use another one.

Run it from the repository root:

```bash
pnpm --filter @sondine/bench bench budget run --scenario S0 --label "main 4f2a"
# or
node apps/bench/src/cli.ts budget run --scenario S0 --label "main 4f2a"
```

## A run

1. Quit every other Sondine instance. Start the build you are measuring (the
   packaged app, or `pnpm dev` with `--app-name Electron`).
2. Close Sondine's window, turn MCP off, and let the engine queue drain: no
   engine worker may be alive (workers exit after 90 s idle). The harness
   warns about a renderer, `sondine-mcp` or an engine worker it finds.
3. Set up the scenario below, then start the run and leave the Mac alone.
   The harness waits `--settle` (1 min) before measuring, then measures for
   `--duration` (30 min, 8 h for the soak).
4. Keep the power source and Low Power Mode the same as the baseline. The
   result records `pmset -g batt` and `pmset -g therm` at the start and the
   end, and warns when the power source changed or the Mac throttled or
   slept.

Ctrl-C stops the meter early and still writes the result, marked
`interrupted`. A second Ctrl-C kills the meter.

If no Sondine process runs, `budget run` stops at once with "no Sondine
process found". `--allow-missing` measures coreaudiod alone, which is useful
only to check the harness on a new machine.

## Scenarios

Run **S6 first**: every delta (coreaudiod CPU and wakeups, power) is taken
against the latest S6 result from the same machine, macOS build and power
source. Use `--baseline <result>` to pick one, or `--baseline none`.

| Scenario | Set up                                                                                                                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S6       | **Paused (baseline).** Sondine running, capture paused from the tray. Nothing playing, no call, quiet room.                                                                                                   |
| S0       | **Silence, mic only.** Capture on, microphone the only source. Quiet room, nothing playing on the Mac. This is the column the always-on gate uses.                                                            |
| S1       | **Music in one app.** Capture on, with the music app's tap. Play an album or a playlist in Music (or Spotify) at normal volume for the whole run, nothing else playing.                                       |
| S2       | **Speech video in Safari.** Capture on. Play a long talk, lecture or interview (spoken voice, little music) in Safari, full length, nothing else playing.                                                     |
| S3       | **FaceTime or Zoom call.** Capture on during a real call with someone talking on both sides, for example a call to a second device in another room with a podcast playing next to it. Camera may stay off.    |
| S4       | **In-person speech on the mic.** Capture on, microphone only, nothing playing on the Mac. People talk near the Mac, or a podcast plays from a phone or speaker about 1 m from it.                             |
| S5       | **Four concurrent app taps.** Capture on with four apps playing at once: music in Music, a video in Safari, a podcast app, and a call or a meeting test (Zoom's audio test works).                            |
| soak     | **8 h mixed.** A normal working day with Sondine on: calls, media and silence mixed. Run it once on AC and once on battery; the footprint slope cap (≤ 2 MiB/h per process) is evaluated from 1 h of samples. |

S0 and S3 have their own caps in the architecture table. S1, S2 and S4 are
checked against the S3 column and S6 against the S0 column, as upper bounds
(`basis: inferred` in the result). S5 and the soak record CPU and wakeups
without a cap.

## Results

Each run writes three files to `bench/results/local/` (git-ignored, never
commit them):

- `<id>.json`, the result (`sondine.budget-result`, `schemaVersion: 1`,
  `src/budget/result-schema.ts`): host (chip, cores, memory, `sw_vers`, power
  and thermal state), scenario, per-process and per-group statistics, Sondine
  sleep assertions from `pmset -g assertions`, every check and the verdict;
- `<id>.samples.jsonl`, the raw meter samples;
- `<id>.summary.json`, the meter's summary.

The id is `<UTC time>-<scenario>-<label>`, so results sort by time.

```bash
node apps/bench/src/cli.ts budget show 20261103T100000Z-S0-main-4f2a
node apps/bench/src/cli.ts budget compare <a> <b>   # paths or ids, a → b
```

`compare` prints every group metric side by side and flags the regressions of
architecture §13: footprint +5 %, CPU, wakeups and energy +10 %.

A check is `pass`, `fail`, `not measured` (no reading, such as ring overflows,
which only `sondine-audio`'s health events show) or `not evaluated` (a reading
without what it needs, such as a delta without an S6 baseline, or a row
whose processes were not all measured). CPU checks are diagnostic (marked so
in `show`): architecture §5 gates on energy and wakeups, so the verdict counts
every other check only. The verdict is `fail` if a gating check fails,
`incomplete` if some could not be judged, else `pass`. `budget run` exits with 3 on `fail`, 2 on a usage error and 1 on any
other error.

The caps live in `src/budget/caps.ts`. They are the starting targets of
architecture §5; once M0 measurements replace them (measured value plus
15 %), update that file and bump `CAPS_VERSION`.

## Limits

- The power delta covers the CPU energy of Sondine's own processes
  (`ri_energy_nj`). coreaudiod's energy and device power need root, so the
  check is marked `coverage: partial` and stays `not evaluated`: the value is
  recorded, but a partial reading cannot show the system cap is met.
- The meter rescans for Sondine processes and coreaudiod every 10 s, so a
  helper that restarts is measured from the next rescan on (a warning names
  it). A sampled process whose role cannot be told from any listing, or one
  alive at the end that was never sampled, leaves its rows `not evaluated`.
- coreaudiod's wakeups come from `top` as package-idle wakeups. They are
  compared only with a baseline read the same way.
- The meter is not free: `ps` runs every interval, and `top`'s first sample
  costs about 1.5 s of CPU, each later one about 0.2 s. That load is not
  counted against Sondine; the meter's own CPU, its children's CPU, wakeups
  and energy are recorded under `harness.meter.overhead`.

## Transcription (`asr`)

M1 step 3 compares Nemotron 3.5 Transcribe 30B (the baseline, through the
product adapter and the app's own sandboxed worker) with Parakeet TDT 0.6B v3
and Qwen3-ASR 1.7B and 0.6B, all on the pinned speech.cpp runtime. Corpora,
weights and the speech executable are pinned (revision, size, sha256) and kept
in `~/Library/Caches/sondine-bench`; results go to `bench/results/local/`.

```bash
node apps/bench/src/cli.ts asr fetch --corpus fleurs-fr,fleurs-en --size 100
node apps/bench/src/cli.ts asr run --engine parakeet-tdt-0.6b-v3 --corpus fleurs-fr
node apps/bench/src/cli.ts asr report bench/results/local/asr-*.json
```

Each item goes as the product sends audio (no language hint; Nemotron with
speakers and timestamps, the challengers text only) and is scored with
`fr-norm` (WER and CER pooled over items, 95 % bootstrap interval). Costs:
cold load, warm RTFx (audio seconds per compute second), the worker's peak
physical footprint (`footprint`), swap before and after. Nemotron runs only on
AC power with normal memory pressure; it uses the app's worker path, so the
product's worker guard keeps Sondine and the bench from loading two at once.
A run stops when swap grows by 2 GB after the engine loaded (the load itself
pushes other apps to swap, as in the product).

## Golden set (`golden`)

Téo's own recordings, exported from Sondine (« Exporter l'audio… »), seeded by
controls that are not candidates (Whisper large-v3 through whisper.cpp
v1.9.5 built from its pinned commit, Sortformer for the voices), then
corrected by him in `reference.txt`. Kept in
`~/Library/Application Support/Sondine/golden/v0`, outside the repository and
iCloud, never committed.

```bash
node apps/bench/src/cli.ts golden add ~/Downloads/"Sondine 2026-11-06 13-05.wav" --scenario appel-fr
node apps/bench/src/cli.ts golden status
```

### Meetings (SUMM-RE)

Eight test meetings of SUMM-RE (CC-BY-SA-4.0, French, 3–4 people, two over
Zoom), each participant's close-talk track summed into one mix, the condition
Sondine hears through one microphone. Prepare them once (about 4 GB read over
HTTP, nothing kept but the PCM, about 1.3 GB):

```bash
cd apps/bench/src/asr/summre && uv run --no-project --with pyarrow==21.0.0 \
  --with "fsspec[http]==2025.9.0" --with aiohttp==3.12.15 --with numpy==2.3.3 \
  python -I prepare.py ~/Library/Caches/sondine-bench
node apps/bench/src/cli.ts asr meetings --engine parakeet-tdt-0.6b-v3
```

On a slow link, name meetings after the cache path to prepare only those
(`prepare.py <cache> 077c_EBPH …`), for instance on a Mac with a faster link,
then copy their folders (`reference.json` and the PCM, or FLAC to decode)
into `~/Library/Caches/sondine-bench/corpora/summre-test/`; the bench checks
the mix's sha256 against `reference.json` before each run.

Nemotron runs as the product sends audio (speakers and timestamps), and the
result keeps each segment's words with their times; the challengers run
speech.cpp's own pipeline (Silero regions, Sortformer speakers). Scoring:
MeetEval 0.4.3 tcpWER (collar 5 s) and cpWER, and a speaker-agnostic WER, on
words normalized with `fr-norm` and apostrophes as separators (SUMM-RE writes
« l heure »).

## The same meeting on both (`same-moment`)

M5.7's exit (ADR 032): ten real double recordings all linked, the offset
within 100 ms of a hand clap marked in both, and ten pairs of rooms at the
same hour never linked. `same-moment synthetic [--long]` runs the same
detector on pairs made in memory, with its CPU per hour of audio.

### Recording the pairs (Téo)

Sondine listening on the Mac, the iPhone app recording, both on the same
meeting. Ten **double recordings**:

- three with the phone **near** (on the table, within 1 m of whoever
  speaks), three with it **far** (across the room, 3 m or more, or in a
  bag), two in a **noisy** room (a café, music, a dishwasher), two where the
  phone starts or stops in the middle so the two share **only a few
  minutes** (2 to 5);
- each at least 3 minutes of speech, two or more voices;
- one sharp **hand clap**, once, loud enough for both, early in the shared
  time (in a short-overlap pair: inside the shared minutes).

Ten **pairs of rooms**: the Mac in one room, the phone in another (or
another building), each hearing its own conversation, a podcast or the TV,
**at the same hour** for 3 minutes or more; no clap needed.

Then, for each pair:

1. On the iPhone, « Partager… » the recording to the Mac (AirDrop) before
   it syncs: the iPhone erases its audio once the Mac holds it. The shared
   file keeps the header with its start.
2. In Sondine, open the Mac's conversation and « Exporter l'audio » (WAV).
3. Open each file in an editor that shows seconds to the millisecond
   (Audacity) and note where the clap starts in each: `clapMacS`,
   `clapPhoneS`.
4. Keep the files and `pairs.json` outside the repository, for instance in
   `~/Library/Caches/sondine-bench/same-moment/`:

```json
{
  "pairs": [
    {
      "id": "near-1",
      "expect": "same",
      "mac": "/Users/me/Library/Caches/sondine-bench/same-moment/near-1-mac.wav",
      "phone": "/Users/me/Library/Caches/sondine-bench/same-moment/near-1-phone.m4a",
      "clapMacS": 14.213,
      "clapPhoneS": 6.871
    },
    {
      "id": "rooms-1",
      "expect": "different",
      "mac": "/Users/me/Library/Caches/sondine-bench/same-moment/rooms-1-mac.wav",
      "phone": "/Users/me/Library/Caches/sondine-bench/same-moment/rooms-1-phone.m4a",
      "macStartMs": 1794560400000
    }
  ]
}
```

A pair of rooms needs `macStartMs` (the Mac file's first sample, Unix ms:
the Sondine MCP's `get_episode` gives the episode's `startedAtMs`), so the
search covers what the clocks really propose. A double recording without it
is taken to agree with the phone at the clap, then the proposal is moved by
`--shift` (37 s) so the detector must find the offset itself.

```bash
node apps/bench/src/cli.ts same-moment run --pairs ~/Library/Caches/sondine-bench/same-moment/pairs.json --label 2026-11-20
```

Each file is decoded with `afconvert` (16 kHz mono, in a temporary folder
removed at once) and compared as core compares them. The table and
`bench/results/local/same-moment-<label>.json` hold numbers only (ids,
found or not, error at the clap, correlations, drift, cost), never a path
or a sound; the summary worth keeping goes to `bench/results/` as
Markdown. Exit code 3 when a pair fails the exit.

## Phone voices (`voices phone`)

M5.8 (ADR 032) decides whether a voice heard by the iPhone app may be
recognized or only suggested (« Marie ? »), with ADR 030's
method: each voice the user named on a phone recording is held out, by
episode and by day, then compared with the centroid of each person's named
voices, by the production rule (`decideVoice` in `packages/db`). Two pairs
apart: against microphone references, and against phone references. A trial
is one person in one recording: every voice named as them there (diarization
may split a person in two), the worst outcome counting, so one voice taken
for someone else makes the trial wrong. Known: the person has references
left. Stranger: the same voices with that person's references taken out, so
every named person is a stranger to the others.
Each pair is counted under the rule built (suggested only, from 99 %) and
the rule a pass would open (80 % / 99 %, three references on two days).

```bash
node apps/bench/src/cli.ts voices phone
```

It copies Sondine's database (opened read-only, the copy in
`~/Library/Caches/sondine-bench/voices/phone/`, deleted after the run),
reads the embeddings the app made, and writes
`bench/results/voices-phone-<date>.md`: counts only, people as « person n »,
no text, no audio. Imported files are left out (not the app's, never
embedded). A phone recording's references never include a recording that
may have heard the same moment: one M5.7 linked, and, linked or not
(detection pending, failed, an overlap too short), any other recording
whose time meets the phone's, 2 minutes wider (15 when its time is
uncertain), across midnight too. Recognizable people are counted in
recordings, not voices: three recordings on two days left whatever day is
held out. The verdict is per pair, held out by day:
`too-few`, `fails` (a stranger recognized, or someone recognized as someone
else) or `passes`. Only a pass of the phone-against-phone pair turns
`PHONE_VOICES_MEASURED` on; a voice compared across channels stays
suggested only (ADR 030).

### Labelling enough phone recordings (Téo)

Enough means the user and four others named on phone recordings, each on
three days or more, two recordings a day: 30 trials (a person in a
recording), which also make 30 stranger trials. Recordings with the whole group count for everyone
in them: six recordings of the same five people, two a day on three days,
are enough.

1. Record with the iPhone app (not Voice Memos: an imported file does not
   count), each person speaking 30 s or more alone over the recording (the
   voice pass reads up to 30 s of a voice's own speech; under 3 s it is
   never recognized).
2. Vary it over the days, as ADR 032 asks: the phone on a table, in a hand,
   in a pocket; the built-in microphone, and once a headset. Some voices
   the user does not know (a café, a meeting with strangers) may stay
   unnamed: they are not counted, the named people serve as strangers.
3. On the Mac, once the recording is synced and transcribed: open it from
   Today (the « iPhone » mark), click each voice (« Voix 1 ») at the top of
   the transcript, choose « C'est moi » or type the person's name (the same
   person each time: pick the name already there). Name every voice of
   every recording; a « Marie ? » shown is confirmed with « Oui ».
4. For the phone-against-microphone pair, the same people are also named
   on the Mac's microphone in three conversations or more on two days or
   more; a meeting the Mac and the phone both heard counts on each side,
   never as its own reference.
5. Run `voices phone` and commit its Markdown; the verdict says what is
   still missing.
