# 024 — Context added to a conversation

Status: Accepted — 2026-11-09

## Context

Téo (2026-11-09) wants to add context to a conversation: links, images,
text notes, and any file (PDF, documents, audio). He decided that every file
type counts, audio included; that agents (ADR 011) see all of it, images
included; and that a global shortcut adding the clipboard to the ongoing
conversation without opening Sondine comes in a second step, after the
conversation view.

The proposal he validated: paste (⌘V) or drop on a conversation, or « Ajouter
du contexte », and Sondine recognizes what it is (a link, an image, a note, a
file); a « Contexte » strip at the top of the conversation, and an item can be
pinned to a sentence with a small marker in the transcript; no link preview
ever loaded from the network (ADR 002); files copied into Sondine's protected
container (ADR 013); deleting the conversation, the pinned passage, or
« oublier les N dernières minutes » deletes what is attached, files included,
and nothing deleted leaves through an export or MCP; a conversation is found
by its notes, links and file names; agents see the context and the Markdown
export holds it.

After the first release (same day), Téo answered the open questions: an
attached audio file gets « Transcrire », which makes it an imported
recording (ADR 021) linked to the conversation and deleted with it; PDFs and
documents go to agents as they are (« la plupart des agents savent lire »),
with no text extraction; the global shortcut's key is left to this decision;
and the missing icons are taken from Nucleo (ADR 009).

The hard part is the anchor. An episode id is not stable: open episodes are
regrouped every 15 s and keep the id of the episode they share most regions
with, closed ones are split and merged, a passage can be deleted out of them.
User assertions already survive all of that by being anchored to capture
facts, `(track_run_id, sample)` (ADR 006), and the app in front follows its
speech region (ADR 022).

## Decision

### What an item is

- One row per item in `context_items`, of four kinds: `note` (text the user
  typed or pasted, at most 20,000 characters), `link` (an `http` or `https`
  address and an optional title the user typed), `image` and `file` (a file
  copied into the container). An image is a file Sondine can draw: PNG,
  JPEG, GIF, WebP, HEIC/HEIF, TIFF or BMP, recognized by its first bytes,
  never by its name.
- Pasted or dropped text is a link when it is one `http(s)` address and
  nothing else, otherwise a note. A file copied in Finder is a file; an
  image on the clipboard (a screenshot) is an image file; a link dragged
  from a browser is a link.

### The anchor

- Every item is anchored, like an assertion, to a point of captured audio:
  `track_run_id` and `anchor_sample`, inside one of the episode's member
  slices and outside every deletion's tombstone. The item belongs to the
  episode whose member slice holds that point; it is never stored with an
  episode id. A split, a merge, a reanalysis and ⌘Z move no item: they move
  slices, and the items follow the audio.
