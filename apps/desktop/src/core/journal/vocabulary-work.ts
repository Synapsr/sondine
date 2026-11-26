import {
  buildVocabularyCheck,
  readVocabularyCheck,
  VOCABULARY_CHECK_BATCH,
  type Vocabulary,
} from "@sondine/core";
import {
  finishVocabularyPass,
  loadVocabularyCheck,
  nextVocabularyEpisode,
  respellEpisode,
  vocabularyNamesKey,
  vocabularyNotes,
  vocabularyOf,
  type Database,
  type VocabularyCheckTarget,
} from "@sondine/db";
import { EngineError, type TextEngine } from "@sondine/engines";

// The Vocabulary's second rule (ADR 046), for the analysis scheduler: in the
// recent transcripts, a name that looks like one of the user's without
// sounding the same (« Sandrine », « Sondine ») is read by the journal's
// model on this Mac, never another engine, and spelled the user's way when
// it says so. The scheduler runs it as a journal unit: after transcription,
// under the journal's admission (power, idle, memory), before the journal of
// the same episode reads it. On the way, each recent transcript gets the
// rule that needs no model, as a new one gets it at publish, so a name just
// added to the list spells the last days too; an episode without a word to
// ask about, or with no model to ask, is settled there. Never logs a word of
// what was said.

type Fields = Readonly<Record<string, string | number | boolean | null | undefined>>;

export type VocabularyOutcome = "done" | "failed" | "cancelled" | "discarded";

/** Episodes settled without the model in one look at the queue, at most. */
const SETTLE_PER_LOOK = 500;

export class VocabularyWork {
  private readonly now: () => number;

  constructor(
    private readonly deps: {
      readonly db: Database;
      readonly log: {
        info(event: string, fields?: Fields): void;
        warn(event: string, fields?: Fields): void;
      };
      readonly now?: () => number;
    },
  ) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * The next episode the model must read, or null; with `episodeId`, that
   * one if it must. Recent episodes are spelled and settled on the way; all
   * of them while there is no `model` to ask.
   */
  next(input: { readonly model: boolean; readonly episodeId?: number }): number | null {
    const { db, log } = this.deps;
    const namesKey = vocabularyNamesKey(db, { model: input.model });
    let vocabulary: { value: Vocabulary; notes: ReturnType<typeof vocabularyNotes> } | null = null;
    for (let looked = 0; looked < SETTLE_PER_LOOK; looked += 1) {
      const nowMs = this.now();
      const next = nextVocabularyEpisode(db, {
        namesKey,
        nowMs,
        ...(input.episodeId === undefined ? {} : { episodeId: input.episodeId }),
      });
      if (next === null) return null;
      vocabulary ??= { value: vocabularyOf(db), notes: vocabularyNotes(db) };
      const spelled = respellEpisode(db, next, vocabulary.value, nowMs);
      if (spelled > 0) log.info("vocabulary.spelled", { episodeId: next, words: spelled });
      const check = loadVocabularyCheck(db, next, vocabulary.value, vocabulary.notes);
      if (check === null) return null;
      if (input.model && check.targets.length > 0) return next;
      finishVocabularyPass(db, {
        episodeId: next,
        runId: check.runId,
        namesKey,
        status: "done",
        answers: [],
        candidates: check.targets.length,
        nowMs,
      });
    }
    return null;
  }

  /**
   * Reads one episode's candidates with the loaded `engine`, then spells
   * what it said in one transaction. A signal that aborts cancels the pass,
   * which is not a failure.
   */
  async run(
    engine: TextEngine,
    episodeId: number,
    signal: AbortSignal,
  ): Promise<VocabularyOutcome> {
    const { db, log } = this.deps;
    const namesKey = vocabularyNamesKey(db, { model: true });
    const check = loadVocabularyCheck(db, episodeId, vocabularyOf(db), vocabularyNotes(db));
    if (check === null) return "discarded";
    const answers: { target: VocabularyCheckTarget; userWord: boolean }[] = [];
    const metrics = { requests: 0, promptTokens: 0, outputTokens: 0, computeMs: 0 };
    const finish = (status: "done" | "failed") =>
      finishVocabularyPass(db, {
        episodeId,
        runId: check.runId,
        namesKey,
        status,
        answers,
        candidates: check.targets.length,
        nowMs: this.now(),
      });
    try {
      for (let start = 0; start < check.targets.length; start += VOCABULARY_CHECK_BATCH) {
        signal.throwIfAborted();
        const batch = check.targets.slice(start, start + VOCABULARY_CHECK_BATCH);
        const request = buildVocabularyCheck(batch);
        const result = await engine.generate(
          {
            id: `vocabulary-${episodeId}-${start}`,
            system: request.system,
            user: request.user,
            schema: request.schema,
            maxOutputTokens: request.maxOutputTokens,
          },
          { signal },
        );
        metrics.requests += 1;
        metrics.promptTokens += result.metrics.promptTokens;
        metrics.outputTokens += result.metrics.outputTokens;
        metrics.computeMs += result.metrics.computeMs;
        const verdicts =
          result.stop === "complete" ? readVocabularyCheck(request, result.text) : null;
        if (verdicts === null) throw new VocabularyFailure("check-shape");
        for (const [index, target] of batch.entries()) {
          answers.push({ target, userWord: verdicts[index] === true });
        }
      }
      const corrected = finish("done");
      log.info("vocabulary.checked", {
        episodeId,
        candidates: check.targets.length,
        corrected,
        ...metrics,
      });
      return "done";
    } catch (error) {
      if (signal.aborted) return "cancelled";
      // What was answered before the failure stays; the pass is tried again later.
      finish("failed");
      const code =
        error instanceof VocabularyFailure
          ? error.code
          : error instanceof EngineError
            ? (error.reason ?? error.code)
            : "internal";
      log.warn("vocabulary.failed", { episodeId, code, ...metrics });
      if (
        error instanceof EngineError &&
        error.code !== "invalid_output" &&
        error.code !== "rejected"
      ) {
        throw error;
      }
      return "failed";
    }
  }
}

/** An answer that is not the shape asked for: a fixed code, never the model's words. */
class VocabularyFailure extends Error {
  override readonly name = "VocabularyFailure";
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
