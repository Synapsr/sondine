# Sondine native

Swift 6 package for everything that touches audio hardware: the always-on
helper `sondine-audio`, the budget meter `sondine-meter`, the capture layer
`SondineCapture`, and the shared library `SondineKit`; and for the one
surface Electron cannot draw, the island beside the notch (`sondine-notch`). Spec:
`docs/architecture.md` §3 and ADR 004/005.

```bash
native/scripts/fetch-models.sh     # Silero VAD v6.2 and WeSpeaker (Core ML) into native/.models (git-ignored), sha256-checked
swift build -c release             # from native/
swift test                         # Swift Testing; no capture, no permission prompts
.build/debug/sondine-phone-fixture --out a.m4a --seconds 60 --kill-after 21   # a phone file, killed mid-write
SONDINE_REAL_HAL=1 swift test --filter RealHALEnumerationTests   # opt-in: lists real devices and processes, no IO
.build/release/sondine-audio segment --in clip.wav --out result.json [--params '{"segmenter":{"preRollMs":500}}'] [--vad none]
.build/release/sondine-audio serve --socket <data>/run/audio.sock --data <data> [--models native/.models]
.build/release/sondine-audio self-test sandbox --data <data> [--models native/.models]   # ADR 010 checks, JSON lines
.build/release/sondine-audio self-test listeners [--rounds 50]   # ADR 004: Core Audio notifications, JSON lines
.build/release/sondine-voice embed --model .models/wespeaker/wespeaker_v2.mlmodelc < request.json   # voice embeddings, JSON
.build/release/sondine-notch < ../packages/protocol/fixtures/notch-commands.jsonl   # the island beside the notch, until end of input
.build/release/sondine-lan serve --identity <data>/lan/identity.p12 --password-file <data>/lan/password --socket <data>/run/phone.sock --name "Sondine K3QZ" --port 0 [--tailnet] [--allow-loopback]   # paired iPhones, until end of input
.build/release/sondine-lan self-test sandbox   # ADR 008: sandboxed (home write refused), listening allowed (signed build), JSON lines
scripts/tap-probe-app.sh taps.jsonl [--counts 0,1,2,4,8] [--seconds 60]  # cost of N app taps (needs a grant)
```

## Targets

