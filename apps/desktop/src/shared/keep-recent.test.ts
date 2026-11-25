import { describe, expect, it } from "vitest";
import { keepFeedback } from "./keep-recent";

const kept = (keptMs: number) => ({ outcome: "kept" as const, atMs: 0, keptMs, episodeIds: [] });

describe("⌃⌥⌘K feedback", () => {
  it("says what was kept, in the menu bar's language", () => {
    expect(keepFeedback(kept(120_000), "fr")).toBe("Gardé : les 2 dernières minutes");
    expect(keepFeedback(kept(119_000), "en")).toBe("Kept: the last 2 minutes");
    // Listening started or stopped meanwhile: only what exists.
    expect(keepFeedback(kept(45_000), "fr")).toBe("Gardé : 45 s");
    expect(keepFeedback(kept(80_000), "en")).toBe("Kept: 1 min");
    expect(keepFeedback({ outcome: "nothing" }, "fr")).toBe("Rien d’enregistré à garder");
    expect(keepFeedback(null, "en")).toBe("Nothing was kept");
  });
});
