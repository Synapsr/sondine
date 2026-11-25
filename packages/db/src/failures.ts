import type { Database } from "./database";
import { int, str } from "./rows";

// What failed lately, by code, for the diagnostic the user reads and sends
// (ADR 042): codes and counts only, never a message.

export interface FailureCount {
  readonly area: "transcription" | "journal";
  readonly code: string;
  readonly times: number;
}

export function failuresSince(db: Database, sinceMs: number): FailureCount[] {
  return db
    .statement(
      `SELECT 'transcription' AS area, error_code AS code, count(*) AS times FROM job_attempts
        WHERE outcome = 'failed' AND finished_at_ms >= ? AND error_code IS NOT NULL GROUP BY error_code
       UNION ALL
       SELECT 'journal' AS area, error_code AS code, count(*) AS times FROM journal_runs
        WHERE status = 'failed' AND finished_at_ms >= ? AND error_code IS NOT NULL GROUP BY error_code
       ORDER BY area DESC, times DESC, code`,
    )
    .all(sinceMs, sinceMs)
    .map((row) => ({
      area: str(row, "area") === "journal" ? "journal" : "transcription",
      code: str(row, "code"),
      times: int(row, "times"),
    }));
}

export interface JobCounts {
  readonly queued: number;
  readonly running: number;
  readonly failed: number;
}

export function jobCounts(db: Database): JobCounts {
  const of = (state: string) =>
    int(db.statement("SELECT count(*) AS n FROM jobs WHERE state = ?").get(state) ?? { n: 0 }, "n");
  return { queued: of("queued"), running: of("running"), failed: of("failed") };
}
