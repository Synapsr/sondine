# 019 — Near-live text

Status: Accepted — 2026-11-08

## Context

Final transcripts wait for power and two minutes of idle (ADR 016), so a
conversation has no text while it happens, nor for a while after. Téo
(2026-11-08): « Je veux bien qu'on teste en direct, utiliser le petit
modèle, sauf quand je suis sur batterie, mais ça doit être un setting »: a
preview to follow a conversation, not a perfect transcript. Architecture §10
planned near-live text as a provisional run that the final pass replaces;
`publishAnalysis` already had the `asr_live` stage. Parakeet TDT 0.6B v3 was
ADR 018's candidate: FLEURS fr 4.7 %, on Téo's Mac a 0.3 s load and 7.9 s
of French in 0.26 s with token times, through the same speech.cpp worker as
Nemotron; it drops overlapping speech and has no speakers.

## Decision

- **A setting**, Settings ▸ « Texte en direct », off by default
  (`settings` key `live.enabled`). Its model, Parakeet F16 (1.25 GB,
  CC-BY-4.0, pinned URL and sha256), is a catalog artifact with role `live`:
  onboarding and « model ready » only count the `final` one.
- **When**: the setting is on, the model verified, the Mac on power, its
  thermal state nominal or fair, memory pressure normal or warn, and the
  final pass's recovery not blocked. Otherwise the worker exits at once;
  idle, 60 s after its last request. It runs whatever the window shows (§10
  first meant only while an episode is open on screen): text is there when
  Téo looks.
- **What**: every 2 s, the commit cadence, for each episode open in this
  session (then once more when it closes), each _finished_ region slice with
  its roll, merged with a neighbour only where the rolls overlap, minus
  deleted ranges, in pieces of at most 5 min (`planLiveUnits`), once its
  samples are imported. Each unit is sent once and its text cached by its
  exact samples; speech still going waits for its pause. Newest first,
  2 min of audio per tick at most.
- **Publish**: the episode's units so far, echo removed from all of them each
  time (`echo/3`), turns per unit, one label per track (`<trackKey>/live/1`),
  taught spellings applied, as a new `asr_live` run at the generation the
  units were read at (`publishLive`). Refused for an older generation, it
  retries next tick; a superseded or refused live run is deleted, so a long
  call keeps one. The final transcript supersedes it as before; the episode's
  analysis state stays as it was.
- **The sentence being said** (Téo, 2026-11-08: « quelques secondes entre
  le moment où je parle et les premiers résultats »): at each commit (the
  transcriber wakes on every imported one), the newest open slice of an open
  episode, its pre-roll on, up to what is imported, at most its last 30 s, is
  transcribed again and kept in memory only (`live.partial`, for the window,
  not for agents). Today's card and the episode show it under the published
  sentences until the sentence ends and its unit publishes. Words show about
  2 s behind the voice, not after the sentence.
- **Deletions**: any deletion clears the cache and the sentence being said; text read before one is
  dropped, not published, and the database refuses outputs over a tombstone
  anyway. Regrouping that deletes an open episode retires its live run first.
- **Workers**: one worker per model (ADR 016 amended): the check before a
  spawn matches the speech binary _and_ the weights, so Parakeet and Nemotron
  may run together (2 GB beside 17 GB); the startup sweep still stops every
  speech process.
- **Window**: Today opens with each open episode outside media, whatever
  its size so far, as soon as speech starts (refreshed every 4 s): a pulsing
  dot, « À l'écoute… » until text comes, then its last three sentences as
  they publish. `Status.live` (state and a revision bumped per publish)
  makes episodes and searches refetch at once; an episode shows « Texte en
  direct, approximatif : la transcription finale le remplacera. », and Today
  a « Texte en direct » badge on a finished one still waiting for its final
  transcript.

## Consequences

- A sentence's final live text appears about 2–4 s after it ends (0.8 s of
  silence for the end, the next commit, 0.3 s of inference); while it is
  said, its words follow about 2 s behind (the 2 s commits). Below that,
  audio must reach the engine as it comes: a streaming engine (Apple's
  SpeechAnalyzer, Kyutai STT), to be benched if this is not enough.
- Live text is searchable and agents read it, flagged by
  `EpisodeSummary.live`; it carries no voices to name and cannot be edited.
- Not measured yet: Parakeet's peak memory and energy beside Nemotron, and
  speech-to-screen latency in a long multi-track call (the exit criterion).
