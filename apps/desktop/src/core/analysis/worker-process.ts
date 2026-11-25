import { execFile } from "node:child_process";
import {
  killStaleWorker,
  stopWorkerProcesses,
  type StaleWorkerOutcome,
  type StopWorkersReport,
} from "@sondine/engines";

// The speech worker as an OS process: core records its pid on the attempt,
// samples its resident memory, and at startup stops every process running
// our speech binary (only core spawns it, so any left is an orphan), then
// kills one an attempt recorded, but only while that pid still runs our
// speech binary (pids are reused).

export interface WorkerProcessTools {
  /** Stops every process running our speech binary: SIGTERM, then SIGKILL. */
  stopAll(): Promise<StopWorkersReport>;
  /** Kills a worker an earlier core recorded, only while it still runs our `speech worker`. */
  reap(pid: number): Promise<StaleWorkerOutcome>;
  /** Resident memory of `pid` in bytes, or null when it is gone. */
  residentBytes(pid: number): Promise<number | null>;
}

function residentBytes(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      "/bin/ps",
      ["-o", "rss=", "-p", String(pid)],
      { timeout: 2_000, encoding: "utf8" },
      (error, stdout) => {
        const kib = error === null ? Number.parseInt(stdout.trim(), 10) : Number.NaN;
        resolve(Number.isFinite(kib) ? kib * 1024 : null);
      },
    );
  });
}

/**
 * Without a speech binary nothing can prove a process is our worker, so none
 * is killed (and none can be spawned either).
 */
export function workerProcessTools(speechBinary: string | null): WorkerProcessTools {
  return {
    stopAll: () =>
      speechBinary === null
        ? Promise.resolve({ stopped: [], survivors: [] })
        : stopWorkerProcesses(speechBinary),
    reap: (pid) =>
      speechBinary === null ? Promise.resolve("other-process") : killStaleWorker(pid, speechBinary),
    residentBytes,
  };
}
