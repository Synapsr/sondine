# 012 — Third parties and biometric data

Status: Proposed — 2026-11-02

## Context

Sondine hears colleagues, call participants, and strangers. Voice profiles
that identify people are special-category data under GDPR Art. 9; recording
laws differ by country.

## Decision

- "Recognise voices" is a global setting (on by default for Téo), with
  per-app and per-episode "Do not identify" rules. Under those rules Sondine
  transcribes and diarizes ("Speaker N") but never embeds or links.
- Only call and in-person episodes feed identity; media never does.
- Unnamed voice profiles not heard for 90 days are deleted with their
  exemplars; named people persist until deleted.
- Deleting a person deletes their profiles, exemplars, and links; their
  transcript segments become anonymous.
- First run explains what Sondine records, that people nearby are recorded
  too, and that the user is responsible for consent where the law requires
  it.

## Consequences

- Work contexts can run without biometric processing.
- Exports exclude voice data unless asked.
