# Delivery plan

Each milestone builds only the contracts and bench rows it needs. A milestone
is done when its exit criteria are met on Téo's Mac with a signed build, and
the results are recorded (bench JSON, decision, or Diagnostics capture).

Release 1 = M0-M4. Release 2 = M5 (iPhone companion). M6 (UX redesign)
reworks how both are reached and said.

## M0 — Signed capture floor and risk spikes

Scope:

- Monorepo, `pnpm check`, signed dev builds (hardened runtime, locked fuses).
- Tray app; `core` utility process with `node:sqlite` and the capture tables.
- `sondine-audio`: pinned or default mic and the `system:other` tap,
  listener-driven discovery, measured-rate resampling, full-signal spool with
  the commit protocol, energy gate + Silero VAD, speech regions, envelopes,
  health histograms, pause and resume, real permission states.
- `sondine-meter` and the budget scenarios S0, S3, S4, S6.
- Spikes, each ending in a recorded decision: MessagePort brokering to the
  utility process; child helper vs SMAppService agent; kernel network
  sandbox per native child; one vs several aggregates for N taps; listener
  reliability on macOS 27; app group container in dev and signed builds.

Exit:

- An 8 h soak stays within the always-on budget, with zero ring overflows.
- Killing the helper, core, or main; revoking a permission; sleep and wake;
  and a full disk each produce recoverable data or an explicit gap.
- Verifies the vision assumption "always-on fits its budget".

Closed 2026-11-05 on Téo's Mac with the signed build `d1bb53a`; kills,
permission withdrawal, and sleep passed there (ADR 003, ADR 004). Carried to
M4:

- The 8 h soak ran on a second Mac (zero ring overflows, energy and wakeups
  within budget), not on Téo's Mac.
- The full disk was tested on a development build with the fake HAL.
- Two S0 values are above the starting caps: coreaudiod (+1.7 points of CPU,
  likely the `system:other` tap, architecture §16) and Electron main's
  wakeups (1.2/s for 1).
- S3 and S4 are not measured.

## M1 — Searchable recording

Scope:

- Episodes: grouping and the size/context decision table (v1).
- `asr`, `align`, and `diarize` contracts; the `speech.cpp worker` adapter
  running Nemotron 3.5 Transcribe 30B IQ4_NL (ASR + native speakers) as the
  reference engine; the `sondine-engines` worker for Core ML challengers
  (Parakeet TDT v3 first); model manager (import of
  already-downloaded weights by APFS clone or copy, a resumable download the
  user starts, sha256 verification).
- Compare-and-publish, FTS search.
- UI: theme, components, Today timeline, Conversation view with playback,
  Search, first run, tray. Design system page.
- Bench: harness, `fr-norm` normalizer, ASR on the public quick tier, golden
  set v0 (60 min).

Exit:

- A real French/English conversation is found by a word and replayed at the
  right second.
- Restarting core mid-job never duplicates or loses results.
- ASR and speaker attribution cost and quality recorded for Nemotron 30B
  (the baseline), Parakeet, and two challengers.

## M2 — Corrections, deletion, export, and agents

Agents and export are Téo's top priority after search
([ADR 014](decisions/014-feature-priorities.md)). They land with deletion so
that nothing deleted can leave through them.

Scope:

- User assertions, transcript edit, split and merge, kind override, delete
  episode, delete range, tombstones, secure delete.
- Export and share: a conversation, a time range, or search results as
  Markdown (timestamps, speaker names), SRT/WebVTT, or versioned JSON. Text
  only by default; an audio clip on request; voice data never. Through the
  save panel or the macOS share sheet (AirDrop, Mail, Messages). Sondine
  hosts nothing.
- Read-only MCP through `sondine-mcp` (ADR 011): search, get episode, list
  episodes in a range, get an excerpt with timestamps. Per-agent tokens and
  a visible local call log.

Exit:

- Reanalysis preserves every assertion.
- A late job cannot resurrect deleted content; deleted text is gone from the
  database file and the WAL.