| Target                  | Content                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SondineKit`            | `audio/` ring buffer, rate estimator, resampler, PCM16; `detect/` envelopes, energy gate, VAD protocol, segmenter, capture-gate pipeline; `spool/` writer, recovery, manifest records; `segment/` file mode; `time/` clocks and stage costs. No ONNX Runtime.                                                                                                                             |
| `CSondineOnnx`          | C shim over the ONNX Runtime C API (Silero session, threading options with read-back). ORT is Microsoft's 1.24.2 pod archive, a binary target pinned by Microsoft's checksum and kept on `sondine-releases` since its upstream went offline (November 2026).                                                                                                                              |
| `SondineSilero`         | `SileroVoiceActivityDetector`: Silero v6.2 on ONNX Runtime 1.24.2 CPU, one intra-op thread, no spinning, sequential.                                                                                                                                                                                                                                                                      |
| `SondineCapture`        | `hal/` the `AudioHardware` protocol, `CoreAudioHardware` and the scriptable `FakeAudioHardware`; `discovery/` device and process catalogs, process resolver; `policy/` microphone selection, attribution decision list, watchdog; `capture/` engine, IO context, track processor; `permissions/`, `power/`; `protocol/` helper wire types; `server/` Unix socket server. No ONNX Runtime. |
| `sondine-audio`         | `serve` (the always-on helper), `segment` (file mode, used by the bench), and the `self-test` commands `sandbox`, `listeners` and `taps`.                                                                                                                                                                                                                                                 |
| `SondineVoice`          | `VoiceEmbedder`: WeSpeaker v2 (CC-BY-4.0, Fluid Inference's Core ML conversion) on the CPU and Neural Engine; a voice's exclusive speech, in pieces, to one pooled 256-d unit vector (windows of at most 10 s, never across two pieces, 3 to 30 s of speech). No ONNX Runtime.                                                                                                            |
| `sondine-voice`         | `embed`: one JSON request on stdin (PCM16 pieces in base64, so no file is opened but the model), one JSON answer on stdout.                                                                                                                                                                                                                                                               |
| `sondine-meter`         | Budget meter for the bench: `sample`, `summarize`, `list` (see `apps/bench`).                                                                                                                                                                                                                                                                                                             |
| `SondineNotch`          | The notch's wire (`packages/protocol/src/notch-messages.ts`, strict) and its geometry: where the notch is, and the island's three states around it. No AppKit.                                                                                                                                                                                                                            |
| `sondine-notch`         | Call context beside the notch (ADR 025): reads `show` lines on stdin, writes the row clicked on stdout, exits at end of input. A non-activating panel above the menu bar, SwiftUI inside.                                                                                                                                                                                                 |
| `SondineLan`            | The iPhone relay's parts (ADR 008): `PeerFilter` (which peers, a pure function of the address and the interfaces), `NetworkInterfaces` (`getifaddrs`), `LanIdentity` (PKCS #12 in memory, the key's pin), `LanRelay` (`NWListener`, TLS 1.3 only, Bonjour, limits, the byte copy), the CLI and its sandbox self-test.                                                                     |
| `sondine-lan`           | The Mac's only network listener: `serve` accepts paired iPhones on the local network (or a Tailscale tunnel, when allowed), checks each peer before TLS, and relays it to core's `phone.sock` after one hello line; `self-test sandbox`. Core starts it and holds its stdin.                                                                                                              |
| `SondinePhone`          | The iPhone app's logic (ADR 031, 032), macOS and iOS 27: the recording header, `AssetPartWriter` (fragmented m4a, header in the comment tag), `RecordingStore`, and `PhoneRecorder` behind the audio session, microphone, disk, clock and notifier protocols, with scripted fakes; iOS adapters under `#if os(iOS)`.                                                                      |
| `sondine-phone-fixture` | Writes a phone recording as the app does, optionally killed mid-write, for the cross-language test of `pnpm test:native`.                                                                                                                                                                                                                                                                 |
| `sondine-phone-e2e`     | The iPhone in the end-to-end sync test of `pnpm test:native`: SondinePhone's real sync client and URLSession transport, driven by JSON lines, against the real `sondine-lan` and core.                                                                                                                                                                                                    |

## Contracts

- **IO callback**: `IOCaptureContext.ingest` validates the buffer list, downmixes to mono into
  `FrameRingBuffer.write`, and records its own duration in an atomic histogram. No lock, no
  allocation, no Objective-C or HAL call; `IOCaptureContextTests` counts heap calls on the
  callback thread through `malloc_logger`, across a ring wrap and an overflow. Overflow drops the incoming block, counts it, and flags the next stored
  block `.gapBefore` with the exact dropped frame count. Each block carries the context's format
  generation (an atomic the drain worker bumps on a rate change), so blocks queued before a rate
  change are drained at their own rate before the resampler switches.
- **Drain worker** (one per track, owns everything below): `MeasuredRateEstimator` →
  `ResampleRatePolicy` → `StreamResampler` (16 kHz mono, rebuilt on rate or channel change) →
  `SpeechActivityPipeline` (envelopes, gate, VAD, segmenter) and `SpoolWriter`
  (`append(floats:)` clamps and NaN-guards to PCM16).
- **Gaps between blocks**: host time between two blocks that neither audio nor counted ring drops
  explain becomes a `stall` gap in the spool and the pipeline when the block is flagged
  `.discontinuity` (IO restarted) or the hole exceeds max(100 ms, 1.5 blocks); shorter spacing is
  jitter or a measured rate still settling.
