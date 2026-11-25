import type { AnalysisWaitReason } from "@sondine/api";
import { WAIT_FOR_ALL, type WaitFor } from "@sondine/db";

// ADR 016, "Admission": checked before each job and every 10 s during one.

/**
 * Disk kept for swap on top of the engine's peak before a cold load. Loading
 * Nemotron (17 GB of footprint) on Téo's 32 GB Mac pushed about 10 GB of other
 * apps to swap (2026-11-05), so a load is admitted on pressure and swap room,
 * not on free memory, which a busy Mac never has (ADR 016).
 */
export const SWAP_ROOM_MARGIN_BYTES = 10 * 1024 ** 3;
/** Automatic jobs need this long without input, unless the screen is locked. */
export const IDLE_REQUIRED_SECONDS = 120;
/** Idle/power refusals allow a job with less than this left to finish. */
export const FINISH_WINDOW_MS = 60_000;
/** Swap growth tolerated once the engine is loaded; more means the Mac thrashes. */
export const SWAP_GROWTH_TOLERANCE_BYTES = 2 * 1024 ** 3;

export type MemoryPressure = "normal" | "warn" | "critical";

/** What the Mac reports now; null when a source did not answer. */
export interface SystemSample {
  readonly onBattery: boolean | null;
  /** Electron's thermal state: `nominal`, `fair`, `serious`, `critical`, `unknown`. */
  readonly thermalState: string | null;
  readonly idleSeconds: number | null;
  readonly locked: boolean;
  readonly memoryPressure: MemoryPressure | null;
  readonly swapUsedBytes: number | null;
  /** Free space on the volume that holds swap files. */
  readonly swapRoomBytes: number | null;
}

export interface AdmissionInput {
  readonly sample: SystemSample;
  /**
   * A user request skips idle and AC, and loads at warn pressure (not
   * critical); the swap room check still applies.
   */
  readonly requested: boolean;
  /**
   * The engine is loaded or loading, in a job or between two. Its own weights
   * hold pressure at warn, so only critical pressure counts, and swap growth
   * past `swapBaselineBytes`. Cold (no engine, before a load): pressure must
   * be normal (not critical for a user request) and the swap volume must have
   * room for the load.
   */
  readonly warm: boolean;
  /**
   * A cold load is under way. Loading Nemotron takes 17 GB within seconds and
   * briefly reached critical pressure in 2 of 5 loads (2026-11-05), each
   * cancelled and then loaded fine 15 s later: pressure is not read while
   * loading, and admission runs again once the engine is ready.
   */
  readonly loading: boolean;
  /** The engine's peak for the longest request of the job; checked before a cold load. */
  readonly peakBytes: number;
  /** Swap in use when the warm engine finished loading; null while it loads, and when cold. */
  readonly swapBaselineBytes: number | null;
  /** What the user lets automatic jobs wait for (all by default); heat always counts. */
  readonly waitFor?: WaitFor;
}

export type AdmissionDecision =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly reasons: readonly AnalysisWaitReason[] };

const order: readonly AnalysisWaitReason[] = [
  "on-battery",
  "thermal",
  "memory",
  "swap",
  "not-idle",
];

/**
 * Whether the pressure level refuses the job. A warm engine holds pressure
 * at warn itself. A request the user made loads at warn too (Téo's choice,
 * 2026-11-07: a busy Mac sits at warn, and waiting for normal never ends);
 * automatic jobs wait for normal.
 */
export function pressureRefuses(
  input: Pick<AdmissionInput, "requested" | "warm" | "loading" | "waitFor">,
  pressure: MemoryPressure | null,
): boolean {
  if (input.loading) return false;
  // Turned off by the user, memory refuses automatic jobs as it refuses a request.
  return input.warm || input.requested || input.waitFor?.memory === false
    ? pressure === "critical"
    : pressure !== "normal";
}

/** Every condition is checked, so the status can list all the reasons at once. */
export function admit(input: AdmissionInput): AdmissionDecision {
  const { sample } = input;
  const reasons = new Set<AnalysisWaitReason>();
  const rules = input.waitFor ?? WAIT_FOR_ALL;
  if (!input.requested && rules.power && sample.onBattery !== false) reasons.add("on-battery");
  if (sample.thermalState !== "nominal" && sample.thermalState !== "fair") reasons.add("thermal");
  if (pressureRefuses(input, sample.memoryPressure)) reasons.add("memory");
  if (
    !input.warm &&
    (sample.swapRoomBytes === null ||
      sample.swapRoomBytes < input.peakBytes + SWAP_ROOM_MARGIN_BYTES)
  ) {
    reasons.add("memory");
  }
  if (
    input.warm &&
    input.swapBaselineBytes !== null &&
    sample.swapUsedBytes !== null &&
    sample.swapUsedBytes > input.swapBaselineBytes + SWAP_GROWTH_TOLERANCE_BYTES
  ) {
    reasons.add("swap");
  }
  const idle =
    sample.locked || (sample.idleSeconds !== null && sample.idleSeconds >= IDLE_REQUIRED_SECONDS);
  if (!input.requested && rules.idle && !idle) reasons.add("not-idle");
  if (reasons.size === 0) return { admitted: true };
  return { admitted: false, reasons: order.filter((reason) => reasons.has(reason)) };
}

/**
 * Why a job cannot go to a compute server now (ADR 040). No model is loaded
 * here, so it waits for neither power nor idle: only for a Mac that is not
 * already in trouble.
 */
export function admitRemote(
  sample: Pick<SystemSample, "thermalState" | "memoryPressure">,
): readonly AnalysisWaitReason[] {
  return [
    ...(sample.thermalState === "critical" ? (["thermal"] as const) : []),
    ...(sample.memoryPressure === "critical" ? (["memory"] as const) : []),
  ];
}

/** Conditions that need no process to read; checked first so a waiting queue stays cheap. */
export function admitCheap(
  input: Omit<AdmissionInput, "warm" | "loading" | "peakBytes" | "swapBaselineBytes">,
): AdmissionDecision {
  return admit({
    ...input,
    sample: { ...input.sample, memoryPressure: "normal", swapRoomBytes: Number.MAX_SAFE_INTEGER },
    warm: false,
    loading: false,
    peakBytes: 0,
    swapBaselineBytes: null,
  });
}

/**
 * Time left from the engine's progress: elapsed × (1 − p) / p. Null before
 * the first progress report.
 */
export function remainingMs(progress: number | null, elapsedMs: number): number | null {
  if (progress === null || progress <= 0) return null;
  if (progress >= 1) return 0;
  return (elapsedMs * (1 - progress)) / progress;
}

/** Memory, swap and heat stop at the next check; only idle/power refusals get finish grace. */
export function shouldCancel(decision: AdmissionDecision, remaining: number | null): boolean {
  if (decision.admitted) return false;
  if (
    decision.reasons.some(
      (reason) => reason === "memory" || reason === "swap" || reason === "thermal",
    )
  ) {
    return true;
  }
  return remaining === null || !Number.isFinite(remaining) || remaining >= FINISH_WINDOW_MS;
}
