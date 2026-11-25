import { readFile, mkdir, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { cpus, totalmem, release, arch } from "node:os";
import { command, json, sha256, prepareSource } from "./io.ts";
import { corpusSchema, segmentSchema, type RunConfig, type Scenario } from "./schema.ts";
import { generateScenarios } from "./scenarios.ts";
import { scoreEvent, validateRegions, perHour } from "./metrics.ts";
import { countEpisodes } from "./planner.ts";
import { reportMarkdown } from "./report.ts";

export const VARIANTS = [
  { id: "default-250", minSpeechMs: 250 },
  { id: "short-128", minSpeechMs: 128 },
  { id: "short-192", minSpeechMs: 192 },
  { id: "strict-384", minSpeechMs: 384 },
] as const;
const read = async (file: string, args: string[]) => {
  try {
    return (await command(file, args, 15_000)).stdout.trim();
  } catch {
    return "unavailable";
  }
};
async function host() {
  return {
    cpu: cpus()[0]?.model,
    cores: cpus().length,
    memoryBytes: totalmem(),
    osRelease: release(),
    arch: arch(),
    node: process.version,
    os: await read("sw_vers", []),
    power: await read("pmset", ["-g", "batt"]),
    thermal: await read("pmset", ["-g", "therm"]),
    swap: await read("sysctl", ["vm.swapusage"]),
    memoryPressure: await read("memory_pressure", ["-Q"]),
    ffmpeg: (await read("ffmpeg", ["-version"])).split("\n")[0],
  };
}
export type Measurement = Awaited<ReturnType<typeof measure>>;
async function measure(config: RunConfig, scenario: Scenario, variant: (typeof VARIANTS)[number]) {
  const id = `${variant.id}-${scenario.id}`;
  const path = join(config.output, "raw", `${id}.json`);
  const input = join(config.cache, "inputs", `${scenario.id}.wav`);
  if (sha256(await readFile(input)) !== scenario.inputSha256)
    throw new Error(`Input changed: ${scenario.id}`);
  const started = performance.now();
  const timing = await command(
    "/usr/bin/time",
    [
      "-l",
      config.helper,
      "segment",
      "--in",
      input,
      "--out",
      path,
      "--vad",
      "silero",
      "--vad-model",
      config.model,
      "--params",
      JSON.stringify({ segmenter: { minSpeechMs: variant.minSpeechMs } }),
    ],
    120_000,
  );
  const processWallMs = performance.now() - started;
  await writeFile(join(config.output, "raw", `${id}.stderr`), timing.stderr);
  const segment = segmentSchema.parse(JSON.parse(await readFile(path, "utf8")));
  if (segment.output.samples !== scenario.sampleCount)
    throw new Error(`Helper changed sample count for ${id}`);
  validateRegions(segment.regions, scenario.sampleCount);
  const plan = countEpisodes({
    sampleRate: 16000,
    sampleCount: scenario.sampleCount,
    regions: segment.regions,
    sourceKind: scenario.sourceKind,
  });
  const maximumRss = /([0-9]+)\s+maximum resident set size/.exec(timing.stderr);
  if (!maximumRss?.[1]) throw new Error("macOS time did not report peak RSS");
  return {
    id,
    variant: variant.id,
    scenario,
    durationMs: scenario.sampleCount / 16,
    regions: segment.regions,
    events: scenario.events.map((event) => scoreEvent(event, segment.regions)),
    plan,
    regionCount: segment.regions.length,
    regionsPerHour: perHour(segment.regions.length, scenario.sampleCount / 16),
    jobsPerHour: perHour(plan.jobsCreated, scenario.sampleCount / 16),
    rejectedBursts: segment.stats.regions.rejectedBursts,
    helperVoicedMs: segment.stats.regions.voicedMs,
    processWallMs,
    maximumRssBytes: Number(maximumRss[1]),
    helperCpuMs: segment.timing.total.cpuNs / 1e6,
    helperWallMs: segment.timing.total.wallNs / 1e6,
    wrapperPid: timing.pid,
    vad: segment.vad,
    parameters: segment.parameters,
  };
}
export async function runBenchmark(config: RunConfig) {
  await mkdir(config.output, { recursive: true });
  await mkdir(join(config.output, "raw"), { recursive: true });
  const corpusBytes = await readFile(join(config.root, "apps/bench/false-moments/corpus.json"));
  const corpus = corpusSchema.parse(JSON.parse(corpusBytes.toString("utf8")));
  if (new Set(corpus.sources.map((source) => source.id)).size !== corpus.sources.length)
    throw new Error("Duplicate corpus id");
  const startedAt = new Date().toISOString();
  const hostBefore = await host();
  const sourceCommit = (
    await command("git", ["-C", config.root, "rev-parse", "HEAD"])
  ).stdout.trim();
  await command("git", [
    "-C",
    config.root,
    "diff",
    "--exit-code",
    "HEAD",
    "--",
    "native",
    "packages",
    "apps/desktop",
  ]);
  const helperSha256 = sha256(await readFile(config.helper));
  const modelSha256 = sha256(await readFile(config.model));
  const harnessDirectory = join(config.root, "apps/bench/false-moments");
  const harnessHashes: Record<string, string> = {};
  for (const entry of (await readdir(harnessDirectory, { withFileTypes: true })).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.isFile())
      harnessHashes[entry.name] = sha256(await readFile(join(harnessDirectory, entry.name)));
  }
  const paths = new Map<string, string>();
  for (const source of corpus.sources)
    paths.set(source.id, await prepareSource(source, config.cache));
  const scenarios = await generateScenarios(corpus, paths, config.cache, config.seed);
  await json(join(config.output, "scenarios.json"), scenarios);
  const measurements: Measurement[] = [];
  for (const variant of VARIANTS) {
    for (const scenario of scenarios) {
      measurements.push(await measure(config, scenario, variant));
      if (measurements.length % 25 === 0)
        console.log(
          `${measurements.length}/${scenarios.length * VARIANTS.length} file-mode runs complete`,
        );
    }
  }
  if (measurements.some((row) => row.vad.modelSha256 !== modelSha256))
    throw new Error("Helper did not use the expected VAD model");
  // Pairing prevents a background voice from masquerading as target-word recall.
  const paired = measurements
    .filter((row) => row.scenario.backgroundPair !== null)
    .map((row) => {
      const background = measurements.find(
        (candidate) =>
          candidate.variant === row.variant &&
          candidate.scenario.id === row.scenario.backgroundPair,
      );
      if (!background) throw new Error("Missing matched background control");
      return {
        id: row.id,
        targetWindows: row.events.length,
        retainedWithTarget: row.events.filter((event) => event.captureOverlap).length,
        retainedWithoutTarget: background.events.filter((event) => event.captureOverlap).length,
        newlyRetainedWindows: row.events.filter(
          (event, index) => event.captureOverlap && !background.events[index]?.captureOverlap,
        ).length,
        warning:
          "Capture windows only; these counts do not establish target-word recognition or acoustic attribution.",
      };
    });
  const result = {
    schema: "sondine.false-moments/1",
    startedAt,
    completedAt: new Date().toISOString(),
    sourceCommit,
    groupingVersions: [...new Set(measurements.map((row) => row.plan.groupingVersion))],
    corpusSha256: sha256(corpusBytes),
    harnessHashes,
    harnessSha256: sha256(JSON.stringify(harnessHashes)),
    corpus,
    helperSha256,
    modelSha256,
    seed: config.seed,
    variants: VARIANTS,
    hostBefore,
    hostAfter: await host(),
    measurements,
    paired,
    limits: [
      "Diagnostic public corpus, not a representative field false-positive rate.",
      "Clip labels are not word timing annotations; strict 100–600 ms recall remains unmeasured.",
      "Transcription jobs are real planner/DB inserts in memory. No ASR, transcript, diarization, warm scheduling or hardware capture is run.",
      "No call attribution is inferred from file audio. Current grouping version is recorded.",
      "Peak process RSS is not physical footprint or proof of Mac responsiveness.",
      "Normal speech is attenuated/filter-transformed; real whispers, distant speech and actual television remain uncovered.",
    ],
  };
  await json(join(config.output, "results.json"), result);
  await writeFile(join(config.output, "rapport-fr.md"), reportMarkdown(result));
  return result;
}
export type BenchmarkResult = Awaited<ReturnType<typeof runBenchmark>>;
