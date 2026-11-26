# Architecture

Status: draft 2, 2026-11-02, revised after two adversarial reviews (Codex
`gpt-6-astra` and a six-lens Claude panel). Decisions live in
`docs/decisions/`; the delivery order lives in [plan.md](plan.md). Numbers
marked _target_ are budgets to verify, not measurements.

## 1. Shape

Sondine keeps four things durable: the audio signal it captured (within
retention), where that audio came from, what the user asserted (names,
corrections, splits, deletions), and exemplar clips of known voices.
Everything a model produces is a revisable interpretation with provenance.

The capture gate (energy gate + VAD) is the one irreversible stage once the
full-signal spool expires. It is tuned as a unit for missed speech, and its
output stays provisional while the spool still holds the signal.

```text
              ┌──────────────────────── Sondine.app ──────────────────────────┐
              │                                                                │
  HAL ───────►│ sondine-audio (Swift, always on)                               │
  mics, taps  │   capture · resample · spool · energy gate · VAD · regions     │
              │      ▲ lifetime pipe (stdin EOF = exit)                        │
              │      │                     │ private Unix socket (JSON lines)  │
              │ Electron main ─────────────┼──────────────┐                    │
              │   tray · windows · power   │              │ MessagePort        │
              │   spawns sondine-audio     ▼              ▼ (brokered once)    │
              │                    core (utilityProcess, Effect shell)         │
              │                      SQLite · grouping · scheduler · oRPC     │
              │                      spawns engine workers (files in/out)     │
              │                           │                                    │
              │        ┌──────────────────┴─────────┐                          │
              │        ▼                            ▼                          │
              │  engine workers (on demand)    renderer (React, only while     │
              │   sondine-engines (Swift)        a window is open)             │
              │   speech.cpp, probes (bench)                                   │
              │                                                                │
              │  sondine-mcp (Swift byte relay) ⇄ core MCP server (socket)     │
              │  browser extension → sondine-browser (relay) → core (socket)  │
              │  sondine-lan (Swift relay, release 2) → core (socket)         │
              └────────────────────────────────────────────────────────────────┘
                       ▲ local network, pinned TLS (release 2, §12)
                       │
                Sondine iPhone app (SwiftUI)
```

## 2. Processes

