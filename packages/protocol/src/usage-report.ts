import * as z from "zod";
import { COUNTED_EVENTS, USAGE_ERRORS, type UsageEvent, type UsageSurface } from "./usage-events";

// The daily report of anonymous statistics (ADR 042): what a Mac whose user
// agreed sends, and all the Worker (`apps/stats`) accepts. No string is free:
// each is one of a closed list, or digits in a fixed shape.

/**
 * The version of the report and of the question asked about it. A field
 * added, or a finer value, moves it: a yes to an older question no longer
 * holds, and Sondine asks again.
 */
export const USAGE_REPORT_VERSION = 1;

/** A count, rounded down to one of these: a day is not recognized by its numbers. */
export const USAGE_COUNTS = [1, 2, 3, 5, 10, 20, 50, 100, 200, 500] as const;
export type UsageCount = (typeof USAGE_COUNTS)[number];

export function usageCount(times: number): UsageCount {
  return USAGE_COUNTS.findLast((step) => step <= times) ?? 1;
}

const UsageCount = z.literal(USAGE_COUNTS);

export const USAGE_MEMORY = ["lt16", "16-31", "32plus"] as const;
export type UsageMemory = (typeof USAGE_MEMORY)[number];

export function usageMemory(bytes: number): UsageMemory {
  const gib = bytes / 1024 ** 3;
  return gib < 16 ? "lt16" : gib < 32 ? "16-31" : "32plus";
}

export const USAGE_INSTALLED = ["0", "1", "2-6", "7-13", "14-27", "28-89", "90plus"] as const;
export type UsageInstalled = (typeof USAGE_INSTALLED)[number];

/** The band of a number of whole days since the first run. */
export function usageInstalled(days: number): UsageInstalled {
  if (days <= 0) return "0";
  if (days === 1) return "1";
  if (days < 7) return "2-6";
  if (days < 14) return "7-13";
  if (days < 28) return "14-27";
  return days < 90 ? "28-89" : "90plus";
}

/** The first run's steps, and its end (`OnboardingStep` in `packages/api`). */
export const USAGE_ONBOARDING = [
  "welcome",
  "statistics",
  "permissions",
  "model",
  "voice",
  "start",
  "done",
] as const;
export type UsageOnboarding = (typeof USAGE_ONBOARDING)[number];

/** A calendar day that exists. */
const Day = z.string().refine((day) => {
  if (!/^20\d\d-\d\d-\d\d$/u.test(day)) return false;
  const at = new Date(`${day}T12:00:00.000Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().startsWith(day);
});

const countsOf = (surface: UsageSurface) =>
  z.partialRecord(z.enum(COUNTED_EVENTS[surface] as [UsageEvent, ...UsageEvent[]]), UsageCount);

export const UsageReport = z.strictObject({
  v: z.literal(USAGE_REPORT_VERSION),
  /** Made for this report alone: a retry is counted once. */
  id: z.uuidv4(),
  day: Day,
  app: z.string().regex(/^\d{1,2}\.\d{1,3}\.\d{1,3}$/u),
  macos: z.string().regex(/^\d{2}\.\d{1,2}$/u),
  memory: z.enum(USAGE_MEMORY),
  installed: z.enum(USAGE_INSTALLED),
  activeDays: z.int().min(0).max(7).nullable(),
  onboarding: z.enum(USAGE_ONBOARDING),
  actions: z.strictObject({
    desktop: countsOf("desktop").optional(),
    mcp: countsOf("mcp").optional(),
    mobile: countsOf("mobile").optional(),
  }),
  errors: z.partialRecord(z.enum(USAGE_ERRORS), UsageCount),
});
export type UsageReport = z.output<typeof UsageReport>;

/** The largest body the Worker reads; a full report is a tenth of it. */
export const MAX_USAGE_REPORT_BYTES = 16 * 1024;

/** What the question shows before an answer, as ADR 042 gives it. */
export const USAGE_EXAMPLE: UsageReport = {
  v: USAGE_REPORT_VERSION,
  id: "5f0c2d5e-8f0b-4b7e-9a3a-2f1d7f7f5b10",
  day: "2026-11-24",
  app: "0.7.0",
  macos: "27.0",
  memory: "32plus",
  installed: "7-13",
  activeDays: 5,
  onboarding: "done",
  actions: {
    desktop: {
      conversation_opened: 5,
      speaker_named: 1,
      transcripts_searched: 2,
      window_opened: 3,
    },
    mcp: { transcripts_searched: 3 },
  },
  errors: { transcription_deadline: 1 },
};
