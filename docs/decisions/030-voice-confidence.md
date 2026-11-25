# 030 — Voice confidence, and recognized voices

Status: Accepted — 2026-11-10. Amends architecture §8 (« Phase A »), ADR 018
(the suggestion row), ADR 025 (matching a call's far side) and ADR 020 (the
user's dictations may teach their voice, on their choice). Amended
2026-11-14 by ADR 034 (the user's voice read is one of their references, on
its day, and vouches for their dictations) and 2026-11-25 (« Marie* » from
99 %, below).

## Context

Téo (2026-11-10), on a conversation of the evening before: « c'est ma voix
mais il me la propose pas alors que j'ai quelques audio quand même pour
référence labellisés ». He asked for a confidence on hover, a threshold
under which a voice still needs confirming and one over which it is taken
as the person « tant qu'il n'y a pas de changement », and expected that more
labelled voices make Sondine surer.

Until now (architecture §8, ADR 018): an unnamed voice whose single closest
named voice was at cosine 0.70 or more, and 0.10 ahead of anyone else, read
« Marie ? ». That threshold came from SUMM-RE room mixes, not from Téo's
voices, and the rule set three limits: « two bands, suggest and new »;
« auto-link stays off until held-out false-accept and abstention targets pass
per channel pair »; « automatic matches never add exemplars ».

The voice Téo pointed at was his: 30 s, cosines 0.65, 0.59, 0.51, 0.46 and
0.44 with the five voices he had named « Moi ». The best of the five stayed
under 0.70. Its sentence also appears twice in the transcript: the same audio,
said then played back 14 dB quieter (word durations identical, envelope
correlation 0.87 against 0.34 for other speech), a voice message heard again
— no transcription fault, and a hard case for any voice match.

Keeping only the closest named voice also works against Téo's intuition:
naming more voices gives a stranger more chances to land near one of them,
and adds no certainty.

## Measurements (2026-11-10, Téo's Mac)

Téo's labels are few: ten named voices with an embedding (his own five on the
MacBook microphone, three of one person from a single morning, two on a
call's far side). To measure, the same embedder (`sondine-voice`, WeSpeaker
ResNet34-LM, version `wespeaker-v2:22e7…:sondine-windows-v1`) embedded, into
files outside the repository: Téo's 55 dictations (his voice alone, three
days), a 3 h phone recording of four people he named, cut into 30, 8, 5 and
3 s pieces, and SUMM-RE room mixes of 26 public speakers. Data, scripts and
results stay out of the repository.

- **The closest voice against the centroid.** Over galleries of 1 to 40 of
  Téo's voices, the strangers' best cosine with the closest voice rises with
  the gallery (0.54 → 0.57), while with the centroid of the gallery (the
  normalized mean) it falls (0.57 with one voice, 0.55 with three to five,
  0.49 with forty), and Téo's own voices rise (fifth percentile 0.50 with one
  voice, 0.66 with five, 0.71 with twenty). The centroid is what makes more
  labels worth more.
- **Calibration.** A logistic fit of the centroid cosine, classes weighed
  even: `confidence = σ(26.6 × cosine − 11.55)`: 80 % at 0.486, 99 % at
  0.607. Fitted on Téo's microphone only, 99 % falls at 0.618; on the other
  recordings only, at 0.684. The percentage is a calibrated confidence at
  even odds on these recordings, not a guarantee; a log of the number of
  references fitted a negative weight and let a single-voice stranger reach
  96 %, so that number is a condition for recognition instead.
- **The rule below, against Téo's names as they are**, held out by episode
  (by day for his dictations), every stranger treated as heard on the
  microphone:
  - 24 strangers, 723 recordings of 3 to 30 s: none recognized; 3 suggested
    (19 recordings of one speaker, as the person of the single morning);
    best confidence 97.9 %. Zero errors among 24 people bounds nothing
    tightly: it is what was seen, not a rate.
  - Téo: 51 of 55 dictations recognized, 4 suggested; his five named voices,
    each held out, 4 recognized, 1 suggested; none taken for someone else.
    Today's rule suggested 40 of 55.
  - The person named on one morning, heard on another day (153 pieces, on
    the phone): 143 suggested, none recognized (one day of references), none
    wrong. Today's rule suggested 4.
  - The voice Téo pointed at: « Moi ? » at 98.2 %.
  - Téo's 649 unnamed microphone voices: 222 recognized as him, 178
    suggested, 249 nothing (today's rule: 232 suggested).
- **Short voices.** Strangers cut to 3 and 5 s score lower against Téo's
  references, not higher (best 0.42 and 0.45): short speech mostly costs
  abstention.
- **Cost.** Reading everyone's references takes 22 ms (the named transcripts,
  as suggestions already did); matching all of Téo's embedded voices 13 ms,
  one episode's 0.3 ms.

