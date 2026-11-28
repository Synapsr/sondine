import { describe, expect, it } from "vitest";
import {
  DEFAULT_SITUATION,
  FIRST_POSITION,
  findStep,
  LAB_JOURNEYS,
  LabSituation,
  nextPosition,
  SITUATION_LABELS,
  situationOf,
} from "./flow-lab";

describe("the flow lab's catalog", () => {
  it("names every journey and step once, and starts where FIRST_POSITION says", () => {
    const journeys = LAB_JOURNEYS.map((journey) => journey.id);
    expect(new Set(journeys).size).toBe(journeys.length);
    for (const journey of LAB_JOURNEYS) {
      const steps = journey.steps.map((step) => step.id);
      expect(new Set(steps).size, journey.id).toBe(steps.length);
      expect(
        steps.every((id) => !id.includes("/")),
        journey.id,
      ).toBe(true);
    }
    expect(findStep(FIRST_POSITION.journey, FIRST_POSITION.step)?.index).toBe(0);
  });

  it("gives each step a route and a situation the schema accepts", () => {
    for (const journey of LAB_JOURNEYS) {
      for (const step of journey.steps) {
        expect(step.path.startsWith("/"), step.id).toBe(true);
        expect(LabSituation.safeParse(situationOf(step, {})).success, step.id).toBe(true);
        for (const offer of step.offers ?? []) expect(SITUATION_LABELS[offer]).toBeDefined();
      }
    }
  });

  it("puts the first run's steps on an empty data folder, before it is done", () => {
    const firstRun = LAB_JOURNEYS.find((journey) => journey.id === "first-run");
    for (const step of firstRun?.steps ?? []) {
      expect(step.data, step.id).toBe("empty");
      expect(step.path, step.id).toBe("/welcome");
    }
  });
});

describe("moving in the lab", () => {
  const at = {
    journey: "first-run",
    step: "permissions",
    situation: { permissions: "denied" },
  } as const;

  it("goes to the next and previous steps, keeping what the user chose", () => {
    expect(nextPosition(at, { type: "next" })).toEqual({ ...at, step: "where" });
    expect(nextPosition(at, { type: "previous" })).toEqual({ ...at, step: "statistics" });
    expect(nextPosition({ ...at, step: "intro" }, { type: "previous" })).toBeNull();
    expect(nextPosition({ ...at, step: "restore" }, { type: "next" })).toBeNull();
  });

  it("starts the journey again from its first step and the step's own situation", () => {
    expect(nextPosition(at, { type: "restart" })).toEqual({
      journey: "first-run",
      step: "intro",
      situation: {},
    });
  });

  it("forgets the choices when going to another journey, not within one", () => {
    expect(nextPosition(at, { type: "go", journey: "cloud", step: "trial" })?.situation).toEqual(
      {},
    );
    expect(
      nextPosition(at, { type: "go", journey: "first-run", step: "start" })?.situation,
    ).toEqual(at.situation);
    expect(nextPosition(at, { type: "go", journey: "cloud", step: "nowhere" })).toBeNull();
  });

  it("layers the defaults, the step's situation and the user's choice", () => {
    const step = findStep("first-listen", "empty-today")?.step;
    if (step === undefined) throw new Error("no step");
    expect(situationOf(step, {})).toEqual({ ...DEFAULT_SITUATION, permissions: "granted" });
    expect(situationOf(step, { permissions: "denied", model: undefined }).permissions).toBe(
      "denied",
    );
  });

  it("changes the situation without moving", () => {
    expect(nextPosition(at, { type: "situation", situation: { network: "offline" } })).toEqual({
      ...at,
      situation: { permissions: "denied", network: "offline" },
    });
    expect(nextPosition(at, { type: "size", width: 800, height: 600 })).toBeNull();
  });
});
