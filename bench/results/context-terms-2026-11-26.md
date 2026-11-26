# Context terms with Nemotron's speakers (2026-11-26)

Can Nemotron 3.5 Transcribe be given the words it spells wrong (a product
name, a first name with an unusual spelling) in the pass that also gives the
speakers (ADR 016, ADR 018)? speech.cpp refuses `prompt` with `speakers`
(`recognizer.cpp`, 0.9.3 to 0.11.2). Exploration only: nothing in the product
changed.

## Setup

- Host: MacBook Air M5, 32 GB, with Sondine Exp 0.8.0 running; each request
  started after 10 min without input and stopped if the user came back.
- speech.cpp 0.9.3 built from source (Metal) with a patch that accepts
  `prompt` with `speakers`: the user turn is the card's prompt for speaker
  tags, then `Context terms: <prompt>.` (the card's contextual sentence).
  IQ4_NL weights, `--device gpu --threads 4`, no language hint.
- Four French excerpts, 32 min: SUMM-RE `024c_EBPH`, first 594.5 s (three
  voices, close-talk tracks summed); two 10-min call excerpts (one remote voice
  each); a 3-min video excerpt with three voices. The three last are private
  and stayed on the Mac, deleted after the run.
- One list of 4 terms for every excerpt, as a vocabulary list would be: two
  said in the private excerpts, two in the meeting; each is a distractor
  elsewhere.
- Requests: `speakers`+`timestamps` (the product's), the same with the terms
  (patched), and `timestamps`+`prompt` without speakers (0.9.3 allows it).
- tcpWER: MeetEval 0.4.3, collar 5 s, plain lower-case normalisation (not
  `fr-norm/1`): compare columns, not with `asr-meetings-2026-11-06.md`.

## Results

|                                                 | speakers       | speakers + terms | terms, no speakers |
| ----------------------------------------------- | -------------- | ---------------- | ------------------ |
| Spoken occurrences of the two private terms     | 0 / 5 right    | 5 / 5 right      | 5 / 5 right        |
| Similar real names rewritten as a term          | 0 / 3          | 2 / 3            | 0 / 3 (1 altered)  |
| Distractor terms inserted                       | 0              | 0                | 0                  |
| SUMM-RE tcpWER                                  | 20.56 %        | 20.61 %          | no speakers        |
| Speaker agreement with column 1 (100 ms frames) | 100 %          | 97.0 – 100 %     | —                  |
| Word changes against column 1                   | 0 %            | 0.2 – 5.3 %      | 3.8 – 24.3 %       |
| Words within 1 s of column 1, meeting / video   | 100 % / 100 %  | 100 % / 100 %    | 56 % / 73 %        |
| Loops (`stop` other than complete)              | 0              | 0                | 0                  |
| Request with load, 600 s call                   | 106 s          | 108 s            | 112 s              |
| Request with load, SUMM-RE excerpt              | 132 s          | 137 s            | 113 s              |
| Peak memory                                     | 18.7 – 19.3 GB | 18.7 – 19.3 GB   | 18.7 – 19.3 GB     |

Two runs of the same request gave identical output (columns 1 and 2): the
differences above are the prompt's, not noise.

## Reading

- The combined prompt spells the terms and keeps the speakers and the word times,
  for 2 to 4 % more time. Its risk: names that sound like a term become the term (2 of 3
  deliberately chosen near names; the terms pass without speakers changed none
  into the term), so on this sample it pulls harder than the card's prompt.
- Without speakers, the CTC alignment takes the transcript as one voice and
  its times drift on conversations, so the other routes are worse: the terms
  pass's words merged with `speech diarize` (`nemotron-3-diarization`, 16 s
  for 72 min, 0.43 GB) give 81 % tcpWER on the meeting, and merged with the
  product's speakers (two Nemotron passes) 103 %. That pass also drops the
  fillers the product keeps.
- vLLM with NVIDIA's plugin takes any prompt (its timestamp middleware does
  not read it), but needs a CUDA GPU of 48 GB or more for FP8 (Blackwell for
  NVFP4), a Python stack beside speech.cpp, and still runs an unevaluated
  prompt: not worth it for this alone.
