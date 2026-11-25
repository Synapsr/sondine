import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildCommitmentCheck,
  readCommitmentCheck,
  speakerRefs,
  type CommitmentCheckVerdict,
  type JournalCommitmentDraft,
} from "@sondine/core";
import { loadJournalSource, openDatabase } from "@sondine/db";
import type { CommitmentCandidate, CommitmentExport } from "./commitments.ts";
import {
  benchTextEngine,
  sondineWatch,
  untilDone,
  yieldToSondine,
  type BenchEngine,
} from "./run.ts";

// `sondine-bench journal commitments check <label>`: the second reading of
// a run's commitments (ADR 028), measured apart from the first, on the copy
// of the database the run read: what it keeps, and what it cost.

export interface CommitmentCheckCost {
  readonly requests: number;
  readonly promptTokens: number;
  readonly outputTokens: number;
  readonly computeMs: number;
  /** Answers not the shape asked for: their commitments are kept. */
  readonly failed: number;
  readonly dropped: Readonly<Partial<Record<CommitmentCheckVerdict, number>>>;
}

export type CheckedExport = CommitmentExport & {
  readonly check: CommitmentCheckCost;
  /** Every candidate with the check's raw answer for its episode, to try other rules (private). */
  readonly answers: readonly {
    readonly candidates: readonly CommitmentCandidate[];
    readonly text: string;
  }[];
};

export async function checkCommitments(options: {
  readonly run: {
    readonly label: string;
    readonly episodes: readonly number[];
    readonly candidates: readonly CommitmentCandidate[];
  };
  readonly out: string;
  readonly database: string;
  readonly engine: BenchEngine;
  readonly model: string;
  readonly server: string;
  readonly effort: string | null;
  readonly socketPath: string;
  readonly timeZone: string;
  readonly log: (line: string) => void;
}): Promise<string> {
  const db = openDatabase(options.database, { migrate: false });
  const engine = benchTextEngine({
    label: `${options.run.label}-check`,
    engine: options.engine,
    model: options.model,
    server: options.server,
    effort: options.effort,
    contextTokens: 16_384,
    socketPath: options.socketPath,
  });
  const watch = sondineWatch(engine.capabilities.locality === "device");
  // A stopped check must not leave the server holding its memory.
  const stop = () => {
    watch.stop();
    void engine.unload().finally(() => process.exit(130));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await yieldToSondine(engine, options.log);
  await engine.load();
  let requests = 0;
  let promptTokens = 0;
  let outputTokens = 0;
  let computeMs = 0;
  let failed = 0;
  const dropped: Partial<Record<CommitmentCheckVerdict, number>> = {};
  const kept: CommitmentCandidate[] = [];
  const answers: { candidates: readonly CommitmentCandidate[]; text: string }[] = [];
  try {
    const byEpisode = Map.groupBy(options.run.candidates, (candidate) => candidate.episodeId);
    for (const [episodeId, candidates] of byEpisode) {
      const source = loadJournalSource(db, episodeId, options.timeZone, Date.now());
      if (source === null) {
        kept.push(...candidates);
        continue;
      }
      const refOf = speakerRefs(source.input.speakers);
      const ref = (label: string | null | undefined) =>
        label === null || label === undefined ? null : (refOf.get(label) ?? null);
      const drafts: JournalCommitmentDraft[] = candidates.map((candidate) => ({
        kind: "commitment",
        text: candidate.text,
        who: ref(candidate.whoLabel),
        to: ref(candidate.toLabel),
        due: null,
        dueText: null,
        segmentIds: candidate.segmentIds,
      }));
      const request = buildCommitmentCheck(source.input, drafts);
      requests += 1;
      let verdicts: CommitmentCheckVerdict[] | null = null;
      try {
        const answer = await untilDone(engine, watch, options.log, (signal) =>
          engine.generate(
            {
              id: `check-${episodeId}`,
              system: request.system,
              user: request.user,
              schema: request.schema,
              maxOutputTokens: request.maxOutputTokens,
            },
            { signal },
          ),
        );
        promptTokens += answer.metrics.promptTokens;
        outputTokens += answer.metrics.outputTokens;
        computeMs += answer.metrics.computeMs;
        if (answer.stop === "complete") verdicts = readCommitmentCheck(request, answer.text);
        answers.push({ candidates, text: answer.text });
      } catch (error) {
        // Kept as written; the request stays with the private results, to see why.
        options.log(
          `check of episode ${episodeId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        writeFileSync(
          join(options.out, `${options.run.label}-check-${episodeId}.request.json`),
          JSON.stringify(request, null, 1),
          { mode: 0o600 },
        );
      }
      if (verdicts === null) failed += 1;
      for (const [index, candidate] of candidates.entries()) {
        const verdict = verdicts?.[index] ?? "commitment";
        if (verdict === "commitment") kept.push(candidate);
        else dropped[verdict] = (dropped[verdict] ?? 0) + 1;
      }
      if (requests % 10 === 0) options.log(`${requests} checks, ${Math.round(computeMs / 1000)} s`);
    }
  } finally {
    watch.stop();
    await engine.unload();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    db.close();
  }
  const label = `${options.run.label}-checked${options.engine === "claude" ? `-${options.model}` : ""}`;
  const result: CheckedExport = {
    schema: "sondine.bench.journal-commitments",
    label,
    configKey: "checked",
    episodes: options.run.episodes,
    candidates: kept,
    check: { requests, promptTokens, outputTokens, computeMs, failed, dropped },
    answers,
  };
  const path = join(options.out, `${label}.commitments.json`);
  writeFileSync(path, JSON.stringify(result, null, 1), { mode: 0o600 });
  return path;
}