| Process                               | Owns                                                                                                                                                                                                                             | Lifetime                                                                                                                                                                  |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sondine-audio`                       | Device and process discovery, taps and mic IO, resampling, full-signal spool, energy gate, VAD, speech regions, activity timeline, envelopes, health, power hold during in-person speech, the app in front over speech (ADR 022) | Always on while listening. Spawned by main so TCC credits Sondine.app. Exits on stdin EOF. `read-voice` (ADR 034): one short process per voice read, spawned by main too. |
| Electron main                         | Dock icon, tray, windows, notifications, `powerMonitor`, login item, spawning `sondine-audio`, brokering the renderer↔core port, relaying playback byte ranges from core (§11)                                                   | App lifetime. No business logic, no database, not on the capture event path.                                                                                              |
| `core` (utility process)              | Effect shell (supervision, scheduler, scopes, retries, spans), SQLite (single writer), grouping, publication, engine workers, oRPC router, MCP server on a socket, the phone's HTTP server on a socket (release 2)               | App lifetime. Connects to `sondine-audio`'s socket.                                                                                                                       |
| Renderer                              | React UI only                                                                                                                                                                                                                    | Created when a window opens, destroyed when it closes.                                                                                                                    |
| Engine workers                        | One engine family each; read audio files, write results                                                                                                                                                                          | Spawned by core for a queue, exit after 90 s idle. Kernel sandbox, no network (ADR 010).                                                                                  |
| Chromium GPU, network, audio services | Owned by Electron, not configurable                                                                                                                                                                                              | Stay alive once spawned; budgeted, and excluded from capture.                                                                                                             |
| `sondine-mcp`                         | stdio ⇄ core socket byte relay for local agents                                                                                                                                                                                  | Started by the agent client; no logic (ADR 011).                                                                                                                          |
| `sondine-browser`                     | Native messaging ⇄ core socket relay for Sondine's browser extension; names the browser that started it                                                                                                                          | Started by a browser for the extension, while the user allows it (ADR 023).                                                                                               |
| `sondine-lan` (release 2)             | The only TCP port: TLS 1.3 and the Bonjour advertisement for paired iPhones, relayed to core's socket; no logic (ADR 008)                                                                                                        | Started by core while a pairing is open or a phone is paired. Sandbox: incoming only.                                                                                     |

Rules:

- Audio never travels through oRPC, base64, or JSON in the product. Engines
  read files; the one exception is the speech.cpp worker's base64 PCM, bounded
  to its adapter (§4). Playback streams WAV bytes from core through main to
  the window's audio element on the `sondine-media:` scheme, in bounded
  slices, never cached (§11).
- Heavy models never load into an Electron process.
- A crash of any child is a recorded gap or a retryable job, never a
  half-published result.
- Electron fuses are locked (RunAsNode, NODE_OPTIONS, inspect off; asar
  integrity on) so no other process can borrow Sondine's permissions
  (ADR 010).

## 3. Capture

See [ADR 004](decisions/004-capture-and-attribution.md). Release 1 targets
macOS 27 on Apple silicon with 32 GB, the only tested configuration.

### Tracks and timing

- Track keys: `input:<deviceUID>`, `app:<bundleID>`, `system:other`,
  `phone:<deviceId>` (release 2). A track run (`runId`) is one continuous
  opening of a track; a capture epoch restarts on device change, rate change,
  wake, or daemon restart.
- Every track is resampled once in the helper to 16 kHz mono from the
  **measured** device rate (frames ÷ Δhost time), rebuilt on rate changes.
- Each manifest stores the timebase and anchor triple (host ticks,
  `mach_continuous_time`, wall ns); each chunk record stores its first-sample
  host ticks, continuous ns, and sample index. Cross-track alignment uses
  continuous time, keeps per-epoch drift estimates, and records alignment
  uncertainty and discontinuities explicitly.

### Discovery (no polling scan)

- One listener on the process object list; on appearance read pid, bundle ID,
  responsible pid, and resolved app once, cache by object id, and attach
  per-object listeners (`IsRunningInput`, `IsRunningOutput`, `Devices`), and
  re-read both IO flags on any of them: on macOS 27 only `Devices` notifies
  (ADR 004).
- Device listeners: devices, default input and output, alive, nominal rate,
  stream format, data source, `ServiceRestarted`, user session.
- A process incarnation is (pid, start time); mappings keep their evidence
  (`responsibility | ancestry | path | daemon-map`) and confidence.

### App attribution

[ADR 026](decisions/026-per-app-taps.md). Each app keeps its own sound:

1. **Sondine and excluded apps**: out of every tap. A process resolved to
   Sondine's own bundle is out even before main reports its pid.
2. **A call** (a call app, call daemon or web call using a microphone): its
   app's tap while the call lasts and 10 s after, whatever it plays.
3. **Any other app with output running**: its own tap, by output start, up
   to 8 (a call takes the latest non-call app's slot when none is free).
   Alerts (`systemsoundserverd`) never get one.
4. **The rest** (processes with no app, apps over the cap, apps released for
   silence) stays on `system:other`, which runs only while one of them runs
   output, and stops 5 s after.

- A tap covers every process object of its app (a new one joins in place)
  and has its own tap-only aggregate, IOProc, track `app:<bundleId>` and VAD
  session: a tap starts and stops without touching the others.
- An app tap ends 30 s after none of its objects ran output; after 120 s of
  exact digital silence (outside a call) its app goes back to
  `system:other` until its output stops and starts again.
- Make-before-break: an app's objects leave `system:other` once its own tap
  delivered a block (up to one drain, 256 ms, is heard on both tracks), and
  an app still playing comes back to it before its tap stops, which runs on
  until `system:other` has delivered for half a second. `system:other`'s exclusions are updated
  in place, so it stays one run while it runs; each change is a
  `track.update` (`source`).
- `system:other` is `single-active` when its output comes from one app (all
  its objects) or one process with no app, else `ambiguous`; app tracks are
  `exact`.
- Sondine's own processes (helper, Electron main, renderer, Chromium GPU and
  audio services) are excluded from every tap; their PIDs are refreshed from
  `app.getAppMetrics()` every 30 s, when a child process exits, and when the
  window starts playing audio (Chromium spawns its audio service at the first
  playback), then again 1 s later. The microphone still hears their playback
  through the speakers: while they run output and the microphone listens, a
  private tap on them feeds the `self:playback` reference (« Echo and
  duplicates », ADR 035), never a track.
- Website or tab is never inferred. Sondine's browser extension reports the
  tabs that play, their address and title, and a YouTube video's position;
  a media region gets the one page its app's browser played at its
  midpoint, another page starts the next media episode, and a region with
  no page joins the one going on (ADR 023, `grouping/6`).

### The app in front

- [ADR 022](decisions/022-foreground-app.md). The helper watches
  NSWorkspace's frontmost application (its activation notification, no
  permission): the bundle ID and name only, never a window or the screen. No
  app is in front while the screen is locked, the screen saver runs or the
  displays sleep, and an excluded app is never named. NSWorkspace is fed by
  the main run loop, so `serve` runs `CFRunLoopRun()` rather than
  `dispatchMain()`.
- It keeps the app in front now and its changes back to 30 s before the
  earliest open region (at most 512), never more: with nobody speaking, the
  last 30 s. `region.close` carries the apps in front while the region
  lasted (`foreground`): the region cut at each change, in run samples,
  placed by interpolating between the clocks of its two ends, at most 64
  spans. Manifests do not hold them.

### Private zones

[ADR 029](decisions/029-private-zones.md). The helper holds capture itself
while a zone at « Rien » applies, from the zones in its `config`:

- **Triggers**, tracked apart from what is reported: a call (call app, call
  daemon, web call; an excluded app's included) and 10 s after; an excluded
  app in a call or listening to a microphone, and 10 s after (it holds the
  microphone only, and its calls and listens stay unreported); the screen
  locked, the screen saver running or the displays asleep (the observers of
  the app in front); a window of hours on the Mac's clock and time zone;
  a network the Mac is on.
- **Occurrences**: one per trigger, from its start to its end, with an id.
  A schedule window's occurrence is the same whenever the helper looks (its
  id comes from the window and its start day), so a helper restart keeps a
  lift. Sleep, wake and a reconnect end none: holds stay as they are while
  asleep, and a network occurrence outlasts a network gone 10 s (60 s after
  a wake, while the Wi-Fi comes back). A lifted occurrence (`holds.lifted`)
  holds nothing until it ends; the next one holds again.
- **Effect**: capture opens only when the user's intent allows it, the device
  and permission are there, and no unlifted hold covers it, checked before
  every open, unmute, retry, reconnect and reconcile. A held microphone is
  muted like a paused one (Bluetooth stopped); a hold on everything stops
  every tap and `system:other`. The runs a hold ends close with `held`; the
  user's pause (`ready.paused`) never changes.
- **What a hold drops**: what each stopped track captured from the trigger's
  start (or from a zone's or a lift's change) and did not commit. Blocks still
  in the IO ring after it are dropped, a block across it is cut, and samples
  already drained into the 2 s commit buffer after it are stored as silence
  (the run keeps its length and its regions). Committed samples stay, and so
  does what was captured between the real event and its notification.
- **Signals, no polling**: the process catalog, the workspace notifications,
  one SystemConfiguration notification on `State:/Network/Service/*/IPv4`
  and `IPv6` (the services whose `NetworkSignature` names a router hardware
  address, IPv4 first; a VPN has none), one wall-clock timer to the next
  window boundary, re-armed at wake and on `NSSystemClockDidChange` and
  `NSSystemTimeZoneDidChange`. The drain checks the boundary and the 10 s
  ends too, before it reads, so a hold is cut where it starts.
- **Networks** are said only as keyed hashes: the first 16 bytes of
  HMAC-SHA256 of the signature with the install's key (`holds.networkKey`),
  lowercase hex. Without a key the helper reads none. A signature never
  leaves its memory; `sondine-audio self-test network` checks the signed
  helper reads one.

### Microphones

- One active mic by default. Selection: the user's **pinned** device (a hard
  override); otherwise, in automatic mode, the device a call is using now
  (call-follow, read from the call's process, ADR 026; never a loopback,
  virtual or aggregate device, nor one whose input streams are all speaker
  echo references); otherwise the default
  input from an allowlist (built-in, USB, Thunderbolt, PCI); otherwise none.
- Never open a Bluetooth mic on its own (it forces low-quality call mode);
  only when pinned with explicit consent or through call-follow, released
  10 s after the call app stops.
- Raw HAL IOProcs with an explicit buffer size; never AVAudioEngine. The IO
  callback only copies into a lock-free ring; a utility-QoS drain worker does
  the rest.
- On a rate or format change, rebuild the resampler first; rebuild the tap or
  device only if zeros or a measured-rate mismatch above 1 % follow.

### Spool and durability

- While listening, every enabled track is appended to a **full-signal
  spool**: raw PCM16 16 kHz files rotated every 10 min per track, committed
  every 2 s (write, `fsync`, then an append-only manifest record with the
  committed offset and a CRC32 of the block, then `fsync` of the manifest).
- Each PCM file has its own manifest, whose header record is written first.
  The `commit` event carries the gaps recorded since the previous commit.
- Recovery first appends and syncs a gap record for the uncommitted tail,
  then truncates the file to its last committed offset, so a crash during
  recovery is finished by the next run. Process crash loses at most 2 s;
  power loss at most 2 s plus filesystem behaviour. Disk-full stops writing,
  records a gap per retry (every 10 s), and raises one error the tray shows
  until a block is stored again (`spool.resumed`).
- **Manifests are the durable record; events are their low-latency copy.**
  Events can be lost (a helper killed before core read them, a core killed
  with events in its socket, commits buffered while core was away that arrive
  before the snapshot names their run, a backlog overflow). After each
  snapshot core reads the manifests of every run it cannot vouch for and
  imports what the database lacks, with the live importer's idempotent
  functions: lost commits, gaps and regions of live runs; runs only their
  manifests know (from a helper that is gone); runs the database still has
  open. A run whose helper is gone closes at its last stored sample
  (`helper_exit`) with a `helper_exit` gap (`power_loss` if it ended before
  the last boot) up to the next run of its track; one the connected helper
  closed while core was away closes as `recovered`. Every closed run is
  accounted for: chunks and gaps cover `[0, sample_end)`, from the manifests
  or as an `unrecorded` gap. A recovery cut drops the chunks it removed.
  Deleted ranges stay deleted.
- At shutdown core imports every event received before the helper's
  `shutdown` ack, so the last commits and closes land before the database
  closes.
- The spool keeps 24 h or 4 GiB (whichever comes first, _target_). Afterwards
  only speech regions (with 1.5 s pre-roll and 0.8 s post-roll), the ranges
  the user keeps (`kept_audio`, « Garder les 2 dernières minutes »), and the
  energy-gated but VAD-rejected audio of the last 7 days (compressed) remain;
  speech regions keep their audio 30 days, archived losslessly (ADR 015).
- The helper writes 10 ms log-energy envelopes for every track (100 floats/s)
  into the manifest, regardless of VAD, for echo analysis.

### Capture gate

- Per track: energy gate (adaptive noise floor), then the VAD engine on the
  drain worker every 256 ms (ONNX Runtime CPU, one intra-op thread, no
  spinning; asserted by a test), then hysteresis segmentation into speech
  regions.
- The VAD sits behind a Swift protocol shared with the helper's file mode
  (`sondine-audio segment --in clip.wav`), which the bench uses.
- Target: missed speech ≤ 1 % per track type on the ungated golden split;
  false alarms limited by the budget.

### Echo and duplicates

- Evidence, not blanket hiding: route prior (built-in speakers vs
  headphones), lag-compensated envelope correlation between each mic and the
  app/system tracks or the self-playback reference, and word-level matching.
- Built (ADR 020, ADR 035): Sondine's own playback is reported by its player
  (the route prior: through headphones nothing is left out). On the
  speakers, the helper taps Sondine's own processes for the private
  `self:playback` reference: 10 ms energy frames sent as `self.envelope`,
  no run, no spool, no VAD, kept by core in memory only (15 min). Each
  closed mic region whose midpoint falls in a playback on the speakers is
  judged once against it (`envelope-echo/1`, `packages/engines/src/self-echo`:
  window lags over 0 to 2 s, then what the playback explains at that lag,
  held through the room's echo, plus the speaker-to-mic coupling; frames
  well above it are someone speaking). Someone spoke: the region joins the
  episodes, and its echo stretches leave its transcript (`echo/4`). Echo,
  no reference, or not judged yet: it belongs to no episode. Only the
  verdict is stored (`self_echoes`).
- A mic word is hidden only on evidence: a lag-compensated app or system
  word with the same normalized form overlaps it, or it was said in a
  stretch judged echo of Sondine's own playback; near-end speech during
  double-talk stays. Originals are never deleted.
- Built (M3, `echo/3`, then `echo/4`, `packages/core/src/episodes/echo.ts`):
  word evidence for played tracks. Before turns are derived, mic words leave
  the published transcript when one stretch of one `system:` or `app:` track
  says them word for word,
  in order on both sides, heard on the mic 0 to 450 ms later with a steady
  lag, three words or more (or a whole two-word mic sentence within 250 ms).
  What the user said around it stays as its own sentences, interjections
  included; speaker turns are cut at what it took. When unsure, the user's
  words stay. The audio stays, so a later pass decides again; the run
  records `metrics.echoWords`. `echo/4` also takes the mic words said in
  the echo stretches ADR 035 found. Envelope correlation between the mic
  and app or system tracks is not built.
- Identity: a voice heard mainly on app/system tracks does not enroll from
  mic exemplars that correlate with playback.
- Voice Processing I/O is rejected. Tap-reference AEC is a later stage
  (trigger: measured echo-flag rate on built-in-speaker routes).

### Power

- The helper sets `SleepingIsAllowed=1` and `FavorSavingPower`. It takes a
  `PreventUserIdleSystemSleep` assertion only while in-person speech is active
  on the mic, released when the episode closes.
- Electron's `powerSaveBlocker` is banned by lint except behind an explicit
  user action. Main and core tolerate App Nap.

### Helper protocol

`packages/protocol` owns JSON Schemas and golden fixtures shared with Swift.

- Socket at `<data>/run/audio.sock` (mode 0600, path passed in argv, at most
  103 bytes), JSON lines, one core client at a time, protocol 7. Core →
  helper: `hello`, `config` (the whole policy, private zones' `holds`
  included; core sends it again whenever they change), `exclude.pids`,
  `pin.input`, `pause`, `resume`, `snapshot`, `request.permissions`,
  `shutdown`. Helper → core: `ready`, `ack`, `permissions`, `devices`,
  `processes`, `track.open|update|close` (a close says why: `paused` for the
  user's pause, `held` for a hold), `region.open|close` (a close with the
  apps in front while it lasted), `commit` (spool), `activity`, `call`,
  `listen`, `call.seen` (a call seen whether Sondine listens or not, ADR 036),
  `situation` (screen away, network hashes), `holds` (every active
  hold: occurrence id, reason, scope, start, lifted), `clock` (every 10 s and
  after wake), `self.envelope` (the `self:playback` reference, about once a
  second while Sondine plays, never replayed), `health` (histograms every
  60 s), `warning`, `error`.
- Every request ends with exactly one reply carrying `replyTo`: `ready` for
  `hello`, `ack` otherwise, or `error`. `snapshot` replays the current state
  (permissions, devices, processes, activity, open tracks with their first
  epoch, the change that started their current epoch, open regions, clock,
  active calls, listens and calls seen, the situation, the holds), repeats any spool
  outage still on (as a plain `error`), and ends with `ack`; core's helper client publishes that `ack` so the importer
  knows the replay is complete, and closes the calls it did not replay at the
  last clock that vouched for them: the snapshot's clock is an anchor, and
  vouches only for the calls it replays (ADR 016, "Episodes").
- `call` events: a call app, a call daemon, or a browser playing sound
  started or stopped using a microphone while Sondine listens; one call id per active span. `call.seen`
  says the same calls whatever the user's pause, from the same catalog pass
  (no listener added), and never opens a call span. `request.permissions`
  asks the OS only in the real app.
- 64-bit clocks travel as decimal strings capped at 2^63−1 and stay `bigint`
  in core and in the database.
- While no client is connected the helper keeps capturing and buffers durable
  events (at most 16,384, then `events.dropped`); core resynchronizes state
  with `snapshot`. Unsent durable events survive a disconnect during replay.
  Replies go only to the connection that sent the request. Closing a
  connection never stops the helper: only an acknowledged `shutdown` or the
  end of its stdin (the lifetime pipe from main) does.
- `serve` refuses to start when `<data>/spool` resolves outside the data
  directory.
- Permission status and stream health are separate fields. System audio is
  `granted-verified` after the first non-zero tap sample; silence never
  proves denial. A `denied` or `restricted` status ends the track's run
  (`permission_revoked`), and a new run starts once access is back. A
  microphone change in System Settings makes macOS quit and reopen Sondine;
  a system audio change does not, and the helper reads it at its next
  health tick (ADR 004).

## 4. Engines

See [ADR 005](decisions/005-swappable-engines.md).

- **First-release stages**: `vad` (in the helper), `asr` (with `streaming:
  native | pseudo | none`), `align`, `diarize`, `embed-speaker`. Language ID
  comes from the ASR tag, else `NLLanguageRecognizer` limited to fr/en.
  `textgen` (ADR 028): the daily journal's model, a resident `llama-server`
  on a Unix socket, its output held to a JSON schema; or, when the user
  chose it, their Claude through their `claude` CLI (ADR 027's flags). **Later**, each with a
  trigger: `aec`, `endpoint`, `embed-text`.
- **Product adapter contract** (TypeScript, `packages/engines`): manifest
  (id, version, runtime, artifacts with url/sha256/license/distribution,
  minimum OS, adapter class), capabilities, resources (measured peak
  footprint per input duration, cold/warm load, unload latency, compute
  units, minimum memory), and stage methods taking **file inputs** and returning
  typed results with coverage, timestamp precision, overlapping turns, and
  provenance.
- An engine may cover several stages in one pass (Nemotron 3.5 Transcribe:
  `asr` + `diarize` + word timestamps); it declares each stage it covers. An
  ASR engine with native speakers publishes its turns with its `asr` run;
  separate engines publish one run per stage, linked by `pass_uid` (ADR 016).
- **Runtime wire protocols are per family**, hidden behind adapters:
  `sondine-engines` (Swift: FluidAudio offline mode, Speech framework,
  speech-swift) speaks JSON lines with request ids, protocol negotiation,
  progress, cancellation acknowledgement, deadlines, and exactly one
  terminal message per request. `speech.cpp worker` keeps its own JSONL
  protocol (base64 PCM); its adapter bounds input size, and may turn the
  model's progress into a share of the request's time: Nemotron's gives its
  two quick steps two thirds and counts writing against the whole context,
  so its adapter gives them 15 % and measures writing in tokens against
  those the audio should give (`nemotron-progress.ts`).
- **Adapter classes**: `product` (runs in a shipped worker) and `probe`
  (bench only, may use Python via `uv`; never selectable as a default until
  ported).
- **License gate** before an engine can become a default. Bundled weights:
  MIT, Apache-2.0, BSD, or CC-BY-4.0 (with attribution in the UI).
  Downloaded weights may also use OpenMDW-1.1 (Nemotron) when the user starts
  the download from the pinned upstream URL, the license and notices are
  shown first, and kept next to the files. Licenses with field-of-use,
  non-commercial, or revenue limits are rejected.
- **Model manager** (`packages/engines/src/models`, jobs in core): catalog
  artifacts pinned by URL, size and sha256, installed by import (APFS clone
  on the models volume, a copy otherwise) or by a resumable download the
  user starts from the pinned URL, then verified before an atomic rename.
  Engines never download, and the speech worker has no network. Details in
  ADR 016 "Models".
- **Topology**: VAD, ASR, and diarization run per source track per episode.
  A host step builds episode speakers (links chunk-local and cross-track
  clusters by embedding) before identity linking. A mono mix is a bench
  condition, adopted only if it wins.
- **Long inputs**: `diarize` receives the whole per-track episode (engines
  must declare internal long-form handling or stay probe-only); ASR chunks
  cut only at VAD gaps.

### Provisional reference configuration

Release 1 favours quality on one well-tested machine class (32 GB, macOS 27)
over reach. Until the first benchmark decision, the product runs this
reference configuration, labelled in Settings:

| Stage             | Reference engine                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| VAD               | Silero v6.2 (ONNX Runtime CPU) behind the energy gate                                                                                 |
| ASR + diarization | **Nemotron 3.5 Transcribe 30B IQ4_NL** through a resident `speech.cpp worker`: text, native speakers, and word timestamps in one pass |
| Speaker embedding | WeSpeaker ResNet34-LM on Core ML (`sondine-voice`): links one person's voices within a transcript, suggests names (§8)                |
| Near-live ASR     | Parakeet TDT 0.6B v3 in its own speech.cpp worker, on finished speech every 2 s (ADR 019)                                             |

Nemotron 3.5 Transcribe 30B is the only engine Téo has seen diarize French
conversations well; pyannote community-1 performed poorly in his tests. It is
the **baseline every challenger must beat** on end-to-end tcpWER and speaker
attribution, not an optional tier. Its cost (about 17.6 GB peak, 20 s cold
load) is handled by the scheduler: the worker stays resident while a queue
drains, waits for memory headroom, and exits after its idle timeout.

Capture and playback work before any model is installed; analysis waits
visibly. The first decision ("First engine defaults") uses the public quick
tier plus the private golden split (§13). Shortlist per stage: two
challengers plus controls (multilingual Whisper large-v3-turbo, WebRTC VAD,
ECAPA-TDNN). pyannote community-1 is kept only as a control.

## 5. Scheduling and resources

- Release 1 assumes 32 GB of memory; lighter tiers are a later decision.
- One accelerator-heavy job at a time. Admission uses the engine's measured
  peak for this input duration, the system memory-pressure level, swap
  growth, thermal state, and power source; heavy tiers wait for AC and idle.
- Priority: capture, then near-live view, then a user-requested finalize,
  then conversations, then moments (batched: ≥ 10 min queued, hourly, or at
  AC idle), then media, then traces, which run only on an engine already
  loaded for other work and never keep it loaded (ADR 016, "Jobs"). Waiting
  jobs age.
- Preemption is real only if the running engine cancels and releases memory
  within its declared unload latency; otherwise the scheduler waits.

### Always-on budget

Window closed, engine workers excluded (budgeted per audio hour). Measured as
the difference between Sondine running and paused, **coreaudiod included**,
with `sondine-meter` (`phys_footprint`, rusage v6, energy) over every PID.

| Scenario | Content                         |
| -------- | ------------------------------- |
| S0       | Silence, mic only               |
| S1       | Music in one app                |
| S2       | Speech video in Safari          |
| S3       | FaceTime or Zoom call           |
| S4       | In-person speech on the mic     |
| S5       | Four concurrent app taps        |
| S6       | Paused                          |
| Soak     | 8 h mixed, on AC and on battery |

Starting caps (_targets_, replaced by M0 measurements plus 15 %):

| Process           | Footprint | CPU mean S0 / S3  | Wakeups/s S0 / S3 |
| ----------------- | --------- | ----------------- | ----------------- |
| `sondine-audio`   | ≤ 48 MiB  | ≤ 0.4 % / ≤ 1.5 % | ≤ 30 / ≤ 80       |
| coreaudiod delta  | —         | ≤ 0.3 % / ≤ 1.0 % | ≤ +25 / ≤ +60     |
| Electron main     | ≤ 100 MiB | ≤ 0.1 %           | ≤ 1               |
| Chromium services | ≤ 84 MiB  | —                 | ≤ 1               |
| `core`            | ≤ 120 MiB | ≤ 0.1 % / ≤ 0.3 % | ≤ 2 / ≤ 5         |

Totals: footprint ≤ 362 MiB; system power delta ≤ 30 mW in S0, ≤ 120 mW in
S3; footprint slope ≤ 2 MiB/h per process over 8 h; zero ring overflows;
zero Sondine sleep assertions in S0. Energy and wakeups are the gate; CPU
time is diagnostic, recorded with its QoS.

Measured on Téo's Mac, 2026-11-05 (MacBook Air M5, macOS 27.0.1, on AC,
signed build `d1bb53a`, no window), 30 min each:

| S0                | Footprint | CPU mean     | Wakeups/s |
| ----------------- | --------- | ------------ | --------- |
| `sondine-audio`   | 38 MiB    | 0.43 %       | 3.9       |
| coreaudiod delta  | —         | +1.68 points | +19.7     |
| Electron main     | 40 MiB    | 0.08 %       | 1.2       |
| Chromium services | 18 MiB    | 0.01 %       | 0.9       |
| `core`            | 48 MiB    | 0.21 %       | 0.5       |

Total 155 MiB (147 MiB paused, S6). Sondine's own CPU energy is 0.97 mW
above paused; coreaudiod's and the device's power need root and are not
measured. No sleep assertion. Above the starting caps: Electron main's
wakeups (1.2 for 1) and coreaudiod's CPU (+1.7 points for 0.3). The
microphone's IO runs in S0 and S6 alike (muted when paused) and the system
tap only in S0, so the tap is the likely cost, on a Mac with 52 audio
clients (§16). Electron
keeps one renderer with no window (13 MiB, no CPU), which the bench reports
as an open window. The runner (M2 Air, 2026-11-04) gave the same picture
with a slower CPU (`sondine-audio` 1.5 %) and no tap cost on an idle
system, and its 8 h soak had no ring overflow and no process growing by
more than 0.5 MiB/h. The S0 caps become these values plus 15 % once the
tap's cost is decided; footprint caps wait for an 8 h soak on this Mac.

## 6. Data model

SQLite in WAL mode, owned by core (`synchronous=NORMAL`, `secure_delete=ON`).
Drizzle for ordinary queries; reviewed SQL for FTS, migrations, and the
publish transaction. See [ADR 006](decisions/006-data-model.md).

| Group      | Tables                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Capture    | `devices`, `apps`, `process_incarnations`, `track_runs`, `epochs`, `spool_files`, `speech_regions` (app named by `system:other` attribution), `chunks` (`audio_state: present \| archived \| expired \| deleted`), `gaps`, `calls` (helper call spans on both clocks), `listens` (other apps listening to a microphone, ADR 020), `foreground_spans` (the app in front over part of a region, ADR 022) |
| Episodes   | `episodes` (`context: call \| in_person \| media \| mixed`, `size: trace \| moment \| conversation`, `analysis_state`, classifier version and inputs), `episode_regions` (one row per region slice: a region cut by a split or the 3 h cap belongs to several episodes of one grouping version)                                                                                                        |
| Analysis   | `analysis_runs` (stage, provenance, input hash, input generation, status, coverage, metrics), `episode_analysis` (current pointers), `segments` (words packed as a BLOB), `speaker_turns`, `episode_speakers`                                                                                                                                                                                          |
| Assertions | `user_assertions` (kind, anchored to `(track_run_id, sample_start, sample_end)`, origin, created, revoked), `deleted_ranges`                                                                                                                                                                                                                                                                           |
| Context    | `context_items` (a note, a link, an image or a file the user added, anchored to `(track_run_id, anchor_sample)`, ADR 024), `context_fts`                                                                                                                                                                                                                                                               |
| Journal    | `journal_runs` (one pass over one episode's transcript, ADR 028), `journal_items` (a line or a commitment), `journal_citations` (the segments it cites), `journal_marks` and `journal_mark_spans` (the user's word, anchored to the cited audio); triggers delete them with any sentence of their episode                                                                                              |
| People     | `people` (`is_self`, unique), `speaker_embeddings` (a voice of a transcript, per embedder version), `voice_reads` (the user's voice read, ADR 034: its embedding only), `voice_passes`, `voice_links`; not built: `exemplars` (own lossless clip, channel, duration, quality, origin `enrolled \| confirmed`)                                                                                          |
| Work       | `jobs`, `job_attempts`                                                                                                                                                                                                                                                                                                                                                                                 |
| Search     | `segments_fts` (external content, `unicode61 remove_diacritics 2`, prefix 2 3), `terms` (Snowball fr/en stems), trigram table for names                                                                                                                                                                                                                                                                |
| Settings   | `settings`, `identity_rules`, `privacy_zone_spans` (when each private zone was on, ADR 029), `situation_spans` (screen away, networks), `kept_audio` (« Garder l'audio », « Garder les 2 dernières minutes »)                                                                                                                                                                                          |

- **User assertions win.** Names, transcript edits, splits, merges, kind
  overrides, and "not this person" are stored as assertions anchored to
  capture facts, never to output ids, and re-applied after every reanalysis.
- **Transcript edits (M2).** The pen beside a segment corrects its text
  (`transcript.edit`; Enter saves, Escape cancels). The segment keeps the
  correction in `text` (so search, exports and agents read it), the engine's
  text in `original_text`, and points to its `transcript_edit` assertion
  (`edit_id`, payload `{ text, original }`); « Rétablir l'original »
  (`transcript.restore`) deletes the assertion. A new transcript gets each
  correction inside publish's transaction: the words timed inside its anchor
  are replaced, those around it stay in their own segments; where two voices
  overlap on one track, it goes to the closest text; it never spans a deleted
  stretch, and one that matches nothing waits for the next transcript.
  Deleting a recording deletes its corrections with its segments.
- **Split and merge (M2).** A closed episode is never regrouped, so its
  boundaries are its rows. The scissors beside a segment (`episodes.split`)
  move the members after its start to a new episode (a region across the cut
  is sliced) and « Fusionner avec la précédente / la suivante »
  (`episodes.merge`) moves the later episode's members into the earlier one.
  The transcript moves with them, republished as derived runs through
  compare-and-publish (a sentence across the cut is cut between its words;
  corrections and names follow their anchors; voices of one lineage keep
  their labels when a split comes back together), certified for the new
  generation only when its source was current, so nothing is re-transcribed
  for it. The episode's « do not identify » rule goes to both parts, and the
  stricter one wins in a merge. Late regions are still repaired into the
  episode they overlap most; they arrive minutes after an episode closes,
  before anyone splits it.
- **End (ADR 044).** « Terminer » (`episodes.end`) ends an open episode as a
  `force_boundary` assertion: the instant on the capture clock and the lane,
  anchored to its last speech. Every pass cuts that lane there, a region said
  across included; the episode closes once its tracks are imported 3 s past
  the end, and reads as closed meanwhile. What follows is another episode.
  Listening is untouched.
- **Kind (M2).** « Type ▸ » in the episode's « ⋯ » says it is a
  conversation, a moment or media (`episodes.setKind`), as `size_override` /
  `context_override` assertions anchored to its longest member slice, so
  they follow its audio. Every later size decision of a closed episode (a
  transcript, a repair, a split or merge) applies them last; « Automatique »
  deletes them and restores the automatic choice kept in `kind_inputs`.
- **Compare-and-publish.** A run publishes only if its input generation is
  still current and no deleted range intersects it; otherwise it is
  discarded. Publish is one transaction: current pointers, segments, turns,
  automatic links, boundary changes, FTS rows.
- **Retention expiry vs deletion.** Expiry removes chunk bytes and sets
  `expired`; text, turns, links, and FTS stay. Only an explicit user delete
  cascades (rows, files, FTS with `secure-delete`, WAL checkpoint, tombstones
  for phones). The importer and regrouper skip `deleted_ranges`.
- **Deleting a passage (M2).** « Supprimer… » on sentences of a closed
  episode, or text selected over several of them, or ⌫; the bar takes the
  passage to the start or the end, and every sentence chosen deletes the
  recording as its menu does (`episodes.delete`). Otherwise
  (`episodes.deletePassage`): a `track_run` tombstone over the
  passage on each of its tracks (regions' roll where a region edge falls
  inside), its 2 s spool blocks scrubbed whole, segments, turns and their
  corrections removed wherever they are, other assertions cut around it.
  Every episode whose transcript or audio reached it gets a new input
  generation and its transcripts (final or live) published again without
  it, so voice embeddings that heard it go and late jobs are refused. A
  complete transcript with nothing left outside it deletes the episode
  whole. `Status.deletions` moves before the scrub, so a pending export and
  the player (which reloads without its buffer) never keep it.
- **People vs voice profiles.** Exemplars own their lossless clip, so an
  embedder swap re-embeds everyone, including people not heard within the
  audio retention window.
- **The app in front (ADR 022).** `foreground_spans` hold the app in front
  over part of a speech region (run samples, wall times, the app), clipped
  to the region as stored when its close is imported; they go with their
  region (foreign key), and deleting a recording or a passage cuts them
  around each tombstone, « forget » by wall time. Retention keeps them with
  the text. A segment's app is the span of its track run at its middle (one
  seek, a run's spans never overlap), read with the segment, never stored on
  it: `TranscriptSegment.app` and `SearchHit.app`, null when none.
- **Context (ADR 024).** `context_items` hold what the user added to a
  conversation: a note, a link (address and the title the user typed, never
  fetched), an image or a file (copied into `<data>/context/<sha256>`, an
  image with an upright preview without metadata). Each is anchored to a
  point of captured audio inside one of the episode's member slices, never
  to an episode id, so regrouping, splits, merges and reanalyses move none;
  a pinned one also keeps its sentence's span. Deleting an episode deletes
  its items, a tombstone deletes the items pinned to a sentence it meets, and
  items whose audio leaves every episode settle on their episode's first
  free audio. Files go once no item and no ⌘Z step holds them. An audio
  file's « Transcrire » makes an imported recording (ADR 021) the item links
  by its track run (`transcript_run_id`); a deletion that takes the item
  deletes that recording in its transaction, « Retirer » only unlinks it.
- **Storage location**: the app group container (protected by macOS app data
  protection), model weights outside it (ADR 013).

## 7. Episodes: conversations and moments

See [ADR 007](decisions/007-conversations-and-moments.md).

- Grouping is deterministic and versioned; boundaries are provisional and may
  be re-split after analysis; manual boundaries are constraints.
- `context` (call, in-person, media, mixed, dictation) is computed after echo flags and
  cross-track dedup. `size` (trace, moment, conversation) comes from a total
  decision table on deduplicated voiced time, elapsed time, speakers, and
  turns, with hysteresis and an explicit provisional state.
- Thresholds affect presentation and priority, never retention.
- Starting values, exported as constants and covered by the version strings
  (`grouping/6`, `size/1`): in-person episodes close after 45 s without
  speech, media after 120 s, calls after 5 min; a call that restarts within
  45 s is the same call; sleep, wake, pause, and resume always split, while device changes and
  capture restarts are only recorded as discontinuities; past 3 h an episode
  is cut at its longest silence (manual merges may exceed it and are
  flagged). The user's end closes one lane's episode at once (ADR 044).
- Calls come from the helper's `call` events (a call app, a call daemon, or
  a browser using the microphone while it plays sound; M1 step 2). During one, the mic, the call
  app's track, and `system:other` (when the app has no tap of its own and
  the track's attribution names no other app) form one `call` episode;
  mic speech while a dictation app listens is a dictation, in a call too
  (ADR 020); outside calls, other mic speech is in person and app or system
  speech is media (ADR 016, "Episodes"). Size: trace below 1.5 s voiced; call, ≥ 60 s voiced, or ≥ 3 min
  elapsed with ≥ 2 speakers or ≥ 6 turns make a conversation; otherwise a
  moment. Hysteresis margins: trace ±0.3 s, voiced ±6 s, elapsed ±15 s,
  turns ±1.
- Moments are grouped per hour in the timeline, searchable and playable;
  conversations get their own view; media and dictations each sit in their
  own lane, hidden by default. An episode names the apps heard in it; in a call, the mic voice
  that speaks most is shown as the user (`self`, « Moi »), a source
  assumption derived at each read until identities (§8).
- Timeline lanes: `media` episodes go to the media lane whatever their size;
  every other episode goes by size, `mixed` and an unknown context included,
  like in-person speech (a mixed conversation is a conversation row, a mixed
  moment joins its hour, a mixed trace is counted with the traces). An
  episode with no size yet is a moment.

## 8. People and voice identity

See [ADR 012](decisions/012-third-parties-and-biometrics.md).

- Only `call` and `in_person` episodes feed identity. Media keeps local labels
  ("Speaker 1") and never creates, suggests, or links people.
- Embeddings come from exclusive speech ≥ 3 s, trimmed at turn edges; 1-3 s
  clusters may only produce stricter suggestions, never new profiles.
- **Zones** (ADR 030, amending Phase A's two bands): nothing, « Marie ? » to
  confirm from 80 %, and from 99 % « Marie* », shown as the person until the
  user confirms or corrects it. Leaving the queue below (recognized, not only
  likely) opens per channel pair
  once held-out false-accept and abstention are measured on it: a microphone
  voice against microphone references only, so far. One prompt per episode
  speaker in a "Who is this?" queue, for voices neither named nor recognized
  for sure.
- Several clusters may link to one person (mic change, cross-track,
  over-split). Simultaneous independent voices are conflict evidence; no
  forced one-to-one assignment.
- Calibration per embedder version on Téo's confirmed labels and public
  recordings (SUMM-RE), held out by episode and day (ADR 030); recalibrated
  as the labels grow.
- The user (`is_self`) is enrolled opt-in (a short read in onboarding, or
  confirming "this is me"); « Apprendre ma voix depuis mes dictées » (off by
  default, ADR 030) adds their latest dictations that sound like them.
- **The voice read (ADR 034).** In the first run (« Apprendre ma voix »,
  after the permissions, « Passer » beside « Commencer »), Settings ▸ Voix
  and the user's page: the user reads a short text aloud while main runs
  `sondine-audio read-voice` (one microphone, chosen as the helper chooses
  it, 16 kHz PCM16 to a new file in `<data>/voice-read`, levels on stdout)
  and core holds the helper's microphone paused (`Listening.holdMicrophone`,
  the intent untouched), so the read is never a memory. Core cuts its voiced
  stretches, `sondine-voice` embeds them, the file is deleted, and the
  embedding is kept in `voice_reads` for the user's row (made as « Moi »
  when there is none). It is one reference on its day, on the microphone,
  its own sitting: « Moi ? » or « Moi* » from the first day, recognition still after
  three references on two days. Reading again replaces it; « Oublier ma
  voix lue », « Reconnaître les voix » off and deleting the user delete it.
  Refused while recognition is off.
- Automatic matches never add exemplars: a recognized voice joins its
  person's references only once the user confirms it. "Recognise voices" can
  be turned off globally, per app, or per episode.
- **Naming (M3, first slice, no biometrics).** The user names a voice of a
  transcript (« Qui est-ce ? » on the conversation's voices, `speakers.name`
  with the transcript's `runId`, refused once a newer transcript replaced
  it). A voice's speech is its segments, merged, without those whose words
  the alignment spread far apart (longer than 2 s plus 1 s a word: Nemotron
  spread one sentence over minutes in transcripts made before its word times
  were repaired, ADR 016, and such a span took other voices' names). Naming
  writes one `speaker_is` assertion per stretch of that speech, with a
  foreign key to `people`, and revokes the anchors it replaces. A speaker of
  the current transcript reads as a person when that person's anchors cover
  at least half of the speech it has alone (where no other voice of the
  track speaks, or all of it when that is under 1 s) and
  80 % of all anchored speech there (and at least 1 s, or, for a shorter
  voice, anchors laid on it: none of that person's anchors over it reaches
  more than 0.25 s past its speech): people talk over each other, and naming
  one voice must not unname the other. A voice split by a reanalysis keeps
  the name on each part, two named voices merged into one stay unnamed, a
  voice that overlaps a named one for part of its speech never borrows it,
  and a « hm » cut out of a named voice never takes its name. Naming a voice
  again as the person it reads as writes nothing, and a name the voice would
  not read is not written: the action fails instead of doing nothing. A voice
  named as the user is
  `self`, and a named voice is never the guessed `self`. Naming is refused in
  media and where an identity rule says not to identify. Deleting a person
  deletes their assertions (cascade); deleting a recording deletes the
  anchors in its ranges.
- **Linking.** Nemotron numbers each request's voices on its own, and
  sometimes gives one person two numbers within a request: a 3 h 22 import
  of four people came out as 25 voices. Once a transcript is published (the
  queue wakes the voice pass), the voice pass embeds each voice from its
  exclusive speech, as below, in every context, and merges voices of one
  track whose groups average a cosine of 0.70 or more (average linkage; on
  that import one person scored 0.72–0.94, two people at most 0.53). A named
  voice links only with voices named as the same person: a name covers the
  speech it was given, and linking never names. Merged voices take the label and
  number of the one heard first, in segments, turns and `episode_speakers`
  in place; `voice_links` marks the run, once. These embeddings are never
  kept: imports and media are linked, not recognised. Transcripts published
  before linking existed are linked by the same scan, newest first.
- **Recognition (M3, second slice, Phase A).** After a transcript is
  published and linked, the voice pass embeds each voice of a call, in-person
  or mixed episode where voices may be identified: its exclusive speech (its
  segments minus every other voice's time on any track, 0.25 s off each end,
  stretches of 1 s or more, up to 30 s; a segment longer than 2 s plus 1 s a
  word is left out, its words spread by the alignment), read back from the spool, sent on
  stdin to `sondine-voice` in the sandboxed `Sondine Voice.app` (WeSpeaker
  ResNet34-LM on Core ML, CC-BY-4.0, bundled with its notice). Embeddings
  live with their run and episode (`speaker_embeddings`, cascades). A
  person's references are the embeddings of the voices named as them; an
  unnamed voice is compared with their centroid, heard the same way when
  they have some (ADR 030), and gets a confidence,
  `σ(26.6 × cosine − 11.55)`. From 80 %, 0.10 ahead of anyone else, it shows
  « Marie ? »; from 99 %, on any channel, « Marie* »; with three references on
  two days, microphone against microphone and 3 s of speech, it is also
  recognized and leaves « Qui est-ce ? ».
  All are derived at each read, never stored. « Oui » names it, « Non »
  writes `speaker_is_not` over its speech. Unnamed embeddings of episodes
  older than 90 days are deleted. « Reconnaître les voix » (Settings ▸ Voix, the
  global identity rule) turned off reads no name anywhere and deletes every
  embedding; the names given stay and read again once it is back on.
  Deleting a person deletes the embeddings of the voices their name reached.
  The voice reads « Marie ? » or « Marie* » in the header, each
  transcript turn and the People queue, and « Marie* » wherever voices are
  named (titles, player, Today, calendar, search, journal); hovering or
  clicking it gives the confidence and asks only « Oui », « Non » or
  « Modifier », which opens « Qui est-ce ? ». Any other voice opens
  « Qui est-ce ? » on click. « Qui est-ce ? » gives each person how much the
  voice sounds like them (`speakers.likeness`, « C'est moi 34 % »), the
  likeliest first, whatever the zone.
  Episode summaries carry the people named in them (`EpisodeSummary.people`)
  and those recognized (`recognized`), so Today reads « Moi, Marie* » instead
  of « 2 voix ». Agents get recognitions in fields of their own, never as
  names; transcript exports keep the user's names only, and the journal
  shows Sondine's guesses from 80 % as « Marie ? », a link that plays the
  voice, never written into its lines.
  People opens with « Qui est-ce ? »: the unnamed voices of the last 30 days
  that spoke 10 s or more, suggested ones first; above them, « À vérifier »
  asks about the voices the user named that sound like someone else at 99 %
  (ADR 030). Not yet: lossless exemplar
  clips (an embedder change cannot re-embed voices whose audio expired, nor
  the voice read, whose recording is deleted once embedded).
- **Merging people (ADR 025).** « Fusionner avec… » on a person's page: every
  assertion naming the other person, revoked ones too, names this one, and
  the other row goes; the name of the page stays, `is_self` if either had it.
  Embeddings stay with their voices, so the person's voice is both at once.
  The merged person's « Non » are cut around the speech named as them and
  around each other (one refusal per sample). Undoable (`people` level of
  the ⌘Z capture). Splitting is « Modifier » on each voice wrongly named.
- **Live identity in calls (ADR 025).** While a call span is active, its far
  side (the call app's tap, or `system:other` attributed to the call app;
  never a microphone) is embedded by `sondine-voice` in windows that never
  overlap: each 3 s over its first 30 s, then the latest 10 s each 30 s,
  following the importer's commits. Each window is matched as any voice is,
  the user competing, on a channel not measured: it counts from 99 % only,
  two agreeing windows make « Marie ? », and nobody is recognized live.
  Nothing is stored; the suggestions live in core until the span ends, cleared by a
  deletion, a pause or a rule. `calls.watch` (never agents) gives each
  person's last three conversations; the menu bar and the notch show them.

## 9. Search

- One external-content FTS5 table on the fr-norm form of segment text (`unicode61
  remove_diacritics 2`, prefixes 2 and 3), a `terms` table with French and
  English Snowball stems for query expansion, and a trigram table for names
  and partial words. Ranked with bm25.
- A query is normalized in French and in English (the forms are ORed). Each
  word typed becomes one quoted phrase of the tokens it normalizes to
  ("l'école" is `l ecole`, "22" is `vingt deux`); the phrases are ANDed and
  the last word is a prefix from two letters.
- Results are grouped by episode, newest first, and paged by episode: the
  filters (local days `from`/`to` inclusive, sizes, contexts; by default
  everything, media, `mixed` and traces included) apply before paging, so a
  page never splits an episode and `total` counts episodes. Each episode
  brings its number of matching segments and its best five (bm25) in time
  order. `untranscribed` counts the closed episodes in the filtered range
  without a transcript yet, which search cannot see; traces are left out of
  that count because they are not transcribed.
- Highlights are exact: the index holds normalized text, so offsets are
  never taken from it. `frNormAlign` (core) cuts the original text into
  pieces (a word, an elided article with its apostrophe, a run of digits, a
  punctuation mark), normalizes each alone, and merges neighbours where that
  differs from normalizing the whole text ("15 %", "10 h 05", "1 000",
  "quatre vingts"), so its units cover the original and their tokens are
  exactly the indexed ones. The query's phrases are matched on those tokens
  the way FTS5 matches them (unicode61 splitting, phrases in a row, prefix on
  the last token, every phrase of a form present), and each match returns
  the original span of its units, in UTF-16 code units: "22" for `vingt
  deux`, nothing for a dropped filler. A test checks that the segments with
  highlights are exactly the ones FTS5 returns. Highlights are computed when
  read, never stored; `searchHighlightsId` carries the alignment version and
  the normalizer id.
- Phonetic keys (M4): a French/English phonetic code per word and per name
  in the personal vocabulary, so a misheard name still matches. The
  vocabulary drives post-correction (ADR 046): names the user's corrections
  taught and their names (Settings ▸ Vocabulaire, People) by sound, at
  publish and over the last 7 days; a word that only looks like one of the
  list is read by the journal's model in the scheduler's journal units. It
  may later bias ASR where an engine supports it (an `asr` capability
  measured on the bench); nothing is sent to an engine today.
- Filters: person, app, context, size, date range. Built: date range, size,
  context, and « Pendant que j'étais dans… » (`foregroundApp`, ADR 022): only
  the segments whose app in front at their middle is that app, the
  untranscribed count narrowed to episodes with speech in it; the menu lists
  the apps something was said in, the latest first (`search.foregroundApps`).
- Context (ADR 024): `context_fts` indexes each item's notes, link title and
  address, or file name in the same form; an episode matches by its
  segments or its context, paged and counted together, and its context
  matches come as `contextHits`. With `foregroundApp`, context is left out.
- Semantic search is a later stage (`embed-text`).

## 10. Near-live view

- A setting (« Texte en direct », ADR 019), off by default, on power only: a
  small engine (Parakeet) transcribes the finished speech of open episodes
  every 2 s, the commit cadence, newest first, each region slice once, with
  no gap or overlap (aligned on sample index); speech still going waits for
  its pause.
- Near-live text is stored as a provisional run, replaced only when the final
  analysis publishes; it survives closing the window and a failed final pass.
- The worker exits when a condition fails, and 60 s after its last request.
  A binary PCM stream (lower latency) is a later option if measurements
  justify it.

## 11. API and interface

- Every user action is one oRPC procedure in `packages/api` with schema,
  errors, MCP metadata, and a local metrics event name. The app calls it
  through TanStack Query.
- Transports: a MessagePort brokered once by main between renderer and core
  (main validates the sender frame and re-brokers on reload); the MCP socket
  (ADR 011); LAN HTTPS for paired phones (release 2).
- Browser link (ADR 023): off until the user turns on « Savoir quelle page
  joue le son » in Settings ▸ Navigateurs, which writes Sondine's native
  messaging host manifest into each installed browser's folder and listens
  on `run/browser.sock`; the extension, loaded by the user, reports the
  tabs that play through `sondine-browser`, at each change and, while
  linked, at least every minute (it reads the tabs every 20 s: Yab sends no
  event when a tab starts playing); every page also says itself when it is
  heard (a page script on all sites, its address, title and whether it is
  heard, nothing else), for Yab, which runs the extension in its Chromium
  engine whose tabs API lists none of its WebKit tabs. A browser's links share its plays (Yab
  runs two workers at once and leaves ports open after them); core closes a
  link that never speaks or falls silent past its promised refresh, and
  traces the link, never a page, in `diagnostics/browser-link.jsonl`
  (2 × 256 KiB at most). Settings shows each browser's links, when its
  extension last spoke, and an extension older than Sondine's. Media episodes name their page
  (« YouTube · <titre> », opened in the default browser by main), YouTube
  sentences open the video at their time, and a site the user does not keep
  has its episodes deleted when they close, with the audio heard while it
  played, before any transcription.
- Agents (M2, ADR 011): off until the user turns on « Autoriser les agents »
  in Settings ▸ Agents, which says what agents will read and that it goes to
  their provider. Each agent connected there gets its own key and a command
  to paste (Claude Code, Codex); the list shows who is connected, and the
  log what each read (tool and episode, person or day, never words). Core
  listens on `run/mcp.sock` only while access is on; `sondine-mcp` relays an
  agent's stdio to it. Read-only tools from an explicit list, through the
  app's procedures; an answer is withheld if anything was deleted while it
  was read, and revoking cuts the agent off at once.
- Discussion with an agent (ADR 027): off until the user turns on
  « Discuter avec un agent dans Sondine » in Settings, after a dialog that
  says what leaves. `/chat` lists this session's discussions and sends a
  message with the model and effort chosen among those the user's Claude
  Code offers (`chat.send`, streamed back by `chat.watch`). Core finds the
  CLI through the login shell, starts it headless with no tool, setting,
  hook, memory, MCP server or session file of the user's, and gives it
  Sondine's relay with a key of the discussion's own: the agent reads
  through the same edge and tools as outside agents. Discussions are kept in
  the database (`chat_discussions`, `chat_messages`) with what each agent
  read (`chat_reads`: episodes at their input generation, people, items of
  context); a deletion erases the discussions with a read since gone or
  changed.
- Undo (M2, ADR 017): Édition ▸ Annuler / Rétablir (⌘Z, ⇧⌘Z) reach the
  page from main; outside a text field it calls `history.undo` / `redo`.
  Core captures what each window edit may change, in its transaction, and
  restores the other capture only while the state still matches it; the
  history lives in core's memory and a deletion forgets it.
- Playback (in the app only, never on MCP). An episode plays as a mono
  16 kHz PCM16 WAV that exists only as a plan: the extents transcription
  reads (region slices with roll, deleted ranges cut out and never read),
  every track placed on one wall-clock timeline. Missing audio and the time
  between extents are silent.
  - `episodes.playback` plans the timeline (no audio read) and returns
    `src` (`sondine-media://episode/<id>?g=<generation>`), `startedAtMs`,
    `durationMs` and `generation`. A segment plays from
    `(segment.startMs - startedAtMs) / 1000` s, whatever its track. The frame
    comes from the extents before any deletion, so a later deletion silences
    audio without moving anything else.
  - The window's audio element loads `src`. Main registers `sondine-media:`
    (`standard`, `secure`, `stream`; no CSP bypass, no fetch, no CORS) and
    serves only GET from the app's own pages: it parses the URL and the
    `Range` header and relays to core on the utility-process channel
    (`media-read` with a request id, `media-cancel`, a 10 s timeout). Core
    answers with one slice of at most 1 MiB (about 32 s), reading and mixing
    only the samples it covers (int16 clamped). A response covers the whole
    range asked for (`206`, or `200` without `Range`), with its exact
    `Content-Length`: Chromium sizes a custom scheme's media from that, not
    from `Content-Range`. Its body pulls the next slice from core only when
    the element reads on, so main holds one slice at a time, and a seek
    cancels it. `404` for an unknown or deleted episode, `409` when `g` is no
    longer the episode's generation (ask `episodes.playback` again), `416`
    past the end, `503` when core is down or busy; always
    `Cache-Control: no-store` and `nosniff`.
  - Core caches plans only (8 episodes), never audio, and runs reads one at
    a time, each in its own turn of the event loop, at most 4 waiting. Every
    read checks the episode, its generation and the tombstones in the same
    synchronous step as the audio read: after a deletion the next range
    answers `404`, and no deleted sample is ever read. Measured on a 3 h
    episode of two overlapping runs on disk, files in the page cache
    (2026-11-06): planning 1.6 ms (300 regions) to 4.8 ms (3,000 regions); a
    slice 1.1 to 1.4 ms at the median, 4.7 ms at most; core RSS +24 MB at
    peak over 140 slices.
  - Limit: bytes already delivered to the renderer cannot be recalled. A
    deletion stops the next range, not what the element has buffered (a few
    minutes at most); stopping clears the element's source, which drops it.
  - The renderer's CSP allows `media-src sondine-media:` and nothing else
    for media.
- Today reads one call, `episodes.day` (also the MCP tool `get_day_overview`),
  computed in core over one indexed scan of the day's episodes: the
  conversations (open ones included with their provisional size), the hours
  with moments (count, untranscribed count, the first words of the newest
  three with text), the media lane, the trace count, and a `revision`. The
  conversation and media lanes come as pages of 100 with their `total` and a
  cursor. An hour group expands with `episodes.list({ day, hour, lane:
  "moments" })`; `episodes.list` pages with a keyset cursor (start time, id),
  stable while new episodes arrive. The screen refetches `episodes.day` every
  15 s, which costs about 3.5 ms on a day of 2 000 episodes; `revision` (a
  hash over the day's episode ids and `updated_at_ms`, which every episode
  write sets) changes only when the day does, so expanded hour groups are
  keyed on it and do not poll.
- `episodes.get` takes an optional `q`: each transcript segment then carries
  its highlights, so the Conversation view can show and step through the
  matches of the search it came from.
- Models (in the app only, never on MCP: an agent never starts a 19 GB
  download): `models.status` and `models.watch` (each catalog artifact's
  phase, progress, kept download bytes, found file and whether importing it
  clones, problem, license; free disk; memory), `models.import`,
  `models.pick` (main shows the open panel), `models.download`,
  `models.cancel` (with `discard`). One job per artifact in core; starting
  what runs returns the status. ADR 016 "Models".
- First run (`onboarding.get`, `onboarding.advance`, `onboarding.complete`,
  in the app only). Its progress is a settings row, kept apart from what
  other services own: the listening intent (Listening), the permission
  evidence (the helper's status), the model (Models).
  - A fresh install (no row, no track run ever) pauses listening before the
    helper connects; the helper client pauses paused sources before `config`
    on every connection, so a new helper never opens them. Nothing is
    recorded until `onboarding.complete` with `startListening`, which
    resumes, then marks the first run done; a helper refusal leaves it open.
    Later calls change nothing.
  - The steps: what Sondine does, the question about anonymous statistics
    (ADR 042: `usage.setSharing`, two equal answers), the permissions, the
    voice read
    (optional, ADR 034: `voiceRead.start`, `finish`, `cancel`, `forget`,
    `get`, `watch`, in the app only), the model (optional), and starting to
    listen. The voice read records only the text the user reads, with the
    helper's microphone held paused, and works before `complete`.
  - An install that already captured (any track run) is marked done at
    startup, with its listening intent untouched.
  - The model step is optional ("Continue without transcription"): capture
    and playback work without a model, and analysis waits with `no-model`.
    It asks first where to transcribe (ADR 040, `compute.*`), then shows
    what the chosen place asks for: the model download for this Mac, or a
    server's terms and its button. That second screen is not saved: a
    relaunch reopens the choice, with the place in force picked.
  - The step on screen is saved with `advance`. macOS may relaunch the app
    after a permission prompt (the microphone's does); the first run reopens
    at that step, still paused. A user who resumes from the menu bar before
    the end is listening; the first run still shows until completed.
- Private zones (ADR 029): Settings ▸ Confidentialité (`privacy.*`, in the
  app only, never on MCP). By default everything is kept; each zone (an app,
  a site, the network the Mac is on, hours, every call, the screen away, and
  the built-in films, series and music sites) takes away the audio, the text
  or both, or deletes after a day or a week; zones add up. What decides is
  stored, never a snapshot: when each zone was on (`privacy_zone_spans`),
  what the helper saw (`situation_spans`), and the episode's apps, page and
  type, so a recording touches a zone when they share 250 ms (or all of a
  shorter one), every span of a zone counting. Core puts the apps at « Rien » in the helper's
  `excludedBundleIds`; an episode that keeps nothing goes when it closes
  (`dropRecordingsKeepingNothing`, ADR 023's path); no automatic job, live
  text or publication for one a zone keeps from text, unless the user asks;
  its audio goes once its final transcript is published (`takeAudioAfterText`,
  blocks marked deleted, then scrubbed). Every 10 min the privacy pass
  deletes recordings whose « Effacé après » is up (« Supprimer »'s
  coordinator), takes the audio of untranscribed text-only recordings after
  7 days, then expires archived audio by type (calls and conversations 90
  days, moments 30, media, traces and dictations 7, counted from the
  recording's end, at least 30 days from the update for audio recorded
  before it; 7 more
  days while it waits for its first transcript), oldest first past the
  20 GiB cap (`expireArchivedAudio`: zeroes, commits, unlinks empty
  archives). « Garder l'audio » (`episodes.keepAudio`, `kept_audio` ranges)
  exempts a recording from all of it, and so does « Garder les 2 dernières
  minutes » (`episodes.keepRecent`, ranges with origin `moment`) for the
  recordings its two minutes reach. A duration change that would remove
  something now returns the counts first (`confirm: false`). Holds never
  write the listening intent; `ListeningStatus.holds` lists them.
- Timed pause: `listening.pause` takes an optional `untilMs`, refused when
  already past; `ListeningStatus.pausedUntilMs` is its end (null for an
  open-ended pause or while listening). Core stores the deadline with the
  paused flags in one transaction and compares it with the wall clock at the
  deadline, at least every 30 s, and as soon as the Mac wakes (Node's timers
  stop during sleep); a deadline passed while Sondine was off resumes at
  launch. Any newer pause or resume replaces the deadline, so an older one
  never fires. The pause covers the scope it was given and ends with it.
- A call (ADR 036, `apps/desktop/src/core/call-offers/`): core follows the
  calls the helper sees (`call.seen`; one lasts until its app has not been
  seen in one for 10 s) and says the one going on with its open episode
  (`ListeningStatus.call`), then what it left (`callEnded`). On a screen with
  a notch the island shows it all call long with a switch, « Ouvrir » and
  « Terminer » (below); without one, a notification offers the same.
  A pause with no end that lasts 3 h is said once (`pauseReminder`). An offer:
  core offers the latest call the helper sees (`call.seen`) while the user's
  pause covers anything, if the pause began at least a minute before the
  call, the app is not muted, the user has not declined it, and no unlifted
  private zone holds capture (`ListeningStatus.callOffer`). The island says
  it once per call; without a notch, or with a second display, a macOS
  notification does (Electron's `Notification`, User Notifications, signed
  builds only) with « Écouter cet appel », « Reprendre l'écoute » and « Pas
  pour <app> ». The menu bar has the same switch while the call lasts.
  `callOffers.listen` resumes what the pause covered and stores, with the
  flags, the call's app and the pause it replaced (`capture.call-listen`,
  `ListeningStatus.forCall`); 10 s after no call of that app is seen, once
  a snapshot has said what the helper sees, Listening reads the stored
  intent again and pauses as before. Any user pause or resume drops the
  record; a timed pause whose end passed is not restored. While nothing is
  paused, the same offer is a `skip` (`CallOffer.kind`): « Sondine écoute
  cet appel » with « Ne pas écouter cet appel » (`callOffers.skip`), which
  pauses everything for that call with the same durable record (`kind:
  "skip"`) and resumes when it ends, unless the user changed the intent
  since. Until the call is over, each takes the other back. Main logs
  `call-offer.notice shown` on Electron's `show` event.
  Settings ▸ Écoute (`callOffers.settings`, `setEnabled`, `allowApp`): one
  switch for both kinds, on by default, a note when macOS keeps the
  notifications off the screen (Node-API addon `notification-settings.node`,
  via preload) with « Ouvrir les réglages », the muted apps with « Prévenir
  à nouveau ». Never on MCP.
- Screens: Today (timeline: conversations as rows, moment groups collapsed,
  media lane hidden), Conversation, People with the "Who is this?" queue,
  Search, Settings (sources, engines with the provisional label, retention,
  privacy), Diagnostics (budget, spans, captures), first run, and the
  dev-only design system page. Tray: listening state (with the end time of a
  timed pause, or the call listened to), the call's switch while one goes on
  (ADR 036), pause for 15 min, 1 h or until resumed, resume, open, keep
  the last 2 minutes (⌃⌥⌘K, also in the sidebar's pause menu, ADR 029),
  erase the last 5, 15 or 60 minutes, a newer version's page or, once it is
  ready, « Redémarrer et mettre à jour » (ADR 045), quit.
- Export (M2): Markdown, SRT/WebVTT, and versioned JSON through the save
  panel or the share sheet, read through the same deletion filter as MCP.
  Text by default, audio clip on request, voice data never. JSON is
  `sondine.transcript/2` (`packages/api/src/transcript-json.ts`, published as
  `docs/schemas/transcript-2.schema.json` by `pnpm --filter @sondine/api run
  gen`; a test keeps them equal; version 2 adds the conversation's context,
  ADR 024). « Partager… » writes the Markdown in a
  folder of its own under the temporary directory and opens the macOS share
  sheet; the folder goes 30 min after the sheet closes, at quit, or at the
  next start. Today's « ⋯ » takes a day the same ways: its transcribed
  conversations and moments in time order, as Markdown or `sondine.day/2`
  (`docs/schemas/day-2.schema.json`); `episodes.exportText` takes the
  episodes' ids and refuses the text once any of them is gone. Search's
  « ⋯ » takes the results (up to 500 episodes with their best matches) as
  Markdown or `sondine.search/2` (`docs/schemas/search-2.schema.json`).
- Context added to a conversation (ADR 024): ⌘V outside a field
  (`context.paste`: main reads the clipboard, files first, then an image it
  writes as PNG into the context staging folder, then text), drops
  (`context.add` with paths or text) and « Choisir des fichiers… »
  (`context.pick`, the open panel through main), pinned to a sentence when
  given its segment. A « Contexte » strip under the header shows them,
  images through `sondine-media://context/<id>?v=<hash prefix>` (main relays
  `context-read` to core like audio); links open in the default browser and
  files in their app from a private temporary copy (`open-file`). Edits,
  removals and pins are ⌘Z steps (`context`). « Transcrire » on an audio
  file (`context.transcribe`) imports it as ADR 021 does. Agents get them in
  `get_episode` and `get_context_item` (an image as MCP image content, a
  text file's text, a PDF or office document up to 5 MiB as an embedded
  resource); exports carry them as text (`sondine.transcript/2`,
  `sondine.day/2`, `sondine.search/2`). ⌃⌥⌘V from any app, or the menu bar's « Ajouter le
  presse-papiers à la conversation », adds the clipboard to the conversation
  going on (`context.pasteOngoing`); main registers the key and shows the
  outcome beside the menu bar icon for a moment.
- Daily journal (ADR 028): `journal.day` and `journal.commitments` (also the
  MCP tools `get_journal` and `list_commitments`), `journal.mark` (« Fait »,
  « Pas un engagement », « Pas juste », « Modifier »), `journal.request`
  (« Écrire maintenant ») and `journal.settings`. The Journal view
  (`/journal`) shows one day: on today the open commitments the user made
  or that were made to them, made in the last 7 days when they have no
  date, else due no more than 7 days ago, then one folded line for those between other people and one
  for the older ones (of the last 30 days); on another day that day's own;
  then its lines by conversation. Today keeps one line, how many of the
  user's commitments are open, to it. Each line ends with the time
  of its cited sentence (hover: the sentences; click: the conversation
  there). The model runs in the analysis scheduler's loop,
  after transcription and never beside it. Settings ▸ Journal du jour says
  who writes it: this Mac, this Mac read again by the user's Claude, or
  their Claude (`journal.claude` shows its sign-in); changing it writes
  nothing again, and « Réécrire ce jour » (`journal.request` with
  `rewrite`) writes a day again by whoever writes now.
- Call context (M4, ADR 025): main follows `calls.watch`; during a call with
  someone suggested, the menu bar reads « Marie ? » beside the icon, and its
  menu starts with her page, her last three conversations (opening in the
  window: main sends `/episode/<id>` on `sondine:navigate`, or loads it in a
  new window's hash) and « Masquer pour cet appel » (`calls.dismiss`). On a
  screen with a notch, the notch becomes an island with the same rows below
  the call's switch (`islandView`, translated; ADR 036): main runs
  `sondine-notch` (AppKit and SwiftUI, sandboxed `Sondine Notch.app`) only
  while there is a view, writes it one `show` line per change on stdin
  (`notch-messages.ts`), and closes stdin to hide it; the helper sends back
  the click, which main checks against the view it shows. Compact (the app's
  icon or her initial, « ? » and the listening dot beside the notch), peek
  (« Marie ? » below it, on arrival), announce (a call that starts, or a card:
  a call's end, a forgotten pause), open when the pointer rests on it
  or, with « Ouvrir l'encoche au survol » off (`calls.setNotch`), on a click.
- Handbook conventions: one typed shortcut registry with rebindable
  shortcuts (TanStack Hotkeys behind a wrapper): `Mod+K` opens Search (the
  validated design gives it the handbook's palette key), `Mod+Shift+P` the
  command palette, `Mod+Shift+D` toggles the theme, and the player takes Space, ←/→
  (5 s) and ↑/↓ (previous/next segment) outside text fields. Paraglide
  fr/en, Sondine Graphical theme, Nucleo icons.

## 12. iPhone companion (release 2)

See [ADR 008](decisions/008-mobile-lan-sync.md) (pairing and sync),
[ADR 031](decisions/031-iphone-app-stack.md) (the app) and
[ADR 032](decisions/032-phone-recordings.md) (recordings). Screens and
journeys are in [iphone-screens.md](iphone-screens.md). Steps M5.1 to
M5.4 and M5.6 are built (the app in `apps/ios`, `SondinePhone` in
`native`, the Mac's import of a phone file; pairing and sync at home through
`sondine-lan` and core's `phone.sock`; a recording's result, its name and
notes, and playback streamed from the Mac; search, the day, its journal,
the open commitments and a conversation's text read live; the Live
Activity and the control); the rest follows plan.md § M5.

The phone records and reads. The Mac analyses, keeps and decides: there is
one memory, the Mac's.

```text
 iPhone: Sondine (SwiftUI, iOS 27)                 Mac: Sondine.app
┌──────────────────────────────────────┐          ┌───────────────────────────────────────────┐
│ recorder (AVAssetWriter)             │          │ sondine-lan (Swift, sandbox: incoming     │
│   one fragmented .m4a per stretch,   │          │   only): Bonjour _sondine._tcp, TLS 1.3,  │
│   header in its comment tag          │          │   peer check; relays bytes, no logic      │
│        │                             │          │        │ <data>/run/phone.sock            │
│        ▼                             │          │        ▼                                  │
│ recordings/<id>/ audio · state ·     │  TLS 1.3 │ core: HTTP on the socket                  │
│   result      (no database)          │  pinned  │   routes: PHONE_PROCEDURES (JSON)         │
│        │                             │  to the  │   bytes: PUT / GET …/audio                │
│ sync client (URLSession, app open) ──┼──────────┼─► phone-inbox/<id>.part ─ sha256 ─┐       │
│   Bonjour at home, known addresses   │  Mac's   │                                   ▼       │
│   elsewhere (Tailscale, opt-in)      │  key     │ import (ADR 021): afinfo reads the header │
│        ▲                             │          │   → archive PCM, track run phone:<id>,    │
│ views: record · list · a recording · │          │     in_person episode, analysis job       │
│   search · today (read live)         │ ◄────────┼── states and results, derived at read     │
└──────────────────────────────────────┘          └───────────────────────────────────────────┘
        │ no network: share sheet, AirDrop, Files ─────► « Importer un audio… », drop, paste
```

### Processes

| Where  | Process       | Owns                                                                                                                                                                                            |
| ------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iPhone | the app       | Recording, its files, the sync client, the screens. Alive in the background only while it records (`audio` mode).                                                                               |
| iPhone | its extension | From M5.6: draws the Live Activity and the control (Lock Screen, Control Center, Action button). Their intent runs in the app; the control reads its state from a keychain group the two share. |
| Mac    | `sondine-lan` | The TCP port, the TLS identity's use, Bonjour, the peer check. Started by core; exits when its stdin closes.                                                                                    |
| Mac    | core          | Everything else: pairing, credentials, the HTTP server on `phone.sock`, the inbox, the import, states and results.                                                                              |

`sondine-audio` gains nothing: it stays without any network entitlement.
Main is not involved beyond showing Settings.

### Flows

1. **Record.** By hand. One file per stretch of continuous audio, 16 kHz
   mono, a fragment every 2 s (a kill loses the last seconds only, to be
   measured on the iPhone), 3 hours at most per file. An interruption closes the file; resuming opens the next one
   of the same session.
2. **Hand over**, three ways that end the same:
   - no network: the share sheet (AirDrop, Files), then the Mac's usual
     import gestures;
   - local network: the paired phone uploads when the app is open, with
     resume by offset, a SHA-256 checked at the end, and `stored`
     answered only after the import committed durably; then the phone
     erases its audio;
   - away from home, when « Autoriser par Tailscale » is on: the same
     upload to the Mac's tunnel address, learned from `hello` at home and
     tried only once no home address answered the pinned `hello` (2 s,
     then 4 s for the tunnel). `hello` says which path the
     relay saw (`via: "tailnet"`, absent at home); the phone's « Mac »
     screen and Settings ▸ Téléphone's last contact show it (M5.5).
3. **Import.** ADR 021's path. A file with Sondine's header becomes a
   phone recording: id from the header (no duplicate, nothing deleted comes
   back, checked again in the publishing transaction), start from the
   header, an `in_person` episode in Today, with a phone mark, transcribed
   as a user request. Forget, split, merge and zones leave it alone, told
   by its track run's kind (`phone`), not by its context.
4. **Analyse.** As any `in_person` episode: transcript, voices linked, then
   suggested on the `phone` channel (§8, never recognized until measured:
   `PHONE_VOICES_MEASURED`, ADR 032 « Built at M5.8 »),
   journal and commitments.
5. **Read.** The phone asks the state of the ids it holds and fetches a
   result when its revision (the SHA-256 of the result as sent) moved:
   core reads it through the app's own procedures (`episodes.get`,
   `journal.day`), withheld when a deletion lands meanwhile, and the phone
   keeps it in `result.json` for recordings of the last 30 days. A name
   and a note typed on the phone wait in its outbox and run on the Mac
   (`context.add`'s path for a note). Playback streams the episode's WAV,
   as the window plays it, by byte ranges into AVPlayer, never written on
   the phone. Search, a day, the journal, the open commitments and any
   conversation's text are read live (`POST /v1/memory/…`) through the
   procedures agents' tools run (`PHONE_MEMORY_READS`), withheld when a
   deletion lands meanwhile, and held by the screen that shows them, never
   in a file; they go when the screen goes or the app leaves the front.
6. **Delete.** Either side; the other follows at the next contact
   (tombstone rows on the Mac, an outbox on the phone).

### Formats

| What              | Format                                                                                                                            | Defined in          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| A recording       | Fragmented MPEG-4 audio (`.m4a`), 16 kHz mono, ALAC unless M5.1 measures that AAC costs nothing                                   | ADR 032             |
| Its header        | JSON in the file's comment tag: recording, session and device ids, part, start (wall clock and UTC offset), input kind, app build | `packages/protocol` |
| Pairing           | A QR: the key's pin, a one-time token, the Bonjour name, port and addresses                                                       | `packages/protocol` |
| Routes            | `POST /v1/<name>` over HTTP/1.1, JSON bodies of `PHONE_ALL_ROUTES`; core routes the `PHONE_PROCEDURES` list only                  | `packages/protocol` |
| Audio on the wire | Raw bytes with an offset (upload) or a byte range of the episode's WAV (playback); never JSON                                     | `packages/protocol` |

Fixtures for each are tested by TypeScript and by Swift.

### Security

- **Transport**: TLS 1.3, the phone trusting only the Mac's public key
  (pinned from the QR). No application-layer cryptography.
- **Pairing**: a one-time token of 5 minutes shown as a QR on the Mac, six
  digits shown on both, a confirmation on the Mac.
- **Identity**: a device id and a random credential (`sdp_…`) in the
  phone's Keychain, this device only; the Mac keeps its hash. Revocable
  per phone, at once. A phone acts only on the recordings it made.
- **Listening**: only while a pairing is open or a phone is paired; peers
  on a directly connected local subnet only, plus Tailscale's ranges on a
  tunnel when the Tailscale switch is on (never for pairing; core closes
  a connection the relay labels `tailnet` while the switch is off, and
  those open when it is turned off); limits on
  connections, time and sizes in the relay and in core, and on wrong
  credentials per peer.
- **Known limits**: a compromised relay can read the data directory; a
  copied key file lets someone pass for the Mac until the pairing is reset
  (ADR 008).
- **Reads** pass the deletion filter and generation check of agents
  (ADR 011): the memory reads run the very procedures of agents' read
  tools, so what agents may not read (zones' settings, people's voices),
  the phone may not either. The phone never gets voice data (embeddings,
  likeness scores, labels), people's ids, diagnostics, settings or the
  audio of what it did not record; a phone sees its own recordings' ids,
  never another phone's.
- **On the phone**: files excluded from backup and unreadable while the
  phone is locked, except those of the recording under way.

### Data

| Where | What                                                                                                                                | Until                                                           |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Phone | A recording's audio                                                                                                                 | The Mac answers `stored`                                        |
| Phone | Its result (text, voices, journal lines, notes), `result.json`                                                                      | Deleted on either side, or the recording is 30 days old         |
| Phone | Search results, a day, the journal                                                                                                  | The app leaves the screen (memory only)                         |
| Mac   | `phone_devices` (name, credential hash, last contact and its path, counts), `phone_recordings` (id, device, track run, state, name) | The phone is revoked; a recording's row stays as a tombstone    |
| Mac   | `same_moment_links` (a phone and a Mac episode compared: offset, drift, shared time, journal source; no audio)                      | Either episode is deleted, or the clocks no longer propose them |
| Mac   | `phone-inbox/<id>.part`                                                                                                             | Imported, or 7 days untouched                                   |
| Mac   | The recording itself                                                                                                                | As any conversation: durations by type, deletion (ADR 029, 032) |

### When something is missing

| Situation                           | What happens                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------ |
| The Mac is off or away              | The phone records and queues; fetched results stay readable; search says the Mac cannot be reached     |
| A transfer is cut                   | It resumes at the byte the Mac holds                                                                   |
| The same recording arrives twice    | One recording; the same id with other bytes is a conflict, and the phone keeps its file                |
| A deleted recording arrives again   | Refused; the phone erases its copy                                                                     |
| The phone is revoked or lost        | Refused from then on; a phone that learns it erases what it cached; a phone never seen again cannot be |
| The app is killed while recording   | The file is readable up to its last seconds; the app says so at its next launch                        |
| The Mac and the phone heard it both | Both kept, linked by their sound (offset within 100 ms), one feeding the journal (ADR 032, M5.7)       |

## 13. Measurement

- **Spans** for every product stage, stored locally, shown on Diagnostics.
  High-rate stages keep histograms in the helper and send them in `health`.
- **Anonymous statistics** (ADR 042, `docs/analytics.md`), only with the
  user's yes: one middleware of the router counts the events of the registry
  by surface (`core/usage/`), a report a day of counts leaves through
  `apps/stats`, and a release alone knows where. Cost on the always-on path:
  without a yes, nothing (no timer, no write); with one, a timer every 30 to
  90 min (under 0.001 wakeups/s for `core`'s 0.5 measured in S0), one settings
  write a minute at most while the user acts, and no audio, VAD or helper
  work.
- **`sondine-bench`** (`apps/bench`) calls the same adapters and the helper's
  file mode. It records host, OS build, power, thermal state, engine
  provenance, corpus manifest hash, and resources via `sondine-meter`.
- **Corpora**: public quick tier (FLEURS fr/en, MLS fr, SUMM-RE test subset,
  AMI eval window, VoxConverse subset, VoxPopuli fr, VoxCeleb1-O), downloaded
  by scripts outside the repo. Private golden set (about 60 min over six
  scenarios to start; dev ≥ 3 h and test ≥ 3 h later), references seeded by a
  non-candidate control engine and flagged `seeded`, consent recorded per
  speaker, never committed.
- **Normalization** for scoring and search is `fr-norm/1`: numbers are
  spelled out as French words (the canonical direction is digits → words),
  with an English path for code-switched spans. Every score stores the
  normalizer id with its options.
- **Selection** is per pipeline profile (vad + asr + align + diarize +
  embed): deciding metrics are end-to-end tcpWER and identity false-merge on
  the private test split, with per-slice quality floors; public corpora are
  diagnostics.
- **Gates**: CI (no models) for parsers, protocol fixtures, normalizer
  goldens, metric parity, grouping and identity on frozen inputs, fake-engine
  end-to-end. Local: ΔWER interval excludes 0 and |Δ| ≥ 0.5 pt, warm RTFx
  −10 %, footprint +5 %, any swap, the always-on budget.

## 14. Repository layout

```text
apps/
  desktop/        Electron: main, preload, renderer, core utility process
  browser-extension/  the extension that says which tab plays sound (ADR 023)
  bench/          sondine-bench CLI
  stats/          the Worker that receives the anonymous reports (ADR 042)
  ios/            the iPhone app: Xcode project, SwiftUI views (release 2, ADR 031)
packages/
  api/            oRPC contract and procedures
  core/           pure domain logic: grouping, classification, identity math, text normalization
  db/             Drizzle schema, migrations, queries
  engines/        adapter contracts, registry, model manager, worker clients
  protocol/       wire formats shared with Swift (schemas, fixtures)
  ui/             Sondine theme tokens, components, icons
native/           Swift package: sondine-audio, sondine-engines, sondine-meter, sondine-mcp, sondine-browser;
                  release 2: sondine-lan and the phone's library (SondinePhone)
bench/            corpus manifests and committed baselines (no audio)
docs/             vision, architecture, plan, decisions
changes/          user-facing change notes
```

## 15. Security and privacy

- Network: model downloads the user starts, updates the user said yes to or a
  check they ask for (ADR 045), the anonymous report the user said yes to (ADR 042), and (release 2) sync with paired iPhones on the local network,
  or through Tailscale once the user allows it (§12, ADR 008). Native
  children run under App Sandbox without network entitlements, and this is
  tested; the one exception, `sondine-lan`, may only accept connections.
  Main and core are policy-only, verified by a no-WAN soak (ADR 002, 010).
- Updates (ADR 045): `core/updates` asks GitHub, downloads into the data
  directory's `updates` folder, checks and decides when (`update-quiet.ts`:
  nothing is cut); main says what the network is, and after its ordinary
  shutdown exchanges the two apps in one step and opens the new one. Off until
  the user says yes; never in a development build, a build that is not a
  signed release, or a copy under another name.
- Electron hardening: locked fuses, context isolation, no Node in the
  renderer, a strict CSP, no remote content. Two private schemes: `sondine:`
  serves the app, `sondine-media:` streams episode audio to it (§11). The
  window opens no other page; a model's license link, matched exactly against
  the catalog, opens in the default browser. The renderer's `img-src` allows
  `sondine-media:` for the images added to conversations (ADR 024).
- Data in the app group container; voice profiles are biometric data with
  their own switch, rules, and deletion (ADR 012, 013).
- Visible listening state, one-click pause, per-app exclusion. Deleting a
  recording (`episodes.delete`) and erasing the last 5, 15 or 60 minutes
  (`episodes.forget`, from the menu bar or the sidebar) exist since M1 step 2:
  a forget deletes every recording it touches whole, listed before it runs,
  and tombstones the range. Deleted audio leaves the disk within about
  20 min (a run's newest spool file is zeroed once it rotates). Agents can
  do neither (`mcp: null`). « Exporter l'audio… » (`episodes.exportAudio`)
  writes a recording's WAV where the user chooses: core asks main for the
  save panel, and main reads the WAV through the media relay, so audio still
  never crosses oRPC. A transcript leaves the same way
  (`episodes.exportText`): the window reads the episode again, writes
  Markdown or subtitles (SRT, WebVTT, timed on the exported audio) with the
  voices named as on screen, and sends it with the deletion count
  (`Status.deletions`) it saw before reading. Core refuses it once anything
  was deleted since, and otherwise asks main to put it on the clipboard or in
  a file through a save panel; main asks core again right before it writes,
  so nothing deleted while the panel was open leaves. Agents cannot export
  either (`mcp: null`).
- Transcript text reaching an LLM is untrusted. The journal's model runs
  without tools, sandboxed without network or access to Sondine's data, on
  the transcript as delimited data; its answer is held to a schema and every
  citation checked; agents are told its lines are interpretations (ADR 028).
  The user's Claude, when they chose it for the journal, gets the same
  requests through their CLI with no tool but the schema's (ADR 027's flags
  and tripwire), after a dialog that says what leaves.
  A discussion's agent (ADR 027) has Sondine's read-only
  tools only, and its CLI no other tool or destination: injected text can
  make it read more of Sondine, to the provider the user agreed to, and
  nothing else.
- The discussion with an agent is the one network use Sondine starts for
  the user's data: the user's own Claude Code CLI, off by default, only for
  a message the user sent (ADR 027).

## 16. Open questions

Settled in M0: child helper rather than an SMAppService agent (ADR 003),
App Sandbox without network entitlements per native child (ADR 010),
listener-driven discovery on macOS 27 and one aggregate for all taps (ADR 004), the app group container in
signed builds and no capture in ad-hoc builds (ADR 013), audio retention
(ADR 015).

- Taps now run only while something plays (ADR 026): silence costs no tap,
  each app playing costs one. On macOS 27.2 the idle `system:other` tap cost
  coreaudiod nothing measurable (2026-11-09, microphone paused), so the
  +1.7 points of the first S0 may belong to the unpaused microphone; S0 with
  the microphone on, a real call's S3, S4 and four apps' S5 are still to
  measure (`bench/results/app-taps-2026-11-09.md` has the emulated runs).
- System audio withdrawn in System Settings is recorded until the next
  health tick (60 s at most, ADR 004). Proposal: read the system audio
  status every 10 s, one tccd request each time.
- The menu bar says « À l'écoute » while a permission is denied; only the
  window shows it. Proposal: a menu bar state for a denied source.
- A quit while core is down is recorded as an outage at the next launch: the
  manifests have no close record that tells a clean stop from a killed helper.
  Proposal: the writer appends an end record when it closes a run.
- Relaunch after a crash of main, which otherwise stops capture until Sondine
  is opened again (M4, with the login item).
- Sondine does not start while the system volume is full: Electron cannot
  create its single-instance lock and the app quits without a word.
- Whether call context may also read the local Calendar (EventKit
  permission) to show who is expected before anyone speaks (M4).