- Deleted content never appears in an export or an MCP result.
- After the user enables it, a local agent (Claude Code, Codex) finds a
  conversation by a word and quotes it with the right timestamps; revoking
  its token refuses the next call.
- A JSON export validates against its schema; a Markdown export reads well in
  a plain text editor.

Discussion with an agent (2026-11-09, ADR 027, outside the milestones): in
Sondine, on Téo's own Claude subscription through his Claude Code CLI, off by
default, reading through the agent tools only. Téo's answers the same night:
reading only for now; discussions kept across launches (done, erased with
what they read); Codex waits until its built-in tools can be removed.

Context (2026-11-09, ADR 024, outside the milestones): notes, links,
images and files added to a conversation, pinned to a sentence or not,
searchable, read by agents (images included), exported as text and deleted
with what they are attached to. Next: the global shortcut that adds the
clipboard to the ongoing conversation.

## M3 — Attribution and identity

Scope: app-tap decision list and transitions, call-follow and call-app taps
(calls themselves are detected and grouped since M1 step 2), echo evidence
and word-level dedup, `diarize` and `embed-speaker` contracts and two
challengers each, episode speakers, Phase A identity (suggest only), People
view and "Who is this?" queue, self enrollment, identity rules.

Exit:

- Concurrent-app fixtures attribute correctly (attribution confusion matrix
  recorded).
- Held-out source, overlap, and cross-device fixtures meet declared
  thresholds; zero false merges on the golden test split.
- Verifies the vision assumptions "per-app attribution stays exact" and
  "voice identity holds across microphones".

State (2026-11-07): built — People and « Qui est-ce ? », Phase A suggestions
(« Marie ? »), « C'est moi », identity rules applied everywhere with the
global switch and « Reconnaître les voix ici » per recording, echo of played
sound left out of the mic transcript by word evidence (`echo/3`), one
person's voices linked within a transcript, across its requests too
(2026-11-08), two people merged into one, undoable (2026-11-09, ADR 025;
splitting is « Modifier » on each voice). 2026-11-09: a tap per app playing
sound and call-follow (ADR 026): every app keeps its own track, calls first,
`system:other` keeps the rest and runs only while it plays; the microphone
follows a call's device. The concurrent-app fixtures attribute every second
of each source to its own track, none to another app's (confusion matrix in
ADR 026, fake HAL, read back from the spool), and the same on Téo's Mac with
two player apps (`bench/results/app-taps-2026-11-09.md`). 2026-11-14:
Sondine's own echo by its reference (ADR 035): a private `self:playback`
tap on Sondine's processes, `envelope-echo/1` in core, what the user says
over a playback on the speakers kept, Sondine's echo left out
(`bench/results/self-echo-2026-11-14.md`, synthetic). Not built —
envelope correlation with app and system tracks, `diarize` /
`embed-speaker` contracts and challengers, the
overlap, cross-device and identity exit fixtures (they need the golden split
and labelled recordings), and a real call's S3 on Téo's Mac. Built
2026-11-14: the onboarding voice read (ADR 034), also in Settings ▸ Voix
and on the user's page; one reference on its day, so « Moi ? » from the
first day and recognition after confirmed voices on a second day.

## M4 — Recall in context, defaults, and release

Scope:

- Personal vocabulary: names and jargon learned from corrections and from
  People. Used for ASR biasing where an engine supports it (a capability
  measured on the bench), and for post-correction otherwise.
- Phonetic search: a French/English phonetic key per word and name, so a
  misheard name still matches ("Kamille" finds Camille).
- Near-live view.
- Call context: once a known voice is recognized in a call, the menu bar
  and the notch show the last conversations with that person (ADR 025). Suggested matches are
  labelled as suggestions (Phase A identity).
- "First engine defaults" decision per pipeline profile; packaged release
  (notarized DMG, update check).

Exit:

- Defaults chosen from recorded evidence (end-to-end tcpWER and identity
  false-merge on the private test split).
- Near-live text appears within 5 s of speech in an ongoing call.
- Vocabulary lowers the name error rate on the golden set (measured with and
  without it); phonetic search recall on misheard names is recorded.
