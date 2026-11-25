# 008 — iPhone companion: pairing and sync

Status: Accepted — 2026-11-10 (direction, Téo's answers below); built at
M5.2 on the Mac, the relay and the phone, and paired and synced on Téo's
devices (below); results, names, notes and playback built at M5.3, the
reads of the Mac's memory at M5.4, and the Tailscale path at M5.5, none yet
tried on a device.
Rewritten in place: the 2026-11-02 text was « Proposed » and written before
M1–M4. The app's stack is [ADR 031](031-iphone-app-stack.md); recording on
the phone and what a phone recording becomes on the Mac is
[ADR 032](032-phone-recordings.md). Amends ADR 002 (a path through
Tailscale) and ADR 010 (one more helper, the only one with a network
entitlement).

## Context

The iPhone records away from the Mac and hands its recordings to the Mac,
which alone analyses them (vision, release 2). Since the first text the Mac
gained what a sync has to respect: one import path for outside audio
(ADR 021), deletion of a recording or a passage with tombstones and an
answer withheld when a deletion lands meanwhile (ADR 006, 011, 017), private
zones and « Effacé après » (ADR 029), people and voices as biometric data
(ADR 012, 030), a journal and commitments that cite transcripts (ADR 028).

Téo's answers (2026-11-10):

1. The phone records and shows the results of its own recordings first;
   then search, the day's journal and commitments are read live on the Mac
   when it can be reached. No copy of the whole memory on the phone.
2. The phone may delete and rename its recordings and add a note. Naming
   voices and correcting text stay on the Mac.
3. Once the Mac confirms it holds a recording, the phone erases its audio.
4. Sync through Tailscale: yes (« pk pas »), off by default, after LAN sync.
5. (2026-11-11) This text, ADR 031 and 032, the plan and the screens:
   « oui ». That includes keeping on the phone the results of its own
   recordings of the last 30 days only.

What was checked (2026-11-10):

- iOS 27.2.1 is current. TN3179 (rev. 2026-10-06): the local-network alert
  appears on the first outgoing connection, `.local` resolution or Bonjour
  operation, and an operation made in the background before the user
  answered is denied silently. A VPN interface is not a local network.
- Apple DTS (Quinn, forums thread 28713) recommends against server-trust
  challenges in a background `URLSession`; `BGContinuedProcessingTask`
  (iOS 26) has developer reports of uploads expiring early.
- Tailscale: packets are encrypted end to end, relays included (« DERP
  servers never access your unencrypted data », doc validated 2026-01); the
  coordination server holds public keys and where each node can be found.
  mDNS does not cross a tailnet (issue 1013, open).
- `/usr/bin/openssl` on macOS 27.2 (LibreSSL 3.3.6) creates a P-256 key and
  a self-signed `ecdsa-with-SHA256` certificate: no dependency for that.
- Node has no Bonjour; Network.framework's `NWListener` does TLS 1.3 and
  the Bonjour advertisement in one object, withdrawn when it stops.

## Decision

### Who listens on the Mac

A new native relay, **`sondine-lan`** (Swift, in `native/`), is the only
process with a TCP port.

- It holds the TLS identity, listens with `NWListener` (TLS 1.3 only),
  advertises `_sondine._tcp` under a generic name (« Sondine » and four
  random characters, never the user's or the Mac's name; TXT: protocol
  version and the first 8 hex digits of the key's pin), checks where each
  peer comes from, and relays the bytes of an accepted connection to core's
  private socket `<data>/run/phone.sock` (0600, as ADR 011), after one line
  that says the path taken: `{"v":1,"via":"lan"}` or `"tailnet"`.
- It parses no HTTP, checks no credential and holds no logic, like
  `sondine-mcp` and `sondine-browser`. Its own limits come before core's:
  8 connections at most, 2 per peer address, 10 s to finish the TLS
  handshake, 60 s without a byte closes a connection.
- App Sandbox with `network.server`, `network.client` and the application
  group; `self-test sandbox` proves the sandbox (no file in the home folder)
  and that it may listen. `network.client` was not in the first design,
  which wanted the sandbox to prove the relay can never call out: on Téo's
  Mac (2026-11-13) Network.framework's listener, under App Sandbox without
  it, never let a peer on the Wi-Fi connect (the kernel log shows each
  answer to the iPhone denied as `network-outbound`; loopback, which every
  test used, was never refused). That guarantee now rests on the relay's
  code, which opens no connection but to core's socket, kept to a byte
  copy; the sandbox still confines its files.
- Core starts it and holds its stdin (end of input means exit). It exists
  only while a pairing is open, at least one phone is paired, or a phone
  revoked in the last day has not heard it yet, and « Synchronisation avec
  l'iPhone » (Settings ▸ Téléphone) is on. Otherwise nothing listens and
  nothing is advertised.
- Its port is chosen once, at the first pairing, and kept, so a phone away
  from home finds it again.

Why not the others:

| Candidate             | Why not                                                                                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sondine-audio`       | The always-on helper has no network entitlement and a test that proves it (ADR 010). The first text's « advertised by the helper » is withdrawn.           |
| Electron main         | A thin supervisor: no business logic, no database (ADR 003).                                                                                               |
| core, with `node:tls` | Puts a TCP port and the TLS key in the process that owns the database (ADR 011: « No TCP port »), and Bonjour would need a dependency or a `dns-sd` child. |

Accepted limit: the relay's application group gives it the data directory
and core's sockets, as it gives `sondine-mcp`. The sandbox protects the rest
of the system and forbids new outbound connections; it does not hide
Sondine's data from a compromised relay, which could send it back over a
connection it accepted. What stands between a peer on the network and that
is Network.framework's TLS 1.3 handshake, and the relay's code, kept to a
byte copy. Narrowing it (a relay with no application group, handed its one
socket by core) is the first hardening to do if this surface ever grows.

Core serves HTTP/1.1 on `phone.sock`:

- **Procedures**: the oRPC router over HTTP, limited to an explicit list,
  `PHONE_PROCEDURES` in `packages/api/src/phone-procedures.ts`, as
  `AGENT_TOOLS` is for agents: new procedures never reach the phone by
  themselves.
- **Bytes**, outside oRPC (audio never travels as JSON): `PUT
  /v1/recordings/{recordingId}/audio` and, from M5.3, `GET
  /v1/recordings/{recordingId}/audio?g={generation}` with a byte range.
- Every request but pairing carries the device credential, checked from
  the headers before a byte of body is read. Reads pass the same deletion
  filter and content-generation check as agents' (ADR 011): an answer read
  before a deletion committed is withheld.
- **Ownership.** A credential is one row of `phone_devices`; the device id
  is the one core recorded at pairing, never one a request names. A
  recording belongs to the device that uploaded it, or whose id its header
  carries when it came as a file (attached when that phone pairs). Every
  procedure and byte route that names a recording checks that it is the
  caller's; reads of the rest of the memory are the listed read procedures
  only. The header is not signed: a file's claim is worth what the person
  who dropped it on the Mac is worth, which is the user.
- Limits in core: 8 KiB of headers within 10 s, 1 MiB per JSON body, 30 s
  without a byte of body, one upload at a time per phone, an inbox of
  2 GiB in all, and a peer address refused for a minute after five wrong
  credentials. A test holds every slot with unauthenticated connections
  and checks that a paired phone still syncs within a minute.
- Settings ▸ Téléphone lists each phone with its last contact and counts of
  what it did (uploads, reads, deletions), never the words.

### Transport

- TLS 1.3, pinned by the phone to the SHA-256 of the Mac's public key
  (SubjectPublicKeyInfo), read from the pairing QR. The certificate's name,
  dates and chain are ignored; nothing but the key is trusted. No
  application-layer cryptography, no fallback.
- The identity is a P-256 key and a self-signed certificate that core
  creates with `/usr/bin/openssl` at the first pairing, in `<data>/lan/`
  (0600). It is as sensitive as the database beside it and protected the
  same way (ADR 013). Whoever copies it can pass for the Mac to a paired
  phone: take its credential, receive its recordings, and answer `stored`
  or `deleted` so that the phone erases them. File permissions do nothing
  once it is copied. The remedy is « Réinitialiser l'appairage »: a new
  key, every credential revoked, and each phone paired again by a QR, at
  home.
- `/usr/bin/openssl` (LibreSSL) writes about one P-256 key in 256 with a
  31-byte private key, in the key file and again in the PKCS #12, and
  macOS's import then pairs no key with the certificate: core makes another
  key until `openssl ec -outform DER` is 121 bytes. `sondine-lan` imports
  the PKCS #12 into its memory only, never into a keychain.
- The phone uses `URLSession` with its own server-trust evaluation, in the
  foreground. Bonjour (`NWBrowser`) finds the Mac at home; the pairing QR
  and each `sync.hello` also give addresses to try when mDNS is blocked.

### Pairing

1. Settings ▸ Téléphone ▸ « Appairer un iPhone… »: core makes a one-time
   token (32 random bytes, 5 minutes, consumed atomically at its first
   presentation, whatever follows), starts the relay and shows a QR:
   `sondine://pair?v=1&pin=…&token=…&name=…&port=…&addr=…`.
2. The phone explains the local-network alert before iOS shows it, scans,
   connects (pinned) and sends the token, a device id it generated, the name
   the user gave the phone, and its protocol version.
3. Both show the same six digits: the first six decimal digits of
   SHA-256(token, device id, the Mac's key pin). The Mac asks « Appairer
   « iPhone de Téo » ? »; only « Appairer » goes on.
4. Core answers, on that same connection, with the device credential,
   `sdp_` and 32 random bytes, and keeps its SHA-256 only
   (`phone_devices`). The phone keeps it in the Keychain
   (`WhenUnlockedThisDeviceOnly`: never synced, never restored on another
   device), with the pin.

One pairing at a time, tied to one connection. It ends when that
connection closes, when « Annuler » is pressed on either side, or after
2 minutes without an answer on the Mac; the relay stops then if no phone
is paired. An answer lost on the way leaves a phone without a credential
and a row no one can use: pairing is done again with a new QR, and a
device id that pairs again replaces its row. A phone or a Mac whose
protocol version the other does not know is refused with both versions,
and each says which app to update. Pairing is refused on the Tailscale
path.

A phone pairs with one Mac; a Mac accepts several phones.

### Revocation

- « Révoquer » on a phone's row closes its connections at once and answers
  `revoked` from then on. A phone that reads `revoked` erases its
  credential and its cached results, keeps the recordings it has not sent
  (they are its own), and says so.
- « Oublier ce Mac » on the phone does the same on its side and tells the
  Mac when it can.
- A lost phone is revoked on the Mac. What it had cached stays on it,
  behind iOS data protection: the Mac cannot erase a phone it never meets
  again, and the cache's own limit (below) runs only when the app does.

### Which peers

- **Local network** (default): the peer's address belongs to an IPv4
  subnet directly connected through a broadcast-capable interface (Wi-Fi,
  Ethernet), or is an IPv6 link-local address on one, or another IPv6
  address in a prefix the Mac holds on one (IPv6's directly connected
  subnet: on a home router the iPhone reached the Mac's global address,
  which the first build refused, 2026-11-13). Tunnels (`utun`,
  point-to-point) and Apple's peer-to-peer Wi-Fi (`awdl`, `llw`) are not
  one. Anything else is refused before TLS: `sondine-lan` reads the peer's
  address and the interfaces (`getifaddrs`, at each connection) when
  `NWListener` hands it the connection, and cancels a refused one before
  starting it. Loopback is accepted in development builds only
  (`--allow-loopback`).
- **Tailscale** (« Autoriser par Tailscale », off by default; amends
  ADR 002): the relay also accepts peers arriving on a tunnel interface
  from 100.64.0.0/10 or fd7a:115c:a1e0::/48, the ranges Tailscale gives
  its nodes (the relay takes a peer from those ranges while a tunnel
  interface holds an address in one of them). Sondine cannot tell
  Tailscale from another tunnel that uses them and does not try: the
  switch allows that kind of path, named after the one Téo uses, and
  everything that matters is checked above it. Same
  pinned TLS, same credential; no Bonjour there: the phone learned the
  Mac's tunnel addresses and port while at home. Sondine never calls
  Tailscale's service, API or CLI. What leaves the house then, and the
  switch says so: packets encrypted twice (WireGuard, then Sondine's TLS)
  may pass through Tailscale's relays, and Tailscale's coordination server
  knows that the two devices talk, not what they say.

### Sending a recording

A recording is one file (ADR 032) with an id the phone chose.

1. `sync.hello`: versions, the phone's clock, the ids it holds. The Mac
   answers with its clock, its addresses, its limits.
2. The phone announces the file: its id, length and SHA-256. The Mac
   answers how many bytes of that very file it holds (none when the length
   or the hash differ from the part it has, which it discards). `PUT
   …/audio` then sends from that offset, in order; a byte that does not
   continue the part is refused. Bytes go to
   `<data>/phone-inbox/<recordingId>.part` (private; parts untouched for
   7 days are removed).
3. With the last byte the Mac checks the SHA-256. A wrong hash discards
   the part. A right one hands the file to the import of ADR 021,
   unchanged but for what ADR 032 adds; the id in the address, in the
   announcement and in the file's header must be the same.
4. The import's last transaction is durable (`durableTransaction`, as
   retention's: the database runs `synchronous=NORMAL`, where an ordinary
   commit can be lost with the power). In it, core checks again that the id
   was not deleted meanwhile and still belongs to this phone, then writes
   the recording, its `phone_recordings` row and the receipt (length and
   SHA-256). Deleting and this transaction take the same lock, so one of
   them is first, and both orders are tested.
5. The Mac answers `stored` only after that commit and the archive file's
   sync. Only then does the phone erase its audio.

- The same id announced again with the same length and hash answers
  `stored` without work. With another length or hash it answers
  `conflict`: the phone keeps its file and says that it needs a look. An
  id deleted on the Mac answers `deleted`, and the phone erases its copy.
- Refused before any work: a file over 1 GiB, a file whose length `afinfo`
  cannot read (the import skips its room check then, which is fine for a
  file the user chose and not for one a phone sends), or not enough room
  for the file, its decoded audio and the archive.
- Sync runs while the app is open, oldest recording first. Nothing is sent
  with the screen locked (the phone's files are unreadable then, see
  below), and no background transfer in M5.

### What the phone keeps

No database. One folder per recording, excluded from backup:

```text
Application Support/Sondine/
  device.json                 device id, the Mac's id and pin (credential in the Keychain)
  outbox/<operationId>.json   a deletion, a name or a note the Mac has not acknowledged
  recordings/<recordingId>/
    audio.m4a                 until the Mac answers `stored`
    events.log                what happened to it, appended: started, stopped, why
    state.json                name, sent bytes, the Mac's state
    result.json               the Mac's result for this recording, once ready
```

- **Protection, file by file.** A locked iPhone lets an app create files
  and keep writing those it holds open (« complete unless open »), not
  open one that exists. So while recording, the app holds `audio.m4a` and
  `events.log` open, and a new stretch (after an interruption, or at
  3 hours) creates new ones. `state.json`, `result.json`, the outbox and
  `device.json` are « complete »: written and read with the phone
  unlocked only, which is when sync and reading happen. M5.1 tests
  rotation and an interruption with the phone locked.
- **The outbox is written first.** Deleting writes the deletion's file,
  then removes the folder; at launch a deletion without its removal is
  finished. Each operation has an id the Mac remembers, so a retry does
  nothing twice (a note sent twice is one note). A deletion beats any
  other operation on its recording; of two names, the later one typed
  wins. An operation leaves the outbox when the Mac acknowledges it.
  « Oublier ce Mac » empties the outbox and says so.
- **Results, without a change log.** For the ids it holds, the phone asks
  `phone.recordings.states`: `unknown`, `receiving`, `waiting`,
  `transcribing`, `ready` with a revision, or `deleted`. It fetches
  `phone.recordings.get` when the revision moved: name, start, length,
  voices (the user's names; a guess marked as a guess, ADR 030), sentences
  with their times, and the journal lines and commitments that cite it.
  The revision is the SHA-256 of that very answer, built from one read
  snapshot: whatever changes what the phone would show (a correction, an
  undo, a name, a guess moved by a reference elsewhere, the journal
  written again, a restart of core) changes it, and nothing is stored to
  keep it. `states` gives states only; the phone sends the revision it has
  with `get`, which answers « unchanged » or the new result.
- **Thirty days of results.** The phone keeps the results of recordings
  made in the last 30 days, each checked at every sync, which bounds both
  the work of a sync and what a lost phone holds. Older recordings are
  read live, like the rest of the Mac's memory. The limit is applied when
  the app starts and before it shows a result, against the latest time
  the phone has seen (a clock set back does not extend it). An app that
  is never opened erases nothing.
- The first text's cursor log with tombstones is dropped. The phone follows
  a short, known list of ids, and a state derived at read cannot drift from
  the database; a log would have to be invalidated by every edit, undo,
  merge and deletion (ADR 030 dropped a stored table for the same reason).
- The only thing the Mac stores for this is `phone_recordings`: one row per
  recording received, kept as a tombstone once deleted (the id and two
  times, no text, no audio).
- **The rest of the Mac's memory is read, never kept**: search, a day, the
  journal, commitments, a conversation's text come live through
  `PHONE_PROCEDURES` and live in memory until the app leaves the screen.
- Never sent to a phone: voice embeddings and profiles, diagnostics,
  settings, agents' keys, the audio of anything the phone did not record.
- Playback of a phone recording streams from the Mac by byte ranges, never
  cached.
- The phone writes three things: deleting, naming and adding a note
  (ADR 024) to a recording it made. Each is the Mac's own procedure.

### When the Mac is off or away

The phone records as usual; each recording says « En attente du Mac ».
Results already fetched stay readable. Search and the journal say that the
Mac cannot be reached. The phone never transcribes. Recordings waiting are
never expired: they are the only copy. The app says how many wait and how
much room they take.

### Deletion, both ways

- **On the Mac** (« Supprimer », « Effacé après »): the
  recording's `phone_recordings` row turns `deleted` in the deletion's
  transaction. At the next contact the phone reads `deleted` and removes
  the folder. A passage deleted on the Mac moves the revision; the phone
  replaces its result.
- **On the phone** (« Supprimer », which says it also deletes on the Mac):
  the folder goes at once and the id waits in the outbox. At the next
  contact `phone.recordings.delete` runs the Mac's deletion coordinator, as
  `episodes.delete` does (not undoable; the undo history is forgotten,
  ADR 017), or discards the part in the inbox. The Mac keeps the tombstone
  either way, so a copy sent later by AirDrop is refused.
- **Between two contacts the other copy still exists**, for 30 days at
  most on a phone whose app is opened (above).
- The Mac's retention applies on the Mac (ADR 032). The phone holds no
  audio once a recording is stored, and its text follows the two rules
  above.

### Wire formats

`packages/protocol` gains the recording header (ADR 032), the pairing QR's
fields and the upload's status lines; `packages/api` gains the `phone`
procedures. JSON Schemas are generated from the zod sources and golden
fixtures are tested by TypeScript and by Swift, as for the helper.

## Consequences

- The capture helper stays without network. One new signed binary to
  package and to check (`check-package`), and one more row in ADR 010's
  entitlements.
- `NSLocalNetworkUsageDescription` (ADR 010) stays in the app's Info.plist.
  Which process macOS names in its alert when a sandboxed child advertises
  a service is verified at step M5.2.
- With macOS's firewall on, the first connection may ask whether
  « sondine-lan » accepts incoming connections.
- Sync happens when the app is opened. Someone who records and never
  opens the app at home keeps everything on the phone.
- Two copies of a text exist between a deletion and the next contact;
  stated in the app where « Supprimer » is confirmed.

## Built at M5.2: the phone (2026-11-13)

The iPhone's side, in `native/Sources/SondinePhone` (`sync-wire.swift`,
`sync-files.swift`, `sync-transport.swift`, `sync-client.swift`) and the
app's « Mac » screen. Decided while building, without Téo; each can be
overturned. What the Mac's relay and core must match is marked « wire ».

- Wire: the relay's TXT record says `v=1` and `pin8=<first 8 hex digits of
  the pin>`; the phone keeps only services whose `pin8` and `v` match.
- Wire: `PUT …/audio` answers an `UploadStatus`, as the announcement does
  (`stored`, or `send` with what the Mac holds when the body ended early,
  or `refused`). The phone sends `Content-Length` (the bytes from the
  offset to the end) and `sondine-offset`; never chunked.
- Wire: `unauthorized` is read as `revoked`: a credential the Mac no longer
  knows (« Réinitialiser l'appairage ») ends the pairing the same way.
- Finding the Mac: Bonjour for 1.5 s, then each matching service is
  resolved by a TCP connection closed at once (URLSession cannot connect to
  a service), and the stored addresses are probed the same way for 2 s.
  The relay sees these connections close before TLS. The first address
  that answers `hello` with the paired Mac's id is kept for the session.
  `hello`'s addresses and port replace the stored ones.
- Pinning: only a P-256 key is accepted; its SubjectPublicKeyInfo is the
  fixed DER header and the 65-byte point, hashed and compared with the
  stored pin. TLS 1.3 minimum, ephemeral session, no cache, no cookies, no
  cellular. Tested against openssl's pin of a certificate made as core
  makes it, and over real TLS on loopback (another key is refused before a
  byte of request leaves).
- When it runs: when the app comes to the front, every 30 s while it stays
  there, after « Arrêter » and after a deletion; cancelled when the app
  leaves the front; skipped while protected data is unavailable (locked).
- Refusals: `too-large`, `header` and `unreadable` stop offering that
  recording (« Refusé par le Mac », kept and shareable); `no-room` pauses
  uploads for 15 minutes; `busy` ends the pass; `hash` hashes the file
  again and restarts it from zero at the next pass; `offset` announces once
  more. `not-yours` on an announcement marks it « Conflit »; on a deletion
  it drops the operation.
- Revocation keeps the outbox: pairing again with the same Mac sends it,
  pairing with another Mac drops it. « Oublier ce Mac » empties it.
- The outbox holds deletions only: the contract has no rename or note
  route yet, so a name stays on the phone (M5.3 adds both, below).
- The QR is read with AVFoundation's metadata output, not VisionKit's data
  scanner (ADR 031's list): QR codes only, on every iPhone iOS 27 runs on.
- The name sent at pairing is `UIDevice.current.name`, which iOS gives as
  « iPhone » without the user-assigned-name entitlement.
- The credential is a generic password (`app.sondine.ios.sync`) in the
  data-protection Keychain, `WhenUnlockedThisDeviceOnly`.

## What changed after Codex Astra's critique (2026-11-10)

It read ADR 008, 031, 032, architecture §12, the plan and the screens
against the code, and made 24 objections. Kept, each checked in the code:

- `stored` was promised after an ordinary commit, which the database's
  `synchronous=NORMAL` can lose with the power: the last transaction is now
  durable, and holds the receipt.
- « Oublier » would have deleted phone recordings, zones would have applied
  to them and they could have been split or merged, because the code tells
  an import by its context: ADR 032 now lists the four rules to move to the
  track run's kind, and M5.1 tests each.
- A recording's owner was not defined; an id sent again could have made a
  phone erase another file (now a receipt of length and hash, and
  `conflict`); a deletion could race an upload being imported (now checked
  in the publishing transaction, under one lock).
- The outbox could lose a deletion in a crash, and resend a note: written
  first, with operation ids.
- The revision named some of its inputs and forgot others, and the agents'
  generation restarts at zero with core: it is a hash of the answer.
- « Erased after 30 days » promised what an unopened app cannot do: said as
  it is, and the cache bounded to recordings of the last 30 days.
- The relay's limits, the consequence of a compromised relay and of a
  copied key, the tunnel ranges that are not Tailscale's alone, IPv6, and
  the pairing's timeout, cancellation and version refusal: all written.
- The phone's files were all given one protection class, which cannot
  write state while locked: now file by file.
- « 2 s at most » rested on a Mac experiment: now a target measured on the
  iPhone; and the clock difference read at upload no longer dates a
  recording.
- The plan: deletion both ways and states moved into M5.2 (a sync that
  cannot say « deleted » is not correct); thresholds for the codec, sample
  continuity by clicks, unrelated rooms for M5.7, migration tests, and the
  three check lanes per step.

Not kept:

- Narrowing the relay now (no application group, a socket handed by core):
  a real gain, written as the first hardening, not worth a second design
  before the first is measured.
- « M5.8 goes beyond suggestions only »: Téo agreed to suggestions until
  the iPhone's microphone is measured, which is what M5.8 does.
- Committed audio fixtures for the writer and reader: no audio is
  committed; the tests make their files.

## Built at M5.2, core (2026-11-13)

Core's side, without the relay's binary or the phone (other branches):
`phone_devices`, `phone_operations` and `phone_uploads` with their
migration; `apps/desktop/src/core/phone/` (the server on `phone.sock`, the
pairing, the identity, the relay's supervisor); `Imports.receive`, whose
last transaction is `durableTransaction`; Settings ▸ Téléphone's procedures
(`phone.*`, no screen yet). Tested through the real core with a fake relay:
plan § M5.2's exits that concern core. Decided while building, without
Téo; each can be overturned:

- **`PHONE_PROCEDURES` lists the six sync routes** (`pair`, `hello`,
  `announce`, `states`, `delete`, `forget`); core routes exactly these. No
  oRPC procedure reaches a phone yet: M5.3 and M5.4 add theirs to the list.
- **A held answer sends `102 Processing` every 20 s** (the pairing's wait
  for « Appairer », an import of up to minutes), so the relay's 60 s
  without a byte does not cut it. The relay must count bytes from core, and
  the phone's client must let a `1xx` pass.
- **Refusal statuses**: 401 `unauthorized` and `revoked`, 403 `not-yours`,
  `pairing-refused` and `pairing-tailnet`, 409 `pairing-used`, 410
  `pairing-closed`, 400 `bad-request` and `version`, 429 `busy`. Upload
  outcomes are 200 with `UploadStatus`, refusals included.
- **A refusal before the body was read** answers, reads the body for 1 MiB
  or 2 s at most so the client hears it, then closes the connection.
- **An upload must be announced first**: a `PUT` with no announcement, or
  at another offset than the part's length, answers `refused: offset`. A
  `PUT` at the file's length with an empty body finishes a whole part (one
  refused for `no-room` stays in the inbox). An inbox over 2 GiB answers
  `no-room`, as does a disk without the file and 512 MiB.
- **Core holds 16 connections**; a new one closes the oldest that has not
  authenticated (never one waiting for « Appairer »). Each request's
  headers have 10 s, counted by core (Node arms its own only on `listen`).
- **The receipt is the SHA-256** already in `phone_recordings`; the length
  is not stored again.
- **States**: an episode whose analysis failed reads `waiting` (it is
  retried when asked).
- **« Appairer un iPhone… » turns sync on**; « Réinitialiser l'appairage »
  revokes every phone and removes the key, the next pairing makes a new
  one. A revoked phone's parts in the inbox go with it.
- **The key is made again until whole**: `/usr/bin/openssl` writes a key
  whose top byte is zero in 31 bytes (one in 256), which `SecPKCS12Import`
  then refuses; core checks `openssl ec -outform DER` is 121 bytes. The
  bundle uses SHA-1 and 3DES, its password file has no newline.
- **A phone's deletion during its upload's import** leaves the import
  alone: the tombstone written first makes the publishing transaction
  refuse it, and the phone hears `deleted`.

## Tested end to end at M5.2 (2026-11-13)

`apps/desktop/test/phone-sync-e2e.test.ts`, in `pnpm test:native`: the real
core on a scratch data directory starts the real `sondine-lan`
(`--allow-loopback`, port 0), and the phone is `sondine-phone-e2e`,
SondinePhone's real sync client and URLSession transport. A TCP proxy of
the test sits between them to cut the line. It pairs (the six digits
compared on both sides, « Appairer » after 21 s), finds the relay by
Bonjour with its pin, sends a file `sondine-phone-fixture` wrote, cut at
half and resumed (one recording, the same SHA-256, the audio erased after
`stored`), finishes a whole part with an empty `PUT`, reads states, deletes
both ways, keeps its pairing through `busy`, and is refused once revoked.
What it found:

- **`102 Processing` works with URLSession** (macOS 27.2). The interim
  answer passes and the final one arrives. `timeoutInterval` counts idle
  time, and the `102`'s bytes reset it: an import held 35 s after the last
  byte ends in `stored` under the upload's 30 s. With the `102` turned off,
  the same upload fails at 30 s. Nothing changed; the iPhone's URLSession
  is the same stack, to confirm on the device.
- **The pins agree.** Core's (the QR, from `openssl`), the relay's TXT
  `pin8` (from `SecPKCS12Import`) and the phone's (SPKI of the key the TLS
  handshake showed) are the same key's.
- **`unauthorized` stays read as `revoked`.** Core answers 401 only from
  its credential lookup (unknown or revoked); an address throttled after
  wrong credentials, or a database error, answers 429 `busy`, which keeps
  the pairing (tested here and in the phone's tests).
- **Wi-Fi off mid-upload**: the Mac hears nothing and holds the dead
  upload until 30 s pass without a body byte. A phone back sooner hears
  `busy`; its next pass resumes from what arrived. Kept.
- **A revocation closes the phone's connections at once**: a request that
  races the close on a kept-alive connection is lost (`unreachable`), and
  the next pass reads `revoked`. Kept.
- **Revoking the last phone stopped the relay** (nothing paired, nothing
  listened), so that phone never heard `revoked`: it went on showing a Mac
  it could no longer reach (Téo, 2026-11-13: « petit problème UX »). Now
  the relay stays up after « Révoquer » until that phone has been answered
  `revoked` (it then erases its credential and shows the pairing screen),
  for a day at most, and not across a restart of core.

## Fixed after Codex Astra's review of the build (2026-11-13)

- A phone file imported by AirDrop answered `stored` to a later
  announcement of the same id from an ordinary commit: every import of a
  file carrying the phone header now commits durably, whichever way it came.
- A deletion from the phone was acknowledged after an ordinary commit, so
  a power cut could lose its tombstone after the phone dropped the
  operation: that commit is durable (and syncs the episode's deletion
  written before it).
- A pairing request whose body trickled in a byte at a time held a relay
  slot for as long as it liked: its whole body now has 10 s.
- A kill between saving `stored` and removing `audio.m4a` left the audio
  on the phone for good: each sync pass first erases the audio of
  recordings the Mac already holds.

## Built at M5.3: results, names, notes, playback (2026-11-13)

Core (`apps/desktop/src/core/phone/phone-results.ts`, three routes and the
playback in `phone-server.ts`), the contract (`phone-sync.ts`, fixtures),
`phone_recordings`' name with its migration, and the phone
(`sync-client.swift`, `remote-audio.swift`, screen 4, the player).
Decided while building, without Téo; each can be overturned. « Wire »
marks what both sides must match.

- **Wire: three routes, as M5.2's.** `POST /v1/recordings/get`
  (`{recordingId, revision}`), `/rename` (`{operationId, recordingId, name,
  typedAtMs}`) and `/note` (`{operationId, recordingId, text}`), plain JSON
  like the rest, not oRPC. `get` answers `result` (with the revision),
  `unchanged`, `unavailable` with the state, or `withheld`; `rename` and
  `note` answer `done` (also when already done, or when a later name won),
  `later` (the Mac does not hold the recording yet: the operation stays) or
  `deleted` (it leaves). Another phone's recording is 403 `not-yours`.
- **Wire: a withheld answer is a `get` status, not a refusal.** Read while
  something was deleted (ADR 011's content generation moved between the
  start of the read and its end), the answer is `{"status":"withheld"}` and
  the phone asks again at its next pass.
- **The result is read through the app's own procedures**, in process as
  agents' tools are: `episodes.get` and `journal.day` (the days the
  recording spans), so the deletion filter and the voices' names and
  guesses are theirs. It holds the name, start, end, « heure incertaine »,
  the voices (the user's name, or a guess as `guess`, never as a name; the
  user), the sentences with their voice, the journal lines and commitments
  of those days that cite it (but those the user said were wrong), its
  notes and links, and what playback needs (the timeline's generation,
  where it starts, its length; nothing once retention took the audio).
  Answers of `get` may reach 8 MiB; other JSON stays at 1 MiB.
- **Wire: the revision is the SHA-256 of the result's JSON as sent.**
  Nothing is stored for it. « A restart of core » in the plan's list is
  read this way: after a restart, a result nothing changed keeps its
  revision (no refetch for nothing), and a change made while core was down
  is seen at the next contact, which a counter starting again at zero would
  have missed. Both are tested.
- **The name is kept in `phone_recordings`, not by a Mac procedure.** The
  Mac had no way to rename a conversation, so the phone's name is a column
  (`name`, and `name_typed_at_ms`, the phone's time of typing it: of two
  names, the later one typed wins; a tie goes to the last received). It
  goes with the recording's text when it is deleted. The Mac shows it after
  the phone mark (« En personne · iPhone · Réunion budget ») in Today and on
  the conversation; it is not renamed on the Mac.
- **A note runs `context.add`'s path** (origin `phone`): the same anchor,
  classification (one address alone is a link) and transaction, durable
  here. The operation's row is claimed in that transaction before the note
  is written, and a try that finds it claimed writes nothing, so a note
  sent twice is one, also when two tries overlap (Codex Astra's review). It
  is not on the window's ⌘Z.
- **Wire: playback is the episode's WAV, as the window's player streams
  it** (16 kHz mono, deleted passages silent), not the phone's file:
  `GET …/audio?g=<generation>` with `Range: bytes=a-b` answers `206` with
  `Content-Range`, read slice by slice (1 MiB) through the window's media
  reader, each slice checking deletions and the generation again, and
  written as it comes. Refusals: 410 `gone` (deleted, not stored), 409
  `stale` (the generation moved: fetch the result again), 416 `range`, 429
  `busy`. A slice refused mid-answer cuts it. The phone asks at most 1 MiB
  at a time, 10 s each. A playback counts one read (its first range).
- **Counts**: each `get` and each playback is a read in `phone_devices`.
- **The phone** (`state.json` and `result.json`, « complete »):
  `result.json` is `{revision, fetchedAtMs, result}`, its revision copied
  into `state.json` so lists never open it. A sync pass is `hello`,
  uploads, names not yet sent, states, the outbox (deletions, names,
  notes), then `get` for each ready recording of the last 30 days. The
  latest time seen is the phone's clock or the Mac's `hello` clock,
  whichever is later, kept in `device.json` (written at most once a minute,
  never moved back); the limit erases `result.json` only, at launch, when
  the app comes to the front, and before a result is shown, by the
  recording's age and the file itself (a kill between writing the file and
  its revision in `state.json` no longer leaves one that never expires).
- **A result is erased when its recording is no longer `ready`** (fixed
  after Codex Astra's review): a passage deleted on the Mac sends the
  recording back to analysis, and the result the phone held still showed
  it until the next `ready`. Now a `states` or `get` answer other than
  `ready` erases `result.json`; screen 4 shows the state words until the
  new result comes. Serving the deletion-filtered transcript during the
  analysis was the other way; erasing is simpler and shows nothing deleted.
- **Names on the phone**: trimmed, control characters turned into spaces,
  200 UTF-16 units at most, blanks for none. A name typed before pairing,
  before the Mac held the recording, or before M5.3 (counted as typed at
  the recording's start) is queued once the Mac holds it. Of two renames
  waiting, the later typed stays; nothing more is queued for a recording
  being deleted. A note needs a paired Mac and waits in the outbox
  (« En attente du Mac » on the screen).
- **Playback on the phone**: AVPlayer on an asset of a private scheme
  whose resource loader fetches ranges through the pinned session; the
  bytes live in the player's memory only. A sentence touched plays from
  its time; `stale` syncs again; without the Mac, « Le Mac n'est pas
  joignable » replaces « Écouter ».

Tested: `apps/desktop/test/phone-results-runtime.test.ts` (the revision
moves after a correction, its undo, a voice named, a guess moved by a name
given in another recording, the journal written twice, a passage deleted,
and a change made while core was down, and not after another recording's
correction, states read or a restart; withheld during a deletion; a name
and a note once, the later name winning, `later` before the Mac holds it;
another phone refused on every route; ranges of a 40 s WAV over several
slices, `stale`, `range` and `gone`), the migration's snapshot and restore
test, the phone's unit tests against the fake Mac (results, the 30-day
limit with a clock set back, names and notes in the outbox, a range read
over pinned TLS), and the end to end of M5.2 extended: the real core,
relay and phone client fetch a result, see the revision move after a
correction, its undo, a voice named and the journal written again, send a
name and a note found on the Mac, read a range and are refused another
generation, and keep the same revision across a restart of core.

## Built at M5.4: reading the Mac's memory (2026-11-13)

Core (`apps/desktop/src/core/phone/phone-memory.ts`, five routes in
`phone-server.ts`), the contract (`packages/protocol/src/phone-memory.ts`,
`fixtures/phone/memory-*.jsonl`, `schemas/phone-memory.json`), the phone
(`mac-memory.swift`, `sync-memory-wire.swift`, one live read in
`sync-client.swift`) and the app (`memory-views.swift`: the search on the
home screen, « Aujourd'hui », a conversation's text). Decided while building,
without Téo; each can be overturned. « Wire » marks what both sides must
match.

- **Wire: five routes, as M5.3's.** `POST /v1/memory/search` (`{text,
  offset}`), `/day` (`{day}`), `/journal` (`{day}`), `/commitments`
  (`{beforeMs}`) and `/conversation` (`{episodeId}`), plain JSON, in their
  own file of the contract (`PHONE_MEMORY_ROUTES`; `PHONE_ALL_ROUTES` joins
  them to the sync's). Each answer may be `{"status":"withheld"}`, as `get`'s
  (the phone asks again, twice at most); `conversation` also answers `gone`
  for an episode deleted or never there. A malformed body is 400
  `bad-request`.
- **The reads are agents' reads.** Each route runs, in process through the
  app's router, the procedure of the agent's tool of the same read
  (`PHONE_MEMORY_READS`: `search_transcripts`, `get_day_overview`,
  `get_journal`, `list_commitments`, `get_episode`), and a test fails if one
  of them stops being a read-only agent tool. So the deletion filter, what a
  zone kept out (ADR 029 applies when text is written: a zone's text is never
  there to read) and the content generation are theirs; nothing of
  Settings, zones, people or voices has a route.
- **What goes out is cut to what the phone shows**, by name: an episode's
  times, kind (context, size, apps by name), first words, the names the
  user gave its voices and the people Sondine recognized as `guesses` (ADR
  030: shown « Marie ? »); a sentence's voice as M5.3's (`name`, or `guess`
  never as a name); no person's id, no likeness score, no label, track or
  playback plan. A phone recording carries its name, and its id only to the
  phone that made it (so it opens there with its result and playback);
  another phone's recording reads as « iPhone » with no id, and its audio
  stays `not-yours`.
- **Search**: 20 episodes a page, by `offset`; the text is trimmed (blank
  answers nothing). Each episode with its best sentences (5) and their
  ranges, and the notes and links that matched (their first 500
  characters; never an image's or a file's).
- **Day**: the conversations of `episodes.day` (100) and how many moments,
  media, dictations and traces. A phone recording of a few seconds of speech
  is a moment there, counted and not listed, as on the Mac.
- **Journal**: the day's lines and the commitments made that day, but those
  the user said were wrong; each with its episode, the sentences of it that
  it cites and the time of the first, which is the hour the screen shows.
- **Commitments**: a page of the open ones of the 90 days before
  `beforeMs`, with the Mac's `today`, so « en retard » (due before it) is the
  Mac's word. The page is the procedure's own: `journal.commitments` gained
  `limit` (agents may pass it too; without it, the whole window as before).
  It orders by the conversation's start, the window's own key, and cuts
  after about 500, never inside the conversations that start in the same
  millisecond as the last one kept; `nextBeforeMs` is that millisecond, so
  the next page neither skips nor repeats one. A page may hold more than
  500 when many conversations share that millisecond; the wire takes 2,000.
- **Conversation**: its voices, then as much text as fits in 8 MiB and its
  notes and links in what is left, one budget for the whole answer, its
  serialized size checked before it leaves; `truncated` when a sentence or
  a note did not fit (the phone says to read the rest on the Mac). Core
  never sends a memory answer over 8 MiB (`busy` instead), which the phone
  would refuse. No audio: the phone plays its own recordings only.
- **Counts**: each memory read is one `reads` in `phone_devices`. No count
  of its own: a column would need a migration while M5.7 adds one beside
  it; Settings ▸ Téléphone says the phone also reads the memory and that
  each read is counted.
- **Logs, never words**: core logs `phone.read {route, status, ms}`; the app
  logs the route and its milliseconds (`app.sondine.ios`, `memory`). They
  are what the device measure of the 300 ms exit reads
  (`bench/results/phone-search-2026-11-13.md`).
- **The phone keeps nothing**: `MacMemory` hands answers to the screen that
  asked; each screen holds them in its own state, gone with it, dropped
  when the app leaves the front and read again when it comes back. A page
  of search results (« Plus de résultats ») is kept only as the answer to
  the request still pending for that search and that reading session
  (`SearchPaging`); another search, or the app leaving the front, cancels
  it and drops what comes back. The live
  read writes no file (no `hello`, no « last seen », an ephemeral session
  without cache); a revocation it hears unpairs as a sync would.
- **Without the Mac**: « Le Mac n'est pas joignable. La recherche lit sa
  mémoire en direct. » (search) or « … Sa mémoire se lit en direct. »
  (« Aujourd'hui », a conversation); before pairing, a line says to pair.
- Fixed on the way: a request whose JSON the contract refused got its
  connection cut instead of 400 `bad-request` (Node marks a request
  destroyed once its body is read; the check now asks the socket).

Tested: `apps/desktop/test/phone-memory-runtime.test.ts` (a reading session
captured as the phone receives it, after a recording and a passage were
deleted and with voices embedded and named on the Mac: every answer parses
with its strict schema, holds none of the deleted words, ids or episode,
no voice field and no likeness score, and each read is counted; each route
withheld when the content generation moves while it reads, then read; a
second phone sees no recording id of the first, nor its audio; unlisted
paths and a bad body refused; a conversation with notes far over a lowered
limit answered under it with every sentence and `truncated`; commitments
paged by one across two conversations starting in the same millisecond,
none skipped or repeated), `PHONE_MEMORY_READS` against the agent
tools in the router's tests, the fixtures on both sides, the phone's tests
against the fake Mac (a session of the five reads leaves every file of the
app's folder as it was; withheld asked again twice; not paired, unreachable
and revoked; a page of an old search or of a session left behind dropped), and the end to end of `pnpm test:native`: the real phone
client searches, reads a day and a conversation over the real relay and
TLS, its folder unchanged, and times 100 searches against the same in core
(0.7 ms more at p95 on loopback).

## Built at M5.5: away from home, through Tailscale (2026-11-13)

The switch, the relay's `--tailnet` and its peer rule existed since M5.2.
M5.5 makes the phone find the Mac through the tunnel, says which path a
contact took, and checks the switch twice. Decided while building, without
Téo; each can be overturned. « Wire » marks what both sides must match.

- **Wire: `hello` says the path, only when it is Tailscale's.** Its answer
  gains `via: "tailnet"` when the relay's line said so, and nothing at
  home (or on development's loopback). The phone's decoder refuses unknown
  keys, so a key sent at home would have broken every phone built before
  M5.5 at its next sync at home; absent, it reads as « at home ». A phone
  that old reaching the Mac through Tailscale fails its `hello` and shows
  the Mac unreachable, which is what it showed before.
- **Core checks the switch again.** A connection whose relay line says
  `tailnet` while « Autoriser par Tailscale » is off is closed before a
  byte of HTTP is read (`phone.tailnet-refused` in the log), and turning
  the switch off closes those already open; the relay, started again
  without `--tailnet`, refuses them before TLS. Pairing on that path stays
  refused (`pairing-tailnet`).
- **Last contact and its path**: `phone_devices.last_via` (`lan`,
  `tailnet`, `loopback`; a migration that rebuilds the table, its
  operations kept), written at each authenticated request; Settings ▸
  Téléphone shows « Il y a 5 min, par Tailscale » or « …, à la maison ».
  With the switch on, it also says that Tailscale must run on both and
  that the phone learns the Mac's tunnel address by opening the app once
  at home.
- **`hello`'s addresses: home first, the tunnels' last.** Core lists the
  home network's IPv4 addresses, then, with the switch on, those of a
  tunnel in 100.64.0.0/10; IPv4 only, as before (Tailscale always gives
  one).
- **The phone's order, and its times.** Bonjour (1.5 s, its resolution cut
  a second later) and the home addresses (2 s each, at once) first; only
  once every one of those failed the pinned `hello`, the addresses in
  Tailscale's ranges (4 s: Tailscale may first find its way through a
  relay). A port that opens is not the Mac: away from home, another machine
  at the saved private address may accept it and fail the pin, and the
  first build then never tried the tunnel (fixed after Codex Astra's
  review: the finder has two steps, `find` and `findTunnel`, and the
  client, `MacCandidates`, asks the second only once the first's addresses
  failed). On cellular the
  home addresses fail at once, so a sync away from home starts after about
  Bonjour's 1.5 s and the tunnel's connection; nothing waits past 2 s and
  4 s, then `hello` has its 10 s. The address that answered last goes first
  only when the finder found it again and it is not a tunnel's, so back
  home the phone syncs at home, and an address left behind at home is not
  waited for away from it. The finder's network is behind a protocol
  (`MacNetwork`), so the tests give it a fake one.
- **Cellular only for the tunnel.** The phone's URLSession had « no
  cellular » (`allowsCellularAccess = false`), which can stop a connection
  through a VPN running over cellular. A request to an address in
  Tailscale's ranges now uses its own session that allows cellular; a
  request to a home address still never does, nor does the TCP probe of
  one or of a Bonjour service (`prohibitedInterfaceTypes`; the first build
  let probes use any interface, fixed after Codex Astra's review).
- **The phone shows the path** on screen 5 (« Chemin : À la maison » or
  « Par Tailscale »), from `hello`'s answer, while the Mac is reachable.
- **ATS and the local network, checked on paper.** The requests go to IP
  literals over HTTPS with TLS 1.3, a P-256 key and SHA-256, the trust
  decided by the pin. Apple's documentation says ATS does not apply to IP
  addresses; older reports say an IP needed `NSAllowsLocalNetworking`,
  which the app has. A 100.x literal is the same kind of host as the
  192.168.x literal that syncs on Téo's iPhone since M5.2, so nothing
  changes in `Info.plist`. A tunnel is not a local network (TN3179): no
  local-network permission is involved. Both to confirm on the device.
- **Tested.** The relay: the switch decides for a peer on a `utun` holding
  the Mac's 100.x (both ranges), and a debug-only option,
  `--loopback-v6-as-tailnet`, makes `::1` stand for a tunnel's peer (a
  release build refuses the option). Core: a hello through Tailscale
  closed with the switch off, accepted with it (upload, states, the path
  kept and answered), an unpaired phone refused there, pairing refused
  there, and an open connection closed when the switch goes off. The
  phone: the finder's order and limits over a fake network (home first,
  the tunnel only after home's time, cellular's quick failure, nothing
  answering ends in 2 + 4 s, a hanging Bonjour cut, a home address that
  opens followed by the tunnel, probes kept off cellular but for a
  tunnel's), and the client's path at home, away and home again against
  the fake Mac, and through the tunnel when another machine at the home
  address fails the pin. End to end (`pnpm
  test:native`): the real core, relay and phone client through the
  test's proxy on `::1`: refused with the switch off, then a sync and a
  recording stored through it, the path on both sides, pairing refused,
  a credential-less request refused through real TLS, and home again.
- **Packet captures** are not done: the steps are in
  `bench/results/tailscale-path-2026-11-13.md`, for the devices.

## Rejected

- Mutual TLS with a Secure Enclave key on the phone: stronger than a
  bearer credential (a copied Mac key could not take it), but building a
  certificate for that key needs a dependency on both sides. The
  credential travels only inside pinned TLS, and revocation is as
  immediate. The first thing to add if the Mac's key file ever proves too
  exposed.
- A relay of Sondine's own outside the house, or any hosted rendezvous:
  ADR 002.
- A replica of the Mac's database on the phone: every copy has to be
  deleted and protected, and a phone is lost more easily than a Mac.
- Background uploads (`URLSession` background sessions,
  `BGContinuedProcessingTask`): Apple advises against trust challenges
  there and the second is reported unreliable for uploads. Reconsidered
  when opening the app proves to be a burden.
