# 032 — Phone recordings: made by hand, one file, the Mac's import

Status: Accepted — 2026-11-10 (direction, Téo's answers below). Built at
step M5.1 on 2026-11-11, except what needs Téo's iPhone (the device
measurements, the codec choice): « Built at M5.1 » below. Step M5.6 (the
control, the Live Activity) built on 2026-11-13: « Built at M5.6 ». Step M5.8
(phone voices measured) built on 2026-11-13, too few labels to open:
« Built at M5.8 ». The codec is
chosen by a measurement at step M5.1; ALAC until then. Amends ADR 021 (a file
that carries Sondine's header is not an « import »), ADR 029 (« Phone
recordings follow hours and types only ») and the format lines of the first
ADR 008. Pairing and sync are [ADR 008](008-mobile-lan-sync.md); the app's
stack is [ADR 031](031-iphone-app-stack.md).

## Context

Téo's answers (2026-11-10):

1. Recording is started by hand, in one gesture, for sessions that may last
   hours with the screen locked. No promise of continuous recording.
2. On the Mac a phone recording belongs in Today, the journal and the
   commitments, with a phone mark, not in « Importés »: it is one of his
   conversations, not a file received from elsewhere.
3. Its voices may be recognized, as suggestions only (« Marie ? ») until
   the iPhone's microphone is measured.
4. (2026-11-11) The documents: « oui ». That includes the two rules below
   proposed without him: zones do not apply to a phone recording (« La
   nuit » included), and « Oublier les N dernières minutes » leaves it
   alone.
5. (2026-11-11) His iPhone is a 16 Pro, which has the Action button: the
   device measurements of M5 and the control of M5.6 are made on it.

What iOS allows (read 2026-11-10; sources dated):

- With the `audio` background mode and an active session an app « is
  allowed to stay active indefinitely » (Apple DTS, forums thread 826462,
  May 2026); no documented time limit.
- Recording must start in the foreground: « a privacy block […] prevents
  recording sessions from activating in the background » (DTS, thread
  816408, February 2026). `AudioRecordingIntent` (iOS 18+) is the
  exception and needs a Live Activity kept active; a July 2026 report
  (thread 836958) has it failing from the Action button on a locked phone,
  with no answer from Apple.
- An interruption (a call answered, another app taking the microphone)
  stops the session; resuming is the app's job, and a January 2026 report
  (thread 813278) has reactivation failing until the app is opened. iOS 27
  adds a resumption recommendation notification.
  `setPrefersNoInterruptionsFromSystemAlerts` keeps a call shown as a
  banner from interrupting unless it is answered.
- No public API records a cellular call.
- A Live Activity stays active 8 hours at most, then up to 4 more on the
  Lock Screen; it is updated locally, without any push service.
- iOS shows an orange dot while the microphone is on. Review guideline
  2.5.14 asks for consent and a clear indication when recording.
- No trustworthy battery figure was found: it is measured at M5.1.

Measured on this Mac (2026-11-10, throwaway script, AVFoundation as on iOS,
synthetic speech): 40 s written six ways, the process killed before closing
the file, then read with the import's own commands (`afinfo`, `afconvert`).

| Written as                       | After the kill | Size for one hour |
| -------------------------------- | -------------- | ----------------- |
| m4a, AAC or ALAC (`AVAudioFile`) | unreadable     | —                 |
| CAF, AAC or ALAC                 | opens, 0 s     | —                 |
| CAF, 16-bit PCM                  | 40.0 s read    | 115 MB            |
| Fragmented m4a, AAC 32 kbit/s    | 39.9 s read    | about 15 MB       |
| Fragmented m4a, ALAC (lossless)  | 38.1 s read    | about 75 MB       |

(Fragmented: `AVAssetWriter` with a movie fragment every 2 s; 16 kHz mono
in every row.) A JSON text written in the file's comment tag before the
first sample comes out of `afinfo -i` unchanged, after a kill too.

This shows which containers can survive, on a Mac. It does not prove the
bound on an iPhone (the encoder's buffer, the file system, a battery that
dies): M5.1 measures the same thing with the app's writer on the phone and
the import's reader on the Mac.

## Decision

### On the phone

- **Started by hand**: the app's button; from step M5.6 also a control on
  the Lock Screen, in Control Center and on the Action button, which opens
  the app when iOS refuses to start the microphone from the background.
  Stopped from the app, the Live Activity or the control. No continuous
  mode, no voice-activity gate on the phone.