- **The whole conversation**: the point is the episode's first audio that no
  tombstone covers (a neighbour's deleted roll may cover its very start).
  After a split, the conversation-wide context stays with the part holding
  that audio, the first one; after a merge, both parts' context is together.
  The point is the first audio when the item was added: a late region
  repaired in front of it later does not move it.
- **Pinned to a sentence**: the item also keeps the sentence's span on its
  track (`span_start`, `span_end`), and its point is the span's middle,
  clamped into the member slice on that track that overlaps the span most
  (a sentence may start in the roll, outside every slice). The transcript
  shows the marker on the current sentence of that track that overlaps the
  span most, else the one nearest to the point, so a new transcript, a
  correction or a split sentence keeps it.
- **Adding** plans the anchor first (the episode, or the sentence of its
  current transcript), then copies the files, then writes the rows in one
  transaction that checks the anchor still holds: the same episode owns
  that audio and no tombstone reached it. An episode deleted meanwhile, or
  whose id came back as another episode, refuses the whole add, and the
  copied files are collected.
- **Settling**: after a grouping pass, a deletion or a passage deletion,
  every item of the episodes it touched whose point no episode holds any
  more, or that a tombstone now covers, moves to the first free audio of its
  episode (the same one when it still exists, else the one that now holds
  the first of its former regions), as the whole conversation's: its
  sentence is no longer there. This covers an open episode's region that
  later turns out to be Sondine's own playback (ADR 020) and leaves every
  episode. An item no episode can hold is deleted, and at each start core
  deletes any item whose audio no episode holds (an orphan).
- **Deletions**:
  - Deleting an episode (« Supprimer », a site left out, ADR 023, and every
    episode « oublier les N dernières minutes » reaches) deletes every item
    of that episode, read before its slices go.
  - Any deletion's tombstone deletes the pinned items whose span meets it,
    whatever episode they are in, as it deletes the segments there: the
    sentence they were pinned to is gone.
  - Deleting a passage that leaves the episode standing settles its items:
    the conversation keeps its context.
  - Imported recordings follow « Supprimer » and passage deletion as above;
    « oublier » leaves them alone (ADR 021), so their context stays with them.
  - An item's transcription (below) goes in the same transaction as the item
    when a deletion takes it, its audio scrubbed with the rest.
- An item is added to an open or closed episode, a call, a media episode,
  a dictation or an import alike.

### Files

- **Where**: `<data>/context/<sha256>`, named by the SHA-256 of their bytes,
  in the app group container (ADR 013). Two items holding the same bytes
  share one file. `<data>/context/previews/<sha256>.jpg|png` holds an
  image's preview; `<data>/context/staging/` holds files on their way in and
  is emptied at each start.
- **Sources**: a path the window gives (a drop, from the preload) or main
  gives (the open panel, the clipboard). Core follows it once through its
  links (`realpath`), takes only a regular file, and refuses anything inside
  Sondine's data directory, but the staging folder where main writes a
  pasted image (moved, not copied).
- **Copy**: core copies into staging with `COPYFILE_FICLONE_FORCE`, an APFS
  clone (no extra space, instant) when the file sits on the container's
  volume, and a plain copy otherwise. It checks the copy's size, syncs it,
  and hashes the copy (what Sondine keeps, not what the source became
  since). One file at a time.
- **One turn**: adds and collections run one after the other in core: an
  add renames its staged files to `<context>/<sha256>` (or drops them when
  those bytes are there already), syncs the folder, then writes its rows; a
  collection never runs in between, so it never removes a file an add is
  about to name. A refused write leaves files no row names, which the same
  turn collects. A crash leaves at most a staging file or a file no row
  names, both removed at the next start.
- **Limits**: 1 GiB per file, 20 files per gesture. A copy (not a clone)
  needs its size plus 512 MiB free on the volume, the margin imports keep
  (ADR 021). Over either, the file is refused with the reason; nothing else
  of the gesture is.
- **What is kept**: the bytes, their SHA-256 and size, the media type found
  in the first bytes (else from the extension, else
  `application/octet-stream`) and the file's name, made safe (no folder, no
  control character, at most 200 characters), never its path.
