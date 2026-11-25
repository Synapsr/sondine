import type { ContextOngoingResult, ContextRefusal } from "@sondine/api";
import { describe, expect, it } from "vitest";
import { pasteFeedback } from "./paste-context";

const added = (itemIds: number[], refused: ContextRefusal[] = []): ContextOngoingResult => ({
  outcome: "added",
  episodeId: 3,
  itemIds,
  refused,
});

describe("⌃⌥⌘V feedback", () => {
  it("says what the clipboard became, in the menu bar's language", () => {
    expect(pasteFeedback(added([7]), "fr")).toBe("Ajouté à la conversation");
    expect(pasteFeedback({ outcome: "none" }, "en")).toBe("No conversation going on");
    expect(pasteFeedback(added([]), "fr")).toBe("Presse-papiers vide");
    expect(pasteFeedback(added([], [{ name: null, problem: "too-long" }]), "fr")).toBe(
      "Rien n’a été ajouté",
    );
    expect(pasteFeedback(null, "en")).toBe("Nothing was added");
  });
});
