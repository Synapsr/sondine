import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { runTool, toolText } from "../exec.ts";
import {
  listedProcessSchema,
  meterSummarySchema,
  type ListedProcess,
  type MeterSummary,
} from "./meter-schema.ts";

// Thin client for the `sondine-meter` executable (native/Sources/sondine-meter).

export async function meterVersion(meter: string): Promise<string | null> {
  const text = await toolText(meter, ["--version"]);
  return text?.trim().replace(/^sondine-meter\s+/, "") ?? null;
}

/** Every process, with argv for this user's processes (Chromium helper flags). */
export async function listProcesses(meter: string): Promise<ListedProcess[]> {
  const output = await runTool(meter, ["list", "--arguments"], 30_000);
  if (!output.ok) throw new Error(`sondine-meter list failed: ${output.stderr.trim()}`);
  return output.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => listedProcessSchema.parse(JSON.parse(line)));
}

export interface SampleRequest {
  readonly pids: readonly number[];
  readonly intervalMs: number;
  readonly durationS: number;
  readonly privilegedIntervalS: number;
  readonly out: string;
  /** Also sample processes matching this regex, rescanned every `rediscoverS`. */
  readonly match?: string;
  readonly rediscoverS?: number;
}

export function sampleArguments(request: SampleRequest): string[] {
  return [
    "sample",
    "--pids",
    request.pids.join(","),
    "--no-coreaudiod",
    "--interval-ms",
    String(request.intervalMs),
    "--duration-s",
    String(request.durationS),
    "--privileged-interval-s",
    String(request.privilegedIntervalS),
    "--out",
    request.out,
    ...(request.match === undefined ? [] : ["--match", request.match]),
    ...(request.rediscoverS === undefined ? [] : ["--rediscover-s", String(request.rediscoverS)]),
  ];
}

/** Starts `sondine-meter sample`; coreaudiod is passed explicitly, so its lookup is off. */
export function startSampling(meter: string, request: SampleRequest): ChildProcess {
  return spawn(meter, sampleArguments(request), { stdio: ["ignore", "ignore", "inherit"] });
}

export interface SummaryGroup {
  readonly label: string;
  readonly pids: readonly number[];
}

export async function summarize(
  meter: string,
  samples: string,
  out: string,
  groups: readonly SummaryGroup[],
): Promise<MeterSummary> {
  const args = ["summarize", "--in", samples, "--out", out];
  for (const group of groups) {
    if (group.pids.length > 0) args.push("--group", `${group.label}=${group.pids.join(",")}`);
  }
  const output = await runTool(meter, args, 120_000);
  if (!output.ok) throw new Error(`sondine-meter summarize failed: ${output.stderr.trim()}`);
  return meterSummarySchema.parse(JSON.parse(await readFile(out, "utf8")));
}
