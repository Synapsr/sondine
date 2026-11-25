# 028 — Daily journal and commitments

Status: Accepted — 2026-11-09 (the model: interim, chosen on two of Téo's days).
Amended 2026-11-10: what a commitment is, sorted by kind (`journal-prompt/2`),
what « Aujourd'hui » lists (§ "Commitments, measured on Téo's days"), and who
writes it: the Mac, the Mac read again by the user's Claude, or their Claude
(§ "Who writes it"). Amended 2026-11-25: the memory its model asks for.

## Context

`plan.md` "Later" item 4, which Téo started on 2026-11-09: a daily journal
and a list of commitments written by a local language model, each line
citing its transcript span.

- **Journal of the day**: what happened, with whom, the topics, the
  decisions. Every line cites the passage it rests on; a click opens it at
  that moment.
- **Commitments**: « je t'envoie ça demain », « on se rappelle jeudi »: who
  committed, to whom, by when. Each cites its sentence.
- The vision forbids « summaries presented as facts »: generated text cites
  its spans. A deleted passage makes what cites it disappear or regenerate,
  as exports and MCP never return deleted content (ADR 011, 024).
- Téo's corrections (a commitment done or wrong, a line corrected) are
  assertions that survive regeneration (ADR 006).
- Agents may read the journal and commitments.
- The model runs only through the transcription scheduler and its admission
  rules (power, idle, memory), never beside Nemotron (17 GB on a 32 GB Mac).
- Its download is started by Téo (ADR 002), pinned by sha256.
- Later, Téo may choose « use my subscription » (Claude, ChatGPT, ADR 027)
  instead of the local model, with his consent since text then leaves the Mac.

## Decision

### Engine contract (`textgen`, ADR 005)

- `packages/engines` gains the `textgen` stage and `TextEngine`. It shares
  with `AsrEngine` a `ResidentEngine` lifecycle (manifest, resources,
  `state`, `pid`, `load`, `unload` resolving once the process is gone) and
  adds `generate(request, { signal, onProgress })`: instructions, the
  content, the JSON schema the answer must follow, an output limit. The
  result carries the text, `stop` (`complete` or `length`), provenance and
  token and time metrics.
- `TextCapabilities.locality` is `device` (the text never leaves the Mac) or
  `provider` (a service the user signed into, ADR 027). The journal runs on
  the `device` engine unless the user chose their Claude (§ "Who writes
  it"), through the Claude adapter (`assistants/claude-text.ts`: one `claude
  -p` per request, ADR 027's flags, the request's schema as
  `--json-schema`, any tool but the schema's stops it).
- **Runtime**: llama.cpp's `llama-server`, release `b12233`, pinned like
  speech.cpp: the archive by size and sha256, then the server and each of the
  ten libraries it loads from its own folder (`@loader_path`) by its own
  sha256, MIT. It ships as `Contents/Helpers/Sondine Text.app`
  (`app.sondine.text`): App Sandbox, the read-only models exception, no
  network, no application group, so it never sees the database or the audio,
  only the text core sends it. Each library is signed, then the app.
- **Transport**: HTTP on a Unix socket, never a TCP port. A sandboxed app may
  write only in its container, so the server listens in
  `~/Library/Containers/app.sondine.text/Data/tmp/sondine-text.sock`, which
  only this user can reach (mode `srwxr-xr-x`: connecting needs write
  permission). Development builds use `$TMPDIR/sondine-text-dev.sock`. The
  server leaves its socket file when it exits, so core removes a stale one
  before each start. Checked on Téo's Mac (2026-11-10) with the signed,
  sandboxed server: it binds in its container and loads the model from the
  models folder (healthy in 3 s), and an app of Sondine's team started by
  LaunchServices, as Sondine is, connects to that socket and removes it,
  where other apps are refused (macOS protects a sandboxed app's
  container). Core waits for `/health`, then posts `/v1/chat/completions` with
  `response_format: json_schema` (the server turns the schema into a
  grammar) and streams the answer, so a cancel closes the connection. Options:
  `--no-webui`, one slot, all layers on the GPU, flash attention, no prompt
  cache kept between requests, reasoning off, a 16,384-token context.
  `-hf`, `--connect` and every download option are never passed, and the
  environment holds only `PATH`, `HOME` and `TMPDIR`.
- **Lifecycle**: unload is SIGTERM, SIGKILL 12 s later, and resolves on the
  exit. Before a spawn, no other process may run our server (else
  `worker_running`). At core's start every process running it is stopped,
  as for speech workers; a survivor blocks the queue until the next launch
  (ADR 016 "Restart").

### The model

- Qwen3.5 9B Instruct, Q4_K_M GGUF (Unsloth's conversion, 5.7 GB, Apache
  2.0), chosen against Gemma 4 E4B and Ministral 3 14B Instruct, all Apache
  2.0 (ADR 005 license gate; Gemma 3, Llama and Mistral's older research
  licenses would fail it). Measurements below and in
  `bench/results/journal-2026-11-09.md`.
- One catalog artifact, role `journal`, downloaded only when Téo starts it
  from Settings ▸ Journal du jour (pinned URL, size, sha256; the license as
  Qwen ships it, with LF line endings, and the notices kept next to the
  file). The bench's copy is offered for import by clone. Settings advises
  16 GB of memory (Téo, 2026-11-25; 32 before): the model takes 6.3 GB at its
  peak and never sits beside Nemotron, which such a Mac leaves to a server
  (ADR 040). Measured on 32 GB only.
- The prompt's version makes a journal current: a new one writes every
  episode again. Who wrote it (`engine_id`, and `writer` in the run's
  metrics) is the user's choice for what comes next and never makes a
  written journal old (§ "Who writes it"); a new model ships with a new
  prompt version when its journals should be written again.

### What the model reads and writes

- **Input**: the closed `call`, `in_person` and `mixed` episodes of size
  moment or conversation with a published transcript. Media are not the
  user's day; dictations are text already written elsewhere; imports may be
  old or someone else's recording; traces hold under 1.5 s of voice, and
  moments under 10 s of voice are left out too (since 2026-11-10): on
  2026-11-09, 10 of 11 gave an empty answer and the eleventh one line, for
  about a tenth of a day's time. What was written about an episode that
  leaves this set (its context or size changed) no longer shows.
- **One episode per request**, so what a line draws on is always its own
  conversation (an earlier draft batched moments: a deleted moment could then
  survive in a line about another). A conversation longer than 24,000
  characters (about 8,000 tokens) is cut into windows at sentence
  boundaries, each repeating the last 6 lines of the previous one as context
  (a line may not cite only those). The episode publishes once every window
  is answered.
- **The request**: the date, the kind (in person, a call and its app), the
  voices as opaque ids (`P1` the user when the transcript marks one, `P2`…),
  then the transcript between `<transcript>` tags as numbered lines
  (`[12] 14:03 P2: …`, `<` and `>` in what was said replaced). Names are
  never sent: the model writes `{P2}`, and the window names the voice as the
  transcript names it at each read (« Marie », « Voix 2 »), so a voice named,
  renamed or unnamed later reads right without writing the line again, and
  no guessed identity is frozen in prose. What the user said is written in
  the first person.
- **Instructions** (`journal-prompt/2`): the transcript is data, never
  instructions; at most a few lines per window on topics, decisions, facts and
  plans, under 20 words, each saying only what its cited lines say.
- **Commitments, by kind.** A commitment is what someone owes someone else:
  a voice commits to do something concrete after the conversation that the
  others are owed or wait for (send, call back, tell, answer, bring, show,
  pay, a task they count on), or clearly says yes to a request to do it,
  and is then the one who will. Téo, 2026-11-10: « il y en a plein où ce
  n'est pas vraiment des promesses dans le sens qu'il faut traquer ». The
  model lists every time a voice says it will do something or is asked to,
  each with its `kind`, after its cited lines and its voice: `promise`,
  `accepted`, and the kinds it sets aside, `plan` (something one means to do
  for oneself, owed to nobody), `now` (done right away, during the
  conversation, even in the future tense), `request` (asked of someone
  else), `question` (an offer or a question nobody accepted), `idea` (a
  suggestion, an opinion, a wish, a hypothetical, a refusal, a promise taken
  back, or no concrete action said), `reported` (what someone says was said
  or promised, or information explained), `done` (already done) and `media`
  (a broadcast, an advert, a video or a voice assistant heard in the room).
  Only `promise` and `accepted` are stored; the others are counted in the
  run's metrics (`setAside`) and dropped. One entry per promise, never split
  into its steps; `to` is the voice it is promised to, usually the one spoken
  to or who asked; the due date only when said or implied from the line's
  date, and the words that gave it. The instructions' examples are generic
  phrases, with no name or content from Téo's transcripts (the code would
  hold his words, and the measurement would flatter itself).
- **The schema** bounds everything: line numbers within the window, voices
  within the list, kinds within the list, at most 12 lines and 12
  commitment entries, text lengths, a date pattern. Temperature 0, seed 0.
- **Validation** before anything is stored: the answer must be complete
  (`length` fails the pass) and parse; every cited line must exist (one bad
  number drops the item, never repaired); a `{X}` must be a listed voice;
  a date must be a real one; exact duplicates go; an item citing only the
  context lines goes; a commitment whose action is a verb and generic words
  only (« faire quelque chose », « faire des trucs ») goes.
  Items cite segment ids.

### Storage

- `journal_runs`: one pass over one episode's transcript (its `asr` run, the
  hash of what the model read, the configuration, provenance, metrics, the
  voice refs, status `running`, `published`, `failed`, `cancelled`,
  `abandoned`). The row is written before the model runs, so a crash leaves
  an attempt to abandon at the next start, never one counted as failed.
- `journal_items` (`event` or `commitment`, text with `{P2}` voices,
  `who`/`to` refs, due date and words, time of the first cited sentence) and
  `journal_citations` (item, segment id, order). Item ids are never reused
  (`AUTOINCREMENT`): a window still showing a replaced line cannot reach its
  successor.
- **Publishing** is one transaction: the attempt is still running, the
  episode's current transcript is still the one read and hashes the same
  (sentences, voices, times, words), every citation is one of its sentences;
  then the older runs of the episode go with their items.
- **Deleting** is the database's own rule, so no path can forget it:
  - `BEFORE DELETE ON segments` deletes every journal run of the sentence's
    episode, and their items and citations. Every path that removes text
    removes segments (a recording, a passage, « oublier », a site left out, a
    retranscription retiring its run, a split or merge republishing), in its
    own transaction, with `secure_delete` on, so a generated line never
    outlives a sentence of its conversation, cited or not.
  - `BEFORE UPDATE OF episode_id, run_id ON segments` does the same.
  - `AFTER UPDATE` of a sentence's text, voice or times (a correction, voices
    linked) marks the episode's runs `stale`: still shown, written again.
  - `AFTER INSERT ON deleted_ranges` deletes the user's marks whose cited
    audio the tombstone meets, with `findDeletedRanges`' rules.
  - The triggers are created at every open of the database, after the
    migrations: drizzle-kit rebuilds a table to alter it, which drops its
    triggers (the search migration says so for FTS). A test drops one and
    reopens. ADR 024 kept FTS maintenance out of triggers; a deletion
    invariant every present and future path must keep belongs in the
    database.
  - The episode's transcript is then republished (passage deletion) or
    replaced, or the episode is gone: the queue writes what is left.

### Téo's word: marks

- « Fait », « Pas un engagement », « Pas juste » (a line), « Modifier » (a
  corrected text; empty gives the model's back) and a corrected date are
  `journal_marks`: the status, the user's text and date, the model's text
  when the mark was made, and the conversation's wall span. They are
  anchored to the audio of every sentence the item cited
  (`journal_mark_spans`: track run, samples, wall time), never to the item.
- At each read a mark goes to at most one item: same kind, a cited sentence
  over its audio, and the closest words (word overlap at least 0.3), greedily
  from the closest pair; marks are looked for two days around the range, so
  a conversation across midnight keeps them. A mark whose line the model no
  longer writes shows on its own with the sentences now over its audio,
  unless it said the line was wrong. A mark back to the model's line (open,
  no text, no date) is deleted.
- A word on a line goes to the mark it already has (another window, a quick
  second click), and is refused when the line is gone since the window read
  it or no longer goes with the mark the window shows.
- A mark's texts may quote what was said: any tombstone over any of its
  spans deletes it, and a tombstone anywhere in its conversation empties the
  model's words it kept, which may draw on a sentence they do not cite. A
  mark left so goes only to the one item of its kind over its audio, and
  shows on its own only with the user's own words.
- Marks are not ⌘Z steps (ADR 017): « Annuler » in the toast after « Pas un
  engagement » or « Pas juste » brings the line back, and the checkbox
  undoes « Fait ».

### Who writes it (2026-11-10)

Téo, measuring Claude Haiku on his days: whoever uses their subscription
chooses what leaves, as long as local choices remain; he will try each for
a few days. Settings ▸ Journal du jour, « Qui écrit le journal »:

- **« Ce Mac »** (by default): the model on the Mac; nothing leaves.
- **« Ce Mac, relu par Claude »**: the Mac's model writes; then the user's
  Claude reads each commitment again with the lines around it (8 before the
  first cited, 4 after) and answers five plain questions (who says it will
  be done, whether it is said, asked or suggested, when, whether someone
  else is owed it, whether it is the conversation). Any reason drops it.
  Only those excerpts leave.
- **« Claude »**: the user's Claude writes the journal with the same
  requests, then reads its commitments again; only what it calls done
  during the conversation, done before, or heard from a broadcast drops.
  Every transcribed conversation leaves.
- The rules are the ones measured (`bench/results/commitments-2026-11-10.md`):
  read again, Qwen's commitments were right 68 % of the time (53 % recall);
  Claude's own 51 % (80 % recall), against 50 % (64 %) for the Mac alone.
- Choosing a Claude writer opens a dialog that says what leaves (the
  excerpts, or every conversation, other people's voices included), with
  which account, and that what is sent cannot be called back, even by
  deleting the conversation later. Back to « Ce Mac » at any time. The
  section shows who is signed in to Claude Code, and what keeps it from
  answering.
- The user's Claude is their `claude` CLI (ADR 027's locator and flags), the
  model `haiku`, in an empty private folder outside the app's container;
  ADR 027's tripwire holds (any tool but the schema's stops the request).
  Codex is not offered: its built-in tools cannot be turned off.
- Claude holds no memory here and loads nothing: the scheduler admits it as
  any journal pass (after transcription, on power and idle unless asked),
  its peak 0. When it does not answer (not installed, signed out, offline,
  its limits), the pass is cancelled, never counted against the
  conversation, and the journal waits 10 minutes; the Journal view says so,
  and « Écrire maintenant » asks again.
- Changing the writer writes nothing again. « Réécrire ce jour », once a day
  is written, writes it again by whoever writes now (Téo: « pouvoir relancer
  1 jour »), so two days, or the same day twice, can be compared. The
  user's marks hold as for any rewrite.
- Agents are told the journal comes from the Mac's model or the user's own
  Claude. Sondine's deletion rules apply to what it stores; what reached
  Anthropic is out of its hands, as the dialog says.

### Scheduling

- No row in `jobs` (whose kind is a CHECK enum a migration would have to
  rebuild): the queue is derived. An episode needs its journal while it is
  eligible and has no published, not stale run with the current
  configuration, and fewer than 3 failed passes on its current transcript.
  Newest first; a day the user asked for (« Écrire maintenant », kept in
  memory) first.
- The analysis scheduler runs it on its single loop. Order: a transcription
  the user asked for, then a journal the user asked for, then automatic
  transcription, then the automatic journal, which runs only once no
  transcription can.
- **Admission** is ADR 016's, unchanged: `admit()` with the text model's
  measured peak, warm or cold, swap baseline after a load, the user's
  « why it waits » switches. A user request skips idle and power. Every
  10 s during a pass, any refusal stops it at once (a pass is seconds to a
  minute, and its progress gives no reliable time left) and the model
  unloads; memory refusals defer the next load as for transcription. A
  cancelled pass is not a failure.
- When transcription is refused for memory or swap room alone, an automatic
  journal is admitted on its own, smaller peak: the 17 GB model may not fit
  where the 6 GB one does.
- **One heavy model**: an engine of 4 GB or more is never loaded while
  another one is. Before loading the text model the scheduler unloads
  Nemotron, and the other way round, and checks each one's process is gone;
  if one is not, nothing loads. Parakeet (1.3 GB, near-live text and
  dictations) stays. The text model unloads 90 s after its last pass.
- A model that fails to load is not tried again for 10 minutes. A
  transcript without words is published empty, without the model. A
  publication refused (what the pass read changed) counts as a failure, so
  a refusal that comes back every time ends after three.

### Reading it

- `journal.day({ day })`: the day's lines by conversation and its
  commitments, each line with its voices, its citations (episode, segment,
  time, speaker, the sentence's current text) and the user's mark; and the
  state (installed, enabled, language, pending, failed, writing, asked).
- `journal.commitments({ status, beforeMs, days })`: commitments across days,
  newest first, by pages of `days` (30 by default): age is a filter, never a
  limit.
- `journal.mark`, `journal.request` (« Écrire maintenant »),
  `journal.settings` (on or off, and the language new lines are written in:
  the window's, set when it differs): window only, `mcp: null`.
- **Agents** (ADR 011): `get_journal` and `list_commitments` in
  `AGENT_TOOLS`, read-only. Their descriptions say the lines are generated
  interpretations to check against their citations, and which words are the
  user's. A mark moves the content generation, so an answer read before it
  does not leave. The call log keeps the tool, the day and a count.

### Window

- A Journal view (`/journal`, « Journal » in the sidebar while the journal
  is on, and in ⇧⌘P), one day at a time with the previous and next days
  (Téo's choice, 2026-11-10, over a block on Today): « Engagements », then
  « Ce qui s'est passé », the day's lines by conversation (its time links to
  it). On today, « Engagements » lists the open ones the user made or that
  were made to them (their voice named as them, or taken for them,
  recognized ✦ or to confirm « Moi ? », ADR 030), made in the last 7 days
  when they have no date, else due no more than 7 days ago (a date decides:
  late by more than a week folds, due later stays), a line the user corrected and their word
  standing alone included; then two folded lines, « 7 entre d'autres
  personnes » and « 4 plus anciens », over the rest of the last 30 days
  (Téo's choice, 2026-11-10, against one list that only grew). A past day
  shows that day's own, all of them. Today keeps one line above its
  timeline, « 3 engagements ouverts · 1 en retard », counting the first
  list, to the view, and nothing while it is empty. Agents read every
  commitment, as before. Each line ends
  with the time of the sentence it cites: hovering shows the cited
  sentences with their time and voice, a click opens the conversation
  there. A commitment has a checkbox
  (« Fait »), its people (« à Marie », « Marie → moi ») and its date (past in
  red); « Modifier », « Changer l'échéance » and « Pas un engagement » (a
  line: « Modifier » and « Pas juste ») show on hover or focus.
- When the day still has conversations to write: « 3 conversations à
  écrire » and « Écrire maintenant ». Without the model, or switched off:
  one line and a link to Settings.
- Settings ▸ Journal du jour: the switch (on by default), what it does and
  that nothing leaves the Mac, and the model.

## Measurements

Téo's Mac (MacBook Air M5, 32 GB, macOS 27.2), on battery, llama.cpp
`b12233`, 16,384-token context, the product's requests (`sondine-bench
journal`). Sample: all of 2026-11-09 (26 episodes, a long call among them) and the conversations of 2026-11-07 (21), plus 10 synthetic
conversations (promises plain, hypothetical, refused, taken back, asked and
not accepted, past; an instruction spoken at the model; English;
code-switching; small talk). Quality judged by reading every commitment and
a sample of lines against their cited sentences.

| Model           | Fixtures | Commitments right | Per episode | Resident |
| --------------- | -------- | ----------------- | ----------- | -------- |
| Qwen3.5 9B      | 9/10     | 58 %              | 20 s        | 6.1 GiB  |
| Gemma 4 E4B     | 6/10     | 39 %              | 13 s        | 5.2 GiB  |
| Ministral 3 14B | 8/10     | 30 %              | 39 s        | 10.2 GiB |

Each model found about 6 in 10 of the real commitments any of them found.
Gemma wrote the promise an instruction in the transcript asked for;
Ministral invented seven commitments on one conversation. Every answer of
every model parsed and cited only lines of its window. The tightened
commitment instructions (`journal-prompt/1`) took Qwen from 72 % to 83 %
right on 2026-11-09 with the same recall. Qwen's journal lines were
supported by their citations about 9 times in 10. The whole Mac drew about
9 W more while Qwen wrote, 2.9 Wh for 47 episodes. Details and caveats
(battery, one judge, a small sample) in
`bench/results/journal-2026-11-09.md`.

## Commitments, measured on Téo's days

Téo, 2026-11-10: « j'ai énormément de faux engagements ». Of the 87
commitments `journal-prompt/1` had written in six days, about three in four
were not ones: things done right away, a radio or a video, a plan for
oneself, a request credited to the one who asked, suggestions, questions; one
sentence cut into three, the same promise twice; « faire quelque chose ».
And « Aujourd'hui » showed all 85 open ones, nothing ever ticked, other
people's promises among them.

Measured on 48 of his episodes (`bench/results/commitments-2026-11-10.md`,
labels and transcripts outside the repository), a commitment being what
someone owes someone else:

| Prompt             | Written | Right | Precision | Recall | Téo's list, right |
| ------------------ | ------- | ----- | --------- | ------ | ----------------- |
| `journal-prompt/1` | 87      | 22.5  | 26 %      | 70 %   | 14.5 of 40 (36 %) |
| `journal-prompt/2` | 41      | 20.5  | 50 %      | 64 %   | 15 of 24 (63 %)   |

Two real commitments of 32 are lost overall, none of Téo's own. The set is
also the one the prompt was written against: the numbers are optimistic,
and the rewrite of his other days is the held-out check. A list of
exclusions, and a second reading by the model, measured worse or not enough
for their cost (the report says how much). The cost stays about the same:
output tokens unchanged, a few seconds a window more for the longer
instructions.

Claude Haiku on Téo's subscription, measured the same way with his
agreement (the user who chooses it knows what leaves, as long as local
choices remain): alone, 40 % precision and 81 % recall, in a third of
Qwen's time; then its own check dropping what is done during the
conversation, 51 % and 80 %; or Qwen then Haiku's check on excerpts only,
68 % and 53 %, 80 % on Téo's list. Both are offered beside the Mac alone
(§ "Who writes it"); Téo will try them for a few days each before choosing.

What is heard without being a conversation of Téo's (a radio in the room, a
video on a phone, a voice assistant) came in through the microphone, like
him: no channel tells it apart, and the Mac's own media already has its
track and stays out (ADR 026). Nothing is inferred about those voices (ADR
004). Two things act on them without a guess: the model may set lines aside
as `media` (its reading, never stored as a fact about a voice, and only ever
removing a candidate); and « Aujourd'hui » lists first what Téo promised or
was promised, so strangers' promises to each other fold away. A test that
would need evidence (the same voice heard in many episodes as a show, an
audio model telling synthetic speech) waits for a reason to build it.

## Review

Codex Astra (`gpt-6-astra`) reviewed the first draft (2026-11-09), 19
findings. Taken: one episode per request, and any change to an episode's
sentences invalidates all of its journal, cited or not (batching let a
deleted moment survive in another's line); publication fenced by the hash of
everything read, not the run id (a correction changes text in place, a
neighbour's deletion removes sentences without a new run); marks anchored
to every cited sentence's audio and deleted by any tombstone over one, and
refused for an item gone since the window read it; a mark goes to at most
one item, by overlap and closest words, never only by overlap; marks move
the agents' content generation; a long conversation publishes once all its
windows are answered; voices as opaque ids, named at read, no names in the
prompt or the prose; the transcript as delimited data, every citation
checked, MCP descriptions saying the lines are interpretations, injection,
negation and hypothetical fixtures in the bench; heavy-model exclusion that
checks the process is gone; the admission state machine reused, not
paraphrased; a pinned context size and a measured peak; truncated answers
refused, not trimmed; durable attempts with failed, cancelled and abandoned
apart; requests before automatic work, both classes; imports left out and
dates from each line; commitments paged, not dropped after 30 days, with
structured date corrections. Kept: the provider branch of the contract,
which Téo asked for (no adapter until ADR 027 allows one); retranscription
deleting a journal without moving the agents' content generation (a
replaced transcript is not a deletion, as for transcripts themselves). The
sandbox spike it asked for is in "Engine contract", transport.

Codex Astra then reviewed the code (2026-11-09), 10 findings, all fixed: a
mark kept the model's words after a deletion of a sentence the line did not
cite (now emptied by the tombstone); a transcript without words looped the
queue (now published empty, and refused publications count as failures);
a pass stopped by admission left the model loaded; marks were looked for
only within the day, so a conversation across midnight lost them; a second
word on a line made a second mark; a stale window could reach the line a
mark had moved to; two commitments of one sentence were merged into one; a
cancel during an awaited load was lost; the window's language was written
again and again; and transcription refused for its memory held back a
journal that fit.

It reviewed the Journal view and the 10 s cut (2026-11-10), 3 findings, all
fixed: lines written about a moment before the cut stayed, stale and never
written again (now hidden with the episodes the journal leaves out);
Today's line counted commitments while the journal was off or without its
model; the architecture's wording of the view.

It reviewed the commitments' change (2026-11-10), 8 findings: the vague
rule dropped « envoyer ça » and "bring it" (now only empty objects, or
« faire » and "do" with a pronoun); the age rule's wording hid that a date
decides over the day it was said (the code follows Téo's words, the text now
says it); and six on the bench: a stopped check left its server running, a
resumed run could mix answers to an older transcript or another prompt
(now refused, and an episode is written again when what the model reads
changed), its saved episodes were not written atomically and read after the
model loaded, energy measured while it waited for Sondine counted Sondine's
(now not given), the check could read the live database (`--db` required),
and the export failed on a fresh folder. All fixed.

It reviewed « Qui écrit le journal » (2026-11-11), 10 findings, all fixed:
the engine the scheduler chose before admission could still be Claude after
the user went back to « Ce Mac » (a pass now starts only on the engine the
current writer names, and every Claude request, and the publication, checks
the writer and the switch again); turning the journal off did not stop a
Claude pass; a Mac model still loaded when the user chose Claude left the
scheduler's sight (it now sees every engine the journal holds); a cancel
while the CLI was being found was lost; the adapter's tripwire was weaker
than ADR 027's (an init without its lists, an MCP server, an unknown block,
an answer before the init now stop it); a Claude pause could outlast its 10
minutes with nothing else queued; a requested day could not ask Claude again
from the view; runs keyed the older way (`…|journal-prompt/2`) would have
been written again; a failed rewrite vanished from the day's status.

## Consequences

- A conversation's journal disappears while its transcript is replaced or
  a passage of it deleted, until the next idle pass writes it again.
- A correction to one word makes the whole conversation's journal stale.
- A day of moments costs one request each: 26 episodes took 9 minutes on
  battery. A conversation takes about 25 s, a moment of 10 s of voice or
  more about 14 s; a busy day (20 conversations, 50 such moments, the
  shorter ones left out) waits for about 20 minutes of idle time on power.
- Lines are written in the window's language when they are written; a
  language switch does not rewrite older ones.
