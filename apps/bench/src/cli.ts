#!/usr/bin/env node
import { parseArgs } from "node:util";
import { formatResult, compareResults } from "./budget/report.ts";
import { loadResult, runBudget } from "./budget/run.ts";
import { scenarioIdSchema, scenarios, SCENARIO_IDS } from "./budget/scenarios.ts";
import { asrUsage, goldenUsage } from "./asr/usage.ts";
import { journalUsage } from "./journal/usage.ts";
import { sameMomentUsage } from "./same-moment/usage.ts";
import { selfEchoUsage } from "./self-echo/usage.ts";
import { voicesUsage } from "./voices/usage.ts";
import { vocabularyUsage } from "./vocabulary/usage.ts";
import { parseDuration } from "./duration.ts";
import { allowExtensionlessTs } from "./ts-resolve.ts";
import { defaultResultsDirectory, findMeter, userPath } from "./paths.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";

const usage = `usage: sondine-bench budget <command>

  budget run --scenario <${SCENARIO_IDS.join("|")}> [options]
      Measures Sondine's always-on cost with sondine-meter and writes a result JSON to
      bench/results/local/ (git-ignored). Exit code 3 when a cap fails.
        --duration <30m>           measuring time (default 30m, soak 8h)
        --label <text>             name for this run (default "local")
        --settle <1m>              wait before measuring (default 1m)
        --interval-ms <1000>       sampling period
        --privileged-interval <60s> top period for coreaudiod idle wakeups and footprint
        --assertion-interval <30s> pmset -g assertions polling period
        --baseline <auto|none|file> S6 result for deltas (default: latest on this machine)
        --app-name <Sondine>       bundle executable name (Electron under pnpm dev)
        --bundle-id <app.sondine>  bundle id looked up with lsappinfo
        --meter <path>             sondine-meter (default $SONDINE_METER, native/.build)
        --results-dir <dir>        where results go
        --allow-missing            measure even if no Sondine process runs (coreaudiod only)

  budget show <result>             print a result (path or id)
  budget compare <a> <b>           compare two results (paths or ids), a → b

scenarios:
${SCENARIO_IDS.map((id) => `  ${id.padEnd(5)} ${scenarios[id].title}`).join("\n")}

${asrUsage}

${goldenUsage}

${journalUsage}

${sameMomentUsage}

${selfEchoUsage}

${voicesUsage}

${vocabularyUsage}`;

class UsageError extends Error {}

function resolveResult(reference: string, directory: string): string {
  const direct = userPath(reference);
  if (existsSync(direct)) return direct;
  const byId = join(directory, reference.endsWith(".json") ? reference : `${reference}.json`);
  if (existsSync(byId)) return byId;
  throw new UsageError(`no result at ${direct} or ${byId}`);
}

