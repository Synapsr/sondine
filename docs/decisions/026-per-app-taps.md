# 026 — A tap per app playing sound

Status: Accepted — 2026-11-09

## Context

Téo (2026-11-09): when two apps play at once, each must keep its own sound. All
system audio went to one track, `system:other`, a global tap minus Sondine's
processes, labelled with an app only when exactly one process object in scope
ran output (`single-active`). On Téo's Mac, from 2026-11-04 to 2026-11-09, 390
of 436 `system:other` speech regions (1.76 h of 1.88 h) had no app. A call
with a YouTube video behind it put both on that track: grouping gave the video
to the call (an ambiguous region joins a call whose app has no tap) and the
pages of ADR 023 could not be told apart.

ADR 004 designed app taps (a decision list, make-before-break transitions,
release after 30 s without output or 120 s of digital silence, a cap of 8);
the protocol carried `app:<bundleId>` tracks, and core already grouped an app
track into its app's media lane or its call. The helper never built one.

Two measurements framed the choice:

- The always-on `system:other` tap likely cost coreaudiod 1.7 points of CPU
  and 20 wakeups/s in silence (S0, 2026-11-05, architecture §5); the runner
  measured about 1.5 points for a first process tap and 0.7 for each more.
- A probe on Téo's Mac (one read of `IsRunningOutput` every 5 s, 2026-11-09,
  18:10–20:10) found output running in 77 % of the samples while he worked,
  two apps or more in 40 %: Klack (keyboard sounds) 64 %, Hex 41 %, T3 Code
  11 %, Yab 7 %. While he was away, 7 % (T3 Code's sounds, mostly).

## Decision

- **A tap per app playing sound.** Every app with a process object in system
  audio's scope running output gets its own private tap (all the app's
  process objects, mono, unmuted), its own tap-only aggregate and IOProc, and
  its own track `app:<bundleId>` with its own VAD session. Taps go to calls
  first (a call app, call daemon or web call keeps its tap while the call
  lasts and 10 s after, whatever it plays, and gets one even after a silence
  release), then by output start, up to `appTaps.max` (8); a call that finds
  every slot taken takes the latest non-call app's, and a lower cap keeps
  the calls, then the earliest taps. A tap that fails to start is tried
  again after 5 s, and so is `system:other`. An app keeps its tap until none of its objects ran output
  for 30 s; after 120 s of exact digital silence on its track (not in a
  call) it goes back to `system:other` until its output stops and starts
  again. A new process object of a tapped app joins its tap in place.
- **`system:other` is the rest, and runs only when needed.** It holds
  processes with no app, apps over the cap, apps released for silence, and
  a newly tapped app until its tap delivered (make-before-break: its objects
  leave `system:other` at the first drain that reads a block of its own tap,
  so up to one drain, 256 ms, is heard twice). An app that goes back to
  `system:other` while it plays keeps its tap until `system:other` has
  delivered for half a second, so nothing of it is lost. It starts when one of
  them runs output, alerts (`systemsoundserverd`) aside, and stops 5 s after
  none does; its exclusion list is updated in place, so it stays one run
  while it runs. In silence no tap runs at all.
- **Attribution counts apps.** `system:other` is `single-active` when its
  output comes from one app, all of that app's objects, or from one process
  with no app; app tracks are `exact`.
- **Apps outside `/Applications` are named too.** App Sandbox lets the
  helper read app bundles under `/Applications` only; an app's main
  executable elsewhere (`~/Applications`, a build folder) takes the bundle id
  Core Audio reports for it, named after its `.app` folder
  (`hal-bundle-id` evidence). Before, it stayed unresolved, on
  `system:other`.
