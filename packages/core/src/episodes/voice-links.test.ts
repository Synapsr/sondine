import { describe, expect, it } from "vitest";
import { linkVoices, type VoiceToLink } from "./voice-links";

// Directions on a plane: the cosine of two voices is the cosine of their angle.
const at = (degrees: number) => [
  Math.cos((degrees * Math.PI) / 180),
  Math.sin((degrees * Math.PI) / 180),
];
const voice = (label: string, degrees: number, extra: Partial<VoiceToLink> = {}): VoiceToLink => ({
  label,
  track: "phone:a",
  vector: at(degrees),
  ...extra,
});

describe("linkVoices", () => {
  it("gives the voices of one person, in any request, the label of the first", () => {
    const links = linkVoices([
      voice("t/1/1", 0),
      voice("t/1/2", 90),
      voice("t/2/1", 85),
      voice("t/2/2", 10),
      voice("t/2/3", 5),
    ]);
    expect(Object.fromEntries(links)).toEqual({
      "t/1/1": "t/1/1",
      "t/1/2": "t/1/2",
      "t/2/1": "t/1/2",
      "t/2/2": "t/1/1",
      "t/2/3": "t/1/1",
    });
  });

  it("keeps apart voices less alike than the threshold, on average over their groups", () => {
    // 40° is a cosine of 0.77, 80° of 0.17: the third voice is 0.47 from the pair on average.
    const links = linkVoices([voice("a", 0), voice("b", 40), voice("c", 80)]);
    expect(links.get("b")).toBe("a");
    expect(links.get("c")).toBe("c");
  });

  it("never links voices of different tracks", () => {
    const links = linkVoices([voice("a", 0), voice("b", 0, { track: "input:mic" })]);
    expect(links.get("b")).toBe("b");
  });

  it("links a named voice only with voices named as the same person", () => {
    const links = linkVoices([
      voice("a", 0, { person: "1" }),
      voice("b", 5, { person: "2" }),
      voice("c", 3),
      voice("d", 4, { person: "1" }),
      voice("e", 2),
    ]);
    expect(Object.fromEntries(links)).toEqual({ a: "a", b: "b", c: "c", d: "a", e: "c" });
  });
});
