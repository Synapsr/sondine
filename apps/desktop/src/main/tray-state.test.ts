import type { Status } from "@sondine/api";
import { describe, expect, it } from "vitest";
import type { HelperProcessInfo } from "../shared/core-messages";
import {
  activeHolds,
  mayRecord,
  TIMED_PAUSE_MS,
  trayControls,
  trayLocale,
  trayState,
} from "./tray-state";

const PAUSES = ["pause-15-min", "pause-1-hour", "pause"];

const status: Status = {
  listening: {
    desired: "listening",
    effective: "listening",
    microphonePaused: false,
    systemAudioPaused: false,
    changedAtMs: 1,
    pausedUntilMs: null,
    holds: [],
    callOffer: null,
    forCall: null,
    call: null,
    callEnded: null,
    pauseReminder: null,
  },
  helper: {
    connection: "connected",
    process: "running",
    pid: 4242,
    restarts: 0,
    sessionId: "6f1c2a4e-8b3d-4c5e-9f10-2a3b4c5d6e7f",
    version: "0.1.0",
    connectedAtMs: 1,
    lastError: null,
  },
  permissions: null,
  tracks: [],
  spool: [],
  lastHealth: null,
  power: { onBattery: false, suspended: false, thermalState: null },
  importer: { imported: 0, errors: 0, lastError: null },
  analysis: {
    worker: "absent",
    queued: { requested: 0, conversations: 0, moments: 0, media: 0, traces: 0 },
    running: null,
    waitingFor: [],
    waitingEpisodeId: null,
    server: null,
    requests: [],
    retryAtMs: null,
    lastError: null,
    models: [],
  },
  live: { enabled: false, state: "off", revision: 0 },
  updates: {
    automatic: null,
    searches: false,
    blocked: "development",
    current: "0.2.0",
    available: null,
    phase: "idle",
    progress: null,
    waitingFor: [],
    requested: false,
    checkedAtMs: null,
    problem: null,
    updated: null,
  },
  retention: { spoolBytes: 0, archivedBytes: 0, blocked: 0, lastProblem: null },
  deletions: 0,
  kept: 0,
  changes: 0,
  updatedAtMs: 1,
};

const helper = (state: HelperProcessInfo["state"]): HelperProcessInfo => ({
  state,
  pid: state === "running" ? 4242 : null,
  restarts: 0,
  lastExit: null,
  nextAttemptAtMs: null,
});

const withListening = (listening: Partial<Status["listening"]>): Status => ({
  ...status,
  listening: { ...status.listening, ...listening },
});

