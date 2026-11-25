# 025 — Merging people, and call context

Status: Accepted — 2026-11-09 (merging people, and call context in the menu
bar and beside the notch); matching amended 2026-11-10 by ADR 030 (a
window is matched by its confidence against each person's centroid).

## Context

The product vision says « The user names, merges, and splits people ». Since
M3 the user names, renames and deletes people and says « Non » to a
suggestion, but two people who are one (« Marie » named in one conversation,
« Marie D. » in another, or « Ajouter une autre Marie ») stay two: two
voices in suggestions, which then stay quiet because neither is 0.10 ahead
of the other (ADR 018), and two pages.

A name never lives on a voice (ADR 006, architecture §8): it is `speaker_is`
assertions over a voice's speech, with a foreign key to `people`; « Non » is
`speaker_is_not`. Voice embeddings belong to a voice of a transcript
(`speaker_embeddings`, by run and label), not to a person: a person's voice
is the embeddings of the voices their name reaches, read when suggestions
are computed.

## Decision: merging people

- **« Fusionner avec… »** on a person's page lists the other people (a
  filter, the user marked « Moi »), and the one picked was this person all
  along: their conversations join this page, which keeps its name; the user
  stays the user whichever of the two it was (`people.merge`, `mergePeople`).
  No confirmation: ⌘Z undoes it.
- **What moves.** Every assertion naming the other person, revoked ones too,
  names this one (one `UPDATE` of `person_id`); the other row is deleted,
  with nothing left to cascade. Nothing about voices is copied or deleted:
  embeddings stay with their voices, so the person's voice is both voices
  from the next read, suggestions included, and a voice that was a tie
  between the two names (a later transcript joined two voices named apart)
  reads as the person.
- **« Est » wins over « n'est pas ».** « Non » to Marie on a voice later
  named Marie D. would say, once merged, that the voice both is and is not
  Marie. The merged person's active « Non » are cut around the speech named
  as them, and around earlier « Non » over the same samples (each sample is
  refused once, so a refusal counted per sample is not doubled); an anchor
  cut is revoked and its parts written again with its origin and date, as
  naming already does.
- **⌘Z (ADR 017).** A merge is reversible (it erases nothing), so it is in
  the history (`people-merge`, « Fusion des personnes annulée »). Its capture
  is a new level, `people`: both rows (name, `is_self`, creation date) and
  every assertion naming either of them, wherever it lies. Undo brings the
  other row back with its id; restoring people now restores `is_self` too,
  the row that stops being the user letting go first (one user at most).
  As for every step, anything changed since over those anchors refuses; so
  does linking having joined voices of a transcript there since (it joins
  voices once they read as one person, which undoing cannot part again). A
  merge redone while the merged-away person's page shows opens the one who
  stays.
- Agents read names: the merge bumps the content generation, so an answer
  read before it does not leave with the name that went (ADR 011). Agents
  never merge.

## Splitting

Not a separate action. A voice wrongly given a name is corrected where it
speaks: « Modifier » on its name opens « Qui est-ce ? », which gives it
another person, a new name, or « Retirer le nom », each undoable. Splitting
one name that covers two people is that gesture on each conversation of the
person's page. A merge done by mistake is undone with ⌘Z during the session;
after that, the same per-voice correction applies, since a merge keeps no
record of which name each anchor had.

The limit is the voice: where diarization or linking put two people under
one voice of a transcript, renaming it renames both, and nothing gives one
passage to another person. Saying who said a sentence was left out of M2;
it is the action to add if that happens often.

## Merging: consequences

- No migration: a merge only rewrites `person_id` and cuts « Non ».
- Two voices of one transcript named apart and merged stay two voices
  (« Marie » twice in the header); linking does not run again for a merge.
- Person ids are rowids, as after a deletion (ADR 017): an agent that kept
  the merged-away id gets « not found », or the next person created, who
  takes the freed id when it was the highest.

## Call context: context

Vision §8 and plan M4: during a call, once a known voice is recognized, the
last conversations with that person are one glance away, within 10 s of the
first recognized voice; a suggested match reads as one (« Marie ? »). Voices
are recognized only after a conversation: the voice pass embeds the voices of
published transcripts every minute, and a call has no final transcript until
it ends. Near-live text has no voices (ADR 019).

Measured on Téo's Mac (M5, 2026-11-09), `sondine-voice embed` as a fresh
process, model load and hash included: 3 s of speech in 0.10 s (wall and
CPU), 9 s in 0.24 s (0.20 s CPU), 30 s in 0.39 s, 110–117 MB peak for that
moment. A resident worker is not worth its memory.

## Decision: live identity, calls only

