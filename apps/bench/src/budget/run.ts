import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { toolText } from "../exec.ts";
import {
  listProcesses,
  meterVersion,
  startSampling,
  summarize,
  type SummaryGroup,
} from "../meter/meter.ts";
import { repoRoot } from "../paths.ts";
import { AssertionTracker } from "./assertions.ts";
import { CAP_GROUP_IDS, CAPS_VERSION } from "./caps.ts";
import {
  discoverProcesses,
  roleGroups,
  rolesOutsideTotal,
  type DiscoveredProcess,
  type ProcessRole,
} from "./discovery.ts";
import { evaluateBudget } from "./evaluate.ts";
import { attributeIncarnations, incarnationKey, sondineMatchPattern } from "./membership.ts";
import {
  readHost,
  readPowerState,
  readThermalState,
  sameConditions,
  type Host,
  type ThermalState,
} from "./host.ts";
import {
  budgetResultSchema,
  groupIdSchema,
  parseBudgetResult,
  RESULT_SCHEMA,
  RESULT_SCHEMA_VERSION,
  type BudgetResult,
  type ResultGroup,
  type ResultProcess,
} from "./result-schema.ts";
import { BASELINE_SCENARIO, scenarios, type ScenarioId } from "./scenarios.ts";

export const HARNESS_VERSION = "0.1.0";
/** How often the meter rescans for new Sondine processes (a restarted helper). */
const REDISCOVER_S = 10;

export interface RunOptions {
  readonly scenario: ScenarioId;
  readonly durationS: number;
  readonly settleS: number;
  readonly label: string;
  readonly intervalMs: number;
  readonly privilegedIntervalS: number;
  readonly assertionIntervalS: number;
  /** `Sondine` for a packaged build, `Electron` under `pnpm dev`. */
  readonly appName: string;
  readonly bundleId: string | null;
  readonly meter: string;
  readonly resultsDirectory: string;
  readonly baseline: "auto" | "none" | { readonly path: string };
  readonly allowMissing: boolean;
  readonly argv: readonly string[];
}

