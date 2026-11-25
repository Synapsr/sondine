import type { Database } from "./database";
import type { EpisodeSummaryRow } from "./episodes-store";
import { currentSpeakerRun, resolveSpeakers } from "./people";
import { str } from "./rows";

/**
 * The phone recordings among `rows` that read « Note » (ADR 039): made by
 * the iPhone app, in person, and every voice of their transcript (the one
 * shown, while a better one may still come) named as the user. A suggestion (« Moi ? ») is not enough: the
 * user confirms it. Their context stays `in_person` for everything else.
 */
export function phoneNotes(db: Database, rows: readonly EpisodeSummaryRow[]): Set<number> {
  const out = new Set<number>();
  const labels = db.statement(
    "SELECT DISTINCT speaker_label FROM segments WHERE run_id = ? AND speaker_label IS NOT NULL",
  );
  for (const row of rows) {
    if (row.phone === null || row.context !== "in_person") continue;
    const runId = currentSpeakerRun(db, row.id);
    if (runId === null) continue;
    const voices = labels.all(runId).map((label) => str(label, "speaker_label"));
    if (voices.length === 0) continue;
    const named = resolveSpeakers(db, runId);
    if (voices.every((label) => named.get(label)?.isSelf === true)) out.add(row.id);
  }
  return out;
}