- Call context appears within 10 s of the first recognized voice.
- Vision assumptions "code-switching is handled" and "moments are useful"
  verified on a labelled week.
- The always-on budget holds on Téo's Mac: the tap decided, S3 and S4
  measured, an 8 h soak, and the caps set to the measurements plus 15 %
  (what M0 carried over).

State (2026-11-07): built — phonetic search (`phonetic-fr/2`, « Kamille »
finds Camille, for the app and agents), personal vocabulary from the user's
name corrections (`vocabulary/2`, at publish, engine text kept), interim
engine defaults (ADR 018, Proposed), « Ouvrir Sondine à l'ouverture de
session ». 2026-11-08: near-live text, a setting on power only (Parakeet,
ADR 019); notarized releases (`pnpm release:mac`, the app and the DMG
accepted by Gatekeeper); the update check, opted into in Settings (GitHub
Releases of `sondine-releases`, ADR 002), with the app at 0.2.0, above the
Tauri app's last release. 2026-11-09: call context (ADR 025): live identity
in calls only (the far side, windows of 3 s then 10 s, two agreeing, nothing
stored), « Marie ? » and her last conversations in the menu bar and, on
a screen with a notch, in an island around it (after Alcove: initial and
« ? » beside the notch, the name below it on arrival, the conversations
when the pointer rests on it, or on a click as a setting; `sondine-notch`, 13 MB while a call shows); its
latency and false suggestions on real calls are not measured yet.
Relaunch after a crash (2026-11-08): main writes `quit` on the helper's
lifetime pipe when it quits on purpose; a pipe closing without it means main
crashed, and the helper opens Sondine again in the background (not within a
minute of its start), keeping the listening intent. Checked on Téo's Mac:
back within a second of a SIGSEGV, nothing after a normal quit. The exit measurements need the golden split, a
labelled week and an 8 h soak; near-live latency in a long call is not
measured yet.

## M5 — iPhone companion (release 2)