function seconds(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  try {
    return parseDuration(value);
  } catch (error) {
    throw new UsageError(`--${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0)
    throw new UsageError(`--${name} must be a positive integer`);
  return number;
}

async function main(argv: readonly string[]): Promise<number> {
  const [group, command, ...rest] = argv;
  if (group === undefined || group === "--help" || group === "-h" || group === "help") {
    console.log(usage);
    return 0;
  }
  if (group === "asr") {
    // The engines import @sondine/protocol, whose sources need the hook.
    allowExtensionlessTs();
    const { asrMain } = await import("./asr/cli.ts");
    return asrMain(command, rest, (message) => new UsageError(message));
  }
  if (group === "journal") {
    allowExtensionlessTs();
    const { journalMain } = await import("./journal/cli.ts");
    return journalMain(command, rest, (message) => new UsageError(message));
  }
  if (group === "same-moment") {
    allowExtensionlessTs();
    const { sameMomentMain } = await import("./same-moment/cli.ts");
    return sameMomentMain(command, rest, (message) => new UsageError(message));
  }
  if (group === "self-echo") {
    allowExtensionlessTs();
    const { selfEchoMain } = await import("./self-echo/cli.ts");
    return selfEchoMain(command, rest, (message) => new UsageError(message));
  }
  if (group === "vocabulary") {
    allowExtensionlessTs();
    const { vocabularyMain } = await import("./vocabulary/cli.ts");
    return vocabularyMain(command, rest, (message) => new UsageError(message));
  }
  if (group === "voices") {
    allowExtensionlessTs();
    const { voicesMain } = await import("./voices/cli.ts");
    return voicesMain(command, rest, (message) => new UsageError(message));
  }
  if (group === "golden") {
    allowExtensionlessTs();
    const { goldenMain } = await import("./golden/cli.ts");
    return goldenMain(command, rest, (message) => new UsageError(message));
  }
  if (group !== "budget") throw new UsageError(`unknown command "${group}"`);

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: true,
    options: {
      scenario: { type: "string" },
      duration: { type: "string" },
      label: { type: "string" },
      settle: { type: "string" },
      "interval-ms": { type: "string" },
      "privileged-interval": { type: "string" },
      "assertion-interval": { type: "string" },
      baseline: { type: "string" },
      "app-name": { type: "string" },
      "bundle-id": { type: "string" },
      meter: { type: "string" },
      "results-dir": { type: "string" },
      "allow-missing": { type: "boolean" },
    },
  });
  const resultsDirectory =
    values["results-dir"] === undefined ? defaultResultsDirectory : userPath(values["results-dir"]);

  switch (command) {
    case "run": {
      if (positionals.length > 0)
        throw new UsageError(`unexpected argument ${positionals[0] ?? ""}`);
      const scenario = scenarioIdSchema.safeParse(values.scenario);
      if (!scenario.success)
        throw new UsageError(`--scenario must be one of ${SCENARIO_IDS.join(", ")}`);
      const durationS = seconds(
        values.duration,
        scenarios[scenario.data].defaultDurationS,
        "duration",
      );
      if (durationS <= 0) throw new UsageError("--duration must be positive");
      const baseline = values.baseline ?? "auto";
      const label = (values.label ?? "local").trim();
      if (label === "") throw new UsageError("--label must not be empty");
      const { result, path } = await runBudget(
        {
          scenario: scenario.data,
          durationS,
          settleS: seconds(values.settle, 60, "settle"),
          label,
          intervalMs: positiveInteger(values["interval-ms"], 1000, "interval-ms"),
          privilegedIntervalS: Math.max(
            1,
            Math.round(seconds(values["privileged-interval"], 60, "privileged-interval")),
          ),
          assertionIntervalS: Math.max(
            1,
            seconds(values["assertion-interval"], 30, "assertion-interval"),
          ),
          appName: values["app-name"] ?? "Sondine",
          bundleId: values["bundle-id"] ?? "app.sondine",
          meter: findMeter(values.meter),
          resultsDirectory,
          baseline:
            baseline === "auto" || baseline === "none"
              ? baseline
              : { path: resolveResult(baseline, resultsDirectory) },
          allowMissing: values["allow-missing"] ?? false,
          argv: process.argv.slice(2),
        },
        (line) => console.error(line),
      );
      console.log(formatResult(result));
      console.log(`\nwritten: ${path}`);
      return result.verdict.status === "fail" ? 3 : 0;
    }
    case "show": {
      const [reference] = positionals;
      if (reference === undefined || positionals.length !== 1)
        throw new UsageError("budget show needs one result");
      console.log(formatResult(await loadResult(resolveResult(reference, resultsDirectory))));
      return 0;
    }
    case "compare": {
      const [a, b] = positionals;
      if (a === undefined || b === undefined || positionals.length !== 2)
        throw new UsageError("budget compare needs two results");
      const comparison = compareResults(
        await loadResult(resolveResult(a, resultsDirectory)),
        await loadResult(resolveResult(b, resultsDirectory)),
      );
      console.log(comparison.text);
      return 0;
    }
    default:
      throw new UsageError(
        command === undefined ? "budget needs a command" : `unknown budget command "${command}"`,
      );
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const usageProblem =
      error instanceof UsageError ||
      (error instanceof TypeError &&
        "code" in error &&
        String(error.code).startsWith("ERR_PARSE_ARGS"));
    console.error(`sondine-bench: ${error instanceof Error ? error.message : String(error)}`);
    if (usageProblem) console.error(`\n${usage}`);
    process.exitCode = usageProblem ? 2 : 1;
  },
);