- **Sondine is never tapped.** A process resolved to Sondine's own bundle is
  out of every scope even before main reports its pid (a renderer or
  Chromium's audio service starting to play).
- **Call-follow.** While a call reads an input device (read live from the
  call's processes and again when the device list changes, so a headset
  joined mid-call counts; the first of its devices that is a microphone),
  the microphone is that device, Bluetooth included (the call already holds it in call mode),
  then 10 s more; never a loopback, virtual or aggregate device, nor one
  whose input streams are all speaker echo references. A pinned microphone
  still wins.
- **Protocol 4.** `tap-start` joins the health stages (from the decision to
  start a tap to its first block). The `transition` event, its `TrackRunRef`,
  the `handoff` attribution and the `transition` end reason are gone: a run
  of an app track is its ownership, and `system:other`'s `track.update`
  (`source`) says when its exclusions change.
- **Core.** App runs recovered from their manifest alone are linked to their
  app (the track key names it), so calls and pages still find them. A
  `system:other` region with no app takes the one page a browser played only
  among browsers without a track of their own then: a browser on its own
  track plays nothing into `system:other`, and its page must not delete
  someone else's speech there (ADR 023). Grouping's rules are unchanged
  (`grouping/5`): an app track joins its call or its app's media lane.

## Considered

- **Taps only to separate speech** (ADR 004 as written): `system:other`
  always on, separation taps when speech on it has two candidates. The speech
  that triggers it is already mixed, every separation moves an app between
  tracks mid-sound, and silence keeps paying for the global tap.
- **One aggregate for every tap** (ADR 004, from the runner's measure: it
  costs the helper less). Adding or removing a tap rebuilds or reconfigures
  the shared device and restarts every track's IO; separate aggregates let a
  tap start and stop alone, for about 0.07 point of helper CPU per extra tap
  on the runner.
- **Keeping released taps and aggregates for a quick restart.** Measured
  first (`tap-start`); not built.
- **Holding a browser out while it plays only sites not kept** (Netflix):
  the extension does not report private windows, a call can share the
  browser, and reports arrive late or stop on a disconnect. Not now; such
  sites stay deleted at the end of their episode (ADR 023).

## Measured

Fixtures on the fake HAL (`native/Tests/SondineCaptureTests/app-taps-tests.swift`):
each fake process plays its own tone, each tap delivers the mix its scope
covers, and the spool is read back; seconds of each tone on each track:

| Scenario                                              | Source   | Its own track | `system:other` | Another app's track |
| ----------------------------------------------------- | -------- | ------------- | -------------- | ------------------- |
| One app, 10 s                                         | Music    | 10.0          | 0              | 0                   |
| Two apps at once (4 s, then 8 s together)             | Music    | 12.0          | 0              | 0                   |
|                                                       | Yab      | 8.0           | 0              | 0                   |
| A video, then a call over it (5 s, then 10 s)         | video    | 15.0          | 0              | 0                   |
|                                                       | call     | 10.0          | 0              | 0                   |
| Three apps over a cap of 2, then a call takes a slot  | Music    | 10.0          | 0.23           | 0                   |
|                                                       | Podcasts | —             | 10.0           | 0                   |
|                                                       | Yab      | 5.5           | 5.23           | 0                   |
|                                                       | call     | 5.0           | 0.23           | 0                   |
| A new process object joins a tapped app               | late     | 4.0           | 0              | 0                   |
| Silence release, then sound without an output restart | Music    | —             | 3.2            | 0                   |
| Sondine, an excluded app, an alert                    | each     | no track      | 0              | 0                   |

No tone ever reached another app's track, and none was lost. The 0.23 s on
`system:other` is one drain heard twice: `system:other` started while an
app's new tap had not delivered yet. Yab's extra 0.5 s on its own track is
its hand-over to `system:other` when the call took its slot (both are
make-before-break).

On Téo's Mac (MacBook Air M5, macOS 27.2), signed builds, the microphone
paused, against the build before (`bench/results/app-taps-2026-11-09.md`):

- Two player apps at once (a 300 Hz and a 500 Hz tone, 30 s each, 20 s
  together): 30.1 s and 30.0 s on their own tracks, 0.0 s on each other's,
  and `system:other` never started.
- Silence: the idle `system:other` tap costs coreaudiod nothing measurable on
  macOS 27.2; it cost Sondine 0.27 point of CPU and 0.66 mW, which go.
- One app speaking: its own tap costs what `system:other` did (Sondine
  1.56 % against 1.61 % of CPU).
- Two apps speaking at once: coreaudiod no more than one global tap; Sondine
  0.92 point of CPU and 2.8 mW more, and the helper 51.8 MiB (one VAD
  session per track, now one model shared between tracks, about 8 MiB less
  per extra track).

## Consequences

- Silence costs no tap. Each app playing costs one tap, so two apps cost two
  where `system:other` cost one: about a point of Sondine's CPU and 14 MiB
  of the helper per app speaking at once. Klack, holding output while Téo
  types, gets its own track then (its clicks rarely reach the VAD).
- The first moments of a sound after silence are lost until its tap
  delivers (`tap-start` in health; ADR 004 measured 52 ms p50 for the
  process list to notice a new player).
- A browser is one app: a web call and a video in another tab of the same
  browser stay on one track, and the video keeps the call's episode open.
- Echo (`echo/3`) compares the mic with the tracks of one episode: a video on
  the speakers during a call is now its own media episode, so its echo on
  the microphone stays in the call's transcript (before, the video itself
  was in the call).
- A `system:other` region keeps the attribution of its start; one that
  spans a change of its scope is not split.
- More runs: each app's playing time is one run of its track, and each
  `system:other` burst one run of that track.
