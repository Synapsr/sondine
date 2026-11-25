# 005 — Swappable engines chosen by local benchmarks

Status: Proposed — 2026-11-02

## Context

Téo wants no legacy pipeline: every ML stage must be chosen by comparing the
serious current options and stay easy to replace. The field moves weekly.
Published French numbers are mostly read speech. Reviews warned that "all
options" is an endless program without a bootstrap and a stopping rule.

## Decision

- First-release stages: `vad` (Swift protocol in the helper, with a file mode
  for the bench), `asr` (streaming as a capability), `align`, `diarize`,
  `embed-speaker`. Later stages get a contract only when a milestone needs
  them: `aec`, `endpoint`, `textgen`, `embed-text`.
- One product adapter contract per stage in `packages/engines` (manifest,
  capabilities, resources, file-based methods, typed results with coverage
  and provenance). Runtime wire protocols stay per family behind adapters.
- Adapter classes: `product` (shipped worker) and `probe` (bench only).
- A reference configuration runs until the first benchmark decision,
  labelled in Settings: Silero VAD; Nemotron 3.5 Transcribe 30B IQ4_NL (ASR +
  native speakers, resident speech.cpp worker). Nemotron 30B is the baseline
  challengers must beat, because it is the only engine Téo has seen diarize
  French conversations well; pyannote community-1 performed poorly in his
  tests and stays a control.
- Release 1 targets 32 GB Macs only: Téo prefers an app that works very well
  for few people over one that works poorly for many. Lighter tiers are a
  later decision with their own test lane.
- Each stage starts with two challengers plus controls; selection is per
  pipeline profile on the private golden test split, with
  public corpora as diagnostics. A changed default is a new decision with its
  evidence.
- License gate before a default: bundled weights must be MIT, Apache-2.0,
  BSD, or CC-BY-4.0; downloaded weights may also be OpenMDW-1.1 (Nemotron),
  downloaded by the user from the pinned upstream URL with the license and
  notices shown and kept. Field-of-use, non-commercial, and revenue-limited
  licenses are rejected.
- Engines never download; the model manager owns artifacts.
- Labelled data plan: golden set v0 of about 60 min over six scenarios in M1,
  references seeded by a non-candidate control and corrected by Téo, consent
  per speaker, at least three people recurring across three sessions by M3.

## Consequences

- The bench calls the same adapters and the helper's file mode, so product
  and bench cannot drift.
- Composite pipelines are host compositions, testable with fake engines.
- An engine that cannot meet the contract is rejected or wrapped explicitly,
  never special-cased in the product.
