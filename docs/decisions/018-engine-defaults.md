# 018 — First engine defaults per pipeline profile

Status: Proposed — 2026-11-07 (interim, from public evidence; the golden set
decides, ADR 005); voice thresholds replaced 2026-11-10 by ADR 030; spelling
amended 2026-11-26 by ADR 046

## Context

M4 asks for defaults chosen from recorded evidence: end-to-end tcpWER and
identity false merges on the private test split. That split does not exist
yet (golden v0 has three situations and no scorer). What exists is public
and local evidence: FLEURS fr/en (`bench/results/asr-fleurs-2026-11-06.md`),
eight SUMM-RE meetings scored with MeetEval
(`bench/results/asr-meetings-2026-11-06.md`), the voice calibration on
SUMM-RE room mixes (`bench/results/voice-calibration-2026-11-07.md`), and
Téo's own talks (ADR 016). The app has shipped Nemotron since M1; this
records why it stays, what each other stage uses, and what would change it.

## Decision

| Profile or stage                                     | Default                                                                                                                                                           | Evidence                                                                                                                                             | Revisit when                                                         |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Conversations and calls (final transcript, speakers) | Nemotron 3.5 Transcribe 30B IQ4_NL, speakers and timestamps in one pass                                                                                           | SUMM-RE tcpWER 19.0 % against 43.9 % (Qwen3-ASR 1.7B) and 51.8 % (Parakeet); right speaker count in 8/8 meetings; hears overlap; FLEURS fr WER 4.6 % | The golden test split, or a cheaper engine within 2 points of tcpWER |
| One person speaking clearly; live text               | Parakeet TDT 0.6B v3, near-live text only (ADR 019)                                                                                                               | FLEURS fr 4.7 % at 123× real time and 1.3 GB; misses overlapping speech (31.6 % deleted on meetings)                                                 | Near-live is built (M4); it would never replace the final pass       |
| Voice activity                                       | Silero VAD 6.2 (ONNX, helper)                                                                                                                                     | M0 capture floor, false-moments diagnostic                                                                                                           | The labelled week shows missed moments                               |
| Speaker embeddings (« Marie ? »)                     | WeSpeaker ResNet34-LM, Core ML; centroid confidence, suggest from 80 %, recognize from 99 % (ADR 030)                                                             | Téo's labels and SUMM-RE, held out (ADR 030)                                                                                                         | Held-out false-accept per channel pair (M3 exit)                     |
| Echo of played sound on the mic                      | `echo/4`: word evidence, and the stretches ADR 035 found to be Sondine's own echo                                                                                 | Unit fixtures, three reviews                                                                                                                         | Envelope correlation with app and system tracks (architecture §3)    |
| Echo of Sondine's own playback                       | `envelope-echo/1` against the `self:playback` reference (ADR 035)                                                                                                 | Synthetic playbacks, 35–40 of 40 per case (`bench/results/self-echo-2026-11-14.md`)                                                                  | Real playbacks on the speakers (`self-echo.judged` logs)             |
| Search                                               | fr-norm index, `phonetic-fr/2` sound-alikes                                                                                                                       | Unit fixtures                                                                                                                                        | Phonetic recall on misheard names in the golden set                  |
| Spelling                                             | `vocabulary/3`: names the user corrected, and their names (list, People) by sound; look-alikes of the list by the journal's model (`vocabulary-check/1`, ADR 046) | Téo's week, counts in `bench/results/vocabulary-2026-11-26.md`                                                                                       | Name error rate on the golden set, with and without                  |

## Consequences

- Nemotron's cost stays the constraint: 17–19 GB at load, 2.7–4.3× real
  time, so final transcription keeps waiting for power and idle (ADR 016).
- None of these is accepted until the golden test split and its scorer
  exist; this ADR moves to Accepted, or is superseded, then.
