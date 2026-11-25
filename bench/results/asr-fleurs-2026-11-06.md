# ASR on FLEURS fr/en — first M1 step 3 runs (2026-11-06)

Read speech only: these runs say how well each engine hears clear French and
English, and what it costs. They say nothing about conversations, overlaps or
who speaks, which the golden set decides (architecture §13: public corpora are
diagnostics, the private test split selects).

## Setup

- Host: MacBook Air M5 (`Mac17,4`), 32 GB, macOS 27.0.1, on AC power, with
  Sondine running and Téo's apps open (19–26 GB of swap already in use).
- Corpora: FLEURS test, `fr_fr` and `en_us` at revision `70bb2e8`, the first
  100 sentence ids, one recording each (17.5 min and 18.1 min of audio).
  Manifests `e959fd11…` (fr) and `ffbfdbf0…` (en).
- Engines on speech.cpp 0.9.3 (Metal), each through the product's worker
  adapter: Nemotron 3.5 Transcribe 30B IQ4_NL as the product sends audio
  (speakers and timestamps, no language hint, the app's sandboxed worker);
  Parakeet TDT 0.6B v3 F16, Qwen3-ASR 1.7B Q8_0 and Qwen3-ASR 0.6B Q8_0 as
  text only, no language hint.
- Scoring: `fr-norm/1` (fillers dropped, French numbers spelled out),
  `error-rate/1`, counts pooled over items, 95 % interval by resampling items.
- Command: `node apps/bench/src/cli.ts asr run --engine <id> --corpus <id> --size 100`.

## Results

| Corpus    | Engine               | WER   | WER 95 %      | CER   | WER without digits | RTFx   | Cold load | Peak    |
| --------- | -------------------- | ----- | ------------- | ----- | ------------------ | ------ | --------- | ------- |
| fleurs-fr | nemotron             | 4.6 % | 3.4 % – 5.9 % | 1.9 % | 4.7 %              | 3.5×   | 8.1 s     | 17.0 GB |
| fleurs-fr | parakeet-tdt-0.6b-v3 | 4.7 % | 3.5 % – 6.2 % | 1.4 % | 4.4 %              | 123.4× | 0.6 s     | 1.3 GB  |
| fleurs-fr | qwen3-asr-1.7b       | 4.3 % | 3.2 % – 5.4 % | 1.6 % | 3.6 %              | 11.6×  | 1.2 s     | 2.3 GB  |
| fleurs-fr | qwen3-asr-0.6b       | 7.8 % | 6.3 % – 9.5 % | 3.0 % | 7.3 %              | 28.0×  | 0.6 s     | 1.0 GB  |
| fleurs-en | nemotron             | 7.6 % | 5.6 % – 9.6 % | 5.3 % | 3.4 %              | 4.3×   | 7.2 s     | 17.0 GB |
| fleurs-en | parakeet-tdt-0.6b-v3 | 5.4 % | 4.1 % – 6.8 % | 1.8 % | 4.4 %              | 134.0× | 0.5 s     | 1.3 GB  |
| fleurs-en | qwen3-asr-1.7b       | 4.0 % | 2.8 % – 5.3 % | 1.5 % | 2.9 %              | 13.2×  | 1.0 s     | 2.3 GB  |
| fleurs-en | qwen3-asr-0.6b       | 5.7 % | 4.2 % – 7.1 % | 2.3 % | 4.2 %              | 38.3×  | 0.4 s     | 1.0 GB  |

"Without digits" covers the 75 items per language whose reference has no
digit (see below).

## Reading

- On clear read speech the four engines are close: the intervals of
  Nemotron, Parakeet and Qwen3 1.7B overlap in both languages. Qwen3 1.7B is
  the best point estimate (3.6 % French and 2.9 % English without digits),
  Qwen3 0.6B the clear last in French (7.3 %). Most remaining errors are
  proper names and homophones (« ces » / « ses ») for all.
- Parakeet matches Nemotron in French (4.4 % vs 4.7 % without digits) at
  35 times the speed and a thirteenth of the memory; Qwen3 1.7B costs 2.3 GB
  and runs at 12–13× real time.
- Nemotron's English WER is inflated by numbers: it writes « two thousand
  seven » where the reference has « 2007 », and `fr-norm` keeps English
  digits. On the 75 items without digits, Nemotron is ahead (3.4 % vs
  4.4 %). Fixing this belongs in `fr-norm`'s English path (a version bump,
  which also touches search) or in a bench-only number policy; until then
  read the « without digits » column for English.
- Costs: Nemotron's 17 GB peak and 3.5–4.3× real time are why Sondine only
  transcribes when the Mac is idle; Parakeet's 1.3 GB and 120–130×, or Qwen3
  1.7B's 2.3 GB and 12×, would allow transcription while Téo works.
- Times: Sondine needs each segment's time (search highlights, click to
  play). Parakeet and Nemotron give word times; Qwen3-ASR on speech.cpp gives
  text only, so a Qwen3 pipeline needs VAD regions as segments or an
  alignment stage, which belongs to the comparison. Cold loads are with the weights in the OS
  file cache; a first load after a reboot is longer (34 s measured for
  Nemotron in the ADR 016 spike).
- None of this measures conversation, overlap, or speaker attribution, where
  Nemotron is the only engine Téo has seen work in French. That is the golden
  set's job (three situations, 30 min, being prepared), with Sortformer
  speakers for the challengers.

## Not yet measured

Conversational French (SUMM-RE with MeetEval tcpWER); the golden set and
speaker attribution (Sortformer for the challengers); energy and the
always-on budget while an engine runs; repeated runs; a Whisper control row.