- **Images**: at add, core makes one preview with `sips` (macOS, offline,
  20 s at most): turned upright from a JPEG's EXIF orientation, at most
  1,568 px on the long side, JPEG at quality 80, or PNG when the image has
  transparency (a window screenshot's shadow); over 1 MiB, a JPEG of
  1,024 px at quality 70; over that again, none. Its metadata is stripped
  (a JPEG's APP1 to APP15 segments and comments: EXIF, XMP, IPTC, an iPhone
  photo's place and camera; a PNG's text, time and EXIF chunks). An image
  over 100 megapixels, or one `sips` cannot read, is kept as a file. The
  window draws the preview, and agents get it (below).
- **Shown in the window** through `sondine-media://context/<itemId>?v=<sha
  prefix>`: main relays the request to core like episode audio (architecture
  §11, `context-read`), core answers the preview's bytes by slices with its
  type (`image/jpeg` or `image/png`; main refuses audio there), only while
  the item exists and its file has that hash. `img-src` keeps `'self' data:`
  plus `sondine-media:`.
- **Opened**: a link opens in the default browser through main (`open-page`,
  http and https only, ADR 023), never in the window. A file or an image
  opens in its default app from a copy core clones into its own private
  temporary folder (`<tmp>/sondine-open-…/<name>`, `open-file`); main opens
  only a path there. Core removes the copy once no item holds its file (the
  item removed, its conversation deleted), at quit and at the next start.
  What another app already read cannot be called back, and changes made in
  that app stay in the copy.
- **Removal**: a file goes when no item and no ⌘Z step holds it: core
  collects after every change to the context, every deletion, whenever ⌘Z's
  history lets steps go (its limit, a new edit dropping what could be
  redone, a refused step, a deletion clearing it), and at start. The file is
  unlinked, its preview too. Sondine does not overwrite it first: APFS writes
  the new bytes elsewhere (copy on write, and a clone shares its blocks with
  the user's original), so zeroing would promise what it cannot; FileVault
  and the container's protection cover the freed blocks. The audio scrubber
  zeroes because an archive file holds other chunks too; a context file is
  whole or nothing.
- **Links** are never fetched: no title, icon or preview from the network.
  Sondine keeps the address and the title the user types, if any.
- **Logs** carry kinds, counts and problems, never a name, a path, an
  address or a note's words.

### Transcribing an audio file

- An audio file item (a type the import panel takes, or any `audio/*`)
  shows « Transcrire ». Core clones the stored bytes, under the user's file
  name, into the import staging folder and imports them as ADR 021 does:
  decoded, archived, one closed episode of context `imported`, queued with
  its voices as a user request. It shows in « Importés » like any import.
- The link is `context_items.transcript_run_id`, the imported recording's
  track run, written in the import's transaction, which refuses when the
  item was removed meanwhile or already has a transcription still there.
  The item then shows « Transcription », which opens that recording.
- **Deleted with the conversation**: whatever takes the item (« Supprimer »,
  a passage the item is pinned to, « oublier », a site left out, a grouping
  pass settling it away when its audio turns out to be Sondine's own
  playback, the orphan sweep at start) deletes the recordings no item links
  any more, in its transaction, as if the user deleted them, and scrubs
  their audio. « Retirer » the item
  only unlinks it: the transcription stays in « Importés » (a toast says
  so), and ⌘Z links it again. Deleting the recording from « Importés »
  leaves the item, which offers « Transcrire » again.
- An import running at core's start waits for retention's startup recovery
  before it writes its archive file (the recovery removes `.tmp` files).

### Search

- `context_fts` (FTS5, external content, the same tokenizer and `fr-norm`
  form as `segments_fts`, FTS5 `secure-delete` on) indexes each item's
  searchable text: a note's text; a link's title, host and path words; a
  file's name. Written and deleted with the rows, never by triggers.
- `searchEpisodes` finds an episode by its segments or its context: the
  episodes of both, the same filters (date, size, context), paged and
  counted together. A context match comes as `contextHits` (the item, its
  text, the ranges that matched). With « Pendant que j'étais dans… », context
  matches are left out: an item has no app in front.

### Agents (ADR 011)

- `get_episode` returns the episode's `context`: each item's id, kind, when it
  was added, the sentence it is pinned to (its time), a note's text, a link's
  address and title, a file's name, media type and size, and whether
  `get_context_item` can show it.
- `search_transcripts` returns the `contextHits` above.
- `get_episode` cuts a note at 2,000 characters for agents
  (`textTruncated`), so a few long notes never make a transcript too large to
  send; the window's preview addresses are left out.
- A new read-only tool, `get_context_item`, gives one item: an image as MCP
  image content (its preview, at most 1 MiB, sent apart from the 100,000
  characters a result's JSON may hold), a text file (a `text/*`, JSON or XML
  type, or one of unknown type, when it reads as UTF-8 without NUL) as its
  text up to 100,000 characters, a note whole, and a document (a PDF, RTF,
  Word, Excel, PowerPoint, Pages, Numbers or Keynote file) as it is, up to
  5 MiB, as an MCP embedded resource (`sondine://context/<id>`, its media
  type, base64) beside the JSON, which says `fileSentAs`. Agents that read
  PDFs read it; Sondine extracts no text. 5 MiB keeps the base64 (6.7 MiB)
  under the 8 MiB an agent's socket may leave unread. Any other file gives
  its name and type only: an image never goes but as its preview (no
  metadata), and bytes of unknown type that are not text never go (they may
  be audio Sondine does not recognize). A document goes with whatever it
  holds (a photo's EXIF inside a Word file): the user attached it for that.
  Audio and video never reach an agent, attached or recorded: an attached
  audio file the user transcribed carries `file.transcript.episodeId`, the
  imported recording `get_episode` reads. The log keeps the tool and the
  episode, never the content.
- Editing or removing an item, or a ⌘Z step over context, moves the content
  generation (an agent answer read before does not leave, ADR 011) and
  counts as a deletion for exports (`Status.deletions`): a transcript export
  waiting for its save panel is refused rather than leave with a removed
  item.

### Exports

- Markdown: a « Contexte » section after the title (notes quoted, links as
  Markdown links, images and files by name, type and size, pinned items with
  their sentence's time). Files' bytes never leave in an export: text only,
  as for transcripts.
- JSON: `sondine.transcript/2` and `sondine.day/2` add `context` to each
  transcript; `sondine.search/2` adds `contextHits`. The `/1` schemas were
  strict, so they could not gain a field. Subtitles carry no context.

### Undo (ADR 017)

- Adding, removing, editing a note or a link's title, and pinning or
  unpinning are window edits: ⌘Z undoes them, ⇧⌘Z redoes them. Every capture
  holds the items anchored in its window, so a split, a merge or a naming
  captured before an item was added refuses as « changed » until that item's
  step is undone, as for assertions.
- A removed item's file stays while a ⌘Z step holds it, so undo brings it
  back; quitting, a deletion (which forgets the history) or the history's
  limit lets it go.

### Window

- A « Contexte » strip under the conversation's header, shown when the
  conversation has context: images as thumbnails, links by their title or
  host, notes as short cards, files by name and size; a pinned item shows its
  sentence's offset in the recording (« 00:40 », as the transcript does),
  which scrolls to it, and « Détacher » on hover. Each item opens on click;
  on hover, a small bar on its top edge offers « Modifier » (notes and
  links) and « Retirer » (⌘Z brings it back), taking no room of its own.
- ⌘V outside a text field adds the clipboard to the conversation; dropping
  files or a link anywhere on the page adds them, and dropping on a sentence
  pins them there. « Ajouter du contexte » (a paperclip in the header) opens
  one field for a note or a link, « Choisir des fichiers… » (the Mac's open
  panel, through main), and one line on ⌃⌥⌘V. Each sentence's actions gain a
  paperclip, « Ajouter du contexte à cette phrase », which opens the same
  field pinned to it. Links show a link, files a document and images without
  a preview a picture; an audio file adds « Transcrire » or « Transcription »
  under its name.
- The transcript marks a sentence with context pinned to it with a pin; the
  marker scrolls to the item in the strip, and the item's pin shows the
  sentence's time.
- Four glyphs joined the Nucleo subset for this (64 of 100, ADR 009):
  paperclip, pin, file and image, generated from the licensed packages at
  the versions the script names.

### The global shortcut

- **⌃⌥⌘V** from any app adds what the clipboard holds (files copied in
  Finder, an image, a link or text, as ⌘V does) to the conversation going
  on: an open episode, else one that ended within 5 minutes; a call first,
  the latest heard first; never media, a dictation or an import. It is
  anchored as the whole conversation's, with origin `tray`. ⌘⇧V (paste and
  match style) and ⌥⌘V (Finder's move) were taken; ⌃⌥⌘V is rarely bound.
- Main registers it (Electron `globalShortcut`) and calls
  `context.pasteOngoing`; core picks the conversation and asks main for the
  clipboard as for ⌘V. When another app registered the key first, Electron
  leaves it to that app; the menu bar item « Ajouter le presse-papiers à la
  conversation », which shows the key, still works.
- **Feedback** without a window or a notification (no permission, nothing
  kept in Notification Center): the menu bar reads « Ajouté à la
  conversation », « Aucune conversation en cours », « Presse-papiers vide » or
  « Rien n'a été ajouté » next to its icon for 2.5 s, then shows again what
  it showed (a call's name). An open conversation's window shows the item at
  its next refresh.
- No setting: one fixed key, and nothing happens until it is pressed.

### Not in this release

- OCR or reading what an image shows (a non-goal of release 1), and any
  text taken from PDFs or office documents: agents get the file as it is,
  and search finds it by its name only.
- Context on Today's rows, the iPhone companion, editing a file, and
  choosing the shortcut's key.

## Review

Codex Astra (`gpt-6-astra`) reviewed the first draft (2026-11-09). Taken:
a removal or an edit refuses a pending export, not only an agent answer; an
add plans its anchor before copying and checks it in its transaction (an
episode id can come back as another episode); anchors avoid tombstones,
and items settle after grouping passes and deletions (a region that turns
out to be self-playback leaves every episode) with an orphan sweep at
start; one turn for adds and collections, the folder synced before the row;
collections when ⌘Z lets steps go, not only on deletions; open copies
removed with their item; bounded previews (one file at a time, a pixel
budget, a size budget, `sips` timed out) without metadata; MCP images
apart from the JSON budget and long notes cut in `get_episode`; sources
followed once and refused inside Sondine's data, opened copies only from
core's own folder, and logs without names or paths. Kept as decided: the
first audio as the conversation-wide anchor, with what it means after a
late repair stated above; a region in two episodes of different grouping
versions is allowed by the schema but not made by any path, and an item
there reads as the newest episode's.

Codex Astra then reviewed the code (2026-11-09); all six findings were
fixed: settling after a grouping pass treats an id the pass deleted or
created as gone (SQLite may reuse it for another conversation); items that
settling deletes count as a deletion (agents, exports, files); a preview
read and an open re-check the item after their I/O and refuse once it is
removed; previews wait in staging and are published in the add's turn, so a
collection never takes one; and a text file's text is cut to fit the whole
MCP result.

Codex Astra reviewed the second pass's code (2026-11-09); all four findings
were fixed: a grouping pass and the orphan sweep at start, not only the
user's deletions, take a settled-away item's transcription along and scrub
its audio; only known documents go to agents as they are, so an image whose
preview failed never leaves with its metadata and audio of a type Sondine
does not recognize never leaves at all; and documents are capped at 5 MiB
so one answer stays under what an agent's socket may leave unread.

## Consequences

- A context item outlives regrouping, splits, merges and reanalyses with no
  code in those paths; only deletions know about it.
- After a split, conversation-wide context sits with the first part only.
- Context added to a passage that is later deleted is gone with it; context
  of the whole conversation survives a passage deletion.
- A cloned file costs no disk until the user changes the original; a copied
  one costs its size, inside the container's backups exclusion.
