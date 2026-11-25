# Phone voices, recognized? (ADR 030 for ADR 032, M5.8) — 2026-11-13

`node apps/bench/src/cli.ts voices phone`, on a copy of Sondine's database on
Téo's Mac (read only; the copy is deleted after the run). Only the voices the user
named, as the app embedded them; dictations are not references here. People
are numbered, never named. Embedder: `wespeaker-v2:22e733a578037be63201c0d4efd8889cf43235faa96f6e60104dd5ad850ca8b2:sondine-windows-v1`.

## What there is

- Recordings made by the iPhone app: 7 kept (2.2 min, 2 days), 6 deleted.
- Their voices embedded: 1; named by the user: 0, on 0 days, 0 trials (a person in a recording).
- Unnamed phone voices, as the app shows them today: 0 recognized, 1 suggested, 0 nothing.
- Imported files on the phone channel (not the app's; never embedded, context `imported`): 7, left out.
- Recordings that may have heard the same moment, left out of each other's references: 0 pairs (linked by M5.7: 0; the others meet on the clock, 2 minutes wider, 15 for an uncertain time).

Recognizable: three recordings on two days left whatever day of the person's phone
recordings is held out, against phone references, and against microphone references.

| Person              | Microphone recordings named (days) | Phone recordings named (days) | Recognizable: phone / microphone references |
| ------------------- | ---------------------------------- | ----------------------------- | ------------------------------------------- |
| person 1 (the user) | 8 (3)                              | 0 (0)                         | no / no                                     |
| person 2            | 4 (2)                              | 0 (0)                         | no / no                                     |
| person 3            | 1 (1)                              | 0 (0)                         | no / no                                     |

## The rule, held out

A trial is one person in one recording: every voice named as them there, the worst
outcome counting (one voice taken for someone else makes the trial wrong). Known: the
person has references left. Stranger: the same voices with their person's references
taken out. Right / wrong: the person suggested or recognized.

### A phone voice against microphone references

| Held out by | Rule                              | Known people (trials) | Recognized right / wrong | Suggested right / wrong | Nothing | Stranger people (trials) | Strangers recognized (people) | Strangers suggested (people) | Best stranger confidence |
| ----------- | --------------------------------- | --------------------- | ------------------------ | ----------------------- | ------- | ------------------------ | ----------------------------- | ---------------------------- | ------------------------ |
| episode     | built (suggested only, from 99 %) | 0 (0)                 | 0 / 0                    | 0 / 0                   | 0       | 0 (0)                    | 0 (0)                         | 0 (0)                        | —                        |
| episode     | opened (as measured: 80 % / 99 %) | 0 (0)                 | 0 / 0                    | 0 / 0                   | 0       | 0 (0)                    | 0 (0)                         | 0 (0)                        | —                        |
| day         | built (suggested only, from 99 %) | 0 (0)                 | 0 / 0                    | 0 / 0                   | 0       | 0 (0)                    | 0 (0)                         | 0 (0)                        | —                        |
| day         | opened (as measured: 80 % / 99 %) | 0 (0)                 | 0 / 0                    | 0 / 0                   | 0       | 0 (0)                    | 0 (0)                         | 0 (0)                        | —                        |

### A phone voice against phone references

| Held out by | Rule                              | Known people (trials) | Recognized right / wrong | Suggested right / wrong | Nothing | Stranger people (trials) | Strangers recognized (people) | Strangers suggested (people) | Best stranger confidence |
| ----------- | --------------------------------- | --------------------- | ------------------------ | ----------------------- | ------- | ------------------------ | ----------------------------- | ---------------------------- | ------------------------ |
| episode     | built (suggested only, from 99 %) | 0 (0)                 | 0 / 0                    | 0 / 0                   | 0       | 0 (0)                    | 0 (0)                         | 0 (0)                        | —                        |
| episode     | opened (as measured: 80 % / 99 %) | 0 (0)                 | 0 / 0                    | 0 / 0                   | 0       | 0 (0)                    | 0 (0)                         | 0 (0)                        | —                        |
| day         | built (suggested only, from 99 %) | 0 (0)                 | 0 / 0                    | 0 / 0                   | 0       | 0 (0)                    | 0 (0)                         | 0 (0)                        | —                        |
| day         | opened (as measured: 80 % / 99 %) | 0 (0)                 | 0 / 0                    | 0 / 0                   | 0       | 0 (0)                    | 0 (0)                         | 0 (0)                        | —                        |

## Verdict

- A phone voice against phone references, held out by day, rule opened: **too-few** (named phone voices on 0 days of 3; 0 people recognizable held out by day, of 4; 0 stranger trials of 30).
- A phone voice against microphone references, held out by day, rule opened: **too-few** (named phone voices on 0 days of 3; 0 people recognizable held out by day, of 4; 0 stranger trials of 30).
- `PHONE_VOICES_MEASURED` (packages/db voices.ts) is off: a phone voice is suggested only, from 99 %. It turns on only when the phone-against-phone pair passes; a voice compared across channels stays suggested only either way (ADR 030).
- Enough means: named phone voices on 3 days or more, 4 people or more (the user and three others) each recognizable whatever day is held out (3 recordings on 2 days left), and 30 stranger trials or more. Zero strangers recognized among few people bounds nothing tightly: it is what was seen, not a rate.

## Reading

- Téo started recording with the iPhone app on 2026-11-12: seven short
  recordings kept, none of their voices named yet, and one of them long
  enough to be embedded. Neither pair can be measured; `phone` stays at
  suggestions only, as ADR 032 decided.
- What is needed, and how to label it: `apps/bench/README.md`, « Labelling
  enough phone recordings ».
- The 3 h phone file of 2026-11-08 that ADR 030 measured by hand is an
  import (not the app's): the app never embeds it, so it is not counted
  here. Its numbers stay those of ADR 030.
