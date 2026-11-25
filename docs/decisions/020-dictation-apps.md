# 020 — Dictation apps

Status: Accepted — 2026-11-08; amended 2026-11-10 by ADR 030 (the user may
let their dictations teach Sondine their own voice), 2026-11-14 by ADR 035
(what the user says over a playback is kept, judged against Sondine's own
reference) and 2026-11-25 (§ "The app's own text")

## Context

Téo dictates a lot with speech-to-text apps, Hex above all, VoiceInk too
(2026-11-08): « Ça peut être intéressant de garder l'audio, mais il faudrait
savoir que ça vient de X. Et du coup, après, on pourrait faire des filtres.
Par exemple, si ça vient d'ici, pas forcément le compter dans les trucs à
diariser ». Until now Sondine heard that speech as in-person talk: mixed
into the conversations around it, diarized by Nemotron, offered for naming.

The helper already resolves which processes run microphone input, and turns
call apps into `call` spans (ADR 007, ADR 016 "Episodes"). An app holding the
microphone is evidence of listening, not of dictation: Hex kept it open all
day by default, until Téo turned on its « release the microphone while idle »
setting (2026-11-08); VoiceInk takes it only while dictating. The system's
speech recognition (Siri, accessibility) listens for other reasons too.

## Decision

- **The helper says who listens.** Every app other than a call with
  microphone input running is a `listen` span (`ListenEvent`, protocol 2):
  one per app however many of its processes listen, `via` `app` or `speech`
  (the system's speech recognition), never Sondine's own nor an excluded
  app, reported under the same conditions as calls. One pass decides calls
  and listeners, by app: an app with a process in a call is a call only. A
  snapshot replays the active spans after its clock; core stores them in
  `listens` with the calls' replay rules (`calls.ts`). Two spans of one app
  are never joined: two dictations are two.
- **Which apps are dictation apps** is the user's rule, by app (`settings`
  key `dictation.apps`, over the defaults): the known dictation apps
  (`KNOWN_DICTATION_APPS`: Hex, VoiceInk, Parler, and since 2026-11-25 Handy,
  superwhisper, Wispr Flow and others) count by default; any other app once the
  user says so in Settings ▸
  « Dictées », which lists every app seen listening, with its icon and when
  it last did, then the known dictation apps installed (Spotlight) that have
  not listened yet, and the apps the user added with « Ajouter une app… »
  (an open panel on /Applications; main reads the bundle ID from the app's
  Info.plist). Speech daemons are never a
  default. A rule applies to the episodes grouped after it: open ones,
  never closed ones.
- **Grouping `grouping/3`.** Outside calls (`grouping/4`: during them too), a mic region
  whose midpoint falls in the first 10 minutes of a dictation app listening
  goes to lane `dictation:<bundleId>`, the earliest such app when several
  listen; its episode's context is `dictation` (`mixed` once merged with
  other speech). The window keeps an app that holds the microphone all day
  from turning the day's talk into dictations. A dictation closes after the
  in-person gap of silence, whatever its app does with the microphone.
  Phone recordings are never dictations. Late regions repair a closed
  dictation only when they fall in a dictation themselves. The episodes'
  `context` CHECK gains `dictation` (a table rebuild: ids, rows that point at
  episodes, indexes and search stay as they were).
- **Transcribed by Parakeet, one voice.** A dictation's job runs on
  Parakeet, with no speakers asked; each track's text gets one label, the
  user's voice (« Moi », a presentation inference as in a call, never an
  identity). Its job has a moment's priority whatever its size. Without
  Parakeet installed, dictations wait and every other job runs; with
  Parakeet only, dictations run and the others wait with `no-model`.
  Parakeet stays one worker for near-live text and dictations
  (`shareEngine`): each has a handle that waits its turn for every load,
  request and unload, and the worker exits once neither holds it. Voices of
  a dictation are never identified: no naming, and no embeddings unless the
  user turned on « Apprendre ma voix depuis mes dictées » (ADR 030), where
  they only teach the user's own voice.
- **Window.** A dictation is labelled « Dictée · Hex » with the app's icon.
  Today shows dictations in their own lane, hidden by default, behind a
  « Dictées » toggle beside « Médias »; they never show among what is being
  said now (the app already typed them). Search finds them like anything
  else, with a « Dictée » context filter. Agents see `context: "dictation"`
  and the `dictations` lane.

## The app's own text

Téo (2026-11-25): « Idéalement, si on peut reprendre exactement ce qui a été
dit par le logiciel de dictée, c'est plus intelligent. »

- **Four apps' histories are read**, by default for everyone (Téo,
  2026-11-25: « à activer par défaut pour tout le monde »), each from its own
  files in `~/Library/Application Support`, never written:
  - Hex (`anomaly.hex`), `hex/history.json`, version 1: when its text came, how
    long the user spoke and the transcription took. The end of speech
    (`timestamp_ms` minus `total_ms`) is the end of Hex's `listen` span to about
    10 ms. Its last 500 or so dictations.
  - VoiceInk, `com.prakashjoshipax.VoiceInk/default.store` (SwiftData): the end
    of speech and its length; the enhanced text when the enhancement succeeded, as typed
    (a failed one leaves its error there, and no duration).
  - Parler, `app.synapsr.parler/history.json`: when the text came.
  - Handy (`com.pais.handy`), `history.db`: the second the text came, read from
    its source, tried on no real file.
