import { z } from "zod";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const sourceSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  category: z.string(),
  role: z.enum(["word", "noise", "instrumental", "vocal-media", "spoken-proxy"]),
  language: z.string().nullable(),
  speaker: z.string().nullable(),
  url: z.url(),
  sha256: hash,
  archive: z.object({ sha256: hash, member: z.string() }).optional(),
  lookup: z.object({ url: z.url(), rowIndex: z.number().int(), revision: z.string() }).optional(),
  license: z.string(),
  licenseUrl: z.url(),
  sourcePage: z.url(),
  attribution: z.string(),
  annotation: z.literal("source-label-only"),
});
export const corpusSchema = z.object({
  version: z.literal(1),
  selection: z.string(),
  limitations: z.array(z.string()),
  sources: z.array(sourceSchema).min(1),
});
export type Source = z.infer<typeof sourceSchema>;
export type Corpus = z.infer<typeof corpusSchema>;

export const regionSchema = z.object({
  startSample: z.number().int().nonnegative(),
  endSample: z.number().int().nonnegative(),
  speechStartSample: z.number().int().nonnegative(),
  speechEndSample: z.number().int().nonnegative(),
  voicedMs: z.number().nonnegative(),
  meanProbability: z.number().min(0).max(1),
  maxProbability: z.number().min(0).max(1),
});
export type Region = z.infer<typeof regionSchema>;
export const segmentSchema = z.object({
  schema: z.literal("sondine.segment-result"),
  version: z.literal(1),
  output: z.object({
    sampleRate: z.literal(16000),
    samples: z.number().int(),
    durationMs: z.number(),
  }),
  parameters: z.unknown(),
  vad: z.object({
    engine: z.literal("silero-vad"),
    version: z.string(),
    modelSha256: hash,
    runtime: z.string(),
    settings: z.unknown(),
  }),
  regions: z.array(regionSchema),
  stats: z.object({
    regions: z.object({ rejectedBursts: z.number(), voicedMs: z.number() }),
    vad: z.object({
      cpuMs: z.number(),
      wallMs: z.number(),
      evaluatedWindows: z.number(),
      windows: z.number(),
    }),
  }),
  timing: z.object({ total: z.object({ cpuNs: z.number(), wallNs: z.number() }) }),
});
export type Segment = z.infer<typeof segmentSchema>;
export interface Event {
  readonly sourceId: string;
  readonly startSample: number;
  readonly endSample: number;
  readonly language: string | null;
  readonly speaker: string | null;
}
export interface Scenario {
  readonly id: string;
  readonly suite: "isolated" | "timeline" | "negative" | "media" | "paired-background";
  readonly condition: string;
  readonly sampleCount: number;
  readonly events: readonly Event[];
  readonly sourceIds: readonly string[];
  readonly sourceKind: "input" | "system";
  readonly inputSha256: string;
  readonly finalGain: number;
  readonly backgroundPair: string | null;
}
export const runConfigSchema = z.object({
  root: z.string(),
  cache: z.string(),
  output: z.string(),
  helper: z.string(),
  model: z.string(),
  seed: z.number().int().min(0).max(0xffffffff),
});
export type RunConfig = z.infer<typeof runConfigSchema>;