Decisions: [ADR 008](decisions/008-mobile-lan-sync.md) (pairing and sync),
[ADR 031](decisions/031-iphone-app-stack.md) (SwiftUI, TestFlight),
[ADR 032](decisions/032-phone-recordings.md) (recordings); the system is
architecture §12 and the screens are [iphone-screens.md](iphone-screens.md).
Direction validated by Téo on 2026-11-10, the documents on 2026-11-11
(device: his iPhone 16 Pro). The code of M5.1 to M5.8 is built (M5.8: the
measurement, `phone` kept at suggestions only). What waits is Téo's: each
step's device exits on his iPhone, the real double recordings of M5.7 and
the labelled phone recordings of M5.8 (each step's state below).

Eight steps, each delivered alone through TestFlight and a Mac release, in
this order unless said otherwise. A step is done when its exit holds,
`pnpm check`, `pnpm test:native` and `pnpm test:ios` pass, and its note is
in `changes/`. Every device measurement is recorded in `bench/results/`.

### M5.1 — Record on the phone, and the Mac files it

Scope: the app (record by hand, the list, a recording's screen, share,
delete from the phone, first run, settings with the build's expiry); the
recorder with interruptions; `pnpm release:ios`. On the Mac: the import
reads the header (`phone_recordings` and its migration, `in_person`, the
phone mark, duplicates and deleted ids refused), and the four rules that
told an import by its context read the track run's kind instead (ADR 032).
No network code on either side.

Shows Téo: he records a conversation away from the Mac, sends it by
AirDrop, and finds it in Today at the hour it happened, transcribed, in the
journal, with « Marie ? » on a voice the Mac knows.

Exit:

- Killed five times while recording on the iPhone, and once by an empty
  battery: each file is read by the Mac's import up to its last seconds
  (the loss is recorded; target 2 s), header included, and the app says
  what happened at its next launch.
- A 3 hour recording, screen locked, of a click played every 10 s by a
  speaker: every click is there, evenly spaced, across the rotation to a
  second file too (a 3 h 10 run), and the length matches the monotonic
  clock within 0.1 %.
- Rotation and an interruption with the phone locked leave readable files
  and a complete `events.log` (the protection classes of ADR 008).
- The interruption table is filled on iOS 27: a call answered, a call
  declined, Siri, an alarm, another app's microphone, a headset connecting.
  Each is one continuous file or an explicit new file with a notification,
  never a silent hole.
- Battery: two 3 hour locked recordings and the same with Voice Memos; the
  percentage per hour is recorded and no more than 1.5 times Voice Memos'.
- Codec: an hour or more of real iPhone speech encoded as ALAC and as AAC
  32 kbit/s; AAC is taken only under 0.5 point of word error difference
  and 0.02 of voice similarity; the result is written into ADR 032.
- The same file imported twice is one recording; deleted then imported
  again, it is refused; the same id with other bytes is refused.
- With a Mac recording and a phone recording of the same minutes: « Oublier
  les 5 dernières minutes » lists and deletes the Mac's only, and the
  phone recording's journal lines stay; the phone recording cannot be
  split or merged; a zone that covers those minutes takes nothing from
  it. Imports made before keep working as they did.
- The migration passes its snapshot and restore test (ADR 006).
- A packet capture of the phone (`rvictl`) while recording and sharing
  shows no flow from the app.

State (2026-11-11, second Mac, branch `t3/m5-1-phone-recording`): built
and tested without the iPhone — the Mac's import of a phone file with
`phone_recordings` (migration with its snapshot and restore test), the four
rules on the track run's kind with a Mac and a phone recording of the same
minutes, `SondinePhone` with the recorder on a scripted audio session
(interruptions, kills, rotation of a 3 h 10 run with no sample lost, a full
disk), the app's M5.1 screens in French and English, `pnpm test:ios`,
`pnpm release:ios` (not run), and the cross-language test: Swift's writer
killed five times on the Mac, each file read by the import up to its last
2.5 s with its header. On Téo's iPhone (2026-11-12 and 13,
`bench/results/iphone-recording-2026-11-13.md`): the first TestFlight build,
a first recording imported at its hour, and five forced quits from 20 s to
10 min, each file read to its end with at most 2 s lost and the notice
shown. Open: an empty battery, the 3 hour click run, rotation and
interruptions locked, the interruption table, battery, the codec on real
speech, the packet capture, and correcting « heure incertaine » by hand. ALAC stays the codec until the measurement.

### M5.2 — Pairing and sync at home

Scope: `sondine-lan`; core's HTTP server, pairing, credentials, ownership,
the inbox, the upload with resume and the durable `stored` answer; each
recording's state (`states`); deletion both ways with the outbox and the
tombstones, since a sync that cannot say « deleted » is not correct;
Settings ▸ Téléphone on the Mac; on the phone, the pairing screen and the
sync client.

Shows Téo: back home he opens the app; his recordings go to the Mac alone,
each turns « Transcrit », and its audio leaves the phone. One he deletes on
the phone disappears from the Mac, and the other way round.

Exit:

- A transfer cut three ways (Wi-Fi off at half, the app killed, Sondine
  quit) resumes and ends with the same SHA-256, one recording, nothing
  lost.
- A recording sent twice is one; the same id with other bytes answers
  `conflict` and the phone keeps its file; the phone erases audio only
  after `stored`.
- Core killed right after `stored` (and the Mac's power cut, on
  second Mac): the recording is there at the next launch.
- A recording deleted on the Mac while its upload is being imported, in
  both orders: it is never there afterwards. One deleted on the Mac is
  gone from the phone's storage at the next contact; one deleted on the
  phone goes through the Mac's deletion (its text absent from the
  database file and the WAL, M2's test), also when the app was killed
  between the tap and the removal.
- A revoked phone is refused at its next request and erases its
  credential; a second pairing with a used or expired token is refused; two
  phones scanning one QR pair one; a pairing left unanswered for 2 minutes
  closes, and the port with it when no phone is paired.
- A phone cannot name, read, play or delete a recording another phone
  made.
- With every slot held by connections that never authenticate, a paired
  phone still syncs within a minute.
- With no phone paired, no pairing open and no revoked phone still to be
  told (a day at most), no port is open and nothing is advertised (a scan
  and `dns-sd -B`).
- A peer outside the local subnet is refused before TLS.
- `sondine-lan self-test sandbox`: the relay is sandboxed and may listen; an iPhone on the Wi-Fi connects to it (the sandbox once refused its answers, 2026-11-13).
- The local-network alert appears once, in the foreground, and names
  Sondine on both devices; App Transport Security has no exception beyond
  local networking.
- Packet captures on the Mac and on the phone during pairing and a sync:
  mDNS and the Mac↔phone flow, nothing else from Sondine.

State (2026-11-13): built on all sides, not yet on a device. Core's server
on `phone.sock` (pairing, credentials, ownership, the inbox, the resumed
upload with the durable `stored`, states, deletion both ways), the relay
`sondine-lan` and its packaging, Settings ▸ Téléphone, and the phone's
pairing screen and sync client (ADR 008, « Built at M5.2 » sections). An
end-to-end test in `pnpm test:native` runs the real core, relay and phone
client together on one Mac (« Tested end to end at M5.2 »), and Codex
Astra's review of the build is fixed. On Téo's devices (2026-11-13,
`bench/results/iphone-recording-2026-11-13.md`): paired, six recordings
sent and stored, deletions from the phone run on the Mac, after two fixes
to the relay (an iPhone's global IPv6 address; `network.client`, without
which the sandbox dropped its answers on the Wi-Fi). Open: the other exits
measured on the network or the devices (Wi-Fi cut, app killed, Sondine quit, power cut on
second Mac, packet captures, `dns-sd -B`, the local-network alert on
both, a peer outside the subnet), and the TestFlight build.

### M5.3 — Results on the phone

Scope: results (`get` with its revision); the transcript with its voices
and journal lines on the phone; rename; a note; playback streamed from the
Mac.

Shows Téo: an hour after a meeting he reads it on the phone, renames it
and adds a note, which he finds on the Mac.

Exit:

- A passage deleted on the Mac is absent from the phone after the next
  contact.
- The revision moves, and the phone shows it, after each of: a correction,
  its undo, a voice named, a guess changed by a name given elsewhere, the
  journal written again, a restart of core. It does not move otherwise.
- A note sent twice is one note; of two names, the later one typed wins.
- A result of a recording older than 30 days is erased at launch, a clock
  set back included.
- With the Mac off: the phone lists, reads what it fetched, records and
  queues.
- An answer read before a deletion committed is withheld (the agents'
  test, on the phone's edge).

State (2026-11-13): built on all sides, not yet on a device. `get` with
its revision (the SHA-256 of the result, read through `episodes.get` and
`journal.day`), `rename` and `note` from the outbox, and playback of the
episode's WAV by byte ranges; the name kept in `phone_recordings` and shown
after the phone mark on the Mac; on the phone, `result.json` for the last
30 days, screen 4 with the transcript, its voices, journal lines, notes and
streamed playback (ADR 008, « Built at M5.3 »). Tested without a device:
every exit above in core's runtime tests (the revision after each change
and a restart, a passage deleted, a note once, the later name, withheld),
the 30-day limit with a clock set back in the phone's tests, and the end
to end of `pnpm test:native` extended to results, names, notes and a range
read. Open: Téo reading, renaming and noting a real meeting on his iPhone,
playback on the device, the Mac off with the app open, and the TestFlight
build.

### M5.4 — Reading the Mac's memory

Scope: search, the day's journal, commitments and a conversation's text,
read live through `PHONE_PROCEDURES`; the phone's activity in Settings ▸
Téléphone.

Shows Téo: on the sofa, he searches a word on the phone and reads the
conversation the Mac recorded yesterday.

Exit:

- Search on the phone answers within 300 ms more than the same search on
  the Mac (p95, local network).
- After a session of reading, the app's folder holds no new file.
- Nothing deleted is returned, and the phone gets no voice data: both read
  from a recorded capture of the exchange.

State (2026-11-13): built on all sides, not yet on a device. Five routes,
`POST /v1/memory/search`, `day`, `journal`, `commitments` and
`conversation`, run the procedures of agents' tools of the same reads in
core (`search_transcripts`, `get_day_overview`, `get_journal`,
`list_commitments`, `get_episode`), withheld when something is deleted
meanwhile, each counted as a read; on the phone, a search field on the home
screen, « Aujourd'hui » (the day's journal, the open commitments, the day's
conversations, previous days) and a conversation's text, read only, held by
the screen that shows them (ADR 008, « Built at M5.4 »). Tested without a
device: the exits in core's runtime tests (a reading session captured as
the phone receives it holds nothing deleted, a whole recording or a
passage, and no voice data or likeness score; withheld on every route),
the phone's tests against the fake Mac (the app's folder unchanged by a
session of reads), and the end to end of `pnpm test:native` extended to a
search, a day and a conversation over the real relay and TLS, with the
folder unchanged. Search on loopback through the relay and TLS: p95
6.2 ms on the phone's client against 5.5 ms for the same search in core,
0.7 ms more (`bench/results/phone-search-2026-11-13.md`). Open: the same
measure on Téo's Wi-Fi from his iPhone (steps in that file), and the
TestFlight build.

