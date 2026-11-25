import * as z from "zod";

// What `sondine-meter` prints (native/Sources/sondine-meter). The meter omits a field it could
// not read; these schemas turn every absent measurement into an explicit null.

const measured = z.number().nullable().default(null);

export const accessSchema = z.enum(["rusage", "setuid-tools", "denied"]);
export type Access = z.infer<typeof accessSchema>;

export const statsSchema = z.object({
  samples: z.int().nonnegative(),
  coveredS: z.number().nonnegative(),
  cpu: z.object({
    meanPercent: measured,
    p95Percent: measured,
    maxPercent: measured,
    seconds: measured,
    qosSeconds: z.record(z.string(), z.number()).nullable().default(null),
  }),
  wakeups: z.object({
    interruptPerS: measured,
    interruptP95PerS: measured,
    idlePerS: measured,
    idleP95PerS: measured,
  }),
  footprint: z.object({
    maxBytes: measured,
    meanBytes: measured,
    lastBytes: measured,
    lifetimeMaxBytes: measured,
    slopeMiBPerHour: measured,
  }),
  energy: z.object({
    joules: measured,
    joulesPerHour: measured,
    milliwatts: measured,
    pCoreJoules: measured,
  }),
  neuralFootprintMaxBytes: measured,
  graphicsFootprintMaxBytes: measured,
  disk: z.object({
    readBytes: measured,
    writtenBytes: measured,
    logicalWrites: measured,
  }),
});
export type Stats = z.infer<typeof statsSchema>;

export const meterOverheadSchema = z.object({
  cpuNs: z.number().nonnegative(),
  childrenCpuNs: z.number().nonnegative(),
  interruptWakeups: measured,
  idleWakeups: measured,
  energyNj: measured,
  lifetimeMaxFootprintBytes: measured,
});
export type MeterOverhead = z.infer<typeof meterOverheadSchema>;

export const meterSummarySchema = z.object({
  schema: z.literal("sondine.meter-summary"),
  version: z.literal(1),
  input: z.object({
    records: z.int().nonnegative(),
    intervalMs: z.int().positive(),
    startedAt: z.string(),
    ticks: z.int().nonnegative(),
    durationS: z.number().nonnegative(),
    sleptS: z.number().nonnegative(),
    endReason: z.string().nullable().default(null),
    meter: meterOverheadSchema.nullable().default(null),
  }),
  windowS: z.number().positive(),
  skipS: z.number().nonnegative(),
  processes: z.array(
    z.object({
      pid: z.int().positive(),
      startUs: z.number().nonnegative(),
      name: z.string(),
      path: z.string().nullable().default(null),
      access: accessSchema,
      exited: z.boolean(),
      stats: statsSchema,
    }),
  ),
  groups: z.array(
    z.object({ label: z.string(), pids: z.array(z.int().positive()), stats: statsSchema }),
  ),
  total: statsSchema,
  warnings: z.array(z.string()),
});
export type MeterSummary = z.infer<typeof meterSummarySchema>;

/** One line of `sondine-meter list --arguments`. */
export const listedProcessSchema = z.object({
  pid: z.int().positive(),
  ppid: z.int().nonnegative(),
  uid: z.int().nonnegative(),
  startUs: z.number().nonnegative(),
  name: z.string(),
  path: z.string().nullable().default(null),
  access: accessSchema,
  arguments: z.array(z.string()).nullable().default(null),
});
export type ListedProcess = z.infer<typeof listedProcessSchema>;
