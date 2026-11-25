# 021 — Audio import

Status: Accepted — 2026-11-08; amended 2026-11-10 by
[ADR 032](032-phone-recordings.md) (release 2, not built): a file that
carries the iPhone app's header takes the same path and becomes a phone
recording, in Today, with its voices and the durations by type, instead of
an « import ».

## Context

Téo (2026-11-08), before the iPhone companion (M5): « j'aimerais ajouter une
étape où je peux importer des audios en mode projet ou contexte. […] le but
pour l'instant c'est juste de pouvoir importer un audio et le transcrire avec
diarization. » Recordings made elsewhere (a phone, another app, a meeting
someone shared) should get what Sondine's own recordings get: a transcript
with voices apart, playback, search, naming, exports. The iPhone companion's
first step is the same thing (ADR 008: « Mac import »), so this is its
groundwork. Projects or contexts to file imports under come later.

## Decision

- **Window.** A sidebar entry « Importés »: the imported recordings, newest
  import first (file name, when it was imported, length, transcription
  progress or why it waits, play), paged, and « Importer un audio… », which
  opens the Mac's panel on the formats Core Audio reads (m4a, mp3, wav, aiff,
  caf, aac, mp4, m4b, flac, and QuickTime: Voice Memos' `.qta`, `.mov`).
  Files dropped on the page, or copied in Finder and pasted (⌘V, outside a
  text field), are imported one after the other (`imports.add`): the
  preload finds a dropped file's path, main reads the pasted ones (the
  clipboard's `text/uri-list`), as the model import already takes a path.
  A row opens the usual recording screen. Imports stay out of Today (Today
  is what the Mac heard) and in search (context filter « Importé »).
- **Pick.** Core asks main for the panel (`pick-file`, shared with model
  files); that path never goes through the window.
- **Decode.** `afinfo` first: over 4 hours, or not enough room on the disk
  for the decoded file and the archive, is refused before any work.
  `afconvert` then writes a 16 kHz 16-bit WAV with the file's channels in a
  private staging folder of the data directory (emptied at each start); core
  averages the channels to mono.
- **Storage: archived audio, kept until deleted.** One closed track run of
  kind `phone` (a recording made away from this Mac's capture, as the
  companion's will be), track key `phone:<runId>`; its PCM in
  `archive/imports/<runId>/0001.pcm`, written as `.tmp`, synced, then renamed
  under retention's lock; 2 s chunks with their CRC, `archived`, whose spool
  file row (`expired`) names the mirrored spool path so archive recovery
  keeps the file. Retention never expires it; deleting the recording scrubs
  it like captured audio. A crash leaves at most a `.tmp` or an unnamed
  archive file, which startup recovery removes, and the staging folder.
- **One episode, no grouping.** One speech region over the whole file and,
  in the same transaction, one closed episode holding it: context `imported`
  (episodes CHECK rebuilt), label the file's name, size from the size table
  with the whole span voiced, and a job queued as a user request: Nemotron
  with speakers, without waiting for power or idle (memory and heat still
  count). Its start is the file's modification time minus its length, or
  now minus its length when that is not plausible; when it was imported is
  the episode's creation time.
- **Kept whole and apart.**
  - « Oublier les N dernières minutes » and its wall-clock tombstones leave
    imported recordings alone; deleting the recording or a passage of it
    works as for any recording.
  - No split, no merge, no change of kind: the database refuses them and the
    window hides them. A split would cut through 2 s audio blocks, so
    deleting one side would take the other's edge.
  - No voice embeddings kept: imports hold third parties (others' meetings,
    podcasts) the user never chose to recognise. Those made to link one
    person's voices across the file's 55-minute requests are dropped once
    linked (architecture §8). Naming voices by hand stays possible. No « Moi » guess either: an imported file may not hold the
    user.

## Not now

Projects or contexts to file imports under; speech regions inside a file
(the whole file is sent and played); a recording time the user confirms.
