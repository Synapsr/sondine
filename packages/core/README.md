# @sondine/core

Pure domain logic in plain TypeScript: no Effect, no I/O, no clock. Every
function is deterministic for its input, so the `core` utility process, the
bench, and tests can call it the same way.

| Module                                      | Entry points                                                       | Version constant             |
| ------------------------------------------- | ------------------------------------------------------------------ | ---------------------------- |
| Episode grouping (architecture §7, ADR 007) | `groupEpisodes`                                                    | `GROUPING_VERSION`           |
| Size decision table (ADR 007)               | `decideSize`, `sizeInputOf`                                        | `SIZE_TABLE_VERSION`         |
| The user's voice in a call (ADR 016)        | `selfSpeakerLabel`                                                 | derived at read, not stored  |
| Text normalization `fr-norm`                | `frNorm`, `frNormTokens`, `frNormSpans`, `frNormId`                | `FR_NORM_VERSION`            |
| Original text ↔ `fr-norm` tokens            | `frNormAlign`, `frNormAlignId`                                     | `FR_NORM_ALIGN_VERSION`      |
| French number words                         | `frenchCardinalWords`, `frenchOrdinalWords`, `frenchDigitsToWords` | covered by `FR_NORM_VERSION` |
| WER and CER                                 | `wordErrorRate`, `charErrorRate`, `sumErrorCounts`                 | `ERROR_RATE_VERSION`         |

```bash
pnpm --filter @sondine/core test
pnpm --filter @sondine/core typecheck
```

## Versioning

Each version constant names the behaviour that produced a stored result:
episodes store `GROUPING_VERSION`, `kind_inputs` stores `SIZE_TABLE_VERSION`,
scores and search terms store `frNormId(options)` (version plus options), and
bench scores store `ERROR_RATE_VERSION`.

**Bump the constant whenever the output changes for any input**: a new rule, a
changed threshold, margin, gap, word list, or tie-break. Refactors that keep
every output identical do not bump. The golden and timeline tests are the
tripwire: if you have to edit an expected value, bump the version in the same
change. A bump lets core regroup or reclassify, and the bench re-score stored
hypotheses, instead of mixing results from two behaviours.

## Episode grouping v2

Input: speech regions of every track (ns times as `bigint` on the shared
capture timeline), call state transitions, app taps (app tracks open over a
span), system events, boundary constraints, and `untilNs`, the time up to
which input is complete. A region still open at `untilNs` is passed with
`endNs = untilNs`.

- **Lanes.** A live region (no echo flag) goes to one lane:
  - **call**: a call is active at the region's midpoint, and the region is on
    a mic (`input`, `phone`), comes from the call app (same bundle ID, or
    `isCallApp`), or is on `system:other` and may carry the call's far side:
    its `attributedBundleId` is the call app, or it has none while the call
    app has no tap of its own (`appTaps`). A `system:other` region
    attributed to another app stays media. Calls come from the transitions:
    with a `callId`, an `active` pairs with that id's `ended` only; the
    spans of one `callKey` (the app) that overlap or restart within 45 s are
    one call. Regions with `callActive` evidence and no recorded transition
    form an inferred call.
  - **in-person**: every other mic region, across mic changes.
  - **media**: every other app or system region, one lane per source
    (bundle ID, else track key), so a video moving from `system:other` to its
    own app tap stays one episode. `attributedBundleId` never picks the
    lane. A YouTube in Safari never joins mic speech; during a call it stays
    media unless Safari is the call app.
- **Gaps.** In-person closes after 45 s of silence (a gap of exactly 45 s is a
  boundary), media after 120 s. A call episode closes when the call ends, or
  after 5 min without speech on any of its tracks while the call goes on (the
  next exchange is a new episode of the same call); a call that restarts
  within 45 s is the same call. An in-person episode closes when a call
  starts.
- **System events.** `sleep`, `wake`, `pause`, `resume` are hard boundaries
  for every lane. `device-change` and `capture-restart` never split; they are
  listed in the episode's `discontinuities`.
