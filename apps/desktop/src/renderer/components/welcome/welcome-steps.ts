import { OnboardingStep, type Permissions, type PermissionState } from "@sondine/api";

// The first run's six steps (architecture §11, ADR 037): what the user wants
// to find again, the question about anonymous statistics (ADR 042), the two permissions, the transcription model (optional), the
// voice read (optional, ADR 034), and starting to listen. Nothing is recorded for memory before
// the last step; the voice read records only the text the user reads. The step on screen is saved, so
// a relaunch after a permission prompt reopens it.

export const WELCOME_STEPS = OnboardingStep.options;

export function stepIndex(step: OnboardingStep): number {
  return WELCOME_STEPS.indexOf(step);
}

export function nextStep(step: OnboardingStep): OnboardingStep | null {
  return WELCOME_STEPS[stepIndex(step) + 1] ?? null;
}

export function previousStep(step: OnboardingStep): OnboardingStep | null {
  const index = stepIndex(step);
  return index > 0 ? (WELCOME_STEPS[index - 1] ?? null) : null;
}

/**
 * What a permission row offers: nothing once granted, the system prompt
 * while it was never asked (or cannot be checked), System Settings once
 * refused, and nothing it can do when the system restricts it.
 */
export type PermissionOffer = "granted" | "ask" | "settings" | "restricted";

export function permissionOffer(permission: PermissionState): PermissionOffer {
  switch (permission.status) {
    case "granted":
    case "granted-verified":
      return "granted";
    case "denied":
      return "settings";
    case "restricted":
      return "restricted";
    case "not-determined":
    case "unknown":
      return "ask";
  }
}

export interface StartNotes {
  /** Sources that will not be recorded for lack of permission. */
  readonly missing: readonly ("microphone" | "systemAudio")[];
  /** Nothing is transcribed until a model is installed. */
  readonly noModel: boolean;
}

export function startNotes(permissions: Permissions | null, modelReady: boolean): StartNotes {
  const missing =
    permissions === null
      ? []
      : (["microphone", "systemAudio"] as const).filter(
          (kind) => permissionOffer(permissions[kind]) !== "granted",
        );
  return { missing, noModel: !modelReady };
}

/** The model step's button: plain once a model is installed or on its way. */
export function modelStepContinues(ready: boolean, busy: boolean): "continue" | "without-model" {
  return ready || busy ? "continue" : "without-model";
}
