# Commitments: precision on Téo's days (2026-11-10)

Téo, 2026-11-10: « j'ai énormément de faux engagements ». This measures the
journal's commitments (ADR 028) against his own and the prompt that replaces
`journal-prompt/1`. Numbers only: the labels, the transcripts and every
answer stay in `~/Library/Caches/sondine-bench/journal/` (`commitments/`).

## The evaluation set

- Every commitment the app had written with `journal-prompt/1` (87, from
  2026-11-04 to 2026-11-09, 43 episodes, 85 open and the 2 Téo marked « Pas
  un engagement »), each read with the lines around what it cites, and a
  search of all 337 written episodes for sentences that sound like a promise
  (« je t'envoie », « je te rappelle », « faut que je »…) that no commitment
  cited: 48 episodes in all.
- One judge (Claude), no second reading. A commitment is what someone owes
  someone else (Téo's word, 2026-11-10: « pas vraiment des promesses dans le
  sens qu'il faut traquer »): a voice commits to do something concrete after
  the conversation that the others are owed or wait for, or says yes to a
  request to do it. A plan one has for oneself is not one. 37 real
  commitments (10 of them borderline, counted half: 32), and 85 sentences that
  hold none, each with the reason.
- Pooled: a unit is the sentences that make one promise, with the voice that
  made it. A commitment written is right when it cites one of them and gives
  it to that voice; a second one on the same unit is a duplicate. Recall is
  over the units any version or the search found.
- This is also the set the new prompt was written against: its numbers are
  optimistic. The instructions' examples are generic phrases with no name
  or content of Téo's, but their kinds, and the shape of a few, come from
  the errors read here. The app's rewrite of the other
  289 episodes is the held-out check.

## Results

Qwen3.5 9B Q4_K_M, llama.cpp `b12233`, the product's requests (`sondine-bench
journal run --episodes labels`), on power, on Téo's Mac in use.

| Version                                     | Written | Right    | Precision | Recall          |
| ------------------------------------------- | ------- | -------- | --------- | --------------- |
| `journal-prompt/1` (the app's)              | 87      | 22.5     | 26 %      | 22.5 (70 %)     |
| v2a: a list of what is not one              | 55      | 16.5     | 30 %      | 16.5 (52 %)     |
| v2c: each entry with its kind               | 41      | 17       | 41 %      | 17 (53 %)       |
| v2d: kinds, « plan » narrowed               | 43      | 20.5     | 48 %      | 20.5 (64 %)     |
| **`journal-prompt/2`** (v2d, vague dropped) | **41**  | **20.5** | **50 %**  | **20.5 (64 %)** |

What « Aujourd'hui » lists first, the commitments where Téo's voice (named
« Moi », or recognized or suggested as him, ADR 030) is the one who promised
or the one promised to, on the 33 episodes where his voice is known:

| Version            | Listed | Right | Precision |
| ------------------ | ------ | ----- | --------- |
| `journal-prompt/1` | 40     | 14.5  | 36 %      |
| `journal-prompt/2` | 24     | 15    | 63 %      |

What the wrong ones were:

| Why not a commitment          | prompt/1 | prompt/2 |
| ----------------------------- | -------- | -------- |
| done right away               | 13       | 2        |
| a broadcast, video, assistant | 10       | 4        |
| a plan for oneself            | 11       | 6        |
| a request to someone else     | 9        | 3        |
| a suggestion or opinion       | 5        | 0        |
| a question or an offer        | 4        | 1        |
| something already done        | 3        | 1        |
| no action said                | 3        | 0        |
| the same promise again        | 2        | 2        |
| a fragment, information       | 3        | 1        |

## What did not pay

- **A list of exclusions** (v2a): the 9B model kept writing requests and
  actions done at once, and dropped plain promises (someone saying they
  would make a call for the other): recall 52 %.
- **Sorting by kind with a broad « plan »** (v2c): team tasks announced
  in a meeting, and a voice saying it would check with someone and come
  back, went to « plan »: recall 53 %. Narrowing it to what one does for oneself alone, and
  naming tasks taken on in front of the people one works with as promises,
  gave v2d.
- **A second reading by the model** (`journal commitments check`): each
  commitment with the lines around it and five plain questions (who says it
  will be done, whether it is said, asked or suggested, when, whether
  someone else is owed it, whether it is the conversation). Dropping all it
  rejects halves recall (v2d: 20 written, 11.5 right). Dropping only what it
  calls a request or a question: 36 written, 19.5 right (54 %, recall 61 %),
  and Téo's list 21, 14 right (67 %): 7 false ones fewer for one real one
  lost, at 9 s per episode holding a commitment (263 s for 30). Not adopted:
  a small gain on a small sample, for a second request type. Worth trying
  again on a larger labelled set or with a stronger model.
- **Rules**: the promiser must speak a cited sentence (removes 2 to 5, a
  real one among them: the model gives a request to the one who asks, who
  did speak); duplicates by voice, nearby sentences and close words (none
  in v2d). Kept: an action that is a verb and generic words only (« faire
  quelque chose », « faire des trucs »), 2 false ones, no real
  one.

## Claude Haiku, on Téo's subscription

With Téo's agreement (2026-11-10: whoever uses their subscription chooses
what leaves, as long as local choices remain), the 48 episodes went to
Anthropic through his Claude CLI (`journal run --engine claude --model
haiku`, `claude-haiku-5-5`, its default effort), with ADR 027's flags: no
tool but the one that carries the schema, no MCP server, none of his
settings, no session kept. The same requests as Qwen (`journal-prompt/2`).

| Form                                        | Written | Right | Precision | Recall | Téo's list, right | Compute             |
| ------------------------------------------- | ------- | ----- | --------- | ------ | ----------------- | ------------------- |
| Qwen alone (`journal-prompt/2`)             | 41      | 20.5  | 50 %      | 64 %   | 15 of 24 (63 %)   | about 1 400 s       |
| Haiku alone                                 | 65      | 26    | 40 %      | 81 %   | 16.5 of 34 (49 %) | 485 s               |
| Haiku, its check dropping what is done now  | 50      | 25.5  | 51 %      | 80 %   | 16.5 of 28 (59 %) | 485 + 132 s         |
| Qwen, Haiku's check dropping all it rejects | 25      | 17    | 68 %      | 53 %   | 12 of 15 (80 %)   | about 1 400 + 122 s |

- Haiku finds more of the real ones, most in one long call; its
  false ones are mostly things done during the conversation (11 of 35).
- Its check (`journal commitments check --engine claude`, the lines around
  each commitment and five plain questions) reads the questions as Qwen did
  not: on Qwen's commitments, dropping all it rejects keeps 17 right of 25;
  on its own, dropping only what it calls done now, done before or media
  removes 15, one borderline real one among them. Dropping all it rejects
  on its own: 43 written, 22 right (51 %, recall 69 %).
- Tokens: the pass 431 000 in (the CLI's own instructions included, cached
  between requests) and 93 000 out, thinking included; its check 104 000 in
  and 21 000 out. Only the last form sends excerpts alone, about ten lines
  around each candidate, instead of whole conversations.
- Fixtures 8 of 10: on the injection it wrote no commitment, and a line
  saying the attempt was made and refused (the fixture flags its words, as it
  did Qwen's once); « je demanderai à ma sœur » became a line, a plan of her
  own under the new definition; the code-switched promise passes, which Qwen
  never did.
- 6 of its commitments nobody had found were real, borderline ones: the set
  now holds 37 (32 counted), and every recall above is over them.

## Cost

| Version            | Compute, 48 episodes | Prompt tokens | Output tokens |
| ------------------ | -------------------- | ------------- | ------------- |
| `journal-prompt/1` | 1312 s (the app's)   | —             | 14 930        |
| v2c                | 1336 s               | 191 478       | 15 387        |
| v2d                | 1587 s               | 193 090       | 14 198        |

The instructions grew by about 500 tokens a window, read at about 320
tokens a second; output stays the same. Between the bench's own runs of
similar prompts the compute varied by a fifth, the Mac being in use (its
prompt phase from 477 s to 624 s): `journal-prompt/2` costs about what the
first did, a few seconds a window more at most. Resident memory 6.2 GiB, as
before. No CPU energy: `sondine-meter` wrote no sample in these runs, for a
reason not looked into. The instructions vary per window (the line count) before the
commitments' part, so the server's prompt reuse stops there; putting the
fixed text first could save its reading on every window after the first.

## Fixtures

8 of 10. The code-switched sentence still loses the user's promise, as with
`journal-prompt/1`. « I'll send them by Friday », said on Thursday 5
November, was given 8 November once (v2a and v2c gave the 6th): one to
watch.

## The bench

Sondine transcribed two long calls with Nemotron during these runs. The
bench now keeps its rule (one heavy model at a time): it looks every 5 s,
unloads its model and waits while Sondine runs Nemotron or its own journal
model, writes the episode it was on again afterwards, and gives no energy
or power for a run that had to wait. It keeps each episode as it ends, with
what the model read, so a stopped run starts where it was: with the same
model, prompt, language and database only, and writing again an episode
whose transcript changed since. Before that rule, one run overlapped
Nemotron and left the Mac with 4 % of its memory free and 17 GB of swap
for a few minutes: Sondine's admission loaded Nemotron while the bench's
6 GB model was resident.