describe("tray state", () => {
  it("shows a private zone holding everything as held, not paused, and keeps the pauses", () => {
    const hold = (scope: "all" | "microphone", lifted = false) => ({
      occurrenceId: `${scope}-${String(lifted)}`,
      reason: scope === "all" ? ("schedule" as const) : ("app" as const),
      scope,
      name: scope === "all" ? "Nuit" : "Zoom",
      zoneId: null,
      sinceMs: 1,
      untilMs: null,
      lifted,
    });
    const held = { ...status, listening: { ...status.listening, holds: [hold("all")] } };
    expect(trayState(held, helper("running"))).toBe("held");
    expect(mayRecord("held")).toBe(false);
    expect(trayControls("held", held).items).toEqual(PAUSES);
    // Lifted, or the microphone alone: still listening.
    const lifted = { ...status, listening: { ...status.listening, holds: [hold("all", true)] } };
    expect(trayState(lifted, helper("running"))).toBe("listening");
    expect(activeHolds(lifted)).toEqual([]);
    const mic = { ...status, listening: { ...status.listening, holds: [hold("microphone")] } };
    expect(trayState(mic, helper("running"))).toBe("listening");
  });

  it("follows the helper's confirmed state once connected", () => {
    expect(trayState(status, helper("running"))).toBe("listening");
    expect(trayState(withListening({ effective: "partial" }), helper("running"))).toBe("partial");
    expect(trayState(withListening({ effective: "unknown" }), helper("running"))).toBe(
      "connecting",
    );
  });

  it("never shows paused while the helper has not confirmed the pause", () => {
    // The helper rejected the pause (or has not answered yet): it is still recording.
    const unconfirmed = withListening({ desired: "paused", effective: "listening" });
    expect(trayState(unconfirmed, helper("running"))).toBe("pause-unconfirmed");
    expect(
      trayState(withListening({ desired: "paused", effective: "partial" }), helper("running")),
    ).toBe("pause-unconfirmed");
    // A running helper that core cannot reach yet may be recording too.
    expect(
      trayState(
        { ...unconfirmed, helper: { ...unconfirmed.helper, connection: "connecting" } },
        helper("running"),
      ),
    ).toBe("pause-unconfirmed");
    expect(
      trayState(withListening({ desired: "paused", effective: "paused" }), helper("running")),
    ).toBe("paused");
  });

  it("shows confirmed pauses even when the user asked to resume", () => {
    expect(
      trayState(withListening({ desired: "listening", effective: "paused" }), helper("running")),
    ).toBe("paused");
  });

  it("shows the user's pause even while the helper is away", () => {
    const paused = withListening({ desired: "paused", effective: "unknown" });
    expect(
      trayState(
        { ...paused, helper: { ...paused.helper, connection: "disconnected" } },
        helper("restarting"),
      ),
    ).toBe("paused");
  });

  it("surfaces a crash loop above everything, and a missing helper as unavailable", () => {
    expect(trayState(withListening({ desired: "paused" }), helper("crash-loop"))).toBe(
      "crash-loop",
    );
    expect(trayState(null, helper("missing"))).toBe("unavailable");
    expect(
      trayState(
        { ...status, helper: { ...status.helper, connection: "incompatible" } },
        helper("running"),
      ),
    ).toBe("unavailable");
  });

  it("says when audio is not being stored, with the microphone still open", () => {
    const full: Status = {
      ...status,
      spool: [{ trackKey: "input:BuiltInMicrophoneDevice", code: "disk.full", sinceMs: 1 }],
    };
    expect(trayState(full, helper("running"))).toBe("disk-full");
    expect(mayRecord("disk-full")).toBe(true);
    expect(trayControls("disk-full", full).items).toEqual(PAUSES);
    const failing: Status = {
      ...status,
      spool: [{ trackKey: null, code: "spool.io", sinceMs: 1 }],
    };
    expect(trayState(failing, helper("running"))).toBe("write-error");
    // Core cannot start on a full data volume: say why rather than "keeps stopping".
    expect(trayState(null, helper("running"), true, true)).toBe("disk-full");
    expect(trayState(null, helper("running"), true, false)).toBe("crash-loop");
    // A confirmed pause stores nothing anyway.
    expect(
      trayState(
        { ...full, listening: { ...full.listening, desired: "paused", effective: "paused" } },
        helper("running"),
      ),
    ).toBe("paused");
  });

  it("waits while core or the connection is starting", () => {
    expect(trayState(null, null)).toBe("connecting");
    expect(
      trayState(
        { ...status, helper: { ...status.helper, connection: "disconnected" } },
        helper("running"),
      ),
    ).toBe("connecting");
  });

  it("keeps the listening icon and offers a retry while a pause is unconfirmed", () => {
    expect(mayRecord("pause-unconfirmed")).toBe(true);
    expect(mayRecord("paused")).toBe(false);
    const unconfirmed = withListening({ desired: "paused", effective: "listening" });
    expect(trayControls("pause-unconfirmed", unconfirmed)).toEqual({
      items: ["retry-pause", "resume"],
      enabled: true,
    });
    expect(trayControls("paused", withListening({ effective: "paused" })).items).toEqual([
      "resume",
    ]);
    expect(trayControls("listening", status).items).toEqual(PAUSES);
  });

  it("offers a pause of 15 min, 1 h or until resumed, and an end to a timed pause", () => {
    expect(TIMED_PAUSE_MS).toEqual({ "pause-15-min": 900_000, "pause-1-hour": 3_600_000 });
    expect(trayControls("partial", status).items).toEqual(PAUSES);
    const timed = withListening({
      desired: "paused",
      effective: "paused",
      pausedUntilMs: 1_793_613_600_000,
    });
    // A timed pause can be kept until resumed instead.
    expect(trayControls("paused", timed).items).toEqual(["resume", "pause"]);
  });

  it("shows the controls as unavailable while core is down", () => {
    expect(trayState(null, helper("running"))).toBe("connecting");
    expect(trayControls("connecting", null)).toEqual({ items: PAUSES, enabled: false });
    expect(trayState(null, helper("running"), true)).toBe("crash-loop");
  });

  it("speaks French on a French Mac and English otherwise", () => {
    expect(trayLocale("fr-FR")).toBe("fr");
    expect(trayLocale("fr")).toBe("fr");
    expect(trayLocale("en-GB")).toBe("en");
    expect(trayLocale("de-DE")).toBe("en");
  });
});
