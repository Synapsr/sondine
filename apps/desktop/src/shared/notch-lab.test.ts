import { describe, expect, it } from "vitest";
import { LAB_SCENARIOS, LAB_START, labReduce, type LabState, type LabStep } from "./notch-lab";

const play = (steps: readonly LabStep[], from: LabState = LAB_START) =>
  steps.reduce((state, step) => labReduce(state, step, 1_000), from);

describe("the notch lab", () => {
  it("takes an answer back, and puts back the capture before", () => {
    const skipped = play([{ type: "start" }, { type: "toggle", on: false }]);
    expect(skipped).toMatchObject({
      offered: false,
      settings: { capture: "paused" },
      answer: { kind: "skip", before: "listening" },
    });
    expect(play([{ type: "toggle", on: true }], skipped)).toMatchObject({
      settings: { capture: "listening" },
      answer: null,
    });
    expect(play([{ type: "hang-up" }], skipped)).toMatchObject({
      call: null,
      settings: { capture: "listening" },
      card: { kind: "ended", restored: "listening" },
    });
  });

  it("drops the answer when the capture is set by hand", () => {
    const state = play([
      { type: "start" },
      { type: "toggle", on: false },
      { type: "set", settings: { capture: "listening", people: undefined } },
    ]);
    expect(state).toMatchObject({ answer: null, settings: { capture: "listening", people: 0 } });
  });

  it("ends every scenario with something to see", () => {
    for (const [name, steps] of Object.entries(LAB_SCENARIOS)) {
      const state = play(steps.map(([, step]) => step));
      expect(state.call !== null || state.card !== null, name).toBe(true);
    }
  });
});
