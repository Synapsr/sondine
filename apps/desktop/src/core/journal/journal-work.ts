import {
  buildCommitmentCheck,
  buildJournalRequest,
  JOURNAL_PROMPT_VERSION,
  keptByCheck,
  mergeWindowItems,
  planWindows,
  readCommitmentCheck,
  readJournalAnswer,
  speakerRefs,
  type CommitmentCheckRule,
  type JournalCommitmentDraft,
  type JournalDraft,
  type JournalInput,
  type JournalLanguage,
} from "@sondine/core";
import {
  finishJournalRun,
  journalPending,
  loadJournalSource,
  nextJournalEpisode,
  publishJournalRun,
  recoverJournalRuns,
  startJournalRun,
  type Database,
  type JournalRange,
  type JournalWriter,
} from "@sondine/db";
import { EngineError, type TextEngine, type TextRequest, type TextResult } from "@sondine/engines";
import type { VocabularyWork } from "./vocabulary-work";

// The daily journal's work for the analysis scheduler (ADR 028): which
// episode comes next, and one episode written, by whoever the user chose:
// the model on this Mac, the same read again by their Claude, or their
// Claude. The scheduler owns admission, loading and unloading; this owns
// the requests, their answers and the publication. Never logs a word of
// what was said or written.

type Fields = Readonly<Record<string, string | number | boolean | null | undefined>>;

export interface JournalUnit {
  /**
   * `vocabulary`: the episode's names that look like the user's words,
   * read by the model on this Mac before its journal (ADR 046).
   */
  readonly kind: "journal" | "vocabulary";
  readonly episodeId: number;
  /** The user asked for its day: idle and power are not waited for. */
  readonly requested: boolean;
}

export type JournalOutcome = "published" | "discarded" | "failed" | "cancelled";

export interface JournalWorkDeps {
  readonly db: Database;
  /** The model on this Mac; null while none is installed. */
  readonly device: () => TextEngine | null;
  /** The user's Claude through their CLI; null where the build has none. */
  readonly claude: () => TextEngine | null;
  /** The setting: off, nothing is written. */
  readonly enabled: () => boolean;
  /** Who writes what comes next (Settings ▸ Journal du jour). */
  readonly writer: () => JournalWriter;
  readonly language: () => JournalLanguage;
  readonly timeZone: () => string;
  readonly log: {
    info(event: string, fields?: Fields): void;
    warn(event: string, fields?: Fields): void;
  };
  /** A journal changed: windows showing its day read it again. */
  readonly onChanged?: (episodeId: number) => void;
  /** A pass failed: its code (ADR 042). */
  readonly onFailed?: (code: string) => void;
  /** The Vocabulary's reading of names (ADR 046); none without it. */
  readonly vocabulary?: VocabularyWork;
  readonly now?: () => number;
}

/** Engine failures after which the server process is still sound. */
const keptAfterFailure: ReadonlySet<string> = new Set(["invalid_output", "rejected"]);

/** After Claude did not answer (signed out, offline, its limits), how long before it is asked again. */
export const CLAUDE_RETRY_MS = 10 * 60_000;

/** How the check reads Claude's verdicts, by writer, as measured on Téo's days. */
const CHECK_RULES: Readonly<Record<JournalWriter, CommitmentCheckRule | null>> = {
  device: null,
  "device-checked": "strict",
  claude: "timing",
};

export class JournalWork {
  private readonly now: () => number;
  /** Days the user asked for, newest request first; forgotten at restart. */
  private requested: JournalRange[] = [];
  private writing: number | null = null;
  /** Claude did not answer: not before this time again. */
  private claudePausedUntil = 0;

