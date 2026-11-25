import { homedir } from "node:os";
import { join } from "node:path";

/** Transcripts and answers stay here, outside the repository. */
export const privateResults = join(homedir(), "Library", "Caches", "sondine-bench", "journal");

export const journalUsage = `journal run --label <id> --model <file.gguf> --server <llama-server> [options]
      Writes a journal and commitments for real days and the synthetic fixtures with one
      model, through the product's requests (ADR 028), and measures its cost. Copies
      Sondine's database first; results stay in ${privateResults}.
        --engine <llama|claude>         llama: --model is a GGUF, --server llama-server (default);
                                        claude: --model an alias (haiku), --server the claude
                                        CLI; the text goes to Anthropic on the user's account
        --effort <low|medium|high>      Claude's effort (default: the CLI's)
        --days <2026-11-07,2026-11-09>  local days (default: none, fixtures only)
        --episodes <ids|labels>         episodes as well, or every one the labels judge
        --db <sondine.db>               default: the signed app's group container
        --language <fr|en>              what the journal is written in (default fr)
        --context <16384>               the server's context, in tokens
        --socket <path.sock>            where the server listens (default /tmp/sondine-bench-journal.sock)
        --meter <path>                  sondine-meter for footprint and CPU energy (optional)
        --out <dir>                     default ${privateResults}

  journal report <label>...         numbers for bench/results (no transcript text)
  journal review <label>            every item with the lines it cites (private)

  journal commitments export <label> [--db <sondine.db>] [--config <key>]
      What the app published with one configuration (default: the most used), from a copy
      of its database, as a run to score.
  journal commitments score <label>... [--labels <file>] [--episodes <ids|labels>] [--db <copy>]
      Precision, recall and wrong commitments by family against the labels (default
      ${privateResults}/commitments/labels.json); writes the unjudged ones, with the lines
      around them when --db is given, to <label>-unjudged.md (private).
  journal commitments check <label> --model <file.gguf> --server <llama-server> --db <copy the run read>
      A second reading of the run's commitments by the model, each with the lines around it;
      writes <label>-checked without those it refused, and what the check cost.`;
