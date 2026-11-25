# 034 — The voice read: the user's voice from the first day

Status: Accepted — 2026-11-14. Amends ADR 030 (the read is one of the
user's references, and vouches for their dictations) and architecture §8
(« a short read in onboarding »), §11 (the first run's steps).

## Context

Architecture §8 promised that the user is enrolled opt-in, « a short read
in onboarding, or confirming "this is me" ». Only the second was built: on
a fresh install Sondine knows nothing of the user's voice until they name
one « C'est moi » in a conversation (or turn on « Apprendre ma voix depuis
mes dictées », ADR 030, which itself needs a named voice first). Téo
finished his first run long ago, so the read must also be reachable later.

ADR 012 makes a voice print biometric data, opt-in, erasable; ADR 030 sets
when a voice is recognized: 99 % against the centroid of three references
on two days, microphone against microphone, 3 s of speech, because a
single-voice centroid let strangers reach 96–97 % on Téo's measurements.

## Decision

- **Where.** An optional step « Apprendre ma voix » in the first run, after
  the permissions (`OnboardingStep` `voice`), with « Passer » as plain as
  « Commencer »; the same read in Settings ▸ Voix (« Ma voix lue ») and on
  the user's page in People. Reading again replaces the read.
- **What the user does.** Reads a short text shown on screen, in the
  window's language (about 75 words, 25–30 s), with a level meter and a
  counter of the voice heard. The read ends by itself at 25 s of voice (or
  60 s in all); « Terminer » is offered from 10 s. One sentence says the
  print stays on this Mac, the recording is deleted at once, and it can be
  forgotten.
- **Consent.** « Reconnaître les voix » off: the step says recognition is
  off and offers nothing; in the first run it offers « Activer la
  reconnaissance des voix », the user's explicit yes, beside « Passer ».
  Core refuses a read while it is off, and storing the read is refused in
  the same transaction that checks it, so a read never outlives the user's
  no.
- **One reference, one sitting.** The read is stored as one embedding
  (`voice_reads`, one row, for the user's `people` row, made as « Moi »
  when there is none) and counts in ADR 030's pools as **one reference, on
  the day it was read, on the microphone**, its own sitting (no voice of
  any episode is the read, so every voice is scored against it). It never
  counts as three: from the first day a voice of the user's reads
  « Moi ? » from 80 % (Téo's measurements: his own voices against a single
  reference, fifth percentile 0.50, 85 %); recognition (ADR 030) still needs
  three references on two days, so the read plus two voices the user
  confirms, at least one on another day than the read. Cutting the read in
  three pieces to make three references was rejected: one sitting is one
  microphone position, one room, one mood, exactly what the « two days »
  rule guards against, and a stranger reached 96–97 % against a one-voice
  centroid (ADR 030).
- **Dictations.** The read is a voice the user gave as theirs: with « Apprendre
  ma voix depuis mes dictées » on, dictations that score 80 % against the
  named voices or the read join the references (they used to need a named
  voice). A dictation still never vouches for another.
- **Audio: only the embedding is kept.** Exemplar clips are not built
  (architecture §8, « Not yet »); every reference today is an embedding. The
  read is recorded to one file in the data directory's `voice-read` folder
  (0700, the file 0600, created new), its voiced stretches cut by an energy
  gate (frames within 30 dB of its loud frames, pauses under 300 ms kept),
  embedded by `sondine-voice`, then the file is deleted whatever happened;
  the folder is emptied at each start. Cost accepted: an embedder change
  makes the read useless (vectors of two versions are never compared) and
  the user reads again.
- **Erasing.** « Oublier ma voix lue » deletes it; turning « Reconnaître
  les voix » off deletes it with every embedding (it has no audio to be made
  again from); deleting the user deletes it (cascade). A merge moves it to
  the person kept, and undoing the merge gives it back to the user; ⌘Z on
  the name that made the user's row is refused rather than erasing a read
  made since. A read under way when any of these happens keeps nothing.
- **Capture path.** Main spawns `sondine-audio read-voice --out <file>`
  (the helper's binary, as main spawns `serve`, so macOS credits
  Sondine.app for the microphone): it opens one microphone as the helper
  chooses it (the default input from the allowlist, else the built-in one;
  never Bluetooth on its own), writes 16 kHz PCM16, and prints a JSON line
  every 100 ms with how much it wrote and its RMS and peak. Main relays
  those numbers to core, never audio, and stops it by closing its stdin.
  It works while listening is paused and before `onboarding.complete`: it is
  an explicit, visible recording for this purpose only, and Sondine's own
  processes are never reported as listening (no dictation span).
- **Never a memory.** While the read records, core holds the helper's
  microphone paused whatever the listening intent (`Listening.holdMicrophone`),
  confirmed by the helper before the recorder starts; the stored intent never
  changes, and a core that dies mid-read gives the microphone back to the
  intent at its next connection. The read touches no spool, region, episode
  or transcript. While held, the menu bar shows the microphone paused,
  which it is. If the helper is away while the intent listens to the
  microphone, the read is refused (a helper with no client keeps capturing).
- **API.** One procedure per action, in the app only (no MCP):
  `voiceRead.start` (« Commencer »), `voiceRead.finish` (« Terminer »),
  `voiceRead.cancel` (« Annuler »), `voiceRead.forget` (« Oublier ma voix
  lue »), with `voiceRead.get` and `voiceRead.watch` for the status. The
  popover of a voice says what its confidence rests on: « d'après votre
  lecture », « d'après 5 voix nommées, votre lecture et 55 dictées »
  (`VoiceMatch.reads`).

## What changed after Codex Astra's review (2026-11-14)

Eight findings, all fixed, each with a test:

- A read is kept only under the consent it started with: the user's row and
  the last change of « Reconnaître les voix » are taken at « Commencer » and
  checked again in the transaction that stores it, so deleting the user,
  merging them, or turning recognition off and back on during the read
  keeps nothing (`voiceReadConsent`).
- « Annuler », « Oublier ma voix lue » and recognition turned off mark the
  read under way at once, before waiting for it, so an embedding already
  running keeps nothing; forgetting also stops a read under way.
- The microphone hold and a new connection's reconciliation share the
  listening lock, so a resume in flight cannot undo a hold.
- A hold asked while the helper is away is refused whatever the intent: a
  helper with no client keeps capturing as it was.
- Main kills the recorder when core dies: the next core gives the
  microphone back to the intent, and the read keeps nothing.
- Undoing or redoing a merge of the user gives the read back to whoever is
  the user.
- The recording ends on the wall clock too (the recorder at its limit plus
  2 s, core 10 s later): a microphone that stops delivering writes nothing
  and would never reach the limit.
- Leaving the screen while « Commencer » is on its way cancels the read.

## Not now

Exemplar clips (and re-embedding the read after an embedder change), a
read on the phone, a per-channel read (a call headset), a check that the
text was read rather than other speech, and asking for a new read when the
embedder changes.

## Consequences

- One migration (`voice_reads`), no new dependency, no network, and no
  helper protocol change: the recorder is a subcommand of `sondine-audio`,
  started per read, and the helper's own capture is held through the
  existing `pause` and `resume`.
- The always-on path is unchanged; the read costs one short process and
  one `sondine-voice` request when the user reads.
- Recognition from the first day means « Moi ? », or « Moi* » from 99 %
  (ADR 030, 2026-11-25); leaving « Qui est-ce ? » waits for
  confirmed voices on a second day, as ADR 030 wants.
- The energy gate is simple: in a loud room it keeps background noise as
  voice, which lowers the read's quality but cannot make a stranger the
  user; the 80 % gate still applies to every match.
