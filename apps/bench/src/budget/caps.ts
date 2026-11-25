import type { ScenarioId } from "./scenarios.ts";

// The always-on budget of docs/architecture.md §5 ("Starting caps", draft 2), as data. These
// are targets: M0 measurements plus 15 % replace them, and that change bumps CAPS_VERSION.
export const CAPS_VERSION = "architecture-5-draft-2";

/** The architecture table gives CPU and wakeup caps for S0 and S3 only. */
export type CapProfile = "S0" | "S3";
export type ProfileLimits = Readonly<Record<CapProfile, number>>;

/** `spec`: the architecture states it. `inferred`: this harness applies a stated cap to a
 * scenario the table does not cover, as an upper bound (see `scenarioProfiles`). */
export type CapBasis = "spec" | "inferred";

export const CAP_GROUP_IDS = [
  "sondine-audio",
  "coreaudiod",
  "electron-main",
  "chromium-services",
  "core",
] as const;
export type CapGroupId = (typeof CAP_GROUP_IDS)[number];

export interface CapRow {
  readonly group: CapGroupId;
  readonly label: string;
  /** Compared as running minus the S6 (paused) baseline. */
  readonly delta: boolean;
  readonly footprintMiB: number | null;
  /** Mean CPU, percent of one core. */
  readonly cpuMeanPercent: ProfileLimits | null;
  readonly wakeupsPerS: ProfileLimits | null;
}

export const capRows: readonly CapRow[] = [
  {
    group: "sondine-audio",
    label: "sondine-audio",
    delta: false,
    footprintMiB: 48,
    cpuMeanPercent: { S0: 0.4, S3: 1.5 },
    wakeupsPerS: { S0: 30, S3: 80 },
  },
  {
    group: "coreaudiod",
    label: "coreaudiod delta",
    delta: true,
    footprintMiB: null,
    cpuMeanPercent: { S0: 0.3, S3: 1.0 },
    wakeupsPerS: { S0: 25, S3: 60 },
  },
  {
    group: "electron-main",
    label: "Electron main",
    delta: false,
    footprintMiB: 100,
    cpuMeanPercent: { S0: 0.1, S3: 0.1 },
    wakeupsPerS: { S0: 1, S3: 1 },
  },
  {
    group: "chromium-services",
    label: "Chromium services",
    delta: false,
    footprintMiB: 84,
    cpuMeanPercent: null,
    wakeupsPerS: { S0: 1, S3: 1 },
  },
  {
    group: "core",
    label: "core",
    delta: false,
    footprintMiB: 120,
    cpuMeanPercent: { S0: 0.1, S3: 0.3 },
    wakeupsPerS: { S0: 2, S3: 5 },
  },
];

export const totalCaps = {
  footprintMiB: 362,
  /** System power, running minus paused. Measured here from Sondine's own processes only. */
  powerDeltaMilliwatts: { S0: 30, S3: 120 } satisfies ProfileLimits,
  footprintSlopeMiBPerHour: 2,
  /** The slope cap is stated over 8 h; shorter runs are too noisy (V8 GC sawtooth). */
  slopeMinimumMeasuredS: 3600,
  ringOverflows: 0,
} as const;

/** "Zero Sondine sleep assertions in S0"; paused should hold none either. */
export const sleepAssertionScenarios: Readonly<Partial<Record<ScenarioId, CapBasis>>> = {
  S0: "spec",
  S6: "inferred",
};

/**
 * Which column of the table applies to each scenario. S1, S2 and S4 run at most the S3 capture
 * work (one app tap, the global tap and the mic, or the mic with the VAD busy), and paused runs
 * less than silence, so their nearest stated cap is an upper bound. S5 (four taps) and the
 * mixed soak exceed every stated column: they record CPU and wakeups without a cap.
 */
export const scenarioProfiles: Readonly<
  Record<ScenarioId, { readonly profile: CapProfile; readonly basis: CapBasis } | null>
> = {
  S0: { profile: "S0", basis: "spec" },
  S1: { profile: "S3", basis: "inferred" },
  S2: { profile: "S3", basis: "inferred" },
  S3: { profile: "S3", basis: "spec" },
  S4: { profile: "S3", basis: "inferred" },
  S5: null,
  S6: { profile: "S0", basis: "inferred" },
  soak: null,
};

/** Regression gates of architecture §13, as fractions of the first run's value. */
export const regressionThresholds = {
  footprint: 0.05,
  energy: 0.1,
  wakeups: 0.1,
  cpu: 0.1,
} as const;

export const MIB = 1_048_576;