- **3 h cap.** When a region pushes an episode over 3 h, the episode closes at
  its longest silence and the rest continues. Without silence (contiguous
  segmenter cuts, overlapping tracks) it closes at the region boundary with
  the least overlap. Ties go to the latest boundary that keeps the head within
  the cap. One region longer than the cap is kept whole and flagged
  `exceedsCap`.
- **Echo and duplicates.** `echo` and `duplicate` regions join the episode
  holding overlapping speech on the track they copy (`hiddenRegionIds`) and
  never count as voiced time; with no such speech they are `unassigned`.
  `self-playback` regions are always `unassigned`.
- **Constraints.** Splits and merges anchored to capture time, optionally
  scoped to track keys. Automatic constraints apply first, then the cap again,
  then manual ones; within each origin by ascending `seq`, so the last applied
  wins. A manual merge may exceed the cap (flagged); an automatic one may not.
  A split inside a region cuts it: both episodes list the region, each holds
  one slice (`regionSlices`, voiced time prorated by duration), and the second
  episode's key is `<regionId>@<startNs>`. A later merge across the split joins
  the slices again.
- **Context.** From the lanes of an episode's live regions: one kind gives
  `call`, `in_person` or `media`; several (only through merges) give `mixed`.
- **Provisional.** An episode is provisional while more speech could still
  join it: `closeReason` is null and `closesAtNs` says when it closes if
  nothing arrives (null while a call is active).
- **Stability.** Grouping is causal: an episode closed at some `untilNs` is
  identical in every later run on extended input, and the output does not
  depend on input order. Both are tested.

## Size decision table v1

`decideSize` is total: every input gets exactly one size. Rows, first match:

1. a manual size constraint (latest `seq`), then an automatic one;
2. `trace`: voiced < 1.5 s;
3. `conversation`: `call` context;
4. `conversation`: voiced ≥ 60 s;
5. `conversation`: elapsed ≥ 3 min and (≥ 2 speakers or ≥ 6 turns), once diarized;
6. `moment`: everything else.

Voiced time is deduplicated (echo and duplicate copies excluded); thresholds
affect presentation and priority, never retention.

- **Provisional.** `episode-open` while grouping keeps the episode open;
  `awaiting-diarization` for a moment that row 5 could still promote. A
  manual constraint is never provisional.
- **Hysteresis.** Given the previous automatic size, each threshold moves
  away from it by a margin: trace ± 0.3 s, voiced ± 6 s, elapsed ± 15 s,
  turns ± 1, speaker count and the call row without margin. A conversation
  stays one down to 54 s voiced; a moment needs 66 s to become one.
  `heldByHysteresis` says when the margin changed the answer.
- **`kind_inputs`.** `decision.inputs` holds every input, the constraint
  used, and the effective thresholds, as JSON-safe data for storage.

Merges and splits are boundary constraints of `groupEpisodes`; the table then
decides the size of each resulting episode.

## fr-norm v1

For WER scoring and search, applied identically to references and hypotheses.
Output is lowercase words separated by single spaces.

1. NFC; `[annotation]` and `<annotation>` tags removed; every apostrophe
   variant becomes `'`; every hyphen and dash becomes a space (so
   `peut-être`, `vingt-et-un`, `c'est-à-dire` split the same on both sides).
2. `œ → oe`, `æ → ae`; lowercase.
3. **Numbers, canonical direction digits → words** (French rules: `et un`,
   `soixante-dix`, `quatre-vingts`, `quatre-vingt-dix`, `cent/cents`,
   `mille`, `million(s)`, `milliard(s)`), then `vingts`/`cents` after a
   number word fold to `vingt`/`cent` because both spellings sound the same:
   - integers up to 999 999 999 999, digit by digit beyond, leading zeros
     read as `zéro` (`06` → `zéro six`);
   - thousands separators: space, no-break space, narrow no-break space, thin
     space, or `.` before exactly three digits (`10 000`, `1.000`);
   - decimals: `3,5` → `trois virgule cinq`, `3,05` → `trois virgule zéro
     cinq`, `3.14` → `trois point quatorze`;
   - `15 %` → `quinze pour cent`; `3,50 €` → `trois euros cinquante`,
     `0,50 €` → `cinquante centimes`, `1 000 000 €` → `un million d' euros`,
     `$` → `dollars`;
   - times: `14h30`, `14 h 30`, `14:30` → `quatorze heures trente`, feminine
     (`1h` → `une heure`, `21h` → `vingt et une heures`);
   - ordinals: `1er`, `1re`, `1ère`, `2e`, `3ème`, `2nd(e)`, plurals (`1ers`);
   - `n° 5` → `numéro cinq`; digits glued to letters split (`mp3` → `mp
     trois`);
   - with `numbers: "keep"`, none of the above: digits stay, and only the
     comma or point inside a number survives punctuation removal.