- **Always visible**: the app's state, iOS's orange dot, and from M5.6 a
  Live Activity with the elapsed time. iOS ends a Live Activity after
  8 hours: the recording goes on, a local notification says so, and the
  control and the app still stop it. The first run says what is recorded,
  that people nearby are recorded too, and that consent is the user's to
  obtain where the law asks for it (ADR 012).
- **Audio session**: record only, no voice processing, the microphone iOS
  routes (built in, wired or Bluetooth; its kind goes in the header);
  banner calls do not interrupt unless answered.
- **Interruptions are explicit, never silent.** When the session is
  interrupted the current file is closed. The app resumes when iOS
  recommends it; when it cannot (the report above), a local notification
  says « Enregistrement interrompu à 14:32 » and opens the app to resume.
  A resumed recording is a new file of the same session, with its own
  start time.
- **One file per stretch of continuous audio**: fragmented MPEG-4 audio
  (`.m4a`), 16 kHz mono, a fragment every 2 s. The target, verified on
  the iPhone at M5.1: a kill, a crash or an empty battery loses a few
  seconds at most (the experiment above lost 0.1 s and 1.9 s). A file
  holds at most 3 hours (the Mac's episode cap, under the import's 4 hour
  limit); a longer session goes on in the next file with no sample lost
  between them.
- **Codec: lossless (ALAC) unless the measurement of M5.1 says AAC costs
  nothing.** Everything Sondine captures is kept lossless so a later
  engine can analyse it again (ADR 015), and the phone erases its copy once
  the Mac has it, so the size is paid for a few hours. M5.1 encodes the
  same real iPhone recordings both ways and compares the text and the
  voices; AAC is taken only if the word error rate moves by less than
  0.5 point (the bench's own threshold) and a voice's similarity to its
  references by less than 0.02. The result is recorded here.
- **The header travels inside the file**, in its comment tag, written
  before the first sample:
  `{"sondine":"phone-recording","v":1,"recordingId":…,"sessionId":…,"part":1,"startedWallMs":…,"utcOffsetMin":…,"deviceId":…,"input":"built-in","previous":null,"app":"0.1.0 (12)"}`.
  `previous` says why the session's previous file ended (`interruption`,
  `rotation`, or `null` for the first). The schema lives in
  `packages/protocol` with fixtures both sides test. No name of a person
  or a device is in it.
- **Storage**: one folder per recording, excluded from backup; the files
  being recorded stay writable with the phone locked, the others are
  readable only unlocked (ADR 008). Recording refuses to start under 1 GB
  free and stops cleanly, with a notice, under 200 MB.

### On the Mac

One import path, ADR 021's. It already runs `afinfo -b` on every file; it
now also reads the comment (`afinfo -i`). The test fixtures are files the
Swift tests write and the TypeScript tests read, made at test time: no
audio is committed.

- **No header**: an imported recording, exactly as today.
- **A valid header**: a phone recording, whichever way the file came
  (dropped, pasted, picked, or sent by the paired phone, ADR 008).
  - Its track run takes `recordingId` as its id (`phone:<recordingId>`). An
    id already here with the same bytes is not imported twice, with other
    bytes it is refused as a conflict; an id deleted here is refused, so
    nothing deleted comes back (`phone_recordings`, ADR 008). All three
    are checked again inside the transaction that publishes it.
  - It starts at the header's time, not at the file's modification time,
    when that time is plausible: not after the moment the Mac receives it
    (5 minutes of tolerance), not before 2025. Otherwise it ends when the
    Mac received it and shows « heure incertaine », which the user can
    correct. The phone's clock read at upload is kept only as a hint for
    finding the same meeting (below): it says nothing sure of the clock at
    recording time.
  - Its episode is `in_person`, not `imported`: Today, the journal and the
    commitments take it; lists and search show a phone mark; « Importés »
    does not list it. It is transcribed as a user request, as imports are.
  - As for imports: one closed track run of kind `phone`, one region over
    the whole file, one closed episode, no grouping, no split and no merge
    (they would cut through 2 s audio blocks, ADR 021). « Type ▸ » stays
    available: durations follow the type.
  - Imports made before this, and files without a header, keep the context
    `imported` and change in nothing.
