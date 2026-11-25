import * as z from "zod";
import { accessSchema, meterOverheadSchema, statsSchema } from "../meter/meter-schema.ts";
import { sondineAssertionSchema } from "./assertions.ts";
import { CAP_GROUP_IDS } from "./caps.ts";
import { processRoleSchema } from "./discovery.ts";
import { hostSchema } from "./host.ts";
import { scenarioIdSchema } from "./scenarios.ts";

// One always-on budget run, written to bench/results/local/<id>.json (git-ignored).
// Bump schemaVersion on any breaking change and keep a reader for the old version.

export const RESULT_SCHEMA = "sondine.budget-result";
export const RESULT_SCHEMA_VERSION = 1;

/** The cap groups plus the sum of every Sondine process outside engine workers. */
export const GROUP_IDS = [...CAP_GROUP_IDS, "sondine-total"] as const;
export const groupIdSchema = z.enum(GROUP_IDS);
export type GroupId = z.infer<typeof groupIdSchema>;

export const checkMetricSchema = z.enum([
  "footprint-max",
  "cpu-mean",
  "wakeups-mean",
  "cpu-mean-delta",
  "wakeups-mean-delta",
  "power-delta",
  "footprint-slope",
  "ring-overflows",
  "sleep-assertions",
]);
export type CheckMetric = z.infer<typeof checkMetricSchema>;

export const checkStatusSchema = z.enum(["pass", "fail", "not-measured", "not-evaluated"]);
export type CheckStatus = z.infer<typeof checkStatusSchema>;

export const checkSchema = z.object({
  id: z.string().min(1),
  /** A group id, or `pid:<n>` for per-process checks. */
  subject: z.string().min(1),
  metric: checkMetricSchema,
  unit: z.enum(["MiB", "%", "/s", "mW", "MiB/h", "count"]),
  limit: z.number(),
  value: z.number().nullable(),
  status: checkStatusSchema,
  basis: z.enum(["spec", "inferred"]),
  /** `partial` when the harness sees only part of what the cap covers. */
  coverage: z.enum(["full", "partial"]),
  note: z.string().nullable(),
});
export type Check = z.infer<typeof checkSchema>;

export const verdictSchema = z.object({
  /** `incomplete`: nothing failed, but some checks could not be measured or evaluated. */
  status: z.enum(["pass", "fail", "incomplete"]),
  pass: z.int().nonnegative(),
  fail: z.int().nonnegative(),
  notMeasured: z.int().nonnegative(),
  notEvaluated: z.int().nonnegative(),
});
export type Verdict = z.infer<typeof verdictSchema>;

export const resultProcessSchema = z.object({
  pid: z.int().positive(),
  startUs: z.number().nonnegative(),
  role: processRoleSchema,
  name: z.string(),
  path: z.string().nullable(),
  access: accessSchema,
  exited: z.boolean(),
  stats: statsSchema,
});
export type ResultProcess = z.infer<typeof resultProcessSchema>;

export const resultGroupSchema = z.object({
  id: groupIdSchema,
  pids: z.array(z.int().positive()),
  stats: statsSchema,
});
export type ResultGroup = z.infer<typeof resultGroupSchema>;

export const budgetResultSchema = z.object({
  schema: z.literal(RESULT_SCHEMA),
  schemaVersion: z.literal(RESULT_SCHEMA_VERSION),
  id: z.string().min(1),
  label: z.string().min(1),
  scenario: z.object({ id: scenarioIdSchema, title: z.string() }),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
  requestedDurationS: z.number().positive(),
  settleS: z.number().nonnegative(),
  /** Awake time covered by samples. */
  measuredS: z.number().nonnegative(),
  sleptS: z.number().nonnegative(),
  interrupted: z.boolean(),
  harness: z.object({
    version: z.string(),
    capsVersion: z.string(),
    git: z.object({ commit: z.string().nullable(), dirty: z.boolean().nullable() }),
    meter: z.object({
      path: z.string(),
      version: z.string().nullable(),
      intervalMs: z.int().positive(),
      privilegedIntervalS: z.int().positive(),
      overhead: meterOverheadSchema.nullable(),
    }),
    argv: z.array(z.string()),
  }),
  host: hostSchema,
  processes: z.array(resultProcessSchema),
  groups: z.array(resultGroupSchema),
  assertions: z.object({
    polls: z.int().nonnegative(),
    intervalS: z.number().positive(),
    sondine: z.array(sondineAssertionSchema),
  }),
  baseline: z
    .object({
      id: z.string(),
      path: z.string(),
      scenario: scenarioIdSchema,
      startedAt: z.iso.datetime(),
    })
    .nullable(),
  checks: z.array(checkSchema),
  verdict: verdictSchema,
  warnings: z.array(z.string()),
  /** Relative to the result file. */
  files: z.object({ samples: z.string(), summary: z.string() }),
});
export type BudgetResult = z.infer<typeof budgetResultSchema>;

/** Parses a result file's JSON, naming the first problems when it does not match. */
export function parseBudgetResult(json: unknown): BudgetResult {
  const parsed = budgetResultSchema.safeParse(json);
  if (parsed.success) return parsed.data;
  throw new Error(
    `not a ${RESULT_SCHEMA} v${RESULT_SCHEMA_VERSION} file:\n${z.prettifyError(parsed.error)}`,
  );
}
