import { app } from "electron";

// Sondine's own PIDs, which the helper excludes from every tap (architecture
// §3): Electron main, renderers, GPU, network and audio services, core, and
// the helper itself. app.getAppMetrics() lists every Chromium child but not
// the helper, which main spawns with child_process.

export function ownProcessIds(helperPid: number | null): number[] {
  const pids = new Set(app.getAppMetrics().map((metric) => metric.pid));
  pids.add(process.pid);
  if (helperPid !== null) pids.add(helperPid);
  return [...pids].filter((pid) => Number.isInteger(pid) && pid > 0).toSorted((a, b) => a - b);
}

export function sameIds(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((pid, index) => pid === b[index]);
}
