# 017 — Undo and redo of the user's edits

Status: Accepted — 2026-11-07

## Context

M2 lets the user split and merge conversations, set their type, correct the
text and name voices. Téo asked for ⌘Z after a split. Undoing by calling the
inverse operation is not exact: a merge cannot be undone by splitting at the
later episode's start when the two overlapped; a split cuts a sentence and
clips its correction, which a merge does not join again; naming a voice
revokes other names under it; setting one type replaces several. Episode and
person ids are SQLite rowids, so a deleted id can come back as another
episode.

## Decision

- Core keeps the history, in memory, for the session: 50 edits made in the
  window (split, merge, type, text correction or « Rétablir l'original »,
  naming, unnaming or renaming, « Non », merging two people, ADR 025).
  Agents cannot edit, so they never appear in it.
- Around each edit, core captures, in the edit's transaction, what it may
  change: the user's assertions over the episode's audio (widened to every
  assertion meeting it), the people involved, what the sentences show for a
  correction, the type columns for a type, and for a split or a merge the
  episodes whole (rows, member slices, the episode's identity rule,
  transcripts as published).
- Ending an ongoing episode (ADR 044) is a step without captures: its end is
  taken back, and redone.
- Undo restores the capture from before and redo the one from after, only
  while the state still prints exactly as the other capture: anything changed
  since refuses (« Impossible d'annuler : la conversation a changé depuis »)
  rather than guessing. Ids come back as they were; transcripts come back as
  derived runs of their lineage, current when they were, with corrections
  projected again from their restored assertions; a correction undone in
  place brings each sentence back as it showed.
- After an edit or a step that leaves an episode due for analysis, core
  queues its job at once.
- Deleting a recording, erasing the last minutes or deleting a person is not
  undoable (it erases for good, after a confirmation) and forgets the whole
  history: captures hold transcript text, and an id may be reused.
- Main sends Édition ▸ Annuler / Rétablir (⌘Z, ⇧⌘Z) to the page, which undoes
  typing when a text field or an open editor has focus, and asks core
  otherwise. A toast says what was undone.

## Consequences

- A restored transcript has no voice embeddings until the voice pass runs
  again, so « Marie ? » suggestions return a little later.
- A new transcript, a late region or a repair between an edit and ⌘Z makes
  that step refuse; the steps under it may still apply.
- Quitting Sondine or a core restart forgets the history.
