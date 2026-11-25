# 004 — Capture, sources, and app attribution

Status: Proposed — 2026-11-02; app attribution replaced by ADR 026 (a tap per
app playing sound, 2026-11-09)

## Context

Téo wants every source handled well: several input devices, internal audio,
and the app each piece of internal audio came from. The prototype used one
global tap and AVAudioEngine, polled discovery, had no route-change handling,
and faked the system-audio permission state. A read-only probe on Téo's Mac
(macOS 27.0.1) showed seven `com.apple.WebKit.GPU` processes, one per WebKit
host app, all with ppid 1. Reviews measured that each HAL property read costs
about 90 µs of coreaudiod CPU, so a 1 Hz scan of 53 process objects costs
about 1.4 % of a core outside Sondine's own processes.

## Decision

- Release 1 targets macOS 27 (the only tested OS); lowering the floor needs
  a test lane.
- Track model `input:<deviceUID>`, `app:<bundleID>`, `system:other`, with track
  runs, capture epochs, and recorded clock anchors.
- Listener-driven discovery, no periodic scan; process incarnations keep
  their mapping evidence and confidence.
- Attribution by one ordered decision list (call app, single active process,
  speech with several candidates, otherwise ambiguous); make-before-break tap
  transitions with canonical ownership intervals; mixed intervals stay
  ambiguous. Replaced by ADR 026: every app playing gets its own tap, and
  `system:other` keeps the rest only while it plays.
- One active mic: pinned is a hard override; automatic mode follows a
  validated call device, then an allowlisted default. Bluetooth mics only
  through call-follow or explicit consent.
- Full-signal spool (24 h / 4 GiB) committed every 2 s with CRC and manifest;
  speech regions and VAD-rejected gated audio outlive it.
- Echo handled as evidence: route prior, envelope correlation, word-level
  dedup, a self-playback reference; Voice Processing I/O rejected. Built for
  Sondine's own playback by ADR 035 (its reference and envelope correlation),
  for played tracks by word evidence (`echo/3`, architecture §3).
- Permissions: status separate from stream health; system audio
  `granted-verified` only after a non-zero tap sample; a denial ends the run
  until access is back.
- Power: sleep allowed except during in-person speech on the mic.

## Consequences

- Two private SPIs (responsible process, TCC preflight) can break on an OS
  update; behavioural checks back them up.
- Tap zero-stalls are handled by an always-on watchdog, rate limited: 15 s of
  exact zeros while output runs in scope that the tap has not heard since the
  latest output start of a process still playing, or 3 s within 30 s of a
  route or rate change until the tap hears something. Apps keep their output
  open in silence after a sound (T3 Code, a Chromium app, for 31 s, measured
  2026-11-04), so zeros after a signal are not a stall. Accepted: a tap that
  goes silent mid-playback with no event is caught at the next output start;
  a tap opened or rerouted while an app holds silent output is rebuilt once.
- A track whose device stops calling back is restarted after 5 s without an
  IO cycle, then with a doubling wait up to 5 min. The built-in microphone
  stopped calling back when AirPods connected (2026-11-09) and recorded
  nothing for 1 h 38 until Sondine restarted.
- A fake HAL behind a protocol makes the policy testable without hardware.
- Website or tab is never inferred: the browser reports the tab that plays,
  through Sondine's extension, while the user allows it (ADR 023).

## Measured (M0)

- Listener reliability, 2026-11-04, macOS 27.0.1 (26A434), `sondine-audio
  self-test listeners --rounds 50`: no missed notification. The process
  object list notified every `afplay` arrival (52 ms p50 after the spawn) and
  departure; the device list every private aggregate added or removed
  (6.7 ms p50, 13 ms max). A process's `IsRunningOutput` listener never fired
  (0 of 150 output starts and stops) while its `Devices` listeners fired on
  every one, the stop within 50 ms. Decision: discovery stays listener-driven
  with no scan; the process catalog listens to `IsRunningInput`,
  `IsRunningOutput` and both `Devices` scopes and re-reads both flags on any
  of them. The self-test is the regression check for a new macOS.
  `IsRunningInput` was not measured (an input process needs a microphone
  grant).