- **New VAD settings** (`config.vad`) reach open runs before the ack: the segmenter closes at the
  last decided window (`track-closed`) and a new one continues, so each region is decided under
  one set of settings. One VAD session per track kind lives as long as the helper.
- **Spool**: `<root>/<track dir>/<runId>/NNNN.pcm` with `NNNN.jsonl` next to it
  (`SpoolLayout`); 10 min per file, a commit every 32 000 samples (2 s): write + fsync PCM, then
  the manifest lines (pending gaps, commit, envelopes, closed regions) + fsync. Lines follow
  `packages/protocol/src/manifest.ts`; `ProtocolFixtureTests` decodes its golden fixtures.
  Sample indices count time: gaps advance them without bytes.
- **Disk full / I/O error**: the writer stops, emits `.failed`, counts samples, retries every
  10 s of audio, and on success writes a `disk-full` or `write-error` gap before resuming.
- **Recovery**: `SpoolRecovery.recover(directory:)` before any writer opens the spool; it cuts
  each PCM file to its last CRC-verified commit, drops torn or invalid trailing lines, and
  appends a `recovery-truncated` gap. The gap is synced before anything is cut, so a crash
  during recovery is finished by the next run. Idempotent.

## Capture-gate defaults (`SpeechActivityParameters`)

| Parameter                               | Default                                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Gate open / close margin over the floor | 9 dB / 5 dB, never below −70 dBFS, 2 frames to open, 400 ms hangover                                                                                         |
| Floor time constants                    | falls 0.2 s, rises 4 s (closed), 0.5 dB/s (open); ≤ −110 dBFS is digital silence                                                                             |
| VAD lookback / reset / startup          | 512 ms before a gate opening; reset after 1 s unevaluated; always evaluated for the first 1 s after the track's first frame above digital silence            |
| Segmenter                               | onset 0.5, offset 0.35, minSpeech 250 ms, minSilence 600 ms, maxSegment 60 s (split at the quietest window in the last 5 s), pre-roll 1.5 s, post-roll 0.8 s |

## Capture layer (`SondineCapture`)

- **HAL**: everything goes through `AudioHardware` (devices, process objects, properties,
  listeners, IOProcs, taps, aggregates, process-wide flags). `FakeAudioHardware` scripts
  hot-plug, default changes, rate changes, process IO, and `ServiceRestarted`, and calls IOProc
  blocks by hand.
- **Discovery** is listener-driven, never a scan: one listener on the process object list, and
  per object `IsRunningInput`, `IsRunningOutput` and `Devices`. Each process incarnation
  (pid, start time) is resolved once: responsibility SPI (dlsym), then parent ancestry, then
  the enclosing `.app`, then the daemon map (`avconferenced` is a FaceTime call,
  `callservicesd` is iPhone call relay). Each mapping keeps its evidence and confidence.
- **Microphone**: the pinned device (Bluetooth only with `allowBluetooth`), else the default
  input when its transport is built-in, USB, Thunderbolt or PCI, else the built-in
  microphone, else none. Bluetooth, Continuity, virtual, aggregate and loopback devices are
  never opened automatically. IOProcs use `AudioDeviceCreateIOProcIDWithBlock` with an explicit
  buffer of about 85 ms (4096 frames at 48 kHz, clamped to the device range): about 12 IO
  wakeups a second instead of 94 at the 512-frame default, against a 10 s ring drained every
  256 ms (100 ms with `--drain-interval-ms 100`).
- **System audio**: one private global tap (`system:other`, mono, unmuted) that excludes
  Sondine's own process objects (the helper, PIDs from `exclude.pids`, and their responsible
  children), on a private tap-only aggregate with `TapAutoStart` off. The exclusion list is
  updated in place; if the HAL refuses, the tap is rebuilt with the new list inside the same run
  (or system audio stops) before `exclude.pids` is acknowledged. `activity` is republished when a
  run opens or closes and when the exclusions change.
