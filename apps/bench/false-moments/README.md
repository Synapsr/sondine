# False moments: file-mode diagnostic benchmark

Run from the repository root on a Mac (macOS, Swift toolchain,
Node >=24.11, pnpm and ffmpeg already available):

```sh
node apps/bench/false-moments/run.mjs
```

This one command installs the locked dependencies if absent, builds the current
file helper in an external Swift cache, fetches the pinned Silero model and
public corpus, generates seeded mixtures, runs the four parameter variants,
typechecks the benchmark, and runs `pnpm check`. It never launches Sondine,
opens audio hardware, plays sound or loads a transcription model.

Optional paths and seed:

```sh
node apps/bench/false-moments/run.mjs \
  --cache /absolute/path/outside/the/repository \
  --output /absolute/path/to/a/new/result-directory \
  --seed 20261106
```

Default cache: `~/Library/Caches/sondine-false-moments`. Default results:
`bench/results/local/false-moments-<timestamp>/`. No audio goes into the
repository. The cache is intentionally retained for offline repetitions.
Do not run two copies with the same cache concurrently.

`--skip-check` skips the final repository checks only. The normal command is
the acceptance command. Ordinary `pnpm check` skips the expensive experiment;
the small correctness tests remain enabled. Since the package's existing
tsconfig includes only `src/` and `test/`, the launcher also runs:

```sh
pnpm --filter @sondine/bench exec tsc --noEmit -p false-moments/tsconfig.json
```

## What is measured

- Nine French isolated acknowledgements, including a dictionary recording of
  _hum_, and 24 English yes/no controls from 17 speakers. Labels identify the
  utterance; they do not provide validated word boundaries.
- Five creator-labelled noises: cough, door, keyboard, dishes, notification.
  Each is repeated six times with dense or sparse spacing. These repetitions
  are exposures to the same recording, not independent samples.
- Instrumental music, singing, and two FLEURS read-speech clips. FLEURS is a
  spoken-background proxy, not a television recording. Each isolated medium
  is evaluated as microphone input and as a system track.
- Separate isolated and continuous suites. Input speech is RMS-normalized to
  -24 dBFS over the whole source file, subject to a 0.9 peak cap; its actual
  gain is recorded in `decoded-manifest.json`. Conditions are clean, -12 dB,
  -24 dB, a low-pass/attenuation room proxy, music, spoken background and a
  120 ms synthetic echo. No target word is cropped or time-stretched.
- Equal-RMS backgrounds are normalized over their whole source files. Their
  instantaneous SNR at a particular word is **not** necessarily 0 dB. One
  common final gain prevents mixture clipping. A matched background-only
  file receives exactly that gain, offset and duration.
- Native `minSpeechMs` values 250 (default), 128, 192 and 384 via the helper's
  file-only `--params`. No production threshold is modified.

`planner.ts` imports the actual desktop `planEpisodes`, imports regions using
the real DB operations, and calls `applyEpisodePlan` in SQLite `:memory:`.
It counts real inserts and reports `traceJobsCreated` separately from
`otherJobsCreated`. Since `grouping/2`, closed traces receive jobs at
`analysisPriorities.trace`. No jobs are executed: a queued trace is not a
completed transcription, and the trace candidate pool says nothing about how
much work can fit in a warm-model window.

The adapter maps the helper's **speech bounds** to the capture manifest's
semantics, not its pre/post-roll bounds, and passes the helper's measured
voice as the region's `voicedSamples`, as the capture manifest does. Since
2026-11-06 the product sizes episodes on that voice, not on the region extent,
which can include internal silence (the cough finding of the first report).

This reconstructs a closed stream from scratch, then advances logical time
past the actual grouping cutoff. That extra logical time is excluded from
audio-hour denominators. It does not reproduce incremental hysteresis, late
repairs, capture clock uncertainty, call detection or the running scheduler.
The corpus runs without call metadata. Separate synthetic planner tests import
explicit call intervals through the real calls table and check their effect on
context, size and job priority. They exercise grouping, not acoustic call
detection or the browser microphone/output policy.

## Reading the results

`rapport-fr.md` gives raw counts per condition; `results.json` preserves all
scores, actual parameter values, source and harness hashes, grouping version,
host state, process timings and peak RSS. `raw/` contains every native JSON and
its `/usr/bin/time -l` output. `scenarios.json` records the generated WAV hashes,
target windows, source identities and mixing gain.

The capture-overlap count needs at least 50 ms in a labelled clip window;
whole-clip retention needs 95% of the container. Speech-envelope overlap is
reported separately from retained roll. These are **not** frame recall or ASR
word accuracy. On a background that already triggers VAD, retention cannot
prove detection of the target; the paired controls expose this ambiguity.

Strict recall for 100–600 ms words remains unmeasured. An external waveform
review suggests roughly 310–510 ms acoustic events for the nine French clips,
but those provisional windows are not used as gold truth. The 100–300 ms range,
real whispers, real distant speech, real TV and independent listening of all
negative labels remain missing. No blanket product threshold should be chosen
from this diagnostic set.

Hourly rates describe the specified synthetic event density. Zero observed
false regions is not a claim of zero real-world false positives. Peak helper
RSS is not physical footprint, whole-app memory use, swap attribution or proof
that a Mac stays responsive under transcription.

## Data and failure behaviour

`corpus.json` pins URLs, SHA-256, archive members, licences and attribution.
Originals and decoded WAVs remain outside Git. CC BY-SA source recordings and
their derived mixtures retain their respective licence obligations; this
benchmark does not relicense audio as AGPL. No transcript is stored in the patch.

A changed hash, missing source, HTTP error, invalid helper output, corrupt cache
or command failure stops the run. Downloads are bounded and performed only by
this explicitly started benchmark. Wikimedia can rate-limit a fresh acquisition;
honour the reported Retry-After before rerunning the same command. Verified
objects are reused. An existing completed result directory is never overwritten.

Subprocess deadlines and interrupts terminate only groups created by the
harness, including a time-wrapper's helper child. All subprocesses are awaited;
no service is left running. The benchmark never stops an existing application.
