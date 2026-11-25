import type { VoiceReadSession, VoiceReadStatus } from "@sondine/api";
import { describe, expect, it } from "vitest";
import { voiceReadView } from "./voice-read-view";

const session = (change: Partial<VoiceReadSession> = {}): VoiceReadSession => ({
  phase: "idle",
  elapsedMs: 0,
  voicedMs: 0,
  targetMs: 25_000,
  minimumMs: 10_000,
  level: 0,
  failure: null,
  ...change,
});

const status = (change: Partial<VoiceReadStatus> = {}): VoiceReadStatus => ({
  recognition: true,
  available: true,
  read: null,
  session: session(),
  ...change,
});

describe("the voice read's view", () => {
  it("offers nothing while voices are not recognized or the build cannot record", () => {
    expect(voiceReadView(status({ recognition: false }))).toEqual({ kind: "recognition-off" });
    expect(voiceReadView(status({ available: false }))).toEqual({ kind: "unavailable" });
  });

  it("counts the voice heard and offers « Terminer » from the minimum", () => {
    const early = session({ phase: "recording", voicedMs: 9_900, level: 0.5 });
    expect(voiceReadView(status({ session: early }))).toEqual({
      kind: "recording",
      voicedSeconds: 9,
      targetSeconds: 25,
      canFinish: false,
      level: 0.5,
    });
    const enough = session({ phase: "recording", voicedMs: 26_000 });
    expect(voiceReadView(status({ session: enough }))).toMatchObject({
      voicedSeconds: 25,
      canFinish: true,
    });
  });

  it("shows an outcome only to the panel that started the read", () => {
    const failed = status({ session: session({ phase: "failed", failure: "too-short" }) });
    expect(voiceReadView(failed)).toEqual({ kind: "ready", failure: "too-short" });
    expect(voiceReadView(failed, false)).toEqual({ kind: "ready", failure: null });
    const done = status({ session: session({ phase: "done" }) });
    expect(voiceReadView(done)).toEqual({ kind: "done" });
    expect(voiceReadView(done, false)).toEqual({ kind: "ready", failure: null });
  });
});