## Decision

- **A person's voice is the centroid of their references.** References are
  the embeddings of the voices the user named as them, in other episodes,
  same embedder version, heard the same way when they have some: a
  microphone (`input:`), the Mac's own sound (`app:`, `system:`), or the
  phone. Otherwise all their references, across channels.
- **Confidence.** `σ(26.6 × cosine − 11.55)`, shown in a voice's popover as a
  percentage never rounded up, with how many named voices it rests on:
  « 98 % de confiance, d'après 5 voix nommées ».
- **Three zones** (the best person 0.10 ahead of the next, in cosine):
  - under 80 %: nothing;
  - from 80 %: « Marie ? », Oui, Non or Modifier, as before;
  - **recognized** at 99 % or more, when the person has three references
    or more, on two days or more, heard the same way, on a measured channel
    (a microphone voice against microphone references: the only pair
    measured), and the voice has 3 s of speech. The voice reads « Marie »
    with a mark (✦), and its popover « Reconnue à 99,4 %, d'après 5 voix
    nommées » with the same three answers.
  - A voice compared across channels, or on a channel not measured, is only
    suggested, and only from 99 %.
- **Derived, never stored.** Recognition is computed at each read from the
  names, refusals, rules and embeddings of that moment, like suggestions. A
  table of recognitions was the first draft; Codex Astra's critique held:
  ⌘Z on a name, a merge undone, a reference taken back, a passage deleted, a
  rule set or an embedding expired would each have to invalidate it, and a
  guess must never outlive the evidence it came from. It stays « tant qu'il
  n'y a pas de changement »: only the user's names, « Non » and rules move it.
- **Never a reference.** A recognized voice is not a name: confirming it
  (« Oui ») names it, and only then does it join the person's references.
  Linking voices within a transcript reads confirmed names only.