### M5.5 — Away from home, through Tailscale

Scope: « Autoriser par Tailscale » on the Mac, off by default, with what it
lets out; the phone tries the Mac's known tunnel addresses when Bonjour
finds nothing.

Shows Téo: on cellular with Tailscale on, his recording reaches the Mac at
home and comes back transcribed.

Exit:

- With the switch off, a peer from 100.64.0.0/10 is refused; on, a paired
  phone syncs and reads; an unpaired one is refused.
- Packet captures: Sondine's processes talk to the phone's tunnel address
  only, and never to a Tailscale host.

State (2026-11-13): built and tested on one Mac, not yet on the devices
(ADR 008, « Built at M5.5 »). The phone tries the Mac's tunnel addresses,
learned from `hello` at home, only once no home address answered the
pinned `hello` (2 s, then 4 s), with cellular allowed for those addresses
only (requests and probes); `hello` answers `via: "tailnet"` on that path, shown on screen 5
(« Par Tailscale » or « À la maison ») and in Settings ▸ Téléphone's last
contact (`phone_devices.last_via`). Core closes a `tailnet` connection
while the switch is off, and those open when it is turned off. Tested:
the relay's rule for a `utun` holding 100.x with the switch off and on;
core's runtime tests (refused off, synced and read on, unpaired and
pairing refused); the finder's order and limits over a fake network; and
the end to end of `pnpm test:native` through a debug-only stand-in for
the tunnel (`::1`, refused by release builds). Open: the exits on Téo's
iPhone on cellular, the packet captures
(`bench/results/tailscale-path-2026-11-13.md` has the steps), ATS and the
cellular session confirmed on the device.