- **Rebuilds**: device list, default devices, alive, data source, wake and `ServiceRestarted`
  reconcile the microphone and the tap. A rate change rebuilds the resampler first (new epoch,
  `track.update` `rate-change`); the IOProc is restarted only if exact zeros (3 s) or a
  measured-rate mismatch above 1 % follow within 5 s. Watchdog: 15 s of exact zeros on the
  tap while a process in its scope has output running rebuilds the tap and aggregate, at most
  once per 5 min per track; a later stall is reported as `zero-suspect`. No IO cycle for 2 s
  marks the stream `stalled`; for 5 s it restarts the microphone's IOProc or rebuilds the tap,
  then again after a wait that doubles up to 5 min while nothing comes (never for a muted
  microphone). A microphone that fails to start or restart opens again 5 s later.
- **Permissions**: microphone from `AVCaptureDevice.authorizationStatus`, system audio from
  `TCCAccessPreflight` (dlsym; `unknown` when the symbol is absent). Either becomes `granted-verified`
  on its track's first non-zero sample. Requests happen only on `request.permissions`.
- **Power**: `SleepingIsAllowed=1` and `FavorSavingPower` at start; a
  `PreventUserIdleSystemSleep` assertion while a microphone speech region is open and no other
  app uses a microphone, released 45 s after the last one.
- **Pause**: built-in and USB microphones are muted through process input mute; Bluetooth IO
  stops. Sleep closes every run; wake reopens them after 2 s.

## `sondine-audio serve`

```
sondine-audio serve --socket <path> --data <dir> [--models <dir>] [--drain-interval-ms 100..1000]
                    [--vad silero|none] [--hal core-audio|fake]
```

- The socket is created with mode 0600; the helper refuses a relative path, a path over 103
  bytes, a directory it does not own or that others can write, and a path held by another
  live helper. A stale socket is removed.
- `<data>/spool` is resolved through symlinks before recovery or any write; if it leaves the
  canonical data directory (or is not a directory), `serve` exits 1 before opening the socket.
- One core client at a time (a second one gets `request.rejected`). The first message must be
  `hello`; the helper answers `ready`. Messages follow `packages/protocol` exactly; the
  golden fixtures are tested in `ProtocolGoldenTests`.
- Each connection has a generation; requests reach the engine tagged with it, and replies go
  only to the connection that asked, while it is open. A `ready` meant for a closed connection
  greets nobody.
- Capture starts with the first `config`. `clock` goes out every 10 s and after wake,
  `health` every `healthIntervalMs` (60 s by default).
- When core disconnects, capture and the spool continue. Durable events (track, region and
  commit events, warnings, errors) wait in a bounded buffer (16 384 events) and are sent after
  the next `ready`, in slices of 256 KiB; state events are not buffered, since core asks for a
  `snapshot`. Durable events a connection had not written when it closed go back to the front
  of the buffer; events the buffer cannot hold are reported as `events.dropped`. A greeted
  client whose backlog overflows is closed as not reading.
