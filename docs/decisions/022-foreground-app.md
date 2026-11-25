# 022 — The app in front while something was said

Status: Accepted — 2026-11-09

## Context

Téo (2026-11-09): when he says a sentence while looking at Sondine, the
transcript, search and agents should know that sentence was said while
Sondine was in front. Episodes already name the apps they heard (calls, what
played, dictation apps, ADR 020), but nothing said which app the user was in.
Window titles and screen content would need Accessibility or Screen
Recording, and screen capture is a non-goal (product vision). NSWorkspace's
frontmost application and its activation notification need no permission.

## Decision

- **App only.** The bundle ID and name of `NSWorkspace.shared
  .frontmostApplication`, nothing else: no window, no title, no screen.
  While the screen is locked, the screen saver runs or the displays sleep
  (their notifications need no permission either), no app is in front: a
  talk over lunch is not said « in Xcode ». An app the user excluded from
  capture is never named. Sondine itself counts.
- **Only over speech.** The helper keeps, in memory, the app in front and its
  changes back to 30 s before the earliest open region (the last 30 s while
  nobody speaks, at most 512 changes), never a log of the day. Each `region.close` carries the
  apps in front while it lasted (`foreground`, protocol 3): the region cut at
  each change, in run samples, at most 64 spans. NSWorkspace is fed by the
  main run loop (under `dispatchMain()` it never changed, measured
  2026-11-09), so `serve` runs `CFRunLoopRun()`.
- **Stored with the region.** Core keeps the spans in `foreground_spans`,
  clipped to the region as stored, with a foreign key that deletes them with
  their region. A deletion that keeps the region cuts them like the user's
  assertions: deleting a recording (each tombstone with its roll), a passage,
  and « oublier les dernières minutes » (by wall time, whole). Retention only
  expires audio: the text stays, and the app with it. Manifests do not hold
  the app, so a region recovered from a manifest has none.
- **A sentence's app** is the one in front at its middle: one index seek on
  `(track_run_id, sample_start)`, since a run's spans never overlap. It is
  read, never stored on segments, so every transcript (final, near-live,
  split, merged, corrected) gets it with no write.
- **Window.** A transcript turn shows the app's icon under its time where
  that app changes from the turns before (a change in the middle of a voice
  starts a turn); no icon where it stays the same or none is known. Search
  gets « Pendant que j'étais dans… » beside the filters: the apps something
  was said in, the latest first, hidden until there is one.
- **Agents.** `get_episode` segments and `search_transcripts` hits carry
  `app` (bundle ID and name, or null), and `search_transcripts` takes
  `foregroundApp`.

## Consequences

- Speech recorded before this change, imported audio and phone recordings
  have no app.
- The helper's always-on cost: on the fake HAL, side by side for 3 min
  with the build before it (2026-11-09), 131 KB more footprint (10.98 MB to
  11.11 MB) and the same CPU (0.67 s against 0.69 s over the first 2 min).
- A sentence across an app switch counts for the app at its middle only, in
  the transcript and in the filter alike.
