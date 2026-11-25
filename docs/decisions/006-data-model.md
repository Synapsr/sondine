# 006 — Recordings, interpretations, assertions, and people are separate

Status: Proposed — 2026-11-02; amended 2026-11-09 by ADR 029 (a private
zone or a type's « Effacé après » deletes recordings whole, on the user's
schedule)

## Context

The prototype grew 24 migrations, two parallel table worlds, JSON-encoded
statuses, embeddings as JSON text, no search on active tables, and names tied
to an embedding model version. Reviews showed that without a separate store
for user corrections, reanalysis can erase them, and a late job can resurrect
deleted content.

## Decision

- Capture facts are immutable except for user or retention deletion, which
  leaves a tombstone (`deleted_ranges`, `chunks.audio_state`).
- User assertions (names, edits, splits, merges, overrides, "not this
  person") are rows anchored to `(track_run_id, sample_start, sample_end)`,
  re-applied after every reanalysis, and always win.
- Model outputs live under `analysis_runs` with provenance and input
  generation; publication is compare-and-publish in one transaction.
- `people` (with one optional `is_self`) are separate from `voice_profiles`
  (per embedder version) and `exemplars`, which own a lossless clip so any
  future embedder can re-embed them.
- Statuses are SQL enums (CHECK), not JSON. Vectors and packed word timings
  are BLOBs.
- Retention expiry removes audio bytes only; explicit deletion cascades
  through rows, files, FTS (`secure-delete`), the WAL, and phone tombstones.
- Context the helper observed over speech, such as the app in front
  (`foreground_spans`, ADR 022), is a capture fact anchored to its speech
  region in run samples: it goes with the region, deletions cut it like
  assertions, and nothing of it is kept outside speech.
- Migrations are versioned SQL with snapshot and restore tests.

## Consequences

- Swapping an embedder re-embeds stored clips; names survive.
- UI read models are queries over these tables, not separate state.