- The helper exits on end of file on stdin (Electron main's lifetime pipe), on SIGTERM,
  SIGINT or SIGHUP, and after acknowledging `shutdown` (the connection gets 2 s to take the
  ack). An unsupported `hello` closes only that connection.
- `--hal fake` runs on `FakeAudioHardware` with fake permissions and power: no hardware is
  touched and nothing can prompt. Tests and smoke runs use it. In `serve`, a
  `FakeSignalDriver` feeds every started IOProc 20 ms blocks of quiet noise with a tone one
  second in four, so the spool, the gate and health run end to end.
- Listeners on an object Core Audio has dropped (a process that exited, an unplugged device,
  a coreaudiod restart) are discarded, not removed: removing them only logs "no object with
  given ID".

## `sondine-audio self-test sandbox`

Checks the ADR 010 sandbox from inside the helper, without a prompt or audio, one JSON line per
check on stdout, exit 0 whatever the results: `sandboxed` (informational, `sandbox_check`),
`network.denied` (a TCP connect to `--target`, default TEST-NET-1 `192.0.2.1:443`, must fail
with EPERM or EACCES), `process.resolution` (path, parent and responsible pid of the helper, its
parent and its responsible app), `process.resolution.hal` (the path of every client Core Audio
lists, apps and system daemons: what attribution resolves; the sandbox empties
`proc_listallpids`), `data.writable` and `data.unix-socket` (a file and a socket in `--data`,
removed), `models.readable` (lists `--models`, reads the Silero header; `writable` is reported,
not judged), then `summary`. Unsandboxed, `network.denied` fails by design.

The App Sandbox will not start a binary whose signature binds no Info.plist with a bundle
identifier, so `Package.swift` links `Sources/sondine-audio/Info.plist` into the executable.

## `sondine-audio self-test listeners`

Measures the notifications listener-driven discovery relies on (ADR 004), with no permission
and nothing audible. Each round starts `afplay` on a 0.6 s clip of digital silence, creates
and destroys a private aggregate device, and starts then stops this process's own output
(`AVAudioPlayer`), and records whether the process object list, the process's IO, and the
device list notified, and how fast. One JSON line per round, then `summary` with misses,
notifications per property, and p50/p95/max latencies; exit 0 whatever the results. Run it
from `.build`: the sandboxed helper cannot start `afplay`.

## `sondine-audio self-test taps`

The M0 spike on taps (architecture §3): what N process taps cost, all in one aggregate device
or one aggregate each. It starts players on a -70 dBFS tone, taps N of them for `--seconds`
per configuration, and reports coreaudiod's CPU (setuid `/bin/ps`), its own CPU and wakeups,
and each tap's frames and peak. Taps deliver silence until macOS grants system-audio capture
to the responsible app, so `scripts/tap-probe-app.sh` runs it from an ad-hoc signed
"Sondine Tap Probe.app" that macOS can ask; the probe waits for the first sample.

## Measured

- 2026-11-02, M5: Silero v6.2 takes about 70 µs CPU per 32 ms window, so 7.9 to 8.2 CPU-s per
  audio hour when the gate is open throughout; one thread, CPU time ≈ wall time. Peak
  footprint in file mode: 29 MB with Silero, 5 MB gate-only.
- 2026-11-03, M2 Air, release build: `sondine-audio` is 35.9 MB unstripped, 22.2 MB stripped
  (ONNX Runtime is most of it). The IO callback makes no heap call (`IOCaptureContextTests`).
- 2026-11-03, Téo's Mac, Developer ID build: `self-test sandbox` passes 8 of 8 with
  `--data` in the group container and `--models ~/Library/Application Support/Sondine/models`
  (outbound connect refused with EPERM; 52 Core Audio clients resolved, 24 of them system
  daemons; models readable, not writable). The app bundle's `Contents/Resources` is not
  readable by the sandboxed helper (EPERM).
- 2026-11-04, Téo's Mac, macOS 27.0.1 (26A434), `self-test listeners --rounds 50`: no missed
  notification. Process objects appear 52 ms (p50) after `afplay` is spawned and leave at its
  exit; the device list notifies in 6.7 ms (p50, max 13 ms). `IsRunningOutput` listeners
  never fired (0 of 150 output starts and stops); `Devices` listeners fired on every one, the
  stop within 50 ms of the property changing. `AVAudioPlayer` keeps output running 2.1 s
  after `stop()`.

## Environment

- `SONDINE_VAD_MODEL`: Silero model path for `segment` and `serve` (default: the nearest
  `.models/silero-vad/silero_vad.onnx` above the executable). The packaged app sets it to its
  copy in the models folder.
- `SONDINE_EXPORT_MANIFESTS=<dir>`: `SpoolProtocolTests` copies the manifests it writes there,
  to validate them with `packages/protocol`.
