import { describe, expect, it } from "vitest";
import { withFocus } from "./chat-instructions";

describe("the agent's focus", () => {
  it("sends the user's words alone without a focus", () => {
    expect(withFocus("Qu'a dit Camille ?", null)).toBe("Qu'a dit Camille ?");
    expect(withFocus("Qu'a dit Camille ?", undefined)).toBe("Qu'a dit Camille ?");
  });

  it("names where the user is looking as a place to start, not a limit", () => {
    const sent = withFocus("Résume", { kind: "episode", episodeId: 42 });
    expect(sent).toContain("episodeId 42");
    expect(sent).toContain("read other conversations when the question needs them");
    expect(sent.endsWith("\n\nRésume")).toBe(true);
    expect(withFocus("x", { kind: "day", day: "2026-11-19" })).toContain("the day 2026-11-19");
    expect(withFocus("x", { kind: "person", personId: 7 })).toContain("personId 7");
  });
});