4. Punctuation and symbols removed (`&` → `et`).
5. Elisions split, keeping the apostrophe on the clitic: `l'`, `d'`, `qu'`,
   `j'`, `n'`, `s'`, `c'`, `m'`, `t'`, `jusqu'`, `lorsqu'`, `puisqu'`,
   `quoiqu'`. Lexical apostrophes stay whole (`aujourd'hui`, `quelqu'un`).
6. 1990 rectifications: circumflex dropped on `i` and `u` (`connaître` →
   `connaitre`) except where the reform keeps it (`dû`, `mû`, `crû`, `sûr`,
   `mûr`, `jeûne` and derivatives, `fût`, `eût`); `événement` → `évènement`,
   `clef` → `clé`; `pourcent` → `pour cent`.
7. Fillers `euh`, `heu`, `ben`, `bah`, `hein`, `mmh`, `hum` (and elongated
   forms such as `euuuh`, `mmmh`, `hmm`): dropped by default, or kept in that
   canonical spelling with `fillers: "keep"`.
8. Optional `diacritics: "strip"` for diacritic-insensitive scoring and search.

**English path** (`language: "en"`, or an `en` span in `frNormSpans`): the
same first steps, then lowercase, punctuation removed, contractions and
possessives kept (`don't`, `it's`), `&` → `and`, digits kept with their
decimal point, thousands commas dropped, fillers `uh`, `um`, `erm`, `hmm`,
`mm`, `mhm`.

Known limits: Roman numerals, negative numbers, units other than `%`, `€`,
`$`, and Belgian or Swiss `septante`/`nonante` are not normalized; a plain
space before three digits always reads as a thousands separator (`12 100`
→ `douze mille cent`).

## fr-norm alignment

`frNormAlign(text, options)` maps the original text to its `fr-norm` tokens,
for search highlights: units in order, never overlapping, skipping only
whitespace, each with the UTF-16 span of the original it covers and the
tokens it produces, all together exactly `frNormTokens(text, options)`.

The text is cut into pieces (a run of letters, ending at an apostrophe so
`l'` is one piece; a run of digits; any other character alone), and each
piece is normalized alone (cached: a piece alone has no context). Where that
differs from the whole text, a depth-first search merges neighbouring pieces,
finest grouping first, within six words: `15 %` → `quinze pour cent`,
`10 h 05`, `1 000`, `n° 5`, `quatre vingts`, `aujourd'hui`. A filler or
punctuation is a unit with no token. If no grouping agrees (an annotation
wider than six words), the whole text is one unit. `frNormAlignId(options)`
is `FR_NORM_ALIGN_VERSION` plus `frNormId(options)`: bump the version when a
change moves a token to another span.

## WER and CER

Levenshtein alignment with unit costs. Among alignments with the fewest
errors it picks the one with the fewest substitutions, which makes the S/I/D
breakdown unique (`a b` → `b c` is one deletion, one hit, one insertion).
`wordErrorRate` splits strings on whitespace; `charErrorRate` counts Unicode
code points, spaces included. Results carry the counts, the rate (null for an
empty reference with insertions), and the alignment. `alignment: false` gives
counts in O(hypothesis) memory; alignments above `MAX_ALIGNMENT_CELLS` must use
it. Aggregate a corpus with `sumErrorCounts`, never by averaging rates.