### M5.6 — Start without opening the app, and see that it records

Depends only on M5.1; it can come earlier if Téo asks.

Scope: the Live Activity (elapsed time, stop, the interrupted state), the
control for the Lock Screen, Control Center and the Action button, the
notification after an interruption.

Shows Téo: he presses the Action button, the phone records, the Lock
Screen shows the time, and he stops it there.

Exit:

- Starting from the control on a locked iPhone: recorded for iOS 27.x
  whether it starts in place or opens the app; it never fails silently.
- A recording longer than 8 hours: the Live Activity ends, a notification
  says the recording goes on, and it does.
- Stopping from the Lock Screen closes the file properly.

State (2026-11-13): built and tested without the iPhone. A widget extension
draws the Live Activity (elapsed time, « Arrêter », the interrupted state
with « Reprendre ») and the control for the Lock Screen, Control Center and
the Action button. One intent runs both in the app: it starts in place, or
opens the app when iOS refuses, or says why in a notification. The 8 hour
rule hands the activity over to a new one, and says the recording goes on
only once it is seen to go on without one. A cold launch with the phone
locked reads the device id from its own file and never makes one up
(Codex Astra's review).
The interruption's notification gets « Reprendre ». The logic is in
`SondinePhone` with tests on injected clocks (`pnpm test:native`).
`pnpm test:ios` passes, and `pnpm release:ios --no-upload` exports the app
with its extension (ADR 031 and 032, « Built at M5.6 »). Open: all three
exits on Téo's iPhone (start from the control on a locked phone, 8 hours,
stop from the Lock Screen), and a TestFlight build.

