# 044 — Ending an ongoing episode by hand

Status: Accepted — 2026-11-25 (Téo: « une fois que j'ai fini de parler,
j'aimerais pouvoir lui dire manuellement que c'est fini et qu'il peut passer à
autre chose »). Builds on ADR 007, ADR 016 and ADR 017.

## Context

An episode closes on its own after a silence: 45 s in person, 120 s for media,
5 min in a call. A Discord channel kept open holds its exchange « En cours »,
untranscribed, for 5 minutes after the last word. A pause is no answer: it
changes what Sondine listens to.

## Decision

- « Terminer » (`episodes.end`) ends an open episode now. Nothing heard from
  that instant joins it: what is said next opens another episode, the call
  still on or not, however soon. A sentence being said is cut there. Listening
  does not change, and silence afterwards makes no episode. It is off MCP:
  agents change nothing in Sondine.
- **The end is an assertion**, kind `force_boundary`, which no grouping pass
  forgets. Its payload is the instant on the capture clock (computed once, from
  the latest clock reading of the boot, so every pass cuts at the same sample)
  and the lane: `in_person`, `call:<app>` (without the call's start, which a
  late event may move), `media:<source>` or `dictation:<app>`. Its anchor is
  the stretch of the episode's last speech: it says whose end it is whatever
  id the episode has, and while that speech is being grouped its lane is the
  ended one, whatever was learned since.
- **Only that lane is cut.** A video, a dictation or another call heard on the
  same tracks at that moment goes on. A region is cut when what was said of it
  before the end is in the lane, or when it would join the lane whole; each
  part then finds its own lane. `groupEpisodes` takes the ends apart from the
  split and merge constraints, before lanes are grouped. Without an end it
  gives what it gave: the version stays `grouping/6`.
- **Closing** waits for the audio, not for the gap: every open track imported
  3 s past the end. The helper closes a region only after 2.3 s of silence
  (its pre-roll and post-roll), so ending right after one's last word leaves
  that sentence whole, and what goes on after a cut is an episode only once it
  is surely speech. In practice 3 to 5 s. Core passes every 500 ms meanwhile;
  after a crash the next pass finishes it.
- **Meanwhile it is over for the user**: `EpisodeSummary.state` says `closed`,
  and what lists the ongoing (the sidebar, the voices of a call, the target of
  « Ajouter le presse-papiers ») leaves it out or ranks it last. The page shows
  what any finished episode shows; « Transcrire maintenant » waits for the
  close. Transcription keeps its rules, and live text stays.
- A closed episode may hold the first part of a region still open; the slice
  has its end. The region stays loaded, from the cut, while an open episode
  holds the rest.
- **Late regions.** An ended episode reaches to its end, not only to its last
  word: a region learned late before the end joins it, one said across is cut,
  one after never joins, unless the user merged the two since.
- **⌘Z** is not a capture (ADR 017): speech goes on arriving, and no print
  would match. The history keeps the end itself. Undoing deletes the assertion
  and, when the episode had closed, reopens it, so the next pass joins it with
  what was said since; when what followed is closed too, the two are merged,
  whatever was heard between them. What the gap would have separated stays
  apart. A transcript already there stays shown, and the episode is due again.
  Redoing puts the same assertion back, or splits the episode there if it has
  closed across it. An episode merged by hand, given a type, or whose audio
  is gone since refuses (« la conversation a changé depuis »).
- The button sits beside the « En cours » badge, and as a stop icon on the
  sidebar's card; ⇧⌘P names each recording going on. No confirmation (⌘Z) and
  no setting. The menu bar does not show the ongoing episode, so it does not
  end it.
- The anonymous report counts it (`episode_ended`): a feature's name, no new
  field and no new question (ADR 042). The Worker refuses a name it does not
  know, so `apps/stats` is deployed before a version that counts it is
  released.

## Consequences

- Deleting the ended episode in the seconds where its cut sentence still goes
  on loses the rest of that sentence: the importer drops a region a deletion
  meets while it is open.
- A late microphone region is repaired by its source, as before: between two
  calls held at once and both closed, it goes to the one it overlaps most.
- « Terminer » costs the passes one indexed query, and loading regions looks
  for the open episode holding each: 3.2 ms instead of 2.6 for 2,500 regions
  (a 6 h horizon full of speech). Capture and VAD are untouched.
