import * as z from "zod";

// Always-on budget scenarios (docs/architecture.md §5). The window stays closed, MCP is off,
// and no engine worker is alive. S6 (paused) is the baseline for every delta.

export const SCENARIO_IDS = ["S0", "S1", "S2", "S3", "S4", "S5", "S6", "soak"] as const;
export const scenarioIdSchema = z.enum(SCENARIO_IDS);
export type ScenarioId = z.infer<typeof scenarioIdSchema>;

export const BASELINE_SCENARIO = "S6" satisfies ScenarioId;

export const scenarios = {
  S0: { title: "Silence, mic only", defaultDurationS: 30 * 60 },
  S1: { title: "Music in one app", defaultDurationS: 30 * 60 },
  S2: { title: "Speech video in Safari", defaultDurationS: 30 * 60 },
  S3: { title: "FaceTime or Zoom call", defaultDurationS: 30 * 60 },
  S4: { title: "In-person speech on the mic", defaultDurationS: 30 * 60 },
  S5: { title: "Four concurrent app taps", defaultDurationS: 30 * 60 },
  S6: { title: "Paused (baseline)", defaultDurationS: 30 * 60 },
  soak: { title: "8 h mixed soak", defaultDurationS: 8 * 3600 },
} as const satisfies Record<ScenarioId, { title: string; defaultDurationS: number }>;