### M5.7 — The same meeting on both

Scope: detection at import, the link, « Aussi enregistré par… », one
source for the journal (ADR 032).

Shows Téo: a meeting recorded by the Mac and by the phone on the table
shows once in his journal, and each recording opens the other at the same
second.

Exit:

- On ten real double recordings, with the phone near and far, a noisy
  room and an overlap of only a few minutes among them: all linked, the
  offset within 100 ms of a hand clap marked in both.
- On ten pairs recorded at the same hour in different rooms (speech in
  both): no link.
- The journal has no line twice; deleting either recording removes the
  link and the journal is written again from the other; the bytes of both
  recordings are unchanged.

State (2026-11-13, branch `t3/5a15ca06`): built on the Mac and tested on
synthetic pairs (ADR 032 « Built at M5.7 »): the detector behind an engine
contract (energy envelopes, coarse and fine correlation, offset and drift),
core comparing each pair the clocks propose, `same_moment_links` with its
migration test, one source for the journal kept by triggers, « Aussi
enregistré par… » with the jump and the switch, and `pnpm bench same-moment`.
On synthetic pairs near, far, noisy and sharing 3 minutes: linked within
20 ms; three pairs of rooms: none; about a second per hour of audio. Open:
Téo's ten double recordings and ten pairs of rooms (protocol in
`apps/bench/README.md`), and the thresholds they set.

### M5.8 — Voices heard by the phone, recognized

Scope: the labelled recordings and the measurement of ADR 032; `phone`
joins the measured channels only if it passes (Téo agreed on 2026-11-10
to suggestions only until the iPhone's microphone is measured).

Shows Téo: « Marie* » instead of « Marie ? » on a phone recording, or the
numbers that say why not yet.

Exit: ADR 030's report for the two pairs (phone against microphone
references, phone against phone references), held out by episode and day:
no stranger recognized; the counts recorded in ADR 030.

Verifies, with M3's fixtures, the vision assumption « voice identity holds
across microphones, phone recordings, and call codecs ».

State (2026-11-13): the measurement is built, the labels are not there.
`phone` is a channel of the recognition code behind one flag,
`PHONE_VOICES_MEASURED`, off (suggestions only, from 99 %), with tests on
synthetic embeddings for phone references, crossing channels and the flag.
`node apps/bench/src/cli.ts voices phone` reads a copy of Téo's database
and writes ADR 030's report for both pairs, held out by episode and by day
(`bench/results/voices-phone-2026-11-13.md`): seven recordings made by the
iPhone app, none of their voices named, so no known person and no stranger
trial; `too-few`, the flag stays off (ADR 030 « Counts by channel pair »,
ADR 032 « Built at M5.8 »). Waits for Téo: phone recordings labelled as in
`apps/bench/README.md` (himself and four others, two recordings a day on
three days, every voice named on the Mac), then the report again, and the
AAC comparison with M5.1's codec measurement.

## M6 — UX redesign (Mac first, then the iPhone)

Scope: a more minimal, simpler and coherent app, with Granola as the
reference (ADR 037, plan in `docs/ux-redesign.md`):

- action levels: primary at one click, secondary at two steps, rare in
  Settings or the palette, each counted as access and done cost;
- a word budget per screen state, with teaching in popovers, modals and
  first-use hints;
- motion only from Graphical's tokens and roles;
- one way to do each thing, and a listening control that tells every
  state;
