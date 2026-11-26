# The Vocabulary on Téo's week — measurements (ADR 046)

Téo's Mac (Apple M5, 32 GB, macOS 27.2), 2026-11-26. A copy of the
database (`sqlite3 .backup`) in a private temporary folder, deleted after;
counts only here, no transcript text. The list: « Téo » and « Sondine »
(note « le nom de mon app »), and Téo's 9 People.

```bash
pnpm bench vocabulary run --db <copy.db> --out <private dir> \
  --model <qwen3.5-9b-q4km/model.gguf> --server <llama-server b12233> \
  --words "Téo,Sondine=le nom de mon app"
```

## What was read

The last 7 days: 178 closed call, in-person and mixed episodes with a
transcript, 6,383 sentences.

## The rule without a model (`vocabulary/3`)

| what                               | words |
| ---------------------------------- | ----: |
| « Théo » → « Téo »                 |    52 |
| « Theo », « Teo » → « Téo »        |     2 |
| « Sondin » → « Sondine »           |     2 |
| People's names written another way |    28 |
| total                              |    84 |

- Of the 52 « Théo », read in their sentences: about 46 are Téo (addressed,
  or talked about as the one doing his work), 2 are another Théo named with
  his surname, 4 cannot be told.
- The 28 People's names are three people's (12, 11, 5), each written
  another way that sounds the same.
- Cost: the whole week settled in 0.8 s (node, the copy's migration
  included); at publish, reading the vocabulary takes 1.7 ms and spelling the
  week's longest episode (2,056 sentences) 8.9 ms; the queue's query 0.7 ms.

## The journal's model (`vocabulary-check/1`)

| run                                          | candidates | yes | right | wrong |
| -------------------------------------------- | ---------: | --: | ----: | ----: |
| list and People, first prompt, batches of 12 |         21 |   2 |     — |     — |
| list and People, `refers_to`, batches of 12  |         21 |  13 |     9 |     2 |
| the list only, one batch of 9                |          9 |   4 |     4 |     0 |
| the list only, one request each (3 runs)     |          9 | 6–7 |   6–7 |     0 |

- The 9 candidates are « Sandrine » (3) and « Sandine » (6) in 8 sentences;
  read in their sentences, all 9 mean the app.
- The People's look-alikes (12 more) gave 2 wrong yeses, other people or a
  common word: the model reads the list's words only. In the first two runs,
  2 more yeses were a person's name spelled another way, which the
  sentences cannot settle (« right » and « wrong » leave them out).
- The final run (the code as committed: the rule, then the model) said yes
  to 7. Its cost: 9 requests, 2,709 prompt and 516 output tokens, 38.6 s
  of compute; the server's resident memory at most 6.55 GB; the model
  loaded in 2.8 s (files in the page cache; 14 s on the first, cold load).
  Over a week: under a minute of the journal's model, in its units.
