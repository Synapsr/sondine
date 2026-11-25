# 035 — Sondine's own echo, by its reference

Status: Accepted — 2026-11-14; amends ADR 020 (« Sondine's own sound »)

## Context

When the user plays a recording back on the Mac's speakers, the microphone
hears it again. ADR 020 left out every mic region whose midpoint fell in a
playback on the speakers: no echo became an in-person moment, but what the
user said over a playback was lost with it. ADR 004 chose echo as evidence,
never blanket hiding: a route prior, lag-compensated envelope correlation,
word matching, and a private `self:playback` reference. Only word matching
was built (`echo/3`), and it cannot help here: Sondine's processes are out of
every tap (ADR 026), so no track carries what it played and no word matches.

The helper already writes a 10 ms log-energy envelope of every track, and
ADR 032 built an envelope correlator (`envelope-xcorr/1`) in TypeScript.

## Decision

- **The reference is a tap on Sondine's own processes**, kept private. While
  one of Sondine's process objects runs output and the microphone listens
  (system audio allowed: the user's switch, no pause, no hold, the
  permission), the helper taps them (`.processes`, like an app tap) on their
  own aggregate. Nothing of it becomes a run, a spool file, a manifest, a VAD
  session or a region, and Sondine stays out of every track. Each drain
  resamples its blocks to 16 kHz and reduces them to 10 ms energy frames;
  about once a second they go to core as `self.envelope` (levels in tenths
  of a dBFS, contiguous from a clock point; a gap starts a new event). The
  tap stops 2 s after Sondine's output does, and with the app taps (pause,
  hold, sleep, a lost device or permission); a hold's cut drops what was
  played after its trigger and not sent yet (frames already sent, a second
  at most, stay in core's memory unused: the microphone is held too). The helper keeps nothing beyond
  the frames not sent yet. An energy envelope holds no words.
- **Core keeps it in memory only**, never on disk: 15 minutes behind the
  newest frame, at most 360 KB. A restart of core forgets it.
- **Each mic region is judged once.** A closed region on an `input:` track
  whose wall midpoint falls in a playback on the speakers, with continuous
  times, is judged as soon as the reference reaches 0.5 s past its end and
  the spool has committed all of its own audio, or 10 s after the playback
  or the region ended (then with what came). Core
  reads its audio where playback does, with 5 s around it for the lag, into
  a 10 ms envelope (`EnvelopeBuilder`); only envelopes reach the detector,
  and only the verdict is stored (`self_echoes`: the verdict, the numbers
  behind it, the method, and the echo stretches in run samples). Deleting
  the region deletes it.
- **The detector, `envelope-echo/1`**, behind `SelfEchoDetector` in
  `packages/engines` (ADR 005), sharing the same-moment detector's features
  (each envelope minus its local mean). In 3 s windows, the normalized
  correlation over every lag from 0 to 2 s (AirPlay's delay included); a
  window's best lag counts from a correlation of 0.5, two standard
  deviations above the window's other lags, and each lag is the median of
  its neighbours' within 2 s, so a change of lag stays a step. Then what the playback explains at that lag: the loudest reference
  frame within ±50 ms of it, held as the room's echo dies away (1.2 dB per
  10 ms), plus the speaker-to-mic coupling (the 40th percentile of mic minus
  reference where the playback is loud), over the microphone's noise floor.
  A frame 7 dB or more above that, in runs of 80 ms, is someone in the room;
  so is any frame where no lag or coupling stands out (nothing of the
  playback is recognizable there, so nothing blames it).
  - **near-end**: 300 ms of such speech within any 2 s, or 200 ms that is a
    tenth of a short region. The region is the room's: it joins the
    episodes, and a closed episode takes it back as a late region.
  - **echo**: the playback explains at least half its speech and nobody
    spoke. No episode holds it, as before. Speech the playback does not
    explain and nobody's either is `near-end`: when unsure, the user's words
    stay.
  - **no-reference**: the reference covers under half its speech (or none of
    it is above the floor), or 300 ms of its speech within any 2 s is where
    the reference is missing and nobody was heard elsewhere: speech the
    reference missed is never called echo. ADR 020's rule: left out.
- **Until judged, ADR 020's rule** holds: an open region, or one whose
  reference has not arrived, stays out; a verdict of `near-end` brings it in
  at the next pass (the work runs the grouping again at once).
- **The route prior stays the player's**: through headphones nothing is
  judged and nothing is left out.
- **The transcript** (`echo/4`): in a region kept, mic words whose middle
  falls in one of its echo stretches (half a second at least, with no
  near-end speech) leave the published transcript, as word evidence's do;
  speaker turns are cut there. The audio stays, as always.

## Not now

- Envelope correlation between the microphone and app or `system:` tracks:
  word evidence (`echo/3`, now `echo/4`) covers calls on the speakers; the
  same detector fits once a measured echo rate asks for it.
- Skipping the tap through headphones: the helper would need core's route
  rule; it costs a tap only while Sondine plays.
- Tap-reference AEC, and keeping a voice heard mainly on playback out of the
  user's enrollment (architecture §3).

## Consequences

- Protocol 6: a helper and a core of different versions refuse each other
  at `hello`, as before.
- Without the reference (system audio off or paused, the permission refused,
  a tap that failed, core restarted during a playback), playback on the
  speakers is left out as ADR 020 decided.
- What the user says over a playback is kept when it stands out of the echo;
  a short reply buried under a loud playback is still lost (35 of 40
  synthetic cases kept), and near-end speech is sometimes found where the
  lag jumps (2 of 40) or no lag stands out of a noisy room (5 of 40),
  letting some echo words through.
- Accepted: the thresholds come from synthetic rooms only; a real speaker,
  its distortion and a microphone's automatic gain may move them. The bench
  (`pnpm bench self-echo synthetic`) and the logs (`self-echo.judged`, numbers
  only) are where real playbacks will say so.

## Measured (2026-11-14)

`bench/results/self-echo-2026-11-14.md`. The detector: 35 to 40 of 40 right
on every echo case (a miss lets echo in, it never loses speech), 40 of 40
on double-talk and
headphones, 35 of 40 on a 0.6 s reply, 750 ms of CPU per hour of speech
judged. The helper's reference:
9.6 ms of CPU per minute of playback (release build), nothing while Sondine
is silent; the tap's own cost on the real HAL is not measured yet (ADR 026
measured an app tap within coreaudiod's noise of the playback's own).
