import { transaction, type Database } from "./database";
import { publishAnalysis, type PublishResult, type SegmentInput, type TurnInput } from "./publish";
import { int, str } from "./rows";

// Near-live text (architecture §10, ADR 019): while an episode is open, a
// small engine transcribes its finished speech and publishes it as the
// episode's `asr_live` run, replaced whole at each publish and by the final
// transcript once it exists. Live runs are throwaway: a superseded or refused
// one is deleted, so a long call does not leave a row per publish.

const ENABLED_KEY = "live.enabled";

/** Whether the user turned near-live text on (off by default). */
export function liveEnabled(db: Database): boolean {
  const row = db.statement("SELECT value FROM settings WHERE key = ?").get(ENABLED_KEY);
  return row !== undefined && JSON.parse(str(row, "value")) === true;
}

export function setLiveEnabled(db: Database, enabled: boolean, nowMs: number): void {
  db.statement(
    `INSERT INTO settings (key, value, updated_at_ms) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms`,
  ).run(ENABLED_KEY, JSON.stringify(enabled), nowMs);
}

export interface LiveEngine {
  readonly engineId: string;
  readonly engineVersion: string;
  readonly engineRuntime: string;
  readonly adapterClass: string;
  readonly modelSha256: string | null;
}

export interface PublishLiveInput {
  readonly episodeId: number;
  /** The generation the units were read at: a region that joined since makes it stale. */
  readonly inputGeneration: number;
  readonly engine: LiveEngine;
  /** What the text was made from (the units' keys), for provenance. */
  readonly inputHash: string;
  readonly segments: readonly SegmentInput[];
  readonly turns: readonly TurnInput[];
  readonly nowMs: number;
}

/**
 * Creates a live run and publishes it in one transaction; the run it
 * supersedes, or itself when refused, is deleted. The episode's analysis
 * state is left alone: live text is not a finished transcript.
 */
export function publishLive(db: Database, input: PublishLiveInput): PublishResult {
  return transaction(db, () => {
    const run = db
      .statement(
        `INSERT INTO analysis_runs (episode_id, stage, status, engine_id, engine_version,
           engine_runtime, adapter_class, model_sha256, engine_config, input_hash,
           input_generation, started_at_ms, finished_at_ms)
         VALUES (?, 'asr_live', 'succeeded', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
      )
      .get(
        input.episodeId,
        input.engine.engineId,
        input.engine.engineVersion,
        input.engine.engineRuntime,
        input.engine.adapterClass,
        input.engine.modelSha256,
        JSON.stringify({ speakers: false, timestamps: true }),
        input.inputHash,
        input.inputGeneration,
        input.nowMs,
        input.nowMs,
      );
    if (run === undefined) throw new Error("no live run row");
    const runId = int(run, "id");
    const result = publishAnalysis(db, {
      episodeId: input.episodeId,
      stage: "asr_live",
      runId,
      inputGeneration: input.inputGeneration,
      segments: input.segments,
      turns: input.turns,
      nowMs: input.nowMs,
    });
    const gone = result.published ? result.supersededRunIds : [runId];
    for (const id of gone) {
      db.statement("DELETE FROM analysis_runs WHERE id = ? AND stage = 'asr_live'").run(id);
    }
    return result;
  });
}