- **Voices.** An `in_person` episode feeds identity (ADR 012), so its voice
  embeddings are kept, on the channel `phone` that `voiceChannel` already
  knows. ADR 030's rule then applies as written: a voice heard on a channel
  that is not measured is only suggested, and only from 99 %. No « Moi »
  guess. « Ne pas identifier » and « Reconnaître les voix » apply as
  everywhere.
- **Retention.** Durations by type apply (a conversation's audio 90 days,
  a moment's 30…), with « Effacé après » by type, « Garder l'audio » and
  the disk cap. They count from the recording's end or from its arrival on
  the Mac, whichever is later, so a recording synced after two weeks away
  is not erased before it was read. This replaces ADR 021's « retention
  never expires it » for phone recordings only.
- **Zones do not apply.** Every zone is a situation the Mac observes (an
  app, a site, its network, its screen), and a recording started by hand
  is a gesture, which comes before zones (ADR 029's layers), « La nuit »
  included. This replaces ADR 029's « hours and types only ».
- **« Oublier les N dernières minutes »** leaves phone recordings alone,
  as it leaves imports (ADR 021): it erases what the Mac heard, and it
  deletes whole every recording it touches, which would take a 3 hour
  phone recording for its last 5 minutes. When a phone recording overlaps
  the minutes forgotten, the confirmation names it and says it stays.

**Rules that must change with this.** Today the code tells an import by its
context `imported`; a phone recording is `in_person`, so each of these has
to read the track run's kind (`phone`) instead, with a test:

| Rule                                 | Where it reads the context today                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Forget skips it, in the list too     | `packages/db/src/forget-range.ts` (`episodesInRange`)                                                        |
| A forget beside it keeps its journal | `packages/db/src/journal-triggers.ts` (`journal_mark_tombstone` clears generated text by wall overlap alone) |
| No split, no merge, no neighbour     | `packages/db/src/episode-boundaries.ts` (`closedEpisode`, `episodeNeighbours`), the transcript's scissors    |
| Zones do not apply                   | `packages/db/src/privacy-policy.ts` (zones are matched without knowing where the audio came from)            |

M5.1 is not done until a Mac recording and a phone recording of the same
minutes pass each of them.

### Voices: what is known, what to measure

Known (ADR 030, 2026-11-10): on a 3 hour phone recording of four people, a
person named from one morning at the Mac's microphone was suggested on 143
of 153 pieces and never taken for someone else. The calibration fitted on
recordings other than Téo's microphone puts 99 % at a cosine of 0.684,
against 0.618 on his microphone: one threshold does not fit every
microphone. Nothing was measured with references heard by an iPhone.

To measure before `phone` joins the measured channels (ADR 030's method,
held out by episode and by day):

- Recordings made by the app on Téo's iPhone, on three days or more: Téo,
  three people or more he names, and voices he does not know; the phone on
  a table, in a hand and in a pocket; the built-in microphone and one
  headset.
- Two pairs, apart: a phone voice against microphone references, and
  against phone references.
- Reported as counts of people and recordings: strangers recognized
  (the opening condition is none), known people recognized, suggested or
  missed, and the same with AAC if the codec question is still open.

Until then phone voices read « Marie ? » at best.

### The Mac and the phone hearing the same meeting

Nothing is ever deleted or merged for this. From step M5.7:

- **Detected at import**: a recording the Mac captured that overlaps the
  phone's by a minute or more on the wall clock, searched 2 minutes wider
  on each side since the phone's clock is not sure, then confirmed by
  correlating the two 10 ms energy envelopes over the overlap, which also
  gives the offset between them. The wall clock only proposes; the sound
  decides. The threshold is set from real double recordings, and from the
  case that must not link: the Mac and the phone recording different
  rooms at the same hour (ADR 030 saw 0.87 for one sound heard twice
  against 0.34 for different speech, on one microphone).
- **Stored as a link** between the two episodes (offset, correlation,
  version of the method). It is computed again when either changes and
  goes when either is deleted; the journal over that time is then written
  again from what is left.
- **Shown**: each says « Aussi enregistré par le téléphone » or « … par le
  Mac » and opens the other at the same moment.
- **One feeds the journal over the shared time**: the one whose speech is
  louder there (mean envelope); the user can switch. The other keeps its
  audio and its text, and search marks it as the same moment.
- Not now: one conversation made of both tracks with word-level
  de-duplication (as `echo/3` does for played sound), which needs
  measurements this step produces.

## Consequences

- On the Mac the first step of M5 is one more read of `afinfo`, a table
  with its migration (snapshot and restore tests, ADR 006), and the four
  rules above moved from the context to the track run's kind.
- An AirDropped file and a synced file end up identical, and the id makes
  sending both harmless.
- A meeting interrupted by a phone call is two recordings on the Mac.
- Lossless audio costs about 75 MB an hour on the phone until sync (an
  upper bound: synthetic speech with no pause).
- A recording started by hand at night is kept even when « La nuit » says
  « Rien ».

## Built at M5.1 (2026-11-11)

Decided while building, without Téo; each can be overturned unless marked
approved.

- **The rules read `source_kind = 'phone'`, which imports have too.** So
  imports keep every rule they had (forget, split, merge), and zones stop
  applying to them as well: a zone is a situation the Mac observed, and an
  imported file's time is only its modification date. Before, a « La nuit »
  zone could take an import dated at night. Approved by Téo on 2026-11-12
  (« oui »).
- **The journal's tombstone trigger**: a mark whose spans are all on
  `phone` runs loses its generated words only to a tombstone on its own
  run; the triggers are now replaced at open when their text changed.
- **`phone_recordings`**: `recording_id` (primary key), `device_id`,
  `state` (`stored`, `deleted`), `track_run_id`, `sha256`, `time_uncertain`,
  `received_at_ms`, `deleted_at_ms`. A CHECK makes a tombstone hold no run
  and no hash; it keeps the device id, which M5.2 needs to answer the phone.
  Deleting the episode (« Supprimer », a type's « Effacé après », the
  « Transcrire » cleanup) turns its row into a tombstone in the same
  transaction.
- **The track run's uid stays random** (it names the archive folder); its
  key is `phone:<recordingId>`. The episode of a phone recording has no
  label: it is a conversation, not a file.
- **Duplicates are answered before decoding**: `afinfo -i` and a SHA-256 of
  the file first; the window says « déjà là », or refuses `conflict` and
  `deleted`. The publishing transaction checks the same again.
- **Plausible time**: the header's start is kept when it is not before
  2025 and the recording ends at most 5 minutes after it reached the Mac;
  otherwise it ends at its arrival, `time_uncertain`, shown « heure
  incertaine » beside the phone mark. Correcting it by hand is not built.
- **The phone mark** is the word « iPhone » in a recording's context line
  (Today, search, its screen, people, the player): the Nucleo subset has no
  phone glyph, and adding one needs the licensed install. Approved by Téo
  on 2026-11-12 (« oui »).
- **« Transcrire » on a conversation's audio file** (ADR 024) stays a
  transcription even when the file carries the header.
- **Retention** counts a phone recording's durations from its end or from
  its episode's creation (its arrival), whichever is later.
- **Interruptions on iOS 27** come from `didBecomeInactiveNotification`
  (source `system`) and `resumptionRecommendationNotification`; a call is
  told from another cause by CallKit's `CXCallObserver`, which reads no
  number and sends nothing.
- **Another microphone** (a headset connecting) starts the next file of the
  session with `previous: interruption`, with no notification: the switch
  is recorded, not a hole. Media services reset is an interruption resumed
  at once.
- **`events.log`** carries the header in its `started` line (written while
  the phone may be locked, unlike `state.json`), a `progress` line every
  minute (the length a kill leaves) and an `ended` line with the reason; a
  kill is found at the next unlocked launch, logged `killed` and said once.
- **A microphone that cannot restart** after a route switch is an
  interruption (closed file, notification, « Reprendre »), never a silent
  hole; a resume that fails keeps its session for the next try.
- **« Partager… »** shares a hard link with a dated name (no copy of the
  audio); deleting the recording removes it, and the app removes every
  such link at launch, so no deleted audio survives in a link.
- **Low space**: the recording screen warns under 500 MB, stops under
  200 MB; it does not start under 1 GB.
- **The Mac-side kill test** writes at ten times real time (the encoder
  keeps up, as with the microphone) and kills after 3, 7, 12, 21 and 34 s:
  at most 2.5 s are lost each time, the header included. The iPhone's own
  measurement stays an exit item.

## Built at M5.6 (2026-11-13)

Decided while building, without Téo; each can be overturned. The app's side
(the extension, the intent, the keychain group) is in ADR 031.

- **Starting from the control** tries in place first: the intent is an
  `AudioRecordingIntent`, iOS's exception to the background block, and the
  app starts the Live Activity before the intent returns, as that exception
  requires. When iOS refuses the microphone all the same (the July 2026
  report above), or the microphone is not allowed yet, the app comes to the
  front and starts there. The same happens when no Live Activity could
  start (Live Activities turned off for Sondine): a recording started out
  of sight without one is stopped at once, since iOS would cut it, and the
  app in front records without one. If the app cannot come to the front
  (the phone stays locked), a notification gives the reason (« Sondine n'a
  pas commencé à enregistrer »). Too little space and a file that cannot be created are
  said at once, without opening the app. Which path iOS 27 takes on the
  iPhone is an exit item.
- **The control is one toggle.** Off to on starts a recording, or resumes an
  interrupted session (its next file, as « Reprendre » does). On to off
  stops it. It shows on only while a file is being written.
- **Stopping from the Lock Screen** (the control, or « Arrêter » on the Live
  Activity) is the recorder's own `stop()`, the path of the app's
  « Arrêter ». The file is finished and its log gets `ended stopped`.
- **The Live Activity follows the session, not the file.** It stays through
  a rotation and through an interruption. While interrupted it shows
  « Interrompu à 14:32 » (« … par un appel »), the counter stopped there,
  with « Reprendre » and « Arrêter ». It ends when the session ends.
- **8 hours.** Apple's documentation says an `AudioRecordingIntent`
  recording must keep a Live Activity, or it stops. Whether iOS 27 also cuts
  a recording that has run in the background for 8 hours when its activity
  ends cannot be known without the iPhone. So the safe way is taken: a
  minute before iOS's limit a new activity takes over, and the old one
  ends. If iOS refuses the new one (likely, the app being in the
  background), the old one runs to iOS's end. A minute after that, only if
  the recording is still being written, a notification says « Sondine
  enregistre toujours », since when, and how to stop. If iOS cut the
  microphone instead, that is an interruption with its own notification,
  and nothing claims the recording goes on. Which of these happens on the
  iPhone is the exit item.
- **With Live Activities turned off** for Sondine, a recording started in
  the app goes on without one, and no 8 hour notice is sent.
- **The interruption's notification** gets a « Reprendre » action. It
  opens the app and resumes at once, where a tap on the notification only
  opens the app on « Reprendre ».

## Built at M5.7 (2026-11-13)

The same meeting on both, on the Mac; decided while building, without Téo,
each can be overturned unless marked approved. Revised the same day after
Codex Astra's review (source eligibility and holes, marks across the link,
short overlaps, failed comparisons).

- **Where it runs**: in core, in TypeScript, behind `SameMomentDetector` in
  `packages/engines` (ADR 005; id `envelope-xcorr/1`, stored with each
  comparison). Core reads each episode's audio where playback reads it
  (its extents, deletions cut out, a minute at a time, nothing cached) into
  a 10 ms energy envelope (`EnvelopeBuilder`); only the envelope reaches the
  detector, and no audio leaves core. Swift with Accelerate was not needed:
  the cost below is a second per hour.
- **The method**: each envelope in dB, minus its local mean (each
  microphone has its own gain, distance and noise), holes (no extent,
  digital silence) left out of every sum. Coarse: normalized
  cross-correlation at 100 ms over every lag the search allows (FFT); the
  best, among lags with a minute in both, must reach 0.25 and stand 8
  standard deviations above the other lags with 20 s in both, each on
  Fisher's scale (atanh) times the square root of its frames, so a short
  overlap's noisier lags neither pass for a peak nor hide one. Two
  recordings of exactly a minute are judged so; when fewer than ten other
  lags remain (a search of a few seconds), the windows decide alone, every
  one agreeing with a median correlation of 0.5. Fine: each 20 s window of the phone's envelope finds its lag at
  10 ms within ±500 ms of the coarse one; a robust line through them
  (Theil–Sen, then least squares on those within 30 ms) gives the offset
  and the drift between the two sample clocks; three windows at least, half
  of those with sound in both, must agree, with a median correlation of
  0.4, and the drift stay under 300 ppm. The thresholds come from
  synthetic pairs (below); Téo's recordings set them (`pnpm bench
  same-moment run`, protocol in `apps/bench/README.md`).
- **Which pairs**: a closed phone recording with its audio, against each
  closed Mac `in_person`, `call` or `mixed` episode with microphone audio
  that overlaps it by a minute once the phone's times are widened by 2
  minutes (15 for one marked « heure incertaine », placed at its arrival:
  right only when it was sent soon after). Only the Mac's microphone tracks
  are read, never the sound the Mac played.
- **When**: once a phone recording is imported, after each transcript is
  published (a Mac conversation is then closed and settled), 30 s after
  core starts and every 10 minutes, one pair at a time in the background.
  A pair is compared once per pair of `input_generation`s and method;
  linked or not, the verdict is stored, so nothing is read twice. Core
  closing during a comparison stores nothing (compared at the next start);
  one that fails (no reader, a read error) stores nothing either and is
  tried again after 10 minutes, then three times longer each time up to
  6 hours, while core runs. Only audio that is all deleted is a verdict
  (no link) without one.
- **The link**: `same_moment_links` (migration with its snapshot and
  restore test): both episodes (deleting either deletes the row), their
  generations, the method, linked or not, the offset (Mac wall − phone wall
  at an anchor on the phone's clock), the drift, the score, the shared time
  on the Mac's clock, the journal's source and whether the user chose it,
  and the detector's numbers. A pair the clocks no longer propose (a split moved one away, a type
  changed) loses its row at the next look; one whose audio retention took
  keeps its link, as its text stays.
- **One source for the journal**: the episode that does not feed it
  leaves out of what the model reads (`journal-input.ts`) its sentences in
  the shared time, only while the journal reads the source (its state,
  type, size and transcript: a source made media, or not transcribed yet,
  suppresses nothing) and only where the source still holds its audio (a
  passage deleted from the source, a tombstone on its run, or on any of
  the Mac's runs for the Mac, leaves the other's sentences there). An
  episode entirely inside it publishes an empty journal without loading
  the model. Triggers (with the journal's, created at each open and
  dropped before the migrations, which may rebuild a table they read)
  delete the journal runs of the episode that does not feed it, before and
  after, on any change to what it leaves out: a link made, gone or with
  another source, offset or shared time (no tolerance); a tombstone over
  the source's shared time; the source's state, type, size or voice
  changing; its transcript published or retired.
- **The user's word stays on one line**: a mark (« Fait », « Pas un
  engagement », a corrected text) made on a line of one recording goes,
  once the other feeds the journal, to the same line written from the
  other: a mark's audio meets a line's when they are on the two linked
  recordings' runs and their times meet through the offset, 500 ms either
  side, then the closest words as for any mark. A word on that line goes
  to that mark. So a commitment marked done on the Mac stays done, once,
  when the iPhone becomes the source.
- **The source is the clearer one, not the louder** (approved by Téo on
  2026-11-13): the mean of a
  recording's loudest 30 % of 10 ms frames minus its 10th percentile over
  the shared time, the larger wins (the ADR said the louder mean envelope:
  two microphones' gains differ, and a far phone in a noisy room is loud
  and poor). « Lire celui-ci au journal » switches, and a comparison made
  again keeps the user's choice.
- **Shown**: under each episode's title « Aussi enregistré par le Mac » or
  « … par l'iPhone », which opens the other at the second playing here (or
  where they start sharing), offset and drift applied, with « le journal
  lit celui-ci / l'autre » and the switch (« celui-ci » too when the journal
  no longer reads the other). Every linked recording is listed, however
  many a long phone recording meets. Today, search, people and the
  player add « aussi sur le Mac » / « aussi sur l'iPhone » to the context
  line.
- **Nothing of either recording changes**: no audio, text, voice or
  deletion is made for a link; deleting one is deleting one, and a passage
  deleted in one stays in the other.

Measured on synthetic pairs made in the tests (speech-like sound in a room
with early reflections and a half-second echo, each microphone with its
own gain, noise, clock error up to 73 s and drift up to 40 ppm;
`pnpm bench same-moment synthetic --long`, this Mac, 2026-11-13):

| Pair                                  | Found  | Worst error | Peak      |
| ------------------------------------- | ------ | ----------- | --------- |
| Phone near, Mac far, 15 min           | linked | 20 ms       | 0.78      |
| Phone far, 18 min                     | linked | 20 ms       | 0.80      |
| Noisy room (a café's babble), 19 min  | linked | 3 ms        | 0.67      |
| Sharing only 3 minutes                | linked | 17 ms       | 0.92      |
| One hour against one hour             | linked | 16 ms       | 0.87      |
| Three pairs of rooms at the same hour | none   | —           | 0.04–0.12 |

Cost: envelope and detection take about 0.47 s of CPU per hour of audio
compared; through core, one hour of phone against one hour of Mac (read
from disk with every block's CRC, two envelopes, the detection) took
0.98 s, 1.2 s of CPU and about 128 MB of memory for the time it runs.
Nothing runs while no phone recording arrives: the 10 minute look is one
query.

## Built at M5.8 (2026-11-13)

Phone voices, measured; decided while building, without Téo, each can be
overturned.

- **One flag**: `PHONE_VOICES_MEASURED` in `packages/db` (`voices.ts`),
  off. On, a phone voice compared with the person's phone references
  follows the microphone's rule (« Marie ? » from 80 %, recognized at 99 %
  with three references on two days and 3 s of speech). Off, as since
  M5.1: suggested only, from 99 %. Either way a phone voice compared with
  references heard another way (the microphone, the Mac's sound), or a
  microphone voice with phone references, is only suggested, from 99 %
  (ADR 030). The flag is set by the report below, never by hand; tests
  cover both states with synthetic embeddings.
- **The measurement**: `node apps/bench/src/cli.ts voices phone`
  (`apps/bench/README.md`). It copies the database read-only, reads the
  embeddings the app made, and counts ADR 030's report for the two pairs
  apart (phone voice against microphone references, against phone
  references), held out by episode and by day, known and as strangers
  (each named person taken out of the references in turn), under the rule
  built and the rule a pass would open. A trial is a person in a recording,
  all the voices named as them there together, the worst outcome counting
  (Codex Astra: two labels of one person counted twice and passed the
  gate with half the recordings). Only recordings the app made count: an
  imported file is never embedded (context `imported`). A phone voice's
  references never include a recording that may have heard the same
  moment: one M5.7 linked, and, linked or not, any other recording whose
  time meets the phone's, 2 minutes wider (15 when its time is uncertain),
  across midnight too (Codex Astra: a meeting M5.7 had not linked could be
  its own reference).
  Results: `bench/results/voices-phone-<date>.md`, counts only, people as
  « person n ».
- **What opens the phone**: the phone-against-phone pair, held out by day,
  with no stranger recognized and nobody recognized as someone else, on
  named phone voices on three days or more, four people or more (the user
  and three others) each with three recordings on two days left whatever
  day is held out, and 30 stranger trials or more. The phone-against-microphone pair is reported
  and opens nothing: crossing channels stays a suggestion (ADR 030).
- **Measured on 2026-11-13** (`bench/results/voices-phone-2026-11-13.md`):
  seven recordings made by the app (2.2 minutes, two days), one voice
  embedded, none named. Both pairs: no known person, no stranger trial,
  `too-few`. The flag stays off: phone voices read « Marie ? » at best.
- **What waits**: Téo's labelled recordings (protocol in
  `apps/bench/README.md`: himself and four others, two recordings a day on
  three days, table, hand, pocket and a headset, every voice named on the
  Mac), then the report again. AAC is not compared: it needs the same
  recordings encoded both ways, the codec measurement of M5.1.

## Rejected

- Continuous recording: iOS does not guarantee resuming after a call, so
  it would have holes found afterwards; a phone in a pocket hears poorly;
  an orange dot all day. Reconsidered once M5.1's battery and interruption
  measurements exist.
- AAC segments of 60 minutes with a manifest beside each (the first
  ADR 008): an ordinary m4a is unreadable after a kill whatever its
  length, and two files per recording do not survive a share sheet well.
- The helper's spool format (PCM with a manifest): safe and already
  shared with Swift, but 115 MB an hour, two files, and a second import
  path.
- A separate « phone » context for episodes: `in_person` already means
  what it is, and every rule that reads contexts would need the new one.
- Transcribing on the phone: the Mac owns analysis (vision); Apple's
  on-device transcriber has no diarization.
