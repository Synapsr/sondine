import { execFile } from "node:child_process";
import { basename } from "node:path";

// What holds the memory macOS counts for its pressure level, app by app, for
// the window's "why it waits" panel. With the compressor on a Mac above 3 GB
// (XNU osfmk/vm/vm_pageout.c, VM_PRESSURE_*; divisors in vm_compressor.c),
// the level depends on two counts only: pages kept uncompressed (active,
// inactive, free, speculative) and the RAM the compressor occupies. Warning
// starts once the compressor holds more than the uncompressed pages; it ends
// once the compressor holds under 40 % of the two together; critical ends
// under 60 % (critical also follows the compressor's own capacity). So
// closing an app helps the level mostly by the compressed memory it held:
// its resident pages only turn free. Each app's share is an estimate: `top`
// counts compressed pages at their original size, and pages compress
// unevenly. Read only while the panel is open; nothing here is logged.

/** Pressure falls back to normal once the compressor holds less than this share. */
export const NORMAL_BELOW_SHARE = 0.4;
/** Critical falls back to warning once the compressor holds less than this share. */
export const WARNING_BELOW_SHARE = 0.6;

export interface VmCounts {
  /** Uncompressed pages (active, inactive, free, speculative), in bytes. */
  readonly uncompressedBytes: number;
  /** RAM the compressor occupies, in bytes. */
  readonly compressedBytes: number;
}

export interface AppMemory {
  readonly name: string;
  /** The app's bundle, for its icon; null for macOS and command-line tools. */
  readonly appPath: string | null;
  /** The app's estimated share of the RAM the compressor occupies. */
  readonly bytes: number;
}

export interface MemoryUse extends VmCounts {
  /** Every app holding compressed memory, the most first. */
  readonly apps: readonly AppMemory[];
}

/** `vm_stat`: page size from the header, then `Pages free: 15433.` lines. */
export function parseVmStat(output: string): VmCounts | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1]);
  const pages = (label: string) => {
    const match = new RegExp(`^${label}:\\s+(\\d+)\\.?$`, "m").exec(output);
    return match?.[1] === undefined ? null : Number(match[1]);
  };
  const free = pages("Pages free");
  const active = pages("Pages active");
  const inactive = pages("Pages inactive");
  const speculative = pages("Pages speculative");
  const compressor = pages("Pages occupied by compressor");
  if (
    !Number.isFinite(pageSize) ||
    pageSize <= 0 ||
    free === null ||
    active === null ||
    inactive === null ||
    speculative === null ||
    compressor === null
  ) {
    return null;
  }
  return {
    uncompressedBytes: (free + active + inactive + speculative) * pageSize,
    compressedBytes: compressor * pageSize,
  };
}

const UNITS: Record<string, number> = {
  B: 1,
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
};

/** `top -l 1 -stats pid,cmprs`: each process's compressed memory, as `609M+` or `0B`. */
export function parseTopCompressed(output: string): Map<number, number> {
  const out = new Map<number, number>();
  let rows = false;
  for (const line of output.split("\n")) {
    if (/^PID\s/.test(line)) {
      rows = true;
      continue;
    }
    if (!rows) continue;
    const match = /^(\d+)\s+([\d.]+)([BKMGT])[+-]?\s*$/.exec(line.trim());
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) continue;
    const bytes = Number.parseFloat(match[2]) * (UNITS[match[3]] ?? 1);
    if (bytes > 0) out.set(Number(match[1]), bytes);
  }
  return out;
}

export interface ProcessEntry {
  readonly ppid: number;
  readonly path: string;
}

/** `ps -axo pid=,ppid=,comm=`: parents and executable paths (paths may hold spaces). */
export function parseProcesses(output: string): Map<number, ProcessEntry> {
  const out = new Map<number, ProcessEntry>();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) continue;
    out.set(Number(match[1]), { ppid: Number(match[2]), path: match[3].trim() });
  }
  return out;
}

/** The outermost app bundle in a path, « Cursor » for its helpers too, and where it is. */
function bundleOf(path: string): { readonly name: string; readonly appPath: string } | null {
  const match = /^(.*?\/([^/]+)\.app)(?:\/|$)/.exec(path);
  return match?.[1] === undefined || match[2] === undefined
    ? null
    : { name: match[2], appPath: match[1] };
}

/** macOS's own binaries; /usr/local holds the user's. */
const SYSTEM_PATH = /^\/(?:System|sbin|bin|Library\/Apple)\/|^\/usr\/(?!local\/)/;

/**
 * The app a process belongs to, as quitting it would stop it: its own bundle,
 * else the nearest ancestor's (a language server started by an editor, a
 * command started in a terminal); macOS for system daemons; else its name.
 */
export function appOf(
  pid: number,
  processes: ReadonlyMap<number, ProcessEntry>,
): { readonly name: string; readonly appPath: string | null } {
  const own = processes.get(pid);
  let current = own;
  for (let depth = 0; current !== undefined && depth < 32; depth++) {
    const bundle = bundleOf(current.path);
    if (bundle !== null) return bundle;
    if (current.ppid <= 1) break;
    current = processes.get(current.ppid);
  }
  if (own === undefined) return { name: "?", appPath: null };
  return { name: SYSTEM_PATH.test(own.path) ? "macOS" : basename(own.path), appPath: null };
}

/** Compressed memory by app, scaled to the RAM the compressor occupies: an estimate. */
export function appShares(
  compressed: ReadonlyMap<number, number>,
  processes: ReadonlyMap<number, ProcessEntry>,
  compressorBytes: number,
): AppMemory[] {
  const byApp = new Map<string, number>();
  const paths = new Map<string, string | null>();
  let total = 0;
  for (const [pid, bytes] of compressed) {
    const { name, appPath } = appOf(pid, processes);
    byApp.set(name, (byApp.get(name) ?? 0) + bytes);
    if (appPath !== null || !paths.has(name)) paths.set(name, appPath);
    total += bytes;
  }
  if (total === 0) return [];
  return [...byApp]
    .map(([name, bytes]) => ({
      name,
      appPath: paths.get(name) ?? null,
      bytes: Math.round((bytes / total) * compressorBytes),
    }))
    .filter((app) => app.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);
}

function run(file: string, args: readonly string[], timeout: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { timeout, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => resolve(error === null ? stdout : null),
    );
  });
}

export const readVmCounts = async (): Promise<VmCounts | null> => {
  const output = await run("/usr/bin/vm_stat", [], 2_000);
  return output === null ? null : parseVmStat(output);
};

/** Each process's compressed memory and its app; `top` costs about a second of CPU. */
export async function readAppCompressed(): Promise<{
  readonly compressed: Map<number, number>;
  readonly processes: Map<number, ProcessEntry>;
} | null> {
  const [top, ps] = await Promise.all([
    run("/usr/bin/top", ["-l", "1", "-stats", "pid,cmprs", "-n", "10000"], 10_000),
    run("/bin/ps", ["-axo", "pid=,ppid=,comm="], 2_000),
  ]);
  if (top === null || ps === null) return null;
  return { compressed: parseTopCompressed(top), processes: parseProcesses(ps) };
}
