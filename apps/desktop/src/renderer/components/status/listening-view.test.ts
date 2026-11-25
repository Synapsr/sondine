import type { CaptureHold, ListeningStatus, SpoolProblem } from "@sondine/api";
import { describe, expect, it } from "vitest";
import { listeningView } from "./listening-view";

const listening = (
  desired: ListeningStatus["desired"],
  effective: ListeningStatus["effective"],
  pausedUntilMs: number | null = null,
): ListeningStatus => ({
  desired,
  effective,
  microphonePaused: null,
  systemAudioPaused: null,
  changedAtMs: 0,
  pausedUntilMs,
  holds: [],
  callOffer: null,
  forCall: null,
  call: null,
  callEnded: null,
  pauseReminder: null,
});

const diskFull: SpoolProblem = { trackKey: null, code: "disk.full", sinceMs: 0 };
const ioError: SpoolProblem = { trackKey: "input:mic", code: "spool.io", sinceMs: 0 };

const hold = (scope: "all" | "microphone", lifted = false): CaptureHold => ({
  occurrenceId: "o1",
  reason: "calls",
  scope,
  name: null,
  zoneId: null,
  sinceMs: 0,
  untilMs: null,
  lifted,
});

const holding = (holds: ListeningStatus["holds"]): ListeningStatus => ({
  ...listening("listening", "listening"),
  holds,
});

describe("listening view", () => {
  it("never offers Resume while the helper is still listening", () => {
    // The pause was asked for but not confirmed (pending or rejected).
    expect(listeningView(listening("paused", "listening"))).toEqual({
      state: "pause-unconfirmed",
      actions: ["retry-pause", "resume"],
      pausedUntilMs: null,
    });
    expect(listeningView(listening("paused", "partial")).state).toBe("pause-unconfirmed");
  });

  it("offers Resume once the pause is confirmed, with the end of a timed pause", () => {
    expect(listeningView(listening("paused", "paused"))).toEqual({
      state: "paused",
      actions: ["resume"],
      pausedUntilMs: null,
    });
    expect(listeningView(listening("paused", "paused", 1_793_613_600_000)).pausedUntilMs).toBe(
      1_793_613_600_000,
    );
  });

  it("shows a confirmed pause even when the user asked to resume", () => {
    expect(listeningView(listening("listening", "paused"))).toMatchObject({
      state: "paused",
      actions: ["resume"],
    });
  });

  it("offers Pause while listening", () => {
    expect(listeningView(listening("listening", "listening"))).toEqual({
      state: "listening",
      actions: ["pause"],
      pausedUntilMs: null,
    });
    expect(listeningView(listening("listening", "partial")).actions).toEqual(["pause"]);
  });

  it("says when capture runs but its audio cannot be stored", () => {
    expect(listeningView(listening("listening", "listening"), [ioError, diskFull])).toEqual({
      state: "disk-full",
      actions: ["pause"],
      pausedUntilMs: null,
    });
    expect(listeningView(listening("listening", "partial"), [ioError]).state).toBe("write-error");
    // Paused, nothing is captured: a stale spool problem does not matter.
    expect(listeningView(listening("paused", "paused"), [diskFull]).state).toBe("paused");
  });

  it("follows the user's request while the helper is not connected", () => {
    expect(listeningView(listening("paused", "unknown"))).toMatchObject({
      state: "unknown",
      actions: ["resume"],
    });
    expect(listeningView(listening("listening", "unknown")).actions).toEqual(["pause"]);
  });

  it("shows a private zone holding everything, with « Écouter quand même » first", () => {
    expect(listeningView(holding([hold("all")]))).toEqual({
      state: "held",
      actions: ["lift", "pause"],
      pausedUntilMs: null,
    });
    // The microphone alone, or a lifted hold, still listens.
    expect(listeningView(holding([hold("microphone")])).state).toBe("listening");
    expect(listeningView(holding([hold("all", true)])).state).toBe("listening");
    // Audio that cannot be stored comes first.
    expect(listeningView(holding([hold("all")]), [diskFull]).state).toBe("disk-full");
  });
});