- **What is heard.** While a call span is active, only its far side: the
  call app's own tap, or `system:other` where its attribution names the call
  app (`farSideRegions`). Unattributed or other apps' sound and microphones
  are left out: the mic is the user and the room, and unattributed system
  sound may be music. Only speech of the current span: a region ending after
  it began, an open one starting after. Region bounds without roll, 0.25 s
  off each end, an open region up to its last imported commit, stretches of
  1 s or more, none touching a deleted range.
- **Which call.** The newest active span (`calls`, no end), with the newest
  open `call` episode that has speech since that span began (a closed region
  by its end, an open one by its start): another call's episode, still open
  minutes after it, stays out. The suggestions belong to the call span, so
  an episode cut at 3 h keeps them; they go when the span ends, and the
  conversations shown are those that began before it.
- **When.** Core follows the importer's commits and region writes, which
  carry call spans starting and ending (no timer, no wakeup of its own): one
  read of the active spans, 1.2 µs on Téo's database, finds no call. With one, nothing runs while « Reconnaître les voix » is off, the
  call's episode or its app is under a « do not identify » rule (the app's
  rule is read from the call itself, before an episode names it), or nobody
  is named with an embedded voice. Windows never share a sample: what one
  saw is consumed by samples per track run, so speech imported late or out
  of order, or an episode cut, never sends audio twice. A window comes with
  each 3 s of new far speech over the call's first 30 s, then with each
  30 s, of its latest 10 s (a voice joining a group call). One at a time.