- **Kept apart for agents and in what leaves the app.** `person` stays the
  user's name. `EpisodeSpeaker.recognized` (with `confidence` and
  `references`), `SearchHit.recognized`, `EpisodeSummary.recognized` and
  `PersonSummary.recognizedCount` carry recognitions; the MCP descriptions say
  they are unconfirmed guesses. People pages list the conversations where
  someone was only recognized, marked, and count them apart. Today counts a
  recognized person as there. Transcript exports keep the user's names
  only: written text that leaves the window holds no guess. The journal's
  lines keep their voices as references, so its text holds no guess either;
  at read, a voice nobody named shows whom Sondine takes it for, from 80 %,
  as « Marie ? » (« Marie ✦ » once recognized), a link that plays the
  conversation where that voice speaks (Téo, 2026-11-10: « afficher la voix
  quand même … que ça soit visible que c'est à confirmer »); agents get it as
  `guess`, apart from `name`. « Qui est-ce ? » lists the voices neither named
  nor recognized; opened on a voice, it gives each person's confidence, the
  likeliest first, even far under 80 % (« C'est moi 34 % »: Téo asked to see
  it on a voice of his that diarization had mixed with another person's).
- **Calls (ADR 025).** A call's far side is heard by the Mac, a channel not
  measured: a window counts only from 99 %, two windows agreeing still make
  « Marie ? », and nobody is recognized during a call. The menu bar and the
  notch keep « Marie ? ». When Téo's confirmed call voices measure that
  channel, it can join the measured ones and drop the « ? ».
- **Unchanged.** Media and dictations are never identified; « Ne pas
  identifier » rules and « Reconnaître les voix » turned off read no
  suggestion and no recognition; nothing new is stored (ADR 012).

## The user's own voice

Téo's voice is by far the most frequent. His dictations, used as his
references, would make it surer: his five named voices all recognized
instead of four, the voice he pointed at recognized (cosine 0.73 instead of
0.58), 252 of his unnamed microphone voices recognized instead of 222, and
still no stranger recognized. ADR 020 promised that dictations are never
identified, « no naming, no embeddings », and a dictation is not proof of
one speaker, so it could not happen by itself. Téo chose it (2026-11-10) as
an explicit setting:

- **« Apprendre ma voix depuis mes dictées »**, Settings ▸ Voix, off by
  default, available while « Reconnaître les voix » is on.
- On, the voice pass also embeds dictations, while a voice is named as the
  user and where no « do not identify » rule holds (the dictation app's, a
  device's, the global one). A dictation still names no one, is never
  recognized nor suggested, and never shows as a voice.
- The latest 100 dictations that pass join the user's references: each
  must score 80 % or more against the voices the user named as themselves
  (never against other dictations), so a dictation said by someone else, or
  drowned in other voices, stays out and never crowds out older ones. They count toward the three references
  on two days; the popover says how many (« d'après 5 voix nommées et 55
  dictées »).
- Off, or the user deleted, or « Reconnaître les voix » off: every dictation
  embedding is deleted with the record that it was made, and a call's live
  matching drops what it read. Unnamed, they are deleted after 90 days like
  any unnamed voice.
- Codex Astra's review of this setting: a call's matching kept the
  dictations for up to a minute after « off », learning went on once the last
  « Moi » was taken back, rejected dictations crowded out older ones, and the
  read scanned every episode; all four fixed, the last by a partial index on
  dictation episodes.

## What changed after Codex Astra's critique (2026-11-10)

- Recognitions derived at read instead of a stored table (above).
- Dictation enrollment dropped from the automatic path; shipped later the
  same day as the explicit setting above, on Téo's choice.
- `person` kept for the user's names, recognition in fields of its own.
- The evaluation counts people and recordings, not resampled trials,
  reports the whole rule held out, and the calibration fitted on separate
  halves.
- A call's far side kept strict (two windows over a long call could
  otherwise agree on a stranger at 80 %).
- Kept despite the critique: a recognized voice shows the name with a mark,
  not « Marie ? », because that is what Téo asked; the mark, the popover and
  the separate fields keep it a guess.

## Counts by channel pair

ADR 030's report, per pair of channels (a voice heard one way, the
references another), held out as written; a pair recognizes only once
measured. People and recordings (for the phone, trials: a person in a
recording), never rates.

| Voice → references      | Measured                                       | Known people (recordings) | Recognized right / wrong | Strangers: people (recordings) | Strangers recognized | Recognizes                                      |
| ----------------------- | ---------------------------------------------- | ------------------------- | ------------------------ | ------------------------------ | -------------------- | ----------------------------------------------- |
| Microphone → microphone | 2026-11-10, by episode (by day for dictations) | 1 (60)                    | 55 / 0                   | 24 (723)                       | 0                    | yes                                             |
| Phone → microphone      | 2026-11-13, by episode and by day (M5.8)       | 0 (0)                     | —                        | 0 (0)                          | —                    | no: across channels, suggested from 99 %        |
| Phone → phone           | 2026-11-13, by episode and by day (M5.8)       | 0 (0)                     | —                        | 0 (0)                          | —                    | no: too few labels (ADR 032, « Built at M5.8 ») |

The microphone's row is the measurement above (Téo's 55 dictations and his
five named voices; SUMM-RE's public strangers). The phone's rows come from
`node apps/bench/src/cli.ts voices phone`
(`bench/results/voices-phone-2026-11-13.md`): seven recordings made by the
iPhone app, none of their voices named yet. The phone opens when the
phone → phone row, held out by day, recognizes no stranger on enough
people and days; ADR 032 says what enough is.

## Amended 2026-11-25: « Marie* » from 99 %

Téo, on a call voice suggested at 99 % and more: confirming stays one click,
« mais dans toutes les mentions de voix, il faudrait qu'on ait quand même le
nom de la voix avec peut-être un astérisque pour dire que ça n'a pas été
confirmé, mais que c'est presque sûr ».

- *_From 99 %, on any channel, a voice reads as the person, marked « Marie_ »**,
  wherever voices are named: the episode's title and badges, turns, player,
  Today, the calendar, search, People, the journal. The asterisk replaces the
  ✦: one mark, one meaning. Under 99 %, « Marie ? » and where it shows are
  unchanged.
- **Two zones behind the mark.** `recognized` keeps its rule above and leaves
  « Qui est-ce ? ». `likely` is every other voice at 99 %: too few references,
  one day, a short voice, or a pair of channels not measured. It stays in
  « Qui est-ce ? », with its ✓, as those answers are what measures a channel.
- The API's `recognized` fields hold both. They were always unconfirmed
  guesses, apart from `person`, and the MCP descriptions already say so.
  « Limiter » to a person (ADR 027) reaches the conversations listed as theirs,
  likely ones included.
- **Kept.** Never a reference; derived at read; exports, and the journal's text
  to edit, hold no guess. A voice only likely the user never becomes the
  episode's « Moi » (`self`), which exports use: on a call's far side it is
  often their own voice coming back.
- A live call keeps « Marie ? » in the menu bar and the notch (ADR 025): two
  short windows are not a voice's whole speech. The iPhone keeps « Marie ? »
  for every guess, its wire having no zone.

**What 99 % is worth on a call**, held out by episode, counts only (read-only
on Téo's data, 2026-11-25):

| Voice → references      | Known people (voices) | 99 % right / wrong / under 99 % | Strangers (voices) taken at 99 % |
| ----------------------- | --------------------- | ------------------------------- | -------------------------------- |
| Microphone → microphone | 3 (17)                | 13 / 0 / 4                      | 0 of 17                          |
| Computer → its best     | 5 (15)                | 14 / 1 / 0                      | 3 of 16                          |

A stranger is a named voice with its person taken out of the references. The
four errors are in one call; the wrong one scores 0.31
with the person Téo named and 0.76 or so with another, so a name given to the
wrong voice is possible there. Either way a call's 99 % is surely less than
99 %: the far side does not become `recognized`.

## Added 2026-11-25: « À vérifier »

Téo, told that a voice he named sounded far more like someone else: « c'est
possible que je me trompe des fois, donc il faudrait peut-être une partie
dans Personnes à vérifier. Et là, on demande une confirmation ».

- **Personnes ▸ « À vérifier »**, above « Voix sans nom », shown only when it
  has something to ask: the voices the user named that sound like someone else
  at 99 % or more, 0.10 closer (cosine) to them than to the person named, with
  3 s of speech; newest first, ten at most (`people.doubts`, never for
  agents). Each is compared as if unnamed, without its own episode's voices.
  A person with no voice in another episode is asked about too.
- **Hear, then answer.** ▶ plays its longest sentence; both likenesses show
  (« Nommée Marie (3 %),
  ressemble à Jules (99,9 %) »), neither answer standing out; « C'est Jules » renames the voice, « C'est bien
  Marie » is a `speaker_is_not` for Jules over its speech (`speakers.refuse`),
  so the same question never comes back. Both undo with ⌘Z.
- **Nothing happens by itself.** Derived at each read, nothing stored: the name
  holds, and stays a reference, until the user answers.
- On Téo's data: 2 of 43 named voices asked about, 8 ms once the references
  are read (about 60 ms with them).

## Consequences

- One migration: a partial index on dictation episodes by start
  (`episodes_dictation_idx`). Episode detail, search, Today and People read
  the named transcripts once per request (22 ms on Téo's data), and the
  user's dictations when they teach; the voice pass embeds dictations only
  while they may teach (one short request each, a few a day).
- Thresholds rest on few labels: one person's microphone in practice, and
  24 public strangers. Other microphones, the phone and calls are not
  measured. Recalibrate on Téo's confirmed labels as they grow, per channel
  pair, held out by day, before opening another pair.
- The percentage is calibrated at even odds; in a room where Téo speaks most,
  his voice is likelier than it says, and a stranger's less.
- A person named on a single day is never recognized: three of their voices
  on two days are needed.
