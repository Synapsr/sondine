import type { Episode } from "./grouping";
import type { ConstraintOrigin, EpisodeContext } from "./types";

/** Bump when a row, a threshold, or a margin of the table changes. */
export const SIZE_TABLE_VERSION = "size/1";

export type EpisodeSize = "trace" | "moment" | "conversation";

/**
 * Size table v1 (ADR 007), on deduplicated voiced time. Starting values, to
 * calibrate on a labelled week. Margins are the hysteresis band: leaving the
 * previous size needs the input to cross its threshold by the margin.
 */
export const SIZE_TABLE_V1 = {
  traceVoicedMs: 1_500,
  traceVoicedMarginMs: 300,
  conversationVoicedMs: 60_000,
  conversationVoicedMarginMs: 6_000,
  conversationElapsedMs: 180_000,
  conversationElapsedMarginMs: 15_000,
  conversationSpeakers: 2,
  conversationTurns: 6,
  conversationTurnsMargin: 1,
} as const;

/** A size assertion: a manual override, or an automatic one from a later stage. */
export interface SizeConstraint {
  readonly size: EpisodeSize;
  readonly origin: ConstraintOrigin;
  readonly seq: number;
}

export interface SizeDecisionInput {
  readonly context: EpisodeContext;
  readonly voicedMs: number;
  /** Episode span, first speech start to last speech end. */
  readonly elapsedMs: number;
  /** The episode is still provisional in grouping and may grow. */
  readonly episodeOpen: boolean;
  /** Null until diarization has run. */
  readonly diarization: { readonly speakers: number; readonly turns: number } | null;
  /** The previous automatic decision, for hysteresis on re-evaluation. */
  readonly previous?: EpisodeSize;
  readonly constraints?: readonly SizeConstraint[];
}

export type SizeRule =
  | "manual-override"
  | "auto-override"
  | "trace"
  | "call"
  | "voiced"
  | "elapsed-speakers"
  | "elapsed-turns"
  | "moment";

export type ProvisionalReason = "episode-open" | "awaiting-diarization";

export interface SizeThresholds {
  readonly traceVoicedMs: number;
  readonly conversationVoicedMs: number;
  readonly conversationElapsedMs: number;
  readonly conversationSpeakers: number;
  readonly conversationTurns: number;
}

/** Everything the decision read, JSON-safe, stored as `kind_inputs`. */
export interface KindInputs {
  readonly version: typeof SIZE_TABLE_VERSION;
  readonly context: EpisodeContext;
  readonly voicedMs: number;
  readonly elapsedMs: number;
  readonly episodeOpen: boolean;
  readonly speakers: number | null;
  readonly turns: number | null;
  readonly previous: EpisodeSize | null;
  readonly constraint: SizeConstraint | null;
  /** Thresholds after hysteresis. */
  readonly thresholds: SizeThresholds;
}

export interface SizeDecision {
  readonly version: typeof SIZE_TABLE_VERSION;
  readonly size: EpisodeSize;
  readonly rule: SizeRule;
  readonly provisional: boolean;
  readonly provisionalReasons: readonly ProvisionalReason[];
  /** The table without hysteresis would have chosen another size. */
  readonly heldByHysteresis: boolean;
  readonly inputs: KindInputs;
}

/**
 * Total decision table: every input gets exactly one size.
 *
 * 1. a manual constraint wins (latest `seq`), then an automatic one;
 * 2. `trace`: voiced < 1.5 s;
 * 3. `conversation`: call context;
 * 4. `conversation`: voiced ≥ 60 s;
 * 5. `conversation`: elapsed ≥ 3 min and (≥ 2 speakers or ≥ 6 turns), once diarized;
 * 6. `moment`: everything else, including provisional middle cases.
 */
export function decideSize(input: SizeDecisionInput): SizeDecision {
  validate(input);
  const previous = input.previous ?? null;
  const thresholds = thresholdsAfter(previous);
  const table = evaluate(input, thresholds);
  const baseline = previous === null ? table : evaluate(input, thresholdsAfter(null));
  const constraint = pickConstraint(input.constraints ?? []);

  const inputs: KindInputs = {
    version: SIZE_TABLE_VERSION,
    context: input.context,
    voicedMs: input.voicedMs,
    elapsedMs: input.elapsedMs,
    episodeOpen: input.episodeOpen,
    speakers: input.diarization?.speakers ?? null,
    turns: input.diarization?.turns ?? null,
    previous,
    constraint,
    thresholds,
  };

  if (constraint?.origin === "manual") {
    return {
      version: SIZE_TABLE_VERSION,
      size: constraint.size,
      rule: "manual-override",
      provisional: false,
      provisionalReasons: [],
      heldByHysteresis: false,
      inputs,
    };
  }

  const reasons: ProvisionalReason[] = input.episodeOpen ? ["episode-open"] : [];
  if (constraint !== null) {
    return {
      version: SIZE_TABLE_VERSION,
      size: constraint.size,
      rule: "auto-override",
      provisional: reasons.length > 0,
      provisionalReasons: reasons,
      heldByHysteresis: false,
      inputs,
    };
  }

  if (
    input.diarization === null &&
    table.size === "moment" &&
    input.elapsedMs >= thresholds.conversationElapsedMs
  ) {
    reasons.push("awaiting-diarization");
  }
  return {
    version: SIZE_TABLE_VERSION,
    size: table.size,
    rule: table.rule,
    provisional: reasons.length > 0,
    provisionalReasons: reasons,
    heldByHysteresis: table.size !== baseline.size,
    inputs,
  };
}

