import { readFile } from "node:fs/promises";
import { it } from "vitest";
import { runConfigSchema } from "./schema.ts";
import { runBenchmark } from "./benchmark.ts";

// Ordinary pnpm check never downloads data or runs the helper.
const configPath = process.env["SONDINE_FALSE_MOMENTS_CONFIG"];
it.skipIf(!configPath)(
  "measures the pinned public file corpus without ASR",
  async () => {
    if (!configPath) throw new Error("Missing explicit benchmark configuration");
    await runBenchmark(runConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8"))));
  },
  1_800_000,
);
