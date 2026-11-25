import type { Status } from "@sondine/api";
import { describe, expect, it } from "vitest";
import { initialStatus } from "../status/status-model";
import { updateWaits, type GoingOn } from "./update-quiet";

const status = initialStatus(0, { microphone: false, systemAudio: false });
const quiet: GoingOn = {
  status,
  capture: { call: false, dictation: false, conversation: false, playback: false },
  phone: false,
  task: false,
  idle: { idleSeconds: 600, locked: false },
};
const waits = (next: Partial<GoingOn>) => updateWaits({ ...quiet, ...next });
const withStatus = (next: Partial<Status>) => waits({ status: { ...status, ...next } });
const capture = (name: keyof GoingOn["capture"]) =>
  waits({ capture: { ...quiet.capture, [name]: true } });

describe("what an update would cut", () => {
  it("is nothing on an idle Mac, listening or paused", () => {
    expect(updateWaits(quiet)).toEqual([]);
  });

  it("names each thing going on", () => {
    expect(capture("call")).toEqual(["call"]);
    expect(capture("dictation")).toEqual(["dictation"]);
    expect(capture("conversation")).toEqual(["conversation"]);
    expect(capture("playback")).toEqual(["task"]);
    expect(waits({ phone: true })).toEqual(["sync"]);
    expect(waits({ task: true })).toEqual(["task"]);
  });

  it("waits for a call it was not told to listen to, and for speech heard now", () => {
    const call = {
      callId: "c",
      bundleId: "us.zoom.xos",
      name: "Zoom",
      sinceMs: 0,
      episodeId: null,
    };
    expect(withStatus({ listening: { ...status.listening, call } })).toEqual(["call"]);
    const track = {
      trackKey: "t",
      runId: "r",
      kind: "input" as const,
      name: null,
      stream: 0,
      measuredRate: null,
      level: null,
      speaking: true,
      ringOverflows: 0,
      droppedSamples: 0,
      openedAtMs: 0,
    };
    expect(withStatus({ tracks: [track as unknown as Status["tracks"][number]] })).toEqual([
      "conversation",
    ]);
  });

  it.each(["loading", "busy", "unloading"] as const)("waits for a %s worker", (worker) => {
    expect(withStatus({ analysis: { ...status.analysis, worker } })).toEqual(["transcription"]);
  });

  it("does not wait for a model kept ready", () => {
    expect(withStatus({ analysis: { ...status.analysis, worker: "ready" } })).toEqual([]);
  });

  it("waits for five idle minutes, or a locked screen", () => {
    const idle = (idleSeconds: number | null, locked = false) =>
      waits({ idle: { idleSeconds, locked } });
    expect(idle(299)).toEqual(["in-use"]);
    expect(idle(300)).toEqual([]);
    expect(idle(0, true)).toEqual([]);
    // Main did not answer: not known to be idle.
    expect(idle(null)).toEqual(["in-use"]);
  });

  it("does not install on a Mac half awake", () => {
    expect(withStatus({ power: { ...status.power, suspended: true } })).toEqual(["in-use"]);
  });
});
