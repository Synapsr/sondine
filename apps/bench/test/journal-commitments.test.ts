import { describe, expect, it } from "vitest";
import { scoreCommitments, type CommitmentLabels } from "../src/journal/commitments.ts";

const labels: CommitmentLabels = {
  version: 1,
  units: [
    { id: "send", episodeId: 1, segments: [10, 9], grade: 1, who: "mic/0/0" },
    { id: "call", episodeId: 1, segments: [20], grade: 1, who: "mic/0/0", words: "appel" },
    { id: "photo", episodeId: 1, segments: [20], grade: 0.5, who: "mic/0/0", words: "photo" },
    { id: "elsewhere", episodeId: 2, segments: [30], grade: 1, who: null },
  ],
  falses: [{ episodeId: 1, segments: [40], family: "immediate" }],
};

const candidate = (segmentIds: number[], text: string, whoLabel: string | null = "mic/0/0") => ({
  episodeId: 1,
  whoLabel,
  text,
  segmentIds,
});

describe("scoring commitments", () => {
  it("counts a unit once, then duplicates, wrong voices and false sentences by family", () => {
    const score = scoreCommitments(labels, {
      label: "run",
      episodes: [1],
      candidates: [
        candidate([9], "envoyer le devis"),
        candidate([10], "envoyer le devis demain"),
        candidate([10], "envoyer le devis", "mic/0/1"),
        candidate([40], "attendre deux minutes"),
        candidate([50], "rien de connu"),
      ],
    });
    expect(score.right).toBe(1);
    expect(score.families).toEqual({ duplicate: 1, "wrong-person": 1, immediate: 1 });
    expect(score.unjudged).toBe(1);
    expect(score.written).toBe(5);
  });

  it("tells two promises of one sentence apart by their words, and counts recall in covered episodes", () => {
    const score = scoreCommitments(labels, {
      label: "run",
      episodes: [1],
      candidates: [candidate([20], "envoyer la photo"), candidate([20], "appeler EDF")],
    });
    expect(score.found.toSorted()).toEqual(["call", "photo"]);
    expect(score.right).toBe(1.5);
    expect(score.possible).toBe(2.5);
    expect(score.missed).toEqual(["send"]);
  });
});
