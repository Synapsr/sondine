# ASR on French meetings (SUMM-RE) — M1 step 3 (2026-11-06 and 07)

Conversational French with 3–4 speakers, the condition FLEURS does not
cover. Public data stays a diagnostic (architecture §13): the golden set
selects. Nemotron, Parakeet and Qwen3-ASR 1.7B have run; Qwen3-ASR 0.6B is
running.

## Setup

- Host: MacBook Air M5 (`Mac17,4`), 32 GB, macOS 27.0.1, with Sondine
  running. Parakeet ran on battery with 18 GB of swap in use; Nemotron on
  AC, its 17 GB load pushing swap to 30 GB, which slowed it.
- Corpus: eight SUMM-RE test meetings (CC-BY-SA-4.0, revision `47cb4ec`),
  eight participant groups, two over Zoom (`012c_EBPZ`, `093c_EBPZ`),
  2 h 38 min in all. Each participant's close-talk track is summed into one
  mix, the condition of one microphone in a room (a mix of close-talk mics
  also carries each voice's crosstalk).
- Engines: Nemotron 3.5 Transcribe 30B IQ4_NL as the product sends audio
  (the app's sandboxed worker, speakers and timestamps, no language hint);
  Parakeet TDT 0.6B v3 F16 and Qwen3-ASR 1.7B Q8_0 in speech.cpp 0.9.3's
  own pipeline (Silero regions, Sortformer speakers, each region's text to
  the speaker who speaks most in it), no language hint.
- Scoring: MeetEval 0.4.3 tcpWER (collar 5 s) and cpWER, and a
  speaker-agnostic WER (all words in time order); words normalized with
  `fr-norm/1`, apostrophes as separators (SUMM-RE writes « l heure »).
- Command: `node apps/bench/src/cli.ts asr meetings --engine <id>`.

## Results

| Engine               | WER    | cpWER  | tcpWER | Speakers found | Deleted | Inserted | RTFx  | Peak    |
| -------------------- | ------ | ------ | ------ | -------------- | ------- | -------- | ----- | ------- |
| nemotron             | 26.5 % | 17.6 % | 19.0 % | 8/8 meetings   | 7.9 %   | 9.2 %    | 2.7×  | 19.0 GB |
| qwen3-asr-1.7b       | 26.0 % | 41.2 % | 43.9 % | 8/8 meetings   | 17.8 %  | 1.6 %    | 10.1× | 2.8 GB  |
| parakeet-tdt-0.6b-v3 | 42.1 % | 50.0 % | 51.8 % | 8/8 meetings   | 31.6 %  | 1.5 %    | 73.1× | 1.9 GB  |

Per meeting, tcpWER:

| Meeting   | Length   | Overlapped words | Nemotron | Qwen3 1.7B | Parakeet |
| --------- | -------- | ---------------- | -------- | ---------- | -------- |
| 007a_ECRH | 20.2 min | 32 %             | 21.8 %   | 51.7 %     | 64.2 %   |
| 012c_EBPZ | 19.3 min | 14 %             | 19.1 %   | 36.2 %     | 39.6 %   |
| 013c_EAPD | 20.4 min | 32 %             | 18.1 %   | 45.2 %     | 50.6 %   |
| 024c_EBPH | 20.6 min | 29 %             | 11.6 %   | 37.8 %     | 48.3 %   |
| 047a_EDRH | 18.3 min | 22 %             | 11.7 %   | 34.0 %     | 49.4 %   |
| 077c_EBPH | 20.2 min | 23 %             | 24.0 %   | 48.0 %     | 49.4 %   |
| 093c_EBPZ | 18.8 min | 14 %             | 18.0 %   | 33.2 %     | 42.1 %   |
| 102a_EBRH | 20.2 min | 39 %             | 25.1 %   | 54.1 %     | 57.5 %   |

With its word times repaired (2026-11-09), Nemotron's tcpWER is 17.9 %
(`word-times-2026-11-09.md`).

"Overlapped words": reference words whose time meets another speaker's
segment. "Deleted" and "Inserted" are shares of the reference words in the
speaker-agnostic count (31,704 words).

## Reading

- Nemotron hears overlapping speech; Parakeet does not. Nemotron writes
  32,112 words for 31,704 in the reference, Parakeet 22,167: Parakeet's
  errors are missing words (31.6 % deleted) where people talk over each
  other, while where one person speaks it writes 93–98 % of the words.
  Nemotron emits overlapping segments of distinct voices (116 to 491 pairs
  per meeting), so it transcribes both people.
- That is also why Nemotron's speaker-agnostic WER (26.5 %) is worse than
  its cpWER (17.6 %): putting two voices' words in one time-ordered stream
  interleaves them. For an engine that transcribes overlap, cpWER and
  tcpWER are the measures; tcpWER adds 1.4 points for timing.
- On conversations, Nemotron is far ahead: tcpWER 19.0 % against 51.8 %,
  ahead in every meeting, with the right number of speakers everywhere. This
  matches what Téo saw on his own talks, and keeps it the reference engine
  for conversations.
- Qwen3-ASR 1.7B hears more than Parakeet (17.8 % of words deleted against
  31.6 %, 26,554 words written) but loses it on who said what: the region
  pipeline gives each region to one speaker, so cpWER rises from 26.0 % to
  41.2 %, against Nemotron's 17.6 %. Its words alone are not the problem;
  the attribution is, which a better speaker stage than "one speaker per
  region" could change.
- Its cost stands: 19 GB peak and 2.7× real time here (with swap at 30 GB;
  3.5–4.3× on FLEURS). Parakeet costs 1.9 GB and runs at 73×; it stays a
  candidate for clear one-person speech and for live text, not for meetings.
- In a call Sondine records the microphone and the Mac's sound as separate
  tracks, so the two sides never mix; in a room they do, and this run is
  that condition.

## Not yet measured

Qwen3-ASR 0.6B (running); the golden set; energy and the always-on budget;
repeated runs.