- **An app that says only when its text came** is placed by its `listen` span:
  the one that ended before, when exactly one ended since the text before it.
  A cancelled dictation, or two at once, makes it none. The microphone must
  have been captured without a hole until the text came: a dictation made while
  Sondine did not watch would otherwise lend its words to the one before.
- **Reading never waits, writes or trusts.** Opened without blocking, checked to
  be a regular file once open, bounded (16 MB of text, 64 MB of database), read
  whole or not at all. A SQLite file is copied to a private folder for the time
  of the query (refused if the app changed it meanwhile; a copy a crash left is
  removed at the next start), with `trusted_schema` off and a plain table of the
  expected name, no generated column. What was read is let go after a minute. Another format, or
  trouble of any kind, is as if there were no history.
- **Not read:** the Hex of Kit Langton (`com.kitlangton.Hex`, sandboxed: macOS
  would ask the user for another app's data), superwhisper (under Documents: the
  same), and apps whose format cannot be checked here (Wispr Flow, Aqua Voice,
  Spokenly, OpenWhispr, FluidVoice, Willow Voice). They count as dictation apps
  by default, by the bundle IDs of their Homebrew casks or source, and Parakeet
  transcribes what is said to them.
- **The past too**, once per app: at start, and when the user turns it on, the
  dictations whose app still keeps the text become it, by the same rules, and
  never a transcription made again. On Téo's Mac, 174 of 334.
- **All of it or nothing.** The app's text is taken only when its dictations
  cover 90 % of the speech heard and half of each stretch of it, and when each
  dictation used is the episode's from end to end, silences included
  (`ownsStretch`): captured without a hole on one microphone, its speech in no
  other episode, nothing of it deleted or corrected. What was said while
  Sondine was paused never comes in, a deleted word never comes back, and a
  correction is never covered. On Téo's 188 dictations of 2026-11-18 to 25,
  173 match; their words agree at 95 % (median) with what Parakeet had heard.
  The others go to Parakeet, and without Parakeet only they wait for it.
- **One segment per dictation**, where it was heard, without word times: Hex
  keeps none, and Sondine invents none. The run's engine is
  `dictation-text:<bundle id>`. It needs no model, so it waits for nothing.
  Private zones apply as to a transcription (ADR 029).
- **Settings ▸ Dictées**: « Reprendre le texte de … » under each of the four, on
  by default.
- The setting's procedure is not counted in the anonymous statistics: the
  report's fields are what the user said yes to (ADR 042).

Codex Astra reviewed it (2026-11-25): 4 findings, all fixed with tests (words
said after capture stopped or in another episode, a hostile file, dictations
waiting without Parakeet, corrections covered). On the four apps and the past,
7 findings, all fixed with tests (a text lent to another dictation, VoiceInk's
enhancement errors, generated columns, torn copies, a past dictation transcribed
again, unreadable metadata, copies left by a crash).

## Sondine's own sound

Téo (2026-11-08): « quand on a du son qui vient depuis Sondine quand
j'écoute des choses, c'est complètement con de le prendre en compte ». The
system tap already excludes Sondine's processes, but on the speakers the
microphone hears the replay, which became in-person moments.

- **The player says when it plays** (`player.state`): at once, every 3 s
  while it plays, and once when it stops. Core keeps each playback as a
  lease in `self_playbacks` (wall time; 6 s past the last renewal, so a
  window that dies stops it soon), with the route of the default output
  when it started: `headphones` (the built-in jack's `hdpn` data source,
  Bluetooth, or a device named so) or `speakers` (anything else, or no
  device list yet).
- **Grouping leaves it out.** A mic region whose wall midpoint falls in a
  playback on the speakers is `self-playback`: no episode holds it, and no
  late-region repair joins it. Through headphones nothing is left out.
  Since ADR 035, a region judged against the `self:playback` reference to
  hold someone's speech is the room's after all; this rule stays for echo,
  for regions not judged yet, and when the reference is missing.
- A change of default output while it plays (headphones plugged or
  unplugged) splits the playback at once, from the helper's device list.
- Accepted: what the user says over a playback on the speakers is left out
  with it when the VAD makes one region of both (kept since ADR 035 when it
  stands out of the echo); a Bluetooth speaker is
  taken for headphones; playbacks are on wall time while regions are placed
  from their track's clock anchor, so a wall clock moved by hand during
  capture shifts them; the regions left out stay ungrouped, read again by
  each pass within its horizon (no lookup of episodes around them).

## Not now

Regrouping closed episodes when a rule changes, attributing per app from
audio taps (ADR 004), and the histories named above as not read.

## Consequences

- The protocol is at version 2: a helper and a core of different versions
  refuse each other, as they ship together.
- A dictation app that holds the microphone between dictations still turns
  the first 10 minutes after it takes the microphone into dictations.
- A browser page that dictates while another tab plays sound is taken for a
  web call, as before (ADR 007).
