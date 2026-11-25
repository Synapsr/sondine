# @sondine/protocol

Wire formats shared by the Swift helper `sondine-audio` and the TypeScript
core: the control socket (JSON lines) and the spool manifests the helper
writes next to each PCM file; the browser link (ADR 023) between
Sondine's browser extension, the relay `sondine-browser` and core; and the
notch (ADR 025, ADR 036) between main and `sondine-notch`. The zod schemas in `src/` are the source; the
JSON Schemas in `schemas/` are generated from them, and the fixtures in
`fixtures/` are the contract both sides test against.

```bash
pnpm --filter @sondine/protocol run gen        # rewrite schemas/*.json
pnpm --filter @sondine/protocol test           # fixtures, codec, schemas up to date
pnpm --filter @sondine/protocol typecheck
```

## Layout

| Path                         | Content                                                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/control-messages.ts`    | Core → helper: `hello`, `config`, `exclude.pids`, `pin.input`, `pause`, `resume`, `snapshot`, `request.permissions`, `shutdown`                                                                  |
| `src/helper-events.ts`       | Helper → core: `ready`, `ack`, `permissions`, `devices`, `processes`, `track.*`, `region.*`, `commit`, `activity`, `call`, `listen`, `situation`, `holds`, `clock`, `health`, `warning`, `error` |
| `src/manifest.ts`            | Manifest records: `header`, `commit`, `gap`, `envelope`, `region`                                                                                                                                |
| `src/browser-messages.ts`    | Browser link: the relay's `BrowserHello`, core's `BrowserAnswer`, and the extension's `hello`, `tabs`, `media`                                                                                   |
| `src/notch-messages.ts`      | Notch: main's `show` (a call with its switch, people, a card), the helper's `ready`, `no-notch`, and clicks                                                                                      |
| `src/phone-recording.ts`     | The iPhone app's recording header, in each file's comment tag (ADR 032)                                                                                                                          |
| `src/usage-*.ts`             | The anonymous daily report and what it counts (ADR 042): core and `apps/stats`, not Swift                                                                                                        |
| `src/json-lines.ts`          | Incremental decoder and encoder; typed errors, never throws                                                                                                                                      |
| `schemas/*.json`             | Generated JSON Schema (draft 2020-12). Do not edit.                                                                                                                                              |
| `fixtures/*.jsonl`           | Valid examples; every type appears at least once                                                                                                                                                 |
| `fixtures/invalid/*.jsonl`   | Lines that must be rejected, one defect each                                                                                                                                                     |
| `fixtures/vectors/*.jsonl`   | CRC-32, envelope decoding and network hash (HMAC-SHA256) vectors                                                                                                                                 |
| `fixtures/handshake/*.jsonl` | Browser relay hellos and core's answers, valid and invalid                                                                                                                                       |
| `fixtures/phone/*.jsonl`     | Phone recording headers, valid and invalid                                                                                                                                                       |

## Wire rules

- UTF-8 JSON, one object per line, ending in `\n`; at most 1 MiB per line
  (newline excluded). Blank lines are ignored.
- Every object is strict: unknown fields are rejected. Optional fields are
  omitted, never `null`; `null` appears only where a schema says nullable.
- 64-bit clocks (`hostTicks`, `continuousNs`, `wallNs`) are decimal strings
  without leading zeros, at most 2^63 − 1. JSON numbers would lose precision
  past 2^53. Every other integer is a JSON number within 2^53 − 1.
- UUIDs are lowercase (`UUID().uuidString.lowercased()` in Swift).
- Sample indices count 16 kHz samples from the start of a track run, gaps
  included. Order and durations use `continuousNs`; wall time is display only.
- Track keys: `input:<deviceUID>`, `app:<bundleID>`, `system:other`.
- Binary data never travels as JSON, with one exception: manifest envelopes
  carry base64 of little-endian Float32 (10 ms log-energy in dBFS, within
  [−120, 0]), because 100 values per second per track would be four times
  larger as decimal text. PCM stays in `.pcm` files.

## Session

1. Core connects and sends `hello` with `protocol: 7`. The helper answers
   `ready` (session id, timebase, capabilities), or `error` with code
   `protocol.unsupported` and closes the connection. It reads `type`, `id`,
   and `protocol` before validating the rest of a `hello`.
2. Every control message carries an `id`. Each request ends with exactly one
   terminal reply carrying that id in `replyTo`: `ready` for `hello`, `ack`
   for the others (`TERMINAL_REPLY`), or `error`.
3. `snapshot` replays current state (`permissions`, `devices`, `processes`,
   `activity`, open `track.open` and `region.open`, `clock`, then active `call`, `listen` and `call.seen`,
   then `situation` and `holds`), each with `replyTo`, then `ack`. Core uses it after
   reconnecting.
4. Permission status (`permissions`) and stream health (`stream` on tracks,
   `health`) are separate. `granted-verified` only follows a non-zero sample.
5. `region.close` carries `foreground`: the apps in front on the Mac while
   the region lasted, by bundle ID and name, in run samples (ADR 022). The
   manifest's `region` record does not.
6. Private zones (ADR 029): `config.holds` says what holds capture (calls, the
   screen away, hours, networks by keyed hash, and the occurrences the user
   lifted); `excludedBundleIds` also holds the microphone while an excluded
   app is in a call or listens. The helper says the Mac's `situation` (screen
   away, network hashes) and every active hold (`holds`) on change. A run a
   hold ends closes with `held`; `ready.paused` stays the user's pause only.
7. Sondine's own sound (ADR 035, protocol 6): while Sondine's processes run
   output, the helper taps them and sends `self.envelope`, the 10 ms energy
   of what Sondine plays (levels in tenths of a dBFS, contiguous frames from
   `start`, at most 6 s per event). It is the private `self:playback`
   reference: no run, no PCM, no manifest, no region, never replayed in a
   snapshot; core keeps it in memory to tell echo of a playback from someone
   speaking over it.
8. Calls seen while paused (ADR 036, protocol 7): `call.seen` says a call
   started or ended whether Sondine listens or not, from the same process
   catalog that already runs in a pause. Core uses it to say a call that starts
   (listen to it during a pause, or not listen to it) and to put the intent
   back when that call ends; it never
   makes a call span, and it is never sent for Sondine or an excluded app.

## Spool manifests

One manifest per PCM file. The `header` comes first; `commit`, `gap`,
`envelope`, and `region` records follow in write order. For each commit the
helper writes and fsyncs the PCM block, appends the `commit` record (durable
length, CRC-32/ISO-HDLC of the block as computed by zlib's `crc32`), then
fsyncs the manifest. Recovery truncates the PCM file to the last commit's
`committedOffset` and appends a `recovery-truncated` gap for the bytes cut.

## Rules JSON Schema cannot express

The zod schemas also check: `toSample > fromSample`, `endSample >
startSample`, `committedOffset >= sampleCount × 2` and even, envelope data
length and value range, `peak >= mean`, histogram ordering (`p50 <= p95 <=
max <= sum`, all zero when `count` is 0), a region's `foreground` spans in
order, apart and inside it, a track's key matching its source,
attribution confidence matching the track kind, permission status matching
its evidence, unique ids in lists, a schedule window that ends where it
starts, network hashes without their key, a hold's scope and detail against
its reason, and a situation's networks out of order. The invalid fixtures cover each rule;
the Swift decoder must reject them too.

## Versioning

- **Fixtures are the contract.** A change to a message changes its schema,
  its fixtures, and the Swift side in the same commit. Both test suites load
  the same files.
- **Bump `PROTOCOL_VERSION` on any breaking change**: a field added, removed,
  renamed, or retyped; a new enum value; a tighter range. Objects are strict,
  so adding an optional field breaks old peers too. The helper and core ship
  together, so a bump is cheap; it exists to catch a stale binary.
- **Bump `SPOOL_FORMAT_VERSION` on any manifest change.** Manifests outlive
  the build that wrote them, so core keeps reading every older version
  (keep the old schema next to the new one).
- After changing a schema, run `gen` and commit `schemas/`. A test fails
  while they are stale.

## Phone recording header

The iPhone app writes one JSON object in each recording's comment tag before
its first sample (ADR 032); the Mac's import reads it with `afinfo -i`.
`src/phone-recording.ts` is its schema (`PhoneRecordingHeader`, version 1),
`schemas/phone-recording-header.json` its JSON Schema, and
`fixtures/phone/header-valid.jsonl` and `header-invalid.jsonl` the lines both
sides test (`SondinePhone`'s `PhoneRecordingHeader`). Beyond types: `part` 1
exactly when `previous` is null, lowercase UUIDs, an offset within ±14 h, the
app as `0.1.0 (12)`, at most 4 KiB. No name of a person or a device. A
change to a field bumps `v`; the Mac keeps reading older ones.
