import { homedir } from "node:os";
import { join } from "node:path";

/** The copy of Sondine's database lives here while the bench reads it, then goes. */
export const privateVoices = join(homedir(), "Library", "Caches", "sondine-bench", "voices");

export const voicesUsage = `voices phone [--db <sondine.db>] [--results <dir>] [--date <YYYY-MM-DD>] [--keep-copy]
      ADR 030's report for phone voices (ADR 032, M5.8): every voice named on a recording
      made by the iPhone app, held out by episode and by day, against microphone references
      and against phone references, known and as a stranger, under the rule built and the
      rule a pass would open. Reads a copy of Sondine's database (made read-only, kept in
      ${privateVoices}/phone and deleted after the run unless --keep-copy) and writes
      numbers only, people as « person n », to <results>/voices-phone-<date>.md.
        --db <sondine.db>    default: the signed app's group container
        --results <dir>      default bench/results
        --date <YYYY-MM-DD>  the result's date (default today)`;