- Apps keep output open in silence after a sound: T3 Code (Chromium) 31 s,
  `AVAudioPlayer` 2.1 s after `stop()`.
- Full disk, 2026-11-04, a 48 MB APFS image, development build on the fake
  HAL: the helper reports the outage once per track (`disk.full`), retries
  every 10 s, writes one gap record per attempt, and reports `spool.resumed`
  only once a block is stored again; the menu bar says the disk is full
  meanwhile. After 45 s full, each track had 48 s of `disk_full` gaps, equal
  to its missing samples. A disk that stays full until the run closes leaves
  its last gaps after the last commit: core reads them from the manifest when
  the run closes, and records what no record covers as an `unrecorded` gap.
  When the disk is full to the last byte, core's writes fail too (repaired
  from the manifests at the next commit), and a core that restarts cannot
  open its database: main then shows the disk as full rather than a crash
  loop. After space came back, the last session's runs were covered to the
  sample (chunks plus gaps equal each run's length). Electron cannot create
  its single-instance lock on a full volume, so Sondine does not start at all
  while the system volume is full (architecture §16).
- Removing a listener from an object Core Audio already dropped logged "no
  object with given ID" (4 lines per exiting process, 32 in 95 min); the
  helper now discards those listeners. Remaining noise: a process that exits
  between the list read and its listeners logs 4 `HasProperty` errors (about
  twice in 25 min).
- Taps, 2026-11-04, second Mac (M2 Air 16 GB, macOS 27.0.1), `scripts/
  tap-probe-app.sh` with its own system-audio grant: eight `afplay` players on
  a -70 dBFS tone, 0 to 8 process taps, 55 s per configuration, two runs.
  coreaudiod's CPU with the players and no tap was 22.3 % of a core; the
  first tap added about 1.5 points, eight taps 6.5 (shared) to 7.4 (separate),
  with a few points of noise between configurations. One aggregate for all
  taps cost coreaudiod no more than one aggregate per tap, and cost the
  capturing process 1.5 to 2.8 times less (8 taps: 0.29 % against 0.82 %, one
  IOProc instead of eight). Decision then: app taps share one aggregate,
  rebuilt make-before-break when the set changes, and stay rare. ADR 026
  chose one aggregate per tap instead (a tap starts and stops alone) and a
  tap per app playing, with no tap at all in silence.
- Permission reset, 2026-11-05, second Mac, signed build: `tccutil reset`
  of the microphone, then of system audio, three minutes apart, while
  capturing. The microphone run kept its signal (room noise at -52 to -56
  dBFS per minute, as before) with no gap: a reset does not stop a running
  stream. The status read `not-determined` and the verified state stayed, so
  Sondine said nothing. The system track carried digital silence all night
  (nothing played), so it tells nothing. Nothing ended a run on a denial
  either. Decision: a `denied` or `restricted` status ends the run with the
  `permission` reason (stored as `permission_revoked`), and capture starts
  again once access is back.
- Access turned off and on in System Settings, 2026-11-05, Téo's Mac
  (MacBook Air M5, macOS 27.0.1), signed build, while capturing; the
  helper's own Core Audio log and tccd's log show each step. Microphone:
  turning access off, and on again, each made macOS quit Sondine and open it
  again. The helper stopped both tracks in a clean shutdown; the new
  instance read `denied` at launch and opened no microphone run while
  system audio went on, then opened the microphone at the launch that
  followed the grant. System audio: macOS offered to quit later, and
  Sondine kept running. macOS did not stop the tap: it ran until the next
  health tick read `denied` 24 s later and stopped it, and a new tap started
  14 s after access came back. What the tap delivered in those 24 s is not
  known. Consequence: on macOS 27 the `permission_revoked` path only serves system
  audio; up to one health tick of system audio is recorded after access is
  withdrawn (architecture §16).
- Lid sleep, 2026-11-05, Téo's Mac, on battery, signed build, from the
  helper's Core Audio log and `pmset -g log`: the helper stopped the
  microphone and the tap 5 s before the clamshell sleep, no IO ran during
  the six dark wakes of the next 63 min, and both started again 3.4 s after
  the lid opened.
