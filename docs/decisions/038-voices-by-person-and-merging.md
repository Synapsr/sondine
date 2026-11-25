# 038 — An episode's voices by person, and merging two voices

Status: Accepted — 2026-11-19. Builds on ADR 025 (merging people) and ADR 030
(voice confidence); follows ADR 037's action levels.

## Context

On a long call (2026-11-19), diarization had numbered one
person twice, so the header showed two people's names twice each, each
with its own time. Téo asked whether that was worth keeping, wanted to click
a voice heard for one second to hear where it spoke, and asked for a way to
merge voices.

What existed:

- Naming two voices as one person already makes them one person
  everywhere; only the header showed one badge per voice.
- Linking (architecture §8, `voice_links`) merges voices of one transcript
  automatically when their embeddings are one person and their names agree.
  It runs once per transcript and renumbers the voices.
- Merging people (ADR 025) moves names between people, never voices.

Two unknown voices that are one person had no answer: the user could only
invent a name for both.

## Decision

- **One badge per person.** The header groups voices by who they read as:
  the user's (« Moi »), each person, and each voice nobody is known as. The
  badge adds up their speaking time. A voice the user named reads the badge
  before one Sondine only recognized. A person's voices stay visible in the
  badge's popover, one step further (« Voix 2 · 46 min »).
- **The popover is where a voice is heard and named.** « Écouter » plays its
  first passage; its passages are listed by their time into the recording
  and each plays from there. A guess asks Oui, Non or Modifier there; an
  unknown voice shows « Qui est-ce ? » there. The ✓ beside a guessed badge
  stays the one-click answer (ADR 037).
- **« Fusionner avec… »**, in an unnamed voice's popover, lists the other
  unnamed voices of the transcript. The one picked and this one are the same
  person: the voice that speaks later joins the one that speaks first, which
  keeps its label. The voices are numbered again 1, 2, 3…, as linking and
  publishing number them: keeping the old numbers was the first draft, but
  ⌘Z republishes the transcript, which numbers voices again, so ⇧⌘Z would
  then give other numbers than the merge did (Codex Astra). Two steps, no
  confirmation: ⌘Z undoes it (`voice-merge`, at the structure level, so the
  transcript comes back with each voice's sentences). Named voices are not
  offered: naming one as the other's person is the one way to join them.
- **A merge teaches nothing by itself.** Both voices lose their embedding and
  the transcript is embedded again, so the joined voice is matched from all
  its speech (up to 30 s); the other voices keep theirs meanwhile. A voice
  pass that read the voices before the merge stores nothing. No voice
  becomes a reference until the user names it (ADR 030), so merging two
  unknowns moves no one's centroid, recognizes no one, and leaves the
  calibration alone. Once the joined voice is named, it is one reference made
  of more speech, which is how the merge helps the model. Linking's
  thresholds are not tuned from merges either: a handful of hand merges is not
  a measurement.
- **Every voice answer shows at once.** Naming, « Non », unnaming and merging
  change the episode on screen before core answers (TanStack Query's cache),
  and come back as they were if core refuses; then the screens read again.

## Consequences

- No migration: a merge rewrites the run's labels as linking does
  (`mergeVoice` shares its join with `mergeVoices`).
- A merge belongs to its transcript: « Retranscrire » makes a new one whose
  voices are linked again from scratch, and a hand merge is not replayed on
  it. Names survive, as they are anchored to speech, not labels.
- A voice on a call's far side (the Mac's own sound) is never recognized for
  sure: at 99 % it reads « Marie* » and still waits in « Qui est-ce ? »
  (ADR 030, amended 2026-11-25).
