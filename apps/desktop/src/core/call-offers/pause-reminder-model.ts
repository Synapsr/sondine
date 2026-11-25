import type { PausedFlags } from "../status/status-model";

// When a forgotten pause is said (ADR 036), as a pure decision.

/** Someone is at the Mac: a key or the pointer moved less than this ago. */
export const USED_WITHIN_S = 60;

export interface ReminderInput {
  readonly flags: PausedFlags;
  /** When the paused flags were last written; null when never. */
  readonly pausedSinceMs: number | null;
  readonly pausedUntilMs: number | null;
  /** Paused, or listening, for one call. */
  readonly forCall: boolean;
  /** The first run keeps Sondine paused until the user starts listening. */
  readonly onboarded: boolean;
  /** The pause already said. */
  readonly saidForMs: number | null;
  readonly afterMs: number;
}

/** The pause to say, and from when: everything paused, with no end; null for none. */
export function reminderDue(
  input: ReminderInput,
): { readonly sinceMs: number; readonly atMs: number } | null {
  const { flags, pausedSinceMs } = input;
  if (!flags.microphone || !flags.systemAudio || pausedSinceMs === null) return null;
  if (input.pausedUntilMs !== null || input.forCall || !input.onboarded) return null;
  if (input.saidForMs === pausedSinceMs) return null;
  return { sinceMs: pausedSinceMs, atMs: pausedSinceMs + input.afterMs };
}
