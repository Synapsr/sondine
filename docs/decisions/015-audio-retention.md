# 015 — Audio retention

Status: Accepted — 2026-11-04; durations by type, built with ADR 029
(2026-11-09)

## Context

The full-signal spool keeps 24 h or 4 GiB (architecture §3). After it, the
architecture kept speech regions and seven days of gated, VAD-rejected audio,
and left the default retention of that audio open. Text is what Téo searches;
audio is what lets a better engine reanalyse a conversation, and what he
replays to check a word. At about 2.5 h of speech a day on two tracks, speech
regions cost about 0.6 GB a day as raw PCM16 and about half that losslessly
compressed.

## Decision

- Speech regions (with their pre-roll and post-roll) keep their audio 30 days
  after their episode closes, archived losslessly, so a later engine
  reanalyses them at full quality. Then their bytes expire
  (`audio_state = expired`); their text, turns and speakers stay.
- Gated, VAD-rejected audio keeps 7 days, compressed (architecture §3).
- Text, turns, speaker labels, assertions and the capture facts stay until the
  user deletes them (ADR 006).
- Exemplar clips of known voices follow their person, not this window
  (ADR 012).
- A size cap (default 20 GiB for archived audio) expires the oldest first
  when it is reached before 30 days, and Diagnostics says so.
- Both values are settings; moments the user keeps (plan: "Keep this") are
  exempt from expiry: « Garder les 2 dernières minutes » keeps what the Mac
  captured then, speech or not, past the spool and every expiry (ADR 029,
  amended 2026-11-14).

## Consequences

- At the cap, about two months of speech fit; the 30 days decide first for a
  typical day.
- Expiry is a retention job in core (M1, with the archiver); explicit deletion
  stays a separate cascade (ADR 006).
