# Product vision

Confirmed with Téo on 2026-11-02. Update this file when scope changes; record
the reason in a decision under `docs/decisions/`.

## Problem

People forget what was said: in meetings, calls, videos, and in-person talk.
Notes are incomplete and cloud recorders send private conversations to
someone else's servers.

## Product

Sondine is an always-on auditory memory for macOS. It listens to every audio
source on the Mac, turns speech into searchable, diarized conversations, and
recognizes each person across conversations by their voice. By default,
everything stays on the user's devices.

## Audience

One person on their own Mac, first Téo. Technical enough to install a macOS
app and grant audio permissions. No account, no team features.

## Release 1 scope

1. **Always-on capture** of every input device (built-in, Bluetooth, USB,
   hot-plug) and of internal audio, attributed to the app that produced it
   when the system allows it, and to the web page when Sondine's browser
   extension reports the tab that plays (ADR 023).
2. **Conversations, automatically.** Speech is grouped into conversations
   without user action. Small exchanges ("moments") are kept, searchable, and
   grouped compactly; large conversations get their own view.
3. **Transcription and diarization** in French and English, including
   code-switching, with a high-quality pass when a conversation ends. Live
   text only while the user looks at the ongoing conversation.
4. **People.** Each voice gets a persistent identity across conversations.
   The user names, merges, and splits people; automatic matches never
   silently retrain an identity.
5. **Search** across everything: words, people, apps, dates, kind. It
   tolerates misheard names (phonetic matching) and learns the user's own
   vocabulary.
6. **Agent access** through a local MCP server, off by default, read-only.
   Top priority after search, with export. Since 2026-11-09 (ADR 027), also
   a discussion with an agent inside Sondine, on Téo's own subscription
   (Claude), off by default, reading through the same read-only tools.
7. **Export and share** a conversation or an excerpt as text (Markdown,
   subtitles, JSON) through the save panel or the share sheet. Sondine hosts
   nothing.
8. **Call context**: when a known person is recognized in a call, the last
   exchanges with them are one glance away.

Priorities and the features planned after release 1 are in
[ADR 014](decisions/014-feature-priorities.md) and [plan.md](plan.md).

## Release 2 scope

- **Companion iPhone app** (iOS only), confirmed with Téo on 2026-11-10
  (ADR 008, 031, 032): records by hand, offline, for hours; hands its
  recordings to the Mac (the share sheet first, then sync on the local
  network, then through Tailscale if the user allows it); shows their
  results, and reads the Mac's memory live (search, the day's journal,
  commitments) without keeping a copy. The Mac alone analyses.

## Constraints

- **Local only.** No cloud, no account, no telemetry without a yes. The only
  network use is model downloads the user starts, updates they said yes to (ADR 045), (release 2) sync with
  paired phones on the local network, or through Tailscale once the user
  allows it (ADR 008), and, once the user turns it on, the discussion with
  an agent: what the user writes and what the agent reads go to the
  provider of their subscription through their own CLI (ADR 027). The audio
  of finished conversations goes to a compute server only when the user
  chooses one, to transcribe it (ADR 040). One anonymous report of counts
  leaves a day only if the user said yes to it (ADR 042).
- **Light and fast.** The always-on path has an explicit CPU, memory, and
  energy budget, measured on every change that touches it.
- **Measured and tested.** Every pipeline stage reports quality and cost;
  engines are chosen by local benchmarks, not by habit.
- **Swappable engines.** Every ML stage sits behind an adapter so a better
  model can replace the current one without touching the product.
- **Open source** under AGPL-3.0. Third-party assets keep their own licenses.
- **Works very well on few machines rather than poorly on many.** Release 1
  targets Apple silicon Macs with 32 GB of memory on macOS 27, the only
  configuration that is tested. Wider support comes only with a test lane
  for it.

## Non-goals for release 1

- Windows, Linux, Android.
- Cloud sync, accounts, hosted share links, collaboration.
- Screen capture or OCR.
- Summaries presented as facts: any generated text cites transcript spans.
- Guessing the website or tab behind browser audio: only the browser,
  through Sondine's extension, says which tab plays (ADR 023).

## Facts

- Prototype measurements (Apple M5, 32 GB): Nemotron 3.5 Transcribe 30B
  IQ4_NL loads in about 20 s and peaks at 17.6 GB for a 51 s clip; smaller
  engines run 20-500x faster than real time. See `docs/decisions/` for the
  engine choices made from new measurements.
- macOS Core Audio process taps (macOS 14.4+) capture app audio without a
  virtual driver.

## Assumptions to verify early

- Per-app attribution stays exact when several apps play at once.
- The always-on path fits its budget over an eight-hour day.
- French/English code-switching is handled by at least one light engine.
- Voice identity holds across microphones, phone recordings, and call codecs.
- Users find moments useful rather than noisy.

Each assumption is tested by a milestone in [plan.md](plan.md).

## Open questions

- Default audio retention after the 24 h full-signal spool.
- Whether capture runs as a child of the app or as a bundled login item
  (M0 spike).
