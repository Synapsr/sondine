# 014 — Feature priorities beyond capture and search

Status: Accepted — 2026-11-02 (decided by Téo)

## Context

After the architecture draft, ten feature ideas were proposed on top of the
release 1 core (capture, conversations, transcription, people, search). Téo
considers all of them useful and ranked them.

## Decision

1. **Agent access through MCP** and **export and share**: highest priority.
   Both land in M2, right after search exists, together with deletion.
2. **Call context**, **phonetic search**, and **personal vocabulary**: next,
   in M4, once identity (M3) and near-live exist.
3. **"Keep this"**, **"forget this"**, and **private zones**: later,
   unscheduled.
4. Not ranked yet: commitments and a daily journal from a local language
   model; starting iPhone recording from the Action button.

"Share" stays local: Sondine writes a file and hands it to the save panel or
the macOS share sheet. It hosts no link and runs no server for it.

## Consequences

- M2 grows: exports and MCP read through one deletion filter, so tombstoned
  content can never leave through either.
- MCP tools come in steps: episodes and excerpts in M2, people in M3.
- Range deletion stays in M2 because export and MCP depend on it; only the
  one-gesture "forget the last N minutes" moves to later.
- Exports carry other people's words. They contain text by default, an
  audio clip only on request, and voice data never (ADR 012).
- The full list and order live in [plan.md](../plan.md).