- a six-step first run set by what the user wants to find again (three
  goals), ending
  on a first memory found by a word;
- the agent as a ⌘J panel that starts where it opens, with an optional
  limit core enforces;
- statistics in Settings, from data already held.

Steps U0 to U9, one thread each, contracts before screens.

Starts after the Graphical work (ADR 033) has landed in `main`.

Shows Téo: pause, open a conversation, confirm a voice, open sharing and
open the agent each in one click; Settings in tabs; a first run that ends
on his own first sentence, found by a word.

Exit:

- Every primary action of `docs/ux-redesign.md` §2 at an access cost of
  one, checked by `pnpm ux:paths` on invented data.
- Every screen state within its word budget (§5), in French and English,
  enforced by a test.
- Only the animations of the catalogue (§6), all immediate under « Réduire
  les animations ».
- The first-run test session, discussion limits and statistics tested in
  core; the cost of each step that adds work reported.

State (2026-11-19, branch `t3/ux-redesign-plan`): validated by Téo and in
progress. Done: U0's look (Allo, black and white, pills) and the capture
script (`pnpm --filter @sondine/desktop ux:shots`), U1 (the dock and the
listening control), U2 (Today with the journal), U2b (People), U3's header,
journal lines and Share, U4's import from anywhere, U5a–b (the agent panel,
its focus and its optional limit enforced in core), U6a (Settings tabs),
U6b–c (statistics), U7b–c's goal step, model order and cloud card. Next:
U7a (the first-memory test session, with the helper) and the live meter,
U4's search chips and the Imported screen's replacement (an « Importés »
lane on Today), the rest of U3 (sentence « ··· », context chips, the voice
popover), U0's text-budget test and click paths, the Settings « ⓘ »
popovers, U8, then the iPhone.

## Later (unscheduled, in priority order)

1. "Keep this": one gesture (tray or global shortcut) keeps the last
   2 minutes as a named moment, protected from spool expiry. Done
   (2026-11-14, ADR 029 amended): « Garder les 2 dernières minutes » in the
   menu bar, ⌃⌥⌘K from any app, or the sidebar's pause menu keeps what the
   Mac captured then, speech or not, past the spool, every duration, zone
   and the disk cap (`kept_audio`, origin `moment`); the recordings it
   reaches read « Gardé à 14:32 ». Not built: naming it (recordings have no
   names yet).
2. "Forget this": one gesture deletes the last N minutes. Done early
   (2026-11-06, M1 step 2): the last 5, 15 or 60 minutes, from the menu bar or
   the sidebar, deleting every recording touched whole. Any passage of a
   recording (M2, 2026-11-07): « Supprimer… » on a sentence, ⇧-click to
   extend, one confirmation; since 2026-11-10 also by selecting text over
   sentences or ⌫, with « Jusqu'à la fin » and « Depuis le début ».
3. Private zones: rules by app, Wi-Fi network, or time of day; retention by
   kind (traces, moments, conversations; audio apart from text). Built
   2026-11-10 (ADR 029): Settings ▸ Confidentialité, one model (by default
   everything is kept; each zone takes away the audio, the text or both, or
   deletes after a day or a week; zones add up; gestures come first). Zones
   for an app, a site, the network the Mac is on (its router's signature, no
   Location), hours, every call and the screen away, held by the helper at
   capture where it can (protocol 5), with « Écouter quand même » in the menu
   bar; audio by type (calls and conversations 90 days, moments 30, media,
   traces and dictations 7), « Garder l'audio » on a recording. Not built:
   Focus filters, calendar events, categories of apps.
4. Commitments and a daily journal from a local language model, each line
   citing its transcript span. Done (2026-11-09, ADR 028): Qwen3.5 9B in a
   sandboxed llama-server, one conversation per request after
   transcription, under its admission and never beside Nemotron; Today shows
   the open commitments and the day's lines, each ending with its cited
   sentence's time; Téo's marks hold through regeneration; deletions take
   what cites them (database triggers); agents read both.
5. iPhone recording started from the Action button or a Live Activity:
   scheduled as M5.6.
