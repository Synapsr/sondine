# 046 — The Vocabulary: the user's words, and the journal's model for look-alikes

Status: Accepted — 2026-11-26 (Téo: « ok » to a list in Settings and to
learning more from corrections, after a call where Sondine wrote « Théo t'as
passé Sandrine » for « Téo » and « Sondine »; « ok » again, 2026-11-26, to
the model running with the journal off, the 7 days read again, and the
People's names by sound only). Amends ADR 018's spelling
row (`vocabulary/2` → `vocabulary/3`). Builds on ADR 006, ADR 016, ADR 028.

## Context

`vocabulary/2` (M4) spells a name the way the user once corrected it, when
the correction sounds like what was heard (« Kamille » → « Camille »),
never at a sentence's start, where a capital proves nothing. On Téo's call
it learned nothing: « Téo » starts the sentence, and « Sandrine » does not
sound like « Sondine » (phonetic keys `sandrin` and `sondin`). A name the
engine does not know comes out as a common one that looks close, and only
the sentence tells them apart.

The engines take no hints today: speech.cpp refuses a `prompt` with
`speakers` (another thread looks at it). So Sondine corrects after the
engine, as `vocabulary/2` does.

## Decision

### The list

- Settings ▸ « Vocabulaire » holds the user's words (`vocabulary_words`), up
  to 500, each with an optional note of 200 characters (« le nom de mon
  app »). One word per spelling without case or accents. The People's names
  count too, read from `people` (a name in both shows once, in the list).
- Procedures `vocabulary.list`, `vocabulary.add`, `vocabulary.update`,
  `vocabulary.remove`, in the window only: no agent and no phone. Their
  usage rule is `never` (ADR 042: counting them would need a new version of
  the question).
- Removing a word changes nothing already written: the original stays
  beside it.

### The rule without a model (`vocabulary/3`)

A word the engine wrote as a name (a capital mid-sentence, or at a
sentence's start when the same transcript writes it with a capital
mid-sentence) that sounds like exactly one of the user's names (same
`phonetic-fr/2` key) is spelled their way: « Théo » → « Téo ». Two of the
user's names with one key: neither. Lower-case words are never touched
(« en théorie », a host named « théo »). A name followed by another word
with a capital (« Théo Martin ») is someone else of that first name and is
left, unless those two words are one of the user's names (« Téo Martin » in
the list or the People); the model is not asked about it either. As for `vocabulary/2`, the
engine's text stays as `original_text`, so « Rétablir l'original » works,
and then records a correction keeping what was heard.

It runs at publish (new transcripts, retranscriptions, near-live text), and
on the last 7 days' transcripts when the names or the corrections change
(below), so a name just added spells the week too.

### The journal's model for look-alikes (`vocabulary-check/1`)

- **Candidates**: a word written as a name that looks like a word of the
  list without sounding the same: same first sound, one edit apart on the
  phonetic key (two from six sounds), and near exactly one of the user's
  names. Never a name of the list itself, nor one a correction taught.
- **Only the words of the list, not the People's names.** On Téo's week the
  model said yes to 2 of 12 look-alikes of People's names that were other
  people or a common word: two close first names are most often two
  people. A person's name the user wants checked goes in the
  list, with a note.
- **One request per candidate**: the word marked in its sentence, two
  sentences before and after, the user's word and note. Batching nine in one
  request lost three of them (4 of 9 against 7 of 9). The answer, by schema:
  what the word refers to in a few words, then `user_word` or `as_written`.
  The instructions say the engine writes common first names for words it
  does not know, and to keep `as_written` between two people's names. The
  transcript is data, never instructions.
- **Where it runs**: the journal's model on this Mac only (Qwen 3.5 9B, ADR
  028), never the user's Claude, whoever writes the journal, and whether the
  journal is on: the model's download is the user's yes to it. It is a
  journal unit for the analysis scheduler: after transcription, under the
  journal's admission (power, idle, memory, ADR 016), one heavy model at a
  time, before the journal of the same episode (a day the user asked for
  first, that day's episodes first). A failed answer is tried again 10
  minutes later, three times at most.
- **Which transcripts**: closed calls, in-person, mixed and imported
  episodes of the last 7 days with a published transcript; not media, not
  dictations. `vocabulary_passes` records each episode read, for its
  transcript run and a key of the names, the taught spellings, whether the
  model was there, and the versions: a new name, a new correction or the
  model installed reads them again. `vocabulary_checks` keeps each answer
  per word of a sentence, so a word is asked once; it goes with the
  sentence (`ON DELETE CASCADE`), the pass with the episode.
- **Writing it**: a `user_word` answer puts the user's spelling in the
  word's place, in the sentence as it was read (one the user corrected or
  that changed since is left), the engine's text kept as `original_text`,
  no correction recorded, the search index rewritten. The journal's
  triggers mark the episode's journal stale, as for a correction.
- **Without the model**, the rule without a model still applies, at
  publish and on the last 7 days; candidates wait for the model.

### Learning from corrections

- A correction at a sentence's start teaches when the name the user wrote
  is already known: one of their names (list or People) or one another
  correction taught. « Théo t'as passé… » → « Téo t'as passé… » teaches
  « Téo » once Téo is a person or a word of the list.
- `transcript.edit` returns what the correction taught (`learned`: the
  window says « Sondine écrira désormais « Téo » ») and the names the user
  wrote that do not sound like what was heard and are not in the list
  (`unheard`: the window offers « Ajouter « Sondine » au Vocabulaire ? »).

### Later: context terms for the engine

The list is plain words with notes, so it can become an engine's « context
terms » (an `asr` capability, ADR 005), local or on the compute server
(ADR 040). Nothing is sent now. Sending them to a server is text leaving
the Mac and needs its own decision.

## Measurements (Téo's week, 2026-11-19 to 26)

On a copy of the database (`sqlite3 .backup`, private, deleted after),
`sondine-bench vocabulary run`, with Téo's 9 People and the list « Téo »,
« Sondine » (note « le nom de mon app »); counts only, in
`bench/results/vocabulary-2026-11-26.md`.

- 178 episodes, 6,383 sentences. The rule without a model spells 84 words:
  52 « Théo » → « Téo » (by their sentences about 46 are Téo, 2 another Théo,
  4 cannot tell). With the surname rule, 83 words and 51 « Théo »: the one left is the other Théo
  followed by his surname; no « Téo » is lost, and the other mention of him
  (without his surname) is still rewritten. The rest: 2 « Theo »/« Teo », 2 « Sondin »,
  and 28 People's names written another way (three people: 12, 11 and 5). Cost: the whole week in 0.8 s, the copy's
  migration included; at publish, 2 ms to read the vocabulary and 9 ms for the
  week's longest episode (2,056 sentences).
- The model: 9 candidates in 8 sentences, all « Sandrine »/« Sandine » for
  « Sondine »; by their sentences all 9 mean the app. The final run
  corrected 7, none wrongly (6 to 7 across the last prompt's runs). 9
  requests, about 300 prompt and 57 output tokens each, 39 s of compute for
  the week, the server's resident memory at most 6.5 GB (the journal's
  model, already admitted at that peak), loaded in 2.8 s warm.
- Before restricting to the list: 21 candidates, 13 yes, 2 of them wrong.

## Consequences

- The always-on path does not change: the model runs only in the
  scheduler's journal units, on candidates only (9 a week here).
- A name added to the list rewrites the last week's matching words in the
  background; each keeps its original.
- The model's yes is a guess: it shows as an edited sentence with
  « Rétablir l'original », as the rule's spellings do.
