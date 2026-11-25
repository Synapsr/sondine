# Nemotron word times on French meetings (SUMM-RE), 2026-11-09

Nemotron's word times can put a sentence's words minutes away from where
they were said: a 3 h 22 import's segments added up to 2.2 times its audio,
and naming one voice took other voices' names. This run measures the fault
and the repair the adapter makes since version 2 (`nemotron-times.ts`,
ADR 016 "Word times").

## Setup

- The eight SUMM-RE test meetings and scoring of
  `asr-meetings-2026-11-06.md`, with Nemotron run again through the 0.3.0
  app's sandboxed worker on the same MacBook Air M5 (on AC, swap near
  10 GB). Its scores did not move: WER 26.5 %, cpWER 17.6 %, tcpWER 19.0 %,
  2.6× real time, 19.0 GB peak.
- The result now keeps each segment's words with their times
  (`hypothesis[].tokens`), so the repair was applied offline to that run's
  output: same text and voices, only times differ.
- Measures, on words normalized as in the meetings run:
  - tcpWER (MeetEval 0.4.3, collar 5 s), with each hypothesis segment
    timed by its bounds, and with each word timed alone;
  - how far each word is from the reference word it matches (an edit
    alignment of the hypothesis in text order against the reference in time
    order, speakers ignored; 26,839 words matched);
  - how much audio the segments cover, and how many last longer than 2 s
    plus 1 s a word (the bound the voice pass uses to leave a segment out).

## Results

| Word times           | tcpWER, segments | tcpWER, words | Words > 2 s off | Words > 5 s off | Words > 30 s off | Segments / audio | Spread segments |
| -------------------- | ---------------- | ------------- | --------------- | --------------- | ---------------- | ---------------- | --------------- |
| As Nemotron writes   | 19.0 %           | 18.4 %        | 0.69 %          | 0.41 %          | 0.06 %           | 1.13×            | 97 of 5,620     |
| Repaired (slack 2 s) | 17.9 %           | 17.9 %        | 0.16 %          | 0.02 %          | 0                | 0.91×            | 3 of 5,620      |

The reference's segments cover 0.90 times the audio. Per meeting the
segments went from 0.81–1.43× to 0.75–1.02×.

The repair moved 357 of 32,112 words. The 155 that match a reference word
were all more than 1 s closer to it afterwards: median 9.8 s off before,
0.3 s after.

Slack, the distance a word may sit off the text order and keep its time:

| Slack | tcpWER, segments | tcpWER, words | Words > 2 s off | Segments / audio | Moved words 0.5 s further off |
| ----- | ---------------- | ------------- | --------------- | ---------------- | ----------------------------- |
| 0 s   | 17.9 %           | 17.9 %        | 0.13 %          | 0.88×            | –                             |
| 1 s   | 17.9 %           | 17.9 %        | 0.13 %          | 0.91×            | 1 of 188                      |
| 2 s   | 17.9 %           | 17.9 %        | 0.16 %          | 0.91×            | 0 of 155                      |
| 5 s   | 17.9 %           | 17.9 %        | 0.38 %          | 0.93×            | –                             |
| 15 s  | 18.4 %           | 18.2 %        | 0.56 %          | 0.99×            | –                             |

## Reading

- Most word times are right (median 0.05 s off); the fault is a few
  sentences whose words sit on the same voice's speech before or after. Each
  of them stretches a segment over the voices between, which is what made
  segments cover more than the audio and names jump between voices.
- The text order is reliable: every moved word that could be checked got
  closer to where it was said. Slack up to 3 s scores the same; at 2 s no
  checked word ended 0.5 s further off (at 1 s, one did), and words of
  voices talking over each other keep their times.
- Three segments still last longer than 2 s plus 1 s a word: their words are
  in order with a pause of 5 to 10 s inside, which the text order cannot
  tell from a real pause. The voice pass still leaves such segments out.
- Meetings run 20 minutes; Téo's import ran in 55-minute requests, where the
  fault was worse (2.2× the audio). The repair works per request, so it
  applies there the same way; a new transcript of that import will show it.