export function resultId(startedAt: Date, scenario: ScenarioId, label: string): string {
  const stamp = startedAt
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replaceAll("-", "")
    .replaceAll(":", "");
  const slug = label
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${stamp}-${scenario}-${slug === "" ? "run" : slug}`;
}

async function bundlePids(bundleId: string | null): Promise<number[]> {
  if (bundleId === null) return [];
  const text = await toolText("/usr/bin/lsappinfo", ["info", "-only", "pid", "-app", bundleId]);
  return [...(text ?? "").matchAll(/\bpid\s*=\s*(\d+)/g)].map((match) => Number(match[1]));
}

async function gitState(): Promise<BudgetResult["harness"]["git"]> {
  const [commit, status] = await Promise.all([
    toolText("git", ["-C", repoRoot, "rev-parse", "--verify", "HEAD"]),
    toolText("git", ["-C", repoRoot, "status", "--porcelain"]),
  ]);
  return { commit: commit?.trim() || null, dirty: status === null ? null : status.trim() !== "" };
}

async function writeAtomically(path: string, text: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text);
  await rename(temporary, path);
}

/** The latest S6 result from the same machine, OS build and power source. */
export async function findBaseline(
  directory: string,
  host: Host,
): Promise<{ result: BudgetResult; path: string } | null> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return null;
  }
  let best: { result: BudgetResult; path: string } | null = null;
  for (const name of names) {
    if (!name.endsWith(".json") || name.endsWith(".summary.json")) continue;
    const path = join(directory, name);
    try {
      const parsed = budgetResultSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
      if (
        !parsed.success ||
        parsed.data.scenario.id !== BASELINE_SCENARIO ||
        !sameConditions(parsed.data.host, host)
      )
        continue;
      if (best === null || parsed.data.startedAt > best.result.startedAt)
        best = { result: parsed.data, path };
    } catch {
      continue;
    }
  }
  return best;
}

export async function loadResult(path: string): Promise<BudgetResult> {
  return parseBudgetResult(JSON.parse(await readFile(path, "utf8")));
}

function summaryGroups(
  processes: readonly { readonly pid: number; readonly role: ProcessRole }[],
): SummaryGroup[] {
  const pidsWhere = (keep: (role: ProcessRole) => boolean) => [
    ...new Set(processes.filter((process) => keep(process.role)).map((process) => process.pid)),
  ];
  const groups: SummaryGroup[] = CAP_GROUP_IDS.map((id) => ({
    label: id,
    pids: pidsWhere((role) => roleGroups[role] === id),
  }));
  groups.push({ label: "sondine-total", pids: pidsWhere((role) => !rolesOutsideTotal.has(role)) });
  return groups.filter((group) => group.pids.length > 0);
}

function thermalWarning(label: string, state: ThermalState): string[] {
  const throttled = state.cpuSpeedLimit !== null && state.cpuSpeedLimit < 100;
  if (state.warningLevel === null && state.performanceWarningLevel === null && !throttled)
    return [];
  return [`thermal pressure at the ${label}: ${state.raw.replaceAll("\n", "; ")}`];
}

export async function runBudget(
  options: RunOptions,
  log: (line: string) => void,
): Promise<{ result: BudgetResult; path: string }> {
  const abort = new AbortController();
  let interrupted = false;
  let onInterrupt: () => void = () => abort.abort();
  const handler = () => onInterrupt();
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  try {
    const notRunning = `no ${options.appName} process found: start Sondine, or pass --allow-missing to measure coreaudiod alone`;
    // Fail before the settle wait, then look again: the app may quit while settling.
    if (!options.allowMissing) {
      const [listed, mainPids] = await Promise.all([
        listProcesses(options.meter),
        bundlePids(options.bundleId),
      ]);
      const early = discoverProcesses(listed, {
        appName: options.appName,
        bundleMainPids: mainPids,
      });
      if (early.sondine.length === 0) throw new Error(notRunning);
    }
    if (options.settleS > 0) {
      log(`settling for ${options.settleS} s before measuring (Ctrl-C aborts)…`);
      try {
        await sleep(options.settleS * 1000, undefined, { signal: abort.signal });
      } catch {
        throw new Error("interrupted before measuring: no result written");
      }
    }

    const startedAt = new Date();
    const [hostAtStart, git, version, listed, mainPids] = await Promise.all([
      readHost(),
      gitState(),
      meterVersion(options.meter),
      listProcesses(options.meter),
      bundlePids(options.bundleId),
    ]);
    const discovery = discoverProcesses(listed, {
      appName: options.appName,
      bundleMainPids: mainPids,
    });
    if (discovery.sondine.length === 0 && !options.allowMissing) throw new Error(notRunning);
    const measured: DiscoveredProcess[] = [
      ...discovery.sondine,
      ...(discovery.coreaudiod === null ? [] : [discovery.coreaudiod]),
    ];
    if (measured.length === 0)
      throw new Error("nothing to measure: neither Sondine nor coreaudiod was found");

    const id = resultId(startedAt, options.scenario, options.label);
    await mkdir(options.resultsDirectory, { recursive: true });
    const resultPath = join(options.resultsDirectory, `${id}.json`);
    const samplesPath = join(options.resultsDirectory, `${id}.samples.jsonl`);
    const summaryPath = join(options.resultsDirectory, `${id}.summary.json`);

    const tracker = new AssertionTracker(discovery.sondine.map((process) => process.pid));
    const pollAssertions = async () => {
      const text = await toolText("/usr/bin/pmset", ["-g", "assertions"]);
      if (text !== null) tracker.record(text, new Date());
    };
    await pollAssertions();
    const poller = setInterval(() => void pollAssertions(), options.assertionIntervalS * 1000);

    const roles = discovery.sondine.map((process) => process.role).join(", ");
    log(
      `measuring ${options.scenario} (${scenarios[options.scenario].title}) for ${options.durationS} s: ` +
        `${discovery.sondine.length} Sondine processes (${roles || "none"})` +
        `${discovery.coreaudiod === null ? "" : " + coreaudiod"}. Ctrl-C stops early and keeps the result.`,
    );
    for (const warning of discovery.warnings) log(`warning: ${warning}`);

    const child = startSampling(options.meter, {
      pids: measured.map((process) => process.pid),
      intervalMs: options.intervalMs,
      durationS: options.durationS,
      privilegedIntervalS: options.privilegedIntervalS,
      out: samplesPath,
      match: sondineMatchPattern(options.appName),
      rediscoverS: REDISCOVER_S,
    });
    onInterrupt = () => {
      if (interrupted) {
        child.kill("SIGKILL");
        return;
      }
      interrupted = true;
      log("stopping: the meter writes its last sample…");
      child.kill("SIGINT");
    };
    const code = await new Promise<number | null>((resolve) => {
      child.once("exit", (exitCode) => resolve(exitCode));
      child.once("error", () => resolve(null));
    });
    clearInterval(poller);
    await pollAssertions();
    if (code !== 0)
      log(
        `warning: sondine-meter exited with ${code === null ? "a signal or a spawn error" : `code ${code}`}`,
      );

    const [powerAtEnd, thermalAtEnd, relisted] = await Promise.all([
      readPowerState(),
      readThermalState(),
      listProcesses(options.meter),
    ]);
    const endedAt = new Date();
    const host: Host = {
      ...hostAtStart,
      power: { start: hostAtStart.power, end: powerAtEnd },
      thermal: { start: hostAtStart.thermal, end: thermalAtEnd },
    };

    const after = discoverProcesses(relisted, {
      appName: options.appName,
      bundleMainPids: mainPids,
    });
    // Group membership comes from what was sampled, restarts included, so read it first.
    const sampled = await summarize(options.meter, samplesPath, summaryPath, []);
    const membership = attributeIncarnations(
      sampled.processes,
      [discovery, after],
      options.appName,
    );
    const processes: ResultProcess[] = sampled.processes.flatMap((process) => {
      const role = membership.roles.get(incarnationKey(process));
      return role === undefined ? [] : [{ ...process, role }];
    });
    const summary = await summarize(
      options.meter,
      samplesPath,
      summaryPath,
      summaryGroups(processes),
    );
    const groups: ResultGroup[] = summary.groups.map((group) => ({
      id: groupIdSchema.parse(group.label),
      pids: group.pids,
      stats: group.stats,
    }));

    const warnings = [...discovery.warnings, ...summary.warnings, ...membership.warnings];
    for (const process of processes) {
      if (process.exited) warnings.push(`${process.role} pid ${process.pid} exited during the run`);
    }
    if (hostAtStart.power.source !== powerAtEnd.source) {
      warnings.push(
        `power source changed during the run (${hostAtStart.power.source} → ${powerAtEnd.source})`,
      );
    }
    warnings.push(
      ...thermalWarning("start", hostAtStart.thermal),
      ...thermalWarning("end", thermalAtEnd),
    );
    if (summary.input.sleptS > 1)
      warnings.push(`the Mac slept for ${summary.input.sleptS.toFixed(0)} s; rates use awake time`);
    if (interrupted || summary.input.endReason === "signal")
      warnings.push("interrupted: shorter than requested");
    if (hostAtStart.lowPowerMode === true) warnings.push("Low Power Mode is on");
    if (options.meter.includes("/.build/debug/")) warnings.push("sondine-meter is a debug build");

    let baseline: { result: BudgetResult; path: string } | null = null;
    if (options.scenario !== BASELINE_SCENARIO && options.baseline !== "none") {
      if (options.baseline === "auto") {
        baseline = await findBaseline(options.resultsDirectory, host);
        if (baseline === null) {
          warnings.push(
            `no ${BASELINE_SCENARIO} baseline on this machine, OS build and power source: run \`budget run --scenario S6\` first`,
          );
        }
      } else {
        const loaded = await loadResult(options.baseline.path);
        if (loaded.scenario.id !== BASELINE_SCENARIO) {
          throw new Error(
            `--baseline must be an ${BASELINE_SCENARIO} result, not ${loaded.scenario.id}`,
          );
        }
        if (!sameConditions(loaded.host, host))
          warnings.push("the baseline comes from a different machine, OS build or power source");
        baseline = { result: loaded, path: options.baseline.path };
      }
    }

    const evaluation = evaluateBudget({
      scenario: options.scenario,
      measuredS: summary.input.durationS,
      processes,
      groups,
      assertions: tracker.polls > 0 ? tracker.assertions : null,
      baseline:
        baseline === null ? null : { id: baseline.result.id, groups: baseline.result.groups },
      incompleteGroups: membership.incomplete,
    });

    const result: BudgetResult = budgetResultSchema.parse({
      schema: RESULT_SCHEMA,
      schemaVersion: RESULT_SCHEMA_VERSION,
      id,
      label: options.label,
      scenario: { id: options.scenario, title: scenarios[options.scenario].title },
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      requestedDurationS: options.durationS,
      settleS: options.settleS,
      measuredS: summary.input.durationS,
      sleptS: summary.input.sleptS,
      interrupted: interrupted || summary.input.endReason === "signal",
      harness: {
        version: HARNESS_VERSION,
        capsVersion: CAPS_VERSION,
        git,
        meter: {
          path: options.meter,
          version,
          intervalMs: options.intervalMs,
          privilegedIntervalS: options.privilegedIntervalS,
          overhead: summary.input.meter,
        },
        argv: [...options.argv],
      },
      host,
      processes,
      groups,
      assertions: {
        polls: tracker.polls,
        intervalS: options.assertionIntervalS,
        sondine: tracker.assertions,
      },
      baseline:
        baseline === null
          ? null
          : {
              id: baseline.result.id,
              path: relative(options.resultsDirectory, baseline.path),
              scenario: baseline.result.scenario.id,
              startedAt: baseline.result.startedAt,
            },
      checks: evaluation.checks,
      verdict: evaluation.verdict,
      warnings,
      files: { samples: basename(samplesPath), summary: basename(summaryPath) },
    });
    await writeAtomically(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    return { result, path: resultPath };
  } finally {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  }
}
