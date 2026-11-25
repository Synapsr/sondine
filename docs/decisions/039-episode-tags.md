# 039 — Tags on recordings, and a phone note read as a note

Status: Accepted — 2026-11-23 (Téo approved the draft reviewed by Codex
Astra, and asked for « Moi ? » to be confirmed on the iPhone too; the
half-day recap stays for later). Amends ADR 037 (the
voice-notes goal it set aside comes back as tags, not as a first-run goal)
and ADR 032 (how a phone recording of the user alone is labelled). Builds on
ADR 024 (the anchor), ADR 008 (the phone's outbox) and ADR 011 (agents).

## Context

On 2026-11-23 Téo recorded a voice note with the iPhone app. He wants to use
Sondine for voice notes, but not every note is for the same purpose. He asks
for tags on the Mac and on the iPhone, to sort recordings simply and find
them again, with content creation in mind: he wants to share more of what he
does, and an agent should be able to write from the notes he tagged
« idées ». He would also like a short spoken recap every half day.

What exists:

- Nothing for tags: no table, no filter, no field in the phone protocol.
- Context items (ADR 024) are anchored to captured audio, not to an episode
  id: the first sample of a member slice no tombstone covers, settled again
  when regrouping or a deleted passage displaces it, swept when their audio
  goes (`context-items.ts`). Regrouping, merges and reanalyses move nothing;
  a split leaves an item with the half that holds its anchor.
- The phone already changes Mac data offline: a note goes into its outbox
  with an operation id, the Mac answers `later` until it has imported the
  recording, and claims the id in the same transaction as the write
  (ADR 008, « Built at M5.3 »). The phone reads the result back in
  `PhoneResult`, whose revision is a hash of its JSON. Both sides refuse
  unknown keys, and `pair` and `hello` refuse another protocol version.
- Search (`search.query`) returns only episodes with a full-text match; its
  filters are period, size, context and the app in front. Agents get
  `list_episodes` (one day), `search_transcripts` and `get_episode`.
- Today's filter menu chooses which lanes a day shows (media, dictations),
  kept by core since `bfe366b`.
- Two recordings of one moment (the phone's and the Mac's, ADR 032 M5.7)
  are both listed; one of them feeds the journal, and the user can switch.

The same note shows two problems, read in the database on 2026-11-23:

- **Its voice reads « Voix 1 », not « Moi ».** The phone recording's only
  voice scores 0.83 against Téo's references (confidence 0.99997), but a
  phone voice is only ever suggested (« Moi ? ») while
  `PHONE_VOICES_MEASURED` is off: ADR 032 M5.8 found no named phone voice
  (`too-few`), and a voice compared with references heard another way stays
  a suggestion (ADR 030). The Mac's microphone heard the same moment and
  recognized him there (0.76, microphone against microphone). Rows show a
  person only when named or recognized, so the phone's row reads « Voix 1 ».
  This is the rule working as decided, on a channel with no labels yet.
- **It reads « En personne ».** A phone recording is always `in_person`
  (`audio-import.ts`): ADR 032 rejected a separate context because every
  rule that reads contexts (journal, references, commitments) would need it.
  Nothing says « Note ».
- The proper nouns came out wrong (the product's own name and two project names). The vocabulary
  (`vocabulary/2`) learns only from corrections, and none were made on these
  words. One correction in the transcript teaches each of them; that is not
  part of this decision.

## Decision

### What is tagged

- **A whole recording**, of any kind: conversation, moment, note, dictation,
  call, media, import. At most 20 tags per recording.
- **Free words, created by typing.** One canonical rule, the same in
  TypeScript and Swift with shared fixtures: Unicode NFC, control characters
  removed, spaces trimmed and collapsed, at most 40 characters (grapheme
  clusters) and 200 UTF-16 code units, not empty. Its key is that text case-folded and without
  diacritics: « Idées » and « idees » are one tag, the first spelling kept.
- **No colour, no icon, no hierarchy** (ADR 037: minimal text).
- **Rare actions further away**: rename (to an existing name merges the
  two), and delete (from every recording, after a confirmation saying how
  many). Both in « Gérer les tags… » at the end of Search's tag menu.

### Stored by core

- `tags (id, name, key UNIQUE, created_at_ms, used_at_ms)`: ids stay across
  renames; `used_at_ms` orders « recent ». A tag on no recording stays in
  the list until deleted, so a word typed once is offered again.
- `recording_tags (tag_id, track_run_id, anchor_sample, origin,
  created_at_ms)`, anchored exactly as a context item for the whole
  conversation, with the same code: the first free sample, settled when
  regrouping or a deleted passage displaces it, removed when the recording
  is deleted (by the user, retention, a private zone, « Oublier ») and swept
  with orphaned anchors. Reanalysis and audio-only retention keep it.
- **Merge and split follow the anchor**: a merge keeps both sets, shown
  once each (removing a tag removes every row of it in the episode); a split
  leaves the tags with the first half, as context. Nothing is copied, so
  split and merge undo (ADR 017) need no change. Phone recordings and
  imports are never split or merged.
- **A phone recording is tagged on its own track run**
  (`phone:<recordingId>`), so the phone can tag it before the Mac has it.
- **Two recordings of one moment keep their own tags.** Search lists the
  recording that carries the tag, whichever one feeds the journal; the
  other is one click away by « Aussi enregistré par… ».
- Every tag change, and a voice the phone names, moves `Status.changes`:
  windows read their recordings, searches and tags again.
- Adding or removing a tag undoes itself (one click back). Rename, merge
  and delete ask for confirmation and are not undone.

### Where it is tagged

- **Mac**: a tag button in the episode's header, beside « Ajouter du
  contexte ». It opens a popover: a field (« Ajouter un tag… ») and the
  tags, most recent first, ticked when on; typing filters them; the field's
  one action is shown as its last row: Return ticks the tag whose key
  matches, else « Créer « … » ». The episode's tags show as chips after its
  voices; a chip opens the search on that tag.
- **iPhone, after « Arrêter »**: no sheet. The new recording's row on Home
  shows the recent tags in one line under it, one tap each, and « + » for
  the full sheet; the line stays until the user leaves Home. Nothing to
  dismiss.
- **iPhone, on the recording's page**: its tags under the line of when and
  how long, and « + » for the sheet (recent tags, which scroll, and a
  field). Long names truncate; Dynamic Type grows the chips, which wrap.
- Both work offline.

### Where it is found

- **Search** gains a tag filter (one tag, a chip like the app filter,
  hidden until a tag exists). A tag with no text is its own query in core,
  over the recordings that carry it, filters applied before paging,
  distinct recordings counted: newest first, open and untranscribed
  recordings included, the first words when there is text. With text, it
  keeps the transcript and context matches of tagged recordings. The app
  filter keeps its meaning (sentences said while the app was in front), so
  it needs text. Results show tags in the line under the time
  (« Conversation · En personne · # idées »).
- **Today and the Calendar** do not filter by tag: their menu chooses lanes
  of a day, and a tag cuts across days. A tag is one click from any
  recording that has it.
- **Agents** (ADR 011): `get_episode`, `list_episodes` and
  `search_transcripts` return each recording's `tags`;
  `search_transcripts` accepts `tag`, with or without `q`, which browses a
  tag across days. `list_episodes` keeps its day. A tag is the user's word,
  data like a context note, never logged by name. Removing, renaming or
  deleting a tag moves the agents' content generation, so an answer read
  before is not sent after. Tools still change nothing.

### The phone

- **Operations, not sets**: each tap is an outbox operation `tag`
  (`operationId`, `recordingId`, `name`, `on`), written before anything it
  replaces is dropped; a later operation on the same recording and key
  replaces one still waiting. The Mac applies each by key, in order: an
  `on` for a name renamed or deleted since creates it again, which is what
  the user just asked. Answers as for a note (`later` until imported, `done`
  once claimed, `deleted`).
- **What the phone shows**: the Mac's `PhoneResult.tags` with the phone's
  waiting operations applied on top. The Mac's tags (names, most recent
  first, 50 at most) come from a new route, kept for offline use with the
  phone's own recents in front.
- **Versions**: version 2 adds the `tag` and `voice` operations, the
  `tags` route, `PhoneResult.tags` and `PhoneSpeaker.guessSelf`. Only
  pairing and `hello` say a version: the Mac accepts 1 or 2 there, answers
  `hello` in the phone's, and keeps it on the phone's row
  (`phone_devices.sync_version`), so its results carry the version 2 keys
  only to a phone that spoke 2; their revision hashes what is sent. The QR,
  the Bonjour record and the relay's first line keep their own version, 1,
  so a phone built before still finds and pairs with the Mac. A version 1
  phone keeps syncing without tags. A version 2 phone facing a version 1
  Mac is refused « version » and says to update the Mac, as today. Fixtures
  for both versions in `packages/protocol`, read by both sides' tests.

### Suggestions, later

When the day's journal (ADR 028) is written, the local text model could also
choose, for each conversation, up to two tags among those that exist (never
a new one). They would show in the popover as « idées ? », accepted in one
click, never applied without the user. It changes the journal's prompt and
output, so it is a versioned journal change, measured (quality, latency,
regeneration) like any other, in its own step after this one.

### The note itself

- **« Note »**: a recording the iPhone app made (a Sondine header, not an
  import), whose voices are all the user's, named or confirmed (not only
  suggested), reads « Note » in the header, Today's rows and search, in
  place of « En personne ». It is a label, not a context: the journal,
  references and commitments still read `in_person`, as ADR 032 decided.
  Until the transcript is done, it reads as today.
- **The voice**: Téo's answer keeps ADR 030 and 032 as they are: « Moi ? » on a
  phone recording is confirmed on the Mac as today (the voice's popover,
  « Oui »), and on the iPhone too (Téo, 2026-11-23: one more outbox
  operation, carrying one of the voice's sentences as the phone read them:
  a transcript made again since leaves the voice unnamed). Each
  confirmation is a labelled phone voice for the M5.8 measurement, which
  opens recognition on the phone when it passes.

### Not decided here

- A reminder every half day to record a recap (a local notification on the
  iPhone that opens « Enregistrer » with « récap » ready). It needs its own
  small decision on notifications.
- Typing « #idées » in the search field as a shortcut for the filter.

## Rejected

- **A « note » context.** ADR 032's reason holds: every rule that reads
  contexts would need it.
- **Recognizing the owner's single voice on their phone at 99 %** (proposed
  in the first draft): owning the phone and starting by hand do not say who
  speaks, and it would skip the measurement ADR 030 and 032 require
  (Codex Astra).
- **Tags by episode id.** Ids change on merge and split; the anchor does
  not (ADR 024).
- **Copying tags to both halves of a split**: it needs split undo to carry
  tags, for a rare case; and to the other recording of one moment: a later
  unlink would leave them wrong.
- **The phone sending a whole set**: a stale phone would undo tags added on
  the Mac meanwhile.
- **A sheet after every « Arrêter »**: one more thing to close each time.
- **Tags on a passage.** He asked to sort recordings; a passage already has
  context items.
- **A tag filter in Today's menu.** It would mix a day's lanes with a word
  that spans days.

## Consequences

- `packages/db`: two tables and a migration; the context anchor's code
  shared with tags; `EpisodeSummary` gains `tags`; a tag-browse query.
- `packages/api`: `tags.list`, `tags.set`, `tags.rename`, `tags.delete`;
  `SearchInput` takes `tag`, and `text` becomes optional with it.
- `packages/protocol`: version 2, the canonical tag rule with fixtures, the
  operation, `PhoneResult.tags`, the tags route, fixtures for both versions.
- `packages/ui`: one Nucleo glyph (`tag`, `IconTagFill18`), 69 of 100
  (ADR 009).
- Changelog notes on the Mac and the iPhone.
