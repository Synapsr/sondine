import * as z from "zod";
import type { ListedProcess } from "../meter/meter-schema.ts";
import type { CapGroupId } from "./caps.ts";

// Finds Sondine's processes in a `sondine-meter list --arguments` snapshot. Executable paths
// come from proc_pidpath, so a process that rewrites its title (Node's process.title) is still
// found. Chromium helpers are told apart by their --type and --utility-sub-type flags.

export const PROCESS_ROLES = [
  "main",
  "audio-helper",
  "core",
  "gpu",
  "network-service",
  "audio-service",
  "storage-service",
  "utility-other",
  "helper-other",
  "renderer",
  "plugin",
  "engine-worker",
  "mcp",
  "coreaudiod",
] as const;
export const processRoleSchema = z.enum(PROCESS_ROLES);
export type ProcessRole = z.infer<typeof processRoleSchema>;

/** Which budget row each role is measured in; null roles count only in the total. */
export const roleGroups: Readonly<Record<ProcessRole, CapGroupId | null>> = {
  main: "electron-main",
  "audio-helper": "sondine-audio",
  core: "core",
  gpu: "chromium-services",
  "network-service": "chromium-services",
  "audio-service": "chromium-services",
  "storage-service": "chromium-services",
  "utility-other": "chromium-services",
  "helper-other": "chromium-services",
  renderer: null,
  plugin: null,
  "engine-worker": null,
  mcp: null,
  coreaudiod: "coreaudiod",
};

/** Roles outside the always-on total: engine workers are budgeted per audio hour. */
export const rolesOutsideTotal: ReadonlySet<ProcessRole> = new Set(["engine-worker", "coreaudiod"]);

export const COREAUDIOD_PATH = "/usr/sbin/coreaudiod";

export interface DiscoveredProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly startUs: number;
  readonly name: string;
  readonly path: string | null;
  readonly role: ProcessRole;
}

export interface DiscoveryOptions {
  /** Bundle executable name: `Sondine` for a packaged build, `Electron` under `pnpm dev`. */
  readonly appName: string;
  /** Main pids that Launch Services reports for the bundle id. */
  readonly bundleMainPids?: readonly number[];
}

export interface Discovery {
  readonly sondine: readonly DiscoveredProcess[];
  readonly coreaudiod: DiscoveredProcess | null;
  readonly warnings: readonly string[];
}

const nativeHelpers: Readonly<Record<string, ProcessRole>> = {
  "sondine-audio": "audio-helper",
  "sondine-engines": "engine-worker",
  "sondine-mcp": "mcp",
};

const utilitySubTypes: Readonly<Record<string, ProcessRole>> = {
  "node.mojom.NodeService": "core",
  "network.mojom.NetworkService": "network-service",
  "audio.mojom.AudioService": "audio-service",
  "storage.mojom.StorageService": "storage-service",
};