  constructor(private readonly deps: JournalWorkDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The engine that writes the windows now: the user's Claude when they chose it. */
  engine(): TextEngine | null {
    return this.deps.writer() === "claude" ? this.deps.claude() : this.deps.device();
  }

  /** Whether the model on this Mac reads the names that look like the user's words (ADR 046). */
  readsVocabulary(): boolean {
    return this.deps.vocabulary !== undefined && this.deps.device() !== null;
  }

  /** Every engine the journal may hold, whoever writes now: the scheduler unloads them all. */
  engines(): TextEngine[] {
    return [this.deps.device(), this.deps.claude()].filter(
      (engine): engine is TextEngine => engine !== null,
    );
  }

  /** Claude did not answer lately: the journal waits while it needs it. */
  claudePaused(): boolean {
    return this.deps.writer() !== "device" && this.now() < this.claudePausedUntil;
  }

  /** When Claude is asked again after it did not answer; 0 while it is not needed or not paused. */
  claudeRetryAt(): number {
    return this.deps.writer() === "device" ? 0 : this.claudePausedUntil;
  }

  /** At start, before any server: attempts a stopped core left are abandoned. */
  recover(): number {
    return recoverJournalRuns(this.deps.db, this.now());
  }

  /**
   * What makes a journal current: the prompt's version. Who wrote it is the
   * user's choice for what comes next, and never makes it old (a day is
   * written again on request).
   */
  configKey(): string {
    return JOURNAL_PROMPT_VERSION;
  }

  /**
   * The next unit and the engine for it, or null. The Vocabulary's reading
   * of an episode comes before its journal, on the model on this Mac only,
   * whoever writes the journal, and whether the journal is on: before a day
   * the user asked for, that day's episodes, then any recent one before an
   * automatic journal.
   */
  next(): { readonly unit: JournalUnit; readonly engine: TextEngine } | null {
    const journal = this.nextJournal();
    const device = this.deps.device();
    const vocabulary = this.deps.vocabulary;
    if (vocabulary !== undefined) {
      // Without the model, recent transcripts still get the rule that needs none.
      const model = device !== null;
      const episodeId =
        journal?.requested === true
          ? vocabulary.next({ model, episodeId: journal.episodeId })
          : vocabulary.next({ model });
      if (episodeId !== null && device !== null) {
        return {
          unit: { kind: "vocabulary", episodeId, requested: journal?.requested === true },
          engine: device,
        };
      }
    }
    const engine = this.engine();
    return journal === null || engine === null ? null : { unit: journal, engine };
  }

  /**
   * The next episode to write, or null. Text leaves the Mac only for the
   * writer the user chose after being told what leaves (Settings).
   */
  private nextJournal(): JournalUnit | null {
    if (!this.deps.enabled()) return null;
    const engine = this.engine();
    if (engine === null || this.claudePaused()) return null;
    if (this.deps.writer() === "device-checked" && this.deps.claude() === null) return null;
    const next = nextJournalEpisode(this.deps.db, this.configKey(), this.requested);
    // A day asked for is done once nothing in it is left; a rewrite that
    // failed stays, so the day still says so (until core restarts).
    if (next === null || !next.requested) {
      this.requested = this.requested.filter(
        (range) =>
          range.rewriteBeforeMs !== undefined &&
          journalPending(this.deps.db, this.configKey(), range).failed > 0,
      );
    }
    return next === null ? null : { kind: "journal", ...next };
  }

  /**
   * « Écrire maintenant » on a day; with `rewrite`, « Réécrire ce jour »:
   * what is written goes again. Asking again keeps a rewrite asked before.
   */
  request(range: JournalRange, rewrite = false): void {
    const before = this.requestedRange(range)?.rewriteBeforeMs;
    const rewriteBeforeMs = rewrite ? this.now() : before;
    const asked = rewriteBeforeMs === undefined ? range : { ...range, rewriteBeforeMs };
    this.requested = [asked, ...this.requested.filter((other) => other.fromMs !== range.fromMs)];
    // The user asked: Claude is asked again at once.
    this.claudePausedUntil = 0;
  }

  /** The day as the user asked for it, if they did: its rewrite counts in what is pending. */
  requestedRange(range: JournalRange): JournalRange | null {
    return this.requested.find((other) => other.fromMs === range.fromMs) ?? null;
  }

  isRequested(range: JournalRange): boolean {
    return this.requested.some((other) => other.fromMs === range.fromMs);
  }

  /**
   * Whether the journal reads any words of the episode: one without (no
   * words, or all of them in the time another recording of the same meeting
   * feeds, ADR 032) needs no model.
   */
  hasText(unit: JournalUnit): boolean {
    if (unit.kind === "vocabulary") return true;
    const source = loadJournalSource(
      this.deps.db,
      unit.episodeId,
      this.deps.timeZone(),
      this.now(),
    );
    return (source?.input.lines.length ?? 0) > 0;
  }

  /** The episode being written now, if any. */
  current(): number | null {
    return this.writing;
  }

  /**
   * The user changed who writes, or turned the journal off, during the
   * pass: not one more request goes out, and nothing it wrote is published.
   */
  private assertWriter(writer: JournalWriter): void {
    if (!this.deps.enabled() || this.deps.writer() !== writer) throw new WriterChanged();
  }

  /**
   * The user's Claude reads each commitment again with the lines around it
   * (`device-checked`, `claude`): what `rule` drops goes, nothing is
   * rewritten. Lines of the journal are not checked.
   */
  private async check(
    input: JournalInput,
    drafts: readonly JournalDraft[],
    writer: JournalWriter,
    rule: CommitmentCheckRule,
    runId: number,
    signal: AbortSignal,
    metrics: {
      checked: number;
      checkDropped: number;
      promptTokens: number;
      outputTokens: number;
      computeMs: number;
    },
  ): Promise<JournalDraft[]> {
    const commitments = drafts.filter(
      (draft): draft is JournalCommitmentDraft => draft.kind === "commitment",
    );
    if (commitments.length === 0) return [...drafts];
    const claude = this.deps.claude();
    if (claude === null) throw new ClaudeUnavailable("claude-missing");
    this.assertWriter(writer);
    const request = buildCommitmentCheck(input, commitments);
    const result = await generate(
      claude,
      {
        id: `journal-${runId}-check`,
        system: request.system,
        user: request.user,
        schema: request.schema,
        maxOutputTokens: request.maxOutputTokens,
      },
      signal,
    );
    metrics.promptTokens += result.metrics.promptTokens;
    metrics.outputTokens += result.metrics.outputTokens;
    metrics.computeMs += result.metrics.computeMs;
    const verdicts = result.stop === "complete" ? readCommitmentCheck(request, result.text) : null;
    if (verdicts === null) throw new JournalFailure("check-shape");
    metrics.checked += commitments.length;
    const dropped = new Set(
      commitments.filter((_, index) => !keptByCheck(verdicts[index] ?? "commitment", rule)),
    );
    metrics.checkDropped += dropped.size;
    return drafts.filter((draft) => draft.kind !== "commitment" || !dropped.has(draft));
  }

  /**
   * Writes one episode with a loaded `engine`: every window, then one
   * publication. A signal that aborts (admission, core stopping) cancels
   * the pass, which is not a failure.
   */
  async run(engine: TextEngine, unit: JournalUnit, signal: AbortSignal): Promise<JournalOutcome> {
    if (unit.kind === "vocabulary") {
      const { vocabulary } = this.deps;
      // Only the model on this Mac reads for the Vocabulary.
      if (vocabulary === undefined || engine !== this.deps.device()) return "discarded";
      const outcome = await vocabulary.run(engine, unit.episodeId, signal);
      return outcome === "done" ? "published" : outcome;
    }
    const { db, log } = this.deps;
    // The scheduler chose the engine before admission: the user may have
    // chosen another writer since. Nothing goes to an engine they left.
    if (engine !== this.engine()) return "discarded";
    const nowMs = this.now();
    const source = loadJournalSource(db, unit.episodeId, this.deps.timeZone(), nowMs);
    if (source === null) return "discarded";
    const refs = speakerRefs(source.input.speakers);
    const runId = startJournalRun(db, {
      episodeId: unit.episodeId,
      asrRunId: source.asrRunId,
      inputHash: source.inputHash,
      configKey: this.configKey(),
      engineId: engine.manifest.id,
      modelSha256: modelOf(engine),
      speakerRefs: Object.fromEntries([...refs.entries()].map(([label, ref]) => [ref, label])),
      nowMs,
    });
    this.writing = unit.episodeId;
    const language = this.deps.language();
    const writer = this.deps.writer();
    const metrics = {
      writer,
      windows: 0,
      promptTokens: 0,
      outputTokens: 0,
      computeMs: 0,
      dropped: 0,
      setAside: 0,
      checked: 0,
      checkDropped: 0,
    };
    try {
      const perWindow: JournalDraft[][] = [];
      for (const window of planWindows(source.input.lines)) {
        signal.throwIfAborted();
        this.assertWriter(writer);
        const request = buildJournalRequest(source.input, window, language);
        const result = await generate(
          engine,
          {
            id: `journal-${runId}-${window.index}`,
            system: request.system,
            user: request.user,
            schema: request.schema,
            maxOutputTokens: request.maxOutputTokens,
          },
          signal,
        );
        metrics.windows += 1;
        metrics.promptTokens += result.metrics.promptTokens;
        metrics.outputTokens += result.metrics.outputTokens;
        metrics.computeMs += result.metrics.computeMs;
        if (result.stop === "length") throw new JournalFailure("output-limit");
        const answer = readJournalAnswer(request, result.text);
        if (!answer.ok) throw new JournalFailure(answer.error);
        metrics.dropped += Object.values(answer.dropped).reduce((sum, n) => sum + (n ?? 0), 0);
        metrics.setAside += Object.values(answer.setAside).reduce((sum, n) => sum + (n ?? 0), 0);
        perWindow.push([...answer.items]);
      }
      const rule = CHECK_RULES[writer];
      const drafts =
        rule === null
          ? mergeWindowItems(perWindow)
          : await this.check(
              source.input,
              mergeWindowItems(perWindow),
              writer,
              rule,
              runId,
              signal,
              metrics,
            );
      this.assertWriter(writer);
      const items = drafts.map((item) => ({
        kind: item.kind,
        text: item.text,
        whoRef: item.kind === "commitment" ? item.who : null,
        toRef: item.kind === "commitment" ? item.to : null,
        due: item.kind === "commitment" ? item.due : null,
        dueText: item.kind === "commitment" ? item.dueText : null,
        segmentIds: item.segmentIds,
      }));
      const published = publishJournalRun(db, {
        runId,
        items,
        metrics: { ...metrics, language },
        timeZone: this.deps.timeZone(),
        nowMs: this.now(),
      });
      if (!published.published) {
        // What it read changed or went: the queue looks at the episode again.
        // Counted as a failure, so a refusal that comes back every time ends.
        finishJournalRun(db, runId, {
          status: "failed",
          errorCode: published.reason,
          metrics,
          nowMs: this.now(),
        });
        log.info("journal.discarded", { episodeId: unit.episodeId, reason: published.reason });
        return "discarded";
      }
      log.info("journal.published", {
        episodeId: unit.episodeId,
        items: published.items,
        ...metrics,
      });
      this.deps.onChanged?.(unit.episodeId);
      return "published";
    } catch (error) {
      if (signal.aborted) {
        finishJournalRun(db, runId, {
          status: "cancelled",
          errorCode: "cancelled",
          metrics,
          nowMs: this.now(),
        });
        return "cancelled";
      }
      // The user chose another writer meanwhile: the next pass is theirs.
      if (error instanceof WriterChanged) {
        finishJournalRun(db, runId, {
          status: "cancelled",
          errorCode: "writer-changed",
          metrics,
          nowMs: this.now(),
        });
        return "cancelled";
      }
      // Claude did not answer: not this transcript's failure; the journal waits.
      if (error instanceof ClaudeUnavailable) {
        this.claudePausedUntil = this.now() + CLAUDE_RETRY_MS;
        finishJournalRun(db, runId, {
          status: "cancelled",
          errorCode: error.code,
          metrics,
          nowMs: this.now(),
        });
        log.warn("journal.claude-unavailable", { episodeId: unit.episodeId, code: error.code });
        return "cancelled";
      }
      // A fixed code, never the engine's message (it may quote what it read).
      const code =
        error instanceof JournalFailure
          ? error.code
          : error instanceof EngineError
            ? (error.reason ?? error.code)
            : "internal";
      finishJournalRun(db, runId, {
        status: "failed",
        errorCode: code,
        metrics,
        nowMs: this.now(),
      });
      log.warn("journal.failed", { episodeId: unit.episodeId, code });
      this.deps.onFailed?.(code);
      if (
        error instanceof EngineError &&
        !keptAfterFailure.has(error.code) &&
        engine.state() !== "absent"
      ) {
        throw error;
      }
      return "failed";
    } finally {
      this.writing = null;
    }
  }
}

const modelOf = (engine: TextEngine) =>
  engine.manifest.artifacts
    .map((artifact) => `${artifact.artifactId}@${artifact.version}`)
    .join(",");

/**
 * One request; the user's Claude not answering (not installed, signed out,
 * offline, its limits) is told apart from an answer that is wrong.
 */
async function generate(
  engine: TextEngine,
  request: TextRequest,
  signal: AbortSignal,
): Promise<TextResult> {
  try {
    return await engine.generate(request, { signal });
  } catch (error) {
    if (
      engine.capabilities.locality === "provider" &&
      error instanceof EngineError &&
      error.code !== "invalid_output" &&
      !signal.aborted
    ) {
      throw new ClaudeUnavailable(`claude-${error.reason ?? error.code}`);
    }
    throw error;
  }
}

/** The user chose another writer during a pass. */
class WriterChanged extends Error {
  override readonly name = "WriterChanged";
}

/** The user's Claude did not answer: a fixed code, never its words. */
class ClaudeUnavailable extends Error {
  override readonly name = "ClaudeUnavailable";
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** A pass that cannot publish: the answer was cut or not the shape asked for. */
class JournalFailure extends Error {
  override readonly name = "JournalFailure";
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
