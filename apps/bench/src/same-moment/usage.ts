import { defaultResultsDirectory } from "../paths.ts";

export const sameMomentUsage = `same-moment run --pairs <pairs.json> [options]
      The same-moment detector (ADR 032, M5.7) on real double recordings: each pair is
      decoded as the import does, compared as core does, and scored against the hand clap
      marked in both files. pairs.json stays outside the repository (it names files); the
      result is numbers only. Exit code 3 when a pair fails M5.7's exit.
        --label <id>        name of the result (default "local")
        --search <2m>       how far from the clocks' proposal to search (core: 2m)
        --shift <37s>       without macStartMs, the proposal is moved this far from the clap
        --out <dir>         default ${defaultResultsDirectory}

  same-moment synthetic [--long] [--seed <n>]
      The same on synthetic pairs made here (near, far, noisy, a 3 minute overlap, three
      pairs of rooms), with the CPU per hour of audio; --long adds an hour against an hour.`;