- **Matching.** As any voice (ADR 030, which replaced the 0.70 cosine with
  the closest named voice): against the centroid of each person's named
  voices in other episodes, same embedder version; the far side is heard by
  the Mac, a channel not measured, so a window counts only at 99 %
  confidence, 0.10 ahead of the next, and never recognizes. The user competes: a window
  closest to their own voice (sidetone, echo on the far side) counts for no
  one. A person is suggested once **two windows** agree on them; people only
  add up during a call, at most four. The named voices are read once a
  minute at most (20 ms on Téo's data).
- **Kept in memory only.** Each embedding is dropped once matched; the
  suggestions live in core until the call ends. Nothing is written, so
  nothing is undone; a deletion, listening paused, recognition turned off or
  a rule set clears them, and a window read before that, or whose call ended
  meanwhile, is dropped. Renaming, merging or deleting a person shows again.
- **API, not agents.** `calls.context`, `calls.watch` (pushed) and
  `calls.dismiss`, all `mcp: null`: `Status` is the agent tool `get_status`,
  so call suggestions stay out of it, as `live.partial` does (ADR 019). Each
  person comes with their last three conversations before this call
  (episode summaries).
- **Logs** give each window's far speech so far, its speech, its embedding
  time and how long after the speech it answered, and when a call was
  recognized; never a name.

## Decision: where it shows (the menu bar and the notch)

Main follows `calls.watch` as it follows the status. While a call goes on
with someone suggested, the menu bar reads « Marie ? » next to Sondine's
icon, and its menu starts with « Marie ? » (her page), her last three
conversations (« Hier 18:30 · first words… », each opening in the window) and
« Masquer pour cet appel ». Nothing past the name shows until the user
clicks. It goes when the call ends.

Téo chose the menu bar (2026-11-09) among three options, and then asked for
the notch too, after Alcove (tryalcove.com):

1. **The menu bar**: one click to see the
   conversations, nothing over the call, no cost. The name shows in a shared
   full screen, and the menu bar hides in a full-screen call until the
   pointer reaches it.
2. **A floating panel**: « Marie ? » and her conversations at the top right,
   over every app, zero clicks. It covers part of the call, needs a second
   renderer while it shows, and past conversations would appear unasked:
   `setContentProtection` does not reliably hide a window from
   ScreenCaptureKit, so a shared screen may show them.
3. **A notification**: one line, silenced by Focus during calls, kept in
   Notification Center after the call, and it needs the permission.

Codex Astra (2026-11-09) picked the menu bar too. The context of a
conversation (ADR 024) can join each row later: the rows are episode
summaries.

## Decision: the notch, an island

(Since 2026-11-25 the island also holds the call itself, with its switch, for
the whole call, and cards: ADR 036.)

On a screen with a notch, the notch becomes an island during the call, in
the manner of Alcove. One black shape, hanging from the top of the screen
with concave corners, morphs between three states:

- **Compact**, all call long: her initial in a circle left of the notch, « ? »
  right of it, in two 32 pt wings within the menu bar's band.
- **Peek**: the island grows down by one line, « Marie ? ». For 4 s when
  someone is recognized.
- **Open**, the pointer resting 0.35 s on the island, or a click: her last
  conversations, the other people suggested with theirs, and « Masquer pour
  cet appel », the rows of the menu. A click on a row opens it in Sondine; a
  click elsewhere, or the pointer away for 0.6 s, closes it.

Opening on hover is the default, Téo's choice (2026-11-09): fewer clicks
weigh more for him than the risk that a pointer passing by shows past
conversations to a shared screen. « Ouvrir l'encoche au survol » in
Settings ▸ Voix turns it off: a click then opens it, and the pointer only
peeks (the name). The island is everything the menu bar shows, and where the
menu bar hides in a full-screen call, the island stays (it joins every Space
and full-screen app, above the menu bar, below the menus it opens). Its morph
is a spring of 0.36 s; content fades in from 0.96 scale (GUI.md); Reduce
Motion turns both off. Screens without a notch show nothing more: a fake notch
on a plain menu bar would cover app menus.

What changed from the first sketch, with Codex Astra's critique (2026-11-09):

- Wide wings with the name cover the menu bar's own items: on Téo's Mac the
  first status item sits 47 pt right of the notch. The wings hold only the
  initial and « ? » (32 pt); the name goes below the notch. On a fuller menu
  bar a wing may still cover the nearest item. Open, the island covers the
  menu bar beside the notch, as a menu covers what lies under it: the user
  opened it, and any click elsewhere closes it.
- Opening on hover can show conversations to a shared screen by accident.
  It stays the default, as Téo asked, with a setting for a click and a
  0.35 s rest so that a pointer crossing to the menu bar does not open it.
- `sharingType = .none` is not honored by ScreenCaptureKit: everything the
  island shows is treated as shareable, like the menu bar title.
- A window larger than the island would block clicks in its transparent
  parts. The window fits the island at rest, and holds the old and the new
  island only while one morphs into the other; every state is centred on the
  notch and hangs from the top, so resizing the window never moves it.
  (2026-11-25: the island's view keeps one size, centred in that window. While
  it followed the window, its middle moved with each morph: the left edge
  stayed and the island grew to the right, 45 pt off at the start.)

**Native, not a second Electron window.** Electron 45 knows nothing of the
notch: `NSScreen.auxiliaryTopLeftArea` and `auxiliaryTopRightArea` give its
place whatever the display's scaling, and only AppKit gives a panel that
never becomes key, never activates its app and acts on the first click. A
renderer would also cost several times the helper's 13 MB. So the island is
`sondine-notch`, an AppKit and SwiftUI helper in `Sondine Notch.app`: App
Sandbox and nothing else, no file, no network, no state restoration. It is
the one native piece that draws UI. It has no strings and no icons of its
own: main sends every word, translated (`callView`), and the initial is a
letter.

**Process.** Main starts it when a call view appears, writes one `show`
line per change on stdin (the setting comes with each, read by core with
the call: `calls.watch` carries it, and `calls.setNotch` refreshes it) (`packages/protocol/src/notch-messages.ts`, golden
fixtures read by both sides), and closes stdin when the view goes (the call
ends, is hidden, recognition or listening stops, core's stream ends): the
helper hides at once and exits, killed after 2 s if it has not; the next
helper starts only once it has gone. It never outlives main, whose end
closes its stdin. A view the wire refuses hides the island rather than leave
the last one up. Each `show` has a number; a click
names it, and main acts only on a click on the view it shows, for an id that
view holds. A helper that finds no notch says so and exits; main starts it
again when a display comes, goes or changes, including during that helper's
last moments. One that fails is not started
again until the next call. Main logs events and categories, never a name or
words.

## Call context: consequences

- Live identity is unproven on real calls: 3 s windows over call codecs, and
  the thresholds, were calibrated on microphone and room speech (ADR 030).
  Two agreeing windows at 99 % and the user as a competitor bound false
  suggestions; a calibration on recorded calls decides the thresholds, and
  whether calls may recognize (M4 exit).
- A call whose far side is only on the microphone (a phone on speaker) or
  whose sound is unattributed is never recognized.
- Cost during a call, from the measurements above: about 10 windows over
  the first 30 s of far speech (0.1 s CPU each), then two a minute of it
  (0.2 s each): about 15 s of CPU per hour of call with half of it far
  speech, in short-lived processes. Nothing without a call. S3 with a real
  call is not measured yet.
- The island, measured on Téo's Mac (15-inch MacBook Air, notch 185 ×
  33.5 pt): 13 MB of memory, shown 0.3 s after its start, no CPU and no
  wakeup at rest; it runs only while someone is recognized in a call. Its
  behaviour over full-screen calls, Stage Manager and a shared screen is not
  checked yet.
- `listPeople` now finds the transcripts a name reaches from each
  transcript's extent (8 ms instead of 0.6 s on 4,400 anchors), and the named
  voices are read with one resolution per transcript: People, `get_person`
  and suggestions get faster too.
