# 007 — Conversations and moments

Status: Proposed — 2026-11-02; amended 2026-11-06 (calls in M1 step 2; voiced time)

## Context

In the prototype every voice burst became a session sent through a 19 GB
model, including one-word results like "Bonjour". Téo wants small exchanges
kept but not given a view of their own. Reviews found the first threshold set
had gaps and mixed content kind with presentation size.

## Decision

- Two independent columns: `context` (call, in_person, media, mixed), computed
  after echo flags and cross-track dedup; and `size` (trace, moment,
  conversation), from a total decision table with hysteresis and an explicit
  provisional state.
- Starting table (v1, calibrated later on a labelled week), on deduplicated
  voiced time. Voiced time is what the VAD heard as speech, not the span of
  its regions, which also hold pauses shorter than its minimum silence: six
  coughs 4 s apart span 2.5 s but hold 1.1 s of voice (false-moments bench,
  2026-11-06). The helper reports it per region; regions closed before it did
  count their span.
  - `trace`: voiced < 1.5 s.
  - `conversation`: a call context, or voiced ≥ 60 s, or (elapsed ≥ 3 min and
    ≥ 2 speakers or ≥ 6 turns once diarized).
  - `moment`: everything else, including provisional middle cases.
- Grouping gaps per context: in-person 45 s, call tied to call state and
  closed by 5 min of silence, media separate from live talk.
- A call is a call app, call daemon, or a browser using the microphone while it plays sound (the
  helper's `call` events). One call is one episode with context `call`,
  hence a conversation: the mic, the call app's track, and the far side on
  `system:other` when the app has no tap of its own and the track is not
  attributed to another app. A call that restarts within 45 s is the same
  call (`grouping/2`, ADR 016 "Episodes"). Five minutes without speech close
  the episode while the call goes on: a voice channel kept open for hours
  gives one episode per exchange (`grouping/4`).
- Mic speech said to a dictation app (Hex, VoiceInk, Parler, or an app the user
  names) is a `dictation`, apart from the talk around it, in its own lane
  (`grouping/3`, ADR 020), during a call too (`grouping/4`).
- Media splits by the web page its browser reported playing: two videos in a
  row are two episodes (`grouping/5`, ADR 023); media with no page reported
  joins the episode going on (`grouping/6`).
- Thresholds affect presentation and priority, never retention. Amended
  2026-11-09 (ADR 029): the type shown sets how long its audio stays.
- Manual size overrides, merges, splits and ends (« Terminer », ADR 044) are
  assertions and always win.

## Consequences

- The classifier has unit tests on synthetic timelines; its evaluation counts
  unwanted splits and merges separately.
- Media is its own lane, filterable and hidden from the main timeline by
  default, whatever the episode's size.
- `mixed` episodes go by size, like in-person ones: a mixed conversation is a
  row, a mixed moment joins its hour, a mixed trace is counted as a trace.
- In a call the microphone voice that speaks most is shown as the user
  (« Moi »), derived at each read and never stored; identities come in M3.