/** The table inputs a grouped episode already provides. */
export function sizeInputOf(
  episode: Pick<Episode, "context" | "voicedMs" | "startNs" | "endNs" | "provisional">,
): Pick<SizeDecisionInput, "context" | "voicedMs" | "elapsedMs" | "episodeOpen"> {
  return {
    context: episode.context,
    voicedMs: episode.voicedMs,
    elapsedMs: Number((episode.endNs - episode.startNs) / 1_000_000n),
    episodeOpen: episode.provisional,
  };
}

function evaluate(
  input: SizeDecisionInput,
  thresholds: SizeThresholds,
): { size: EpisodeSize; rule: SizeRule } {
  if (input.voicedMs < thresholds.traceVoicedMs) return { size: "trace", rule: "trace" };
  if (input.context === "call") return { size: "conversation", rule: "call" };
  if (input.voicedMs >= thresholds.conversationVoicedMs)
    return { size: "conversation", rule: "voiced" };
  const diarization = input.diarization;
  if (diarization !== null && input.elapsedMs >= thresholds.conversationElapsedMs) {
    if (diarization.speakers >= thresholds.conversationSpeakers) {
      return { size: "conversation", rule: "elapsed-speakers" };
    }
    if (diarization.turns >= thresholds.conversationTurns) {
      return { size: "conversation", rule: "elapsed-turns" };
    }
  }
  return { size: "moment", rule: "moment" };
}

/**
 * Moves each threshold away from the previous size by its margin, so a value
 * hovering at a threshold keeps the size it already has.
 */
function thresholdsAfter(previous: EpisodeSize | null): SizeThresholds {
  const t = SIZE_TABLE_V1;
  const trace =
    previous === null
      ? t.traceVoicedMs
      : previous === "trace"
        ? t.traceVoicedMs + t.traceVoicedMarginMs
        : t.traceVoicedMs - t.traceVoicedMarginMs;
  const direction = previous === null ? 0 : previous === "conversation" ? -1 : 1;
  return {
    traceVoicedMs: trace,
    conversationVoicedMs: t.conversationVoicedMs + direction * t.conversationVoicedMarginMs,
    conversationElapsedMs: t.conversationElapsedMs + direction * t.conversationElapsedMarginMs,
    conversationSpeakers: t.conversationSpeakers,
    conversationTurns: t.conversationTurns + direction * t.conversationTurnsMargin,
  };
}

function pickConstraint(constraints: readonly SizeConstraint[]): SizeConstraint | null {
  let best: SizeConstraint | null = null;
  for (const constraint of constraints) {
    if (
      best === null ||
      (constraint.origin === "manual" && best.origin === "auto") ||
      (constraint.origin === best.origin && constraint.seq > best.seq)
    ) {
      best = constraint;
    }
  }
  return best === null ? null : { size: best.size, origin: best.origin, seq: best.seq };
}

function validate(input: SizeDecisionInput): void {
  for (const [name, value] of [
    ["voicedMs", input.voicedMs],
    ["elapsedMs", input.elapsedMs],
  ] as const) {
    if (!Number.isFinite(value) || value < 0)
      throw new RangeError(`${name} must be finite and ≥ 0`);
  }
  if (input.diarization !== null) {
    const { speakers, turns } = input.diarization;
    if (!Number.isInteger(speakers) || speakers < 0 || !Number.isInteger(turns) || turns < 0) {
      throw new RangeError("speakers and turns must be integers ≥ 0");
    }
  }
}

/** Everything the size decision read and chose, JSON-safe (`episodes.kind_inputs`). */
export function kindInputsOf(decision: SizeDecision): Record<string, unknown> {
  return {
    ...decision.inputs,
    rule: decision.rule,
    provisionalReasons: [...decision.provisionalReasons],
    heldByHysteresis: decision.heldByHysteresis,
  };
}
