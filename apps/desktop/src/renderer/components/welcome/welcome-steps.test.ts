import type { PermissionState } from "@sondine/api";
import { describe, expect, it } from "vitest";
import {
  modelStepContinues,
  modelStepView,
  nextStep,
  permissionOffer,
  previousStep,
  startNotes,
  stepIndex,
  WELCOME_STEPS,
} from "./welcome-steps";

const permission = (status: PermissionState["status"]): PermissionState => ({
  status,
  evidence: "not-checked",
});

describe("first run", () => {
  it("goes through six steps in order, the voice read after the model (ADR 037)", () => {
    expect(WELCOME_STEPS).toEqual([
      "welcome",
      "statistics",
      "permissions",
      "model",
      "voice",
      "start",
    ]);
    expect(stepIndex("model")).toBe(3);
    expect(nextStep("welcome")).toBe("statistics");
    expect(nextStep("statistics")).toBe("permissions");
    expect(nextStep("permissions")).toBe("model");
    expect(nextStep("model")).toBe("voice");
    expect(nextStep("voice")).toBe("start");
    expect(nextStep("start")).toBeNull();
    expect(previousStep("permissions")).toBe("statistics");
    expect(previousStep("welcome")).toBeNull();
  });

  it("asks for a permission, sends to System Settings once refused, and stops when restricted", () => {
    expect(permissionOffer(permission("granted-verified"))).toBe("granted");
    expect(permissionOffer(permission("granted"))).toBe("granted");
    expect(permissionOffer(permission("not-determined"))).toBe("ask");
    expect(permissionOffer(permission("unknown"))).toBe("ask");
    expect(permissionOffer(permission("denied"))).toBe("settings");
    expect(permissionOffer(permission("restricted"))).toBe("restricted");
  });

  it("says before starting what will not be recorded or transcribed", () => {
    expect(
      startNotes({ microphone: permission("granted"), systemAudio: permission("denied") }, false),
    ).toEqual({ missing: ["systemAudio"], noModel: true });
    expect(startNotes(null, true)).toEqual({ missing: [], noModel: false });
  });

  it("lets the model step continue without transcription", () => {
    expect(modelStepContinues(false, false)).toBe("without-model");
    expect(modelStepContinues(false, true)).toBe("continue");
    expect(modelStepContinues(true, false)).toBe("continue");
  });

  it("offers where to transcribe on every Mac, and the model only for this Mac (ADR 040)", () => {
    expect(modelStepView(false, false)).toBe("destination-and-model");
    expect(modelStepView(true, false)).toBe("destination");
    expect(modelStepView(true, true)).toBe("destination");
    // Too small a Mac keeps its card, with its sign-up link and the same choice.
    expect(modelStepView(false, true)).toBe("cloud-card");
  });
});