function basename(path: string | null, fallback: string): string {
  if (path === null) return fallback;
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

function flag(args: readonly string[] | null, name: string): string | null {
  const prefix = `--${name}=`;
  const match = args?.find((argument) => argument.startsWith(prefix));
  return match === undefined ? null : match.slice(prefix.length);
}

function bundleDirectory(path: string): string | null {
  const index = path.indexOf(".app/Contents/MacOS/");
  return index === -1 ? null : path.slice(0, index + ".app/".length);
}

function helperRole(
  process: Pick<ListedProcess, "name" | "path" | "arguments">,
  appName: string,
): ProcessRole | null {
  const executable = basename(process.path, process.name);
  const nativeRole = nativeHelpers[executable];
  if (nativeRole !== undefined) return nativeRole;
  if (executable === `${appName} Helper (GPU)`) return "gpu";
  if (executable === `${appName} Helper (Renderer)`) return "renderer";
  if (executable === `${appName} Helper (Plugin)`) return "plugin";
  if (executable !== `${appName} Helper`) return null;
  const type = flag(process.arguments, "type");
  if (type === "gpu-process") return "gpu";
  if (type === "renderer") return "renderer";
  if (type !== "utility") return "helper-other";
  const subType = flag(process.arguments, "utility-sub-type");
  return (subType === null ? undefined : utilitySubTypes[subType]) ?? "utility-other";
}

/** A role from the executable alone, for a process seen in no listing; null when the role
 * depends on its arguments (a plain Chromium helper) or it is not Sondine's. */
export function roleFromExecutable(
  process: { readonly name: string; readonly path: string | null },
  appName: string,
): ProcessRole | null {
  if (process.path === COREAUDIOD_PATH) return "coreaudiod";
  if (process.path?.endsWith(`/${appName}.app/Contents/MacOS/${appName}`) === true) return "main";
  const executable = basename(process.path, process.name);
  if (executable === `${appName} Helper`) return null;
  const role = helperRole({ ...process, arguments: null }, appName);
  return role === "helper-other" ? null : role;
}

export function discoverProcesses(
  listed: readonly ListedProcess[],
  options: DiscoveryOptions,
): Discovery {
  const warnings: string[] = [];
  const bundleMainPids = new Set(options.bundleMainPids ?? []);
  const mainSuffix = `/${options.appName}.app/Contents/MacOS/${options.appName}`;
  const mains = listed.filter(
    (process) => bundleMainPids.has(process.pid) || (process.path?.endsWith(mainSuffix) ?? false),
  );
  const mainPids = new Set(mains.map((process) => process.pid));
  const bundles = mains.flatMap((process) => {
    const directory = process.path === null ? null : bundleDirectory(process.path);
    return directory === null ? [] : [directory];
  });

  const children = new Map<number, ListedProcess[]>();
  for (const process of listed) {
    const siblings = children.get(process.ppid) ?? [];
    siblings.push(process);
    children.set(process.ppid, siblings);
  }
  const descendants = new Map<number, number>(); // pid → the main or core pid it descends from
  const queue = [...mainPids];
  while (queue.length > 0) {
    const parent = queue.shift();
    if (parent === undefined) break;
    for (const child of children.get(parent) ?? []) {
      if (mainPids.has(child.pid) || descendants.has(child.pid)) continue;
      descendants.set(child.pid, parent);
      queue.push(child.pid);
    }
  }

  const sondine: DiscoveredProcess[] = [];
  const corePids = new Set<number>();
  const pending: ListedProcess[] = [];
  for (const process of listed) {
    const inBundle =
      process.path !== null && bundles.some((directory) => process.path?.startsWith(directory));
    const executable = basename(process.path, process.name);
    const related = mainPids.has(process.pid) || descendants.has(process.pid) || inBundle;
    if (!related && nativeHelpers[executable] === undefined) continue;
    const role = mainPids.has(process.pid) ? "main" : helperRole(process, options.appName);
    if (role === null) {
      pending.push(process);
      continue;
    }
    if (role === "core") corePids.add(process.pid);
    sondine.push(describe(process, role));
  }
  // Unrecognized descendants: core's children are engine workers (speech.cpp, llama-server).
  for (const process of pending) {
    let ancestor = descendants.get(process.pid);
    let underCore = false;
    while (ancestor !== undefined && !mainPids.has(ancestor)) {
      if (corePids.has(ancestor)) underCore = true;
      ancestor = descendants.get(ancestor);
    }
    sondine.push(describe(process, underCore ? "engine-worker" : "helper-other"));
  }
  sondine.sort((a, b) => a.pid - b.pid);

  const coreaudiodProcesses = listed.filter((process) => process.path === COREAUDIOD_PATH);
  if (coreaudiodProcesses.length === 0)
    warnings.push("coreaudiod not found: the coreaudiod delta cannot be measured");
  if (coreaudiodProcesses.length > 1)
    warnings.push(`${coreaudiodProcesses.length} coreaudiod processes; using the first`);
  const coreaudiodProcess = coreaudiodProcesses[0];

  const count = (role: ProcessRole) => sondine.filter((process) => process.role === role).length;
  if (mains.length === 0) warnings.push(`no ${options.appName} main process found`);
  if (mains.length > 1)
    warnings.push(`${mains.length} ${options.appName} main processes: quit the extra instance`);
  if (count("audio-helper") === 0) warnings.push("no sondine-audio process found");
  if (count("audio-helper") > 1) warnings.push(`${count("audio-helper")} sondine-audio processes`);
  if (count("core") === 0) warnings.push("no core utility process found");
  if (count("renderer") > 0)
    warnings.push(
      "a window is open (renderer alive): the always-on budget is measured with windows closed",
    );
  if (count("engine-worker") > 0) {
    warnings.push(
      "an engine worker is alive: let the queue drain (workers exit after 90 s idle); it is excluded from the total",
    );
  }
  if (count("mcp") > 0)
    warnings.push("sondine-mcp is running: the budget is measured with MCP off");

  return {
    sondine,
    coreaudiod: coreaudiodProcess === undefined ? null : describe(coreaudiodProcess, "coreaudiod"),
    warnings,
  };
}

function describe(process: ListedProcess, role: ProcessRole): DiscoveredProcess {
  return {
    pid: process.pid,
    ppid: process.ppid,
    startUs: process.startUs,
    name: process.name,
    path: process.path,
    role,
  };
}
