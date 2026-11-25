import { describe, expect, it } from "vitest";
import { selfSpeakerLabel, type SpeakerSource } from "./self-speaker";

const mic = (label: string, voicedMs: number): SpeakerSource => ({
  label,
  trackKind: "input",
  voicedMs,
});
const far = (label: string, voicedMs: number): SpeakerSource => ({
  label,
  trackKind: "system",
  voicedMs,
});

describe("selfSpeakerLabel", () => {
  it("marks the microphone speaker who speaks most in a call", () => {
    // Built-in speakers: the mic also hears the far side, as a second, shorter voice.
    const speakers = [
      far("system:other/0/0", 90_000),
      mic("input:mic/0/0", 40_000),
      mic("input:mic/0/1", 12_000),
    ];
    expect(selfSpeakerLabel("call", speakers)).toBe("input:mic/0/0");
  });

  it("marks one speaker only, the earlier one on a tie", () => {
    expect(selfSpeakerLabel("call", [mic("a", 5_000), mic("b", 5_000)])).toBe("a");
  });

  it("marks the voice of a dictation", () => {
    expect(selfSpeakerLabel("dictation", [mic("input:mic/0/0", 8_000)])).toBe("input:mic/0/0");
  });

  it("marks nobody outside a call or a dictation, or without a microphone speaker", () => {
    expect(selfSpeakerLabel("in_person", [mic("a", 5_000)])).toBeNull();
    expect(selfSpeakerLabel("media", [mic("a", 5_000)])).toBeNull();
    expect(selfSpeakerLabel(null, [mic("a", 5_000)])).toBeNull();
    expect(selfSpeakerLabel("call", [far("f", 5_000)])).toBeNull();
    expect(selfSpeakerLabel("call", [])).toBeNull();
  });
});
