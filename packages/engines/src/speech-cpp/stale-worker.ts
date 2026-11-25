import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EngineError } from "../contract.ts";

const run = promisify(execFile);

export type StaleWorkerOutcome = "killed" | "not-running" | "other-process";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: a process of another user holds the pid, so it is not ours.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Pids of every process whose executable is exactly `executable` (`ps` comm,
 * the full path it was started from), never matched by name alone. With
 * `weights`, only the workers loading that model file (one worker per model:
 * near-live text and the final pass each have their own).
 */
export async function findWorkerProcesses(executable: string, weights?: string): Promise<number[]> {
  const { stdout } = await run("/bin/ps", ["-ww", "-axo", "pid=,comm="], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const pids: number[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    if (match[2] === executable && pid !== process.pid) pids.push(pid);
  }
  if (weights === undefined || pids.length === 0) return pids;
  const { stdout: commands } = await run(
    "/bin/ps",
    ["-ww", "-o", "pid=,command=", "-p", pids.join(",")],
    {
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const loading = new Set<number>();
  for (const line of commands.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match?.[2] === undefined) continue;
    // `worker <weights> --device …` as the engine spawns it: paths may hold spaces.
    if (match[2].includes(` worker ${weights} --device `)) loading.add(Number(match[1]));
  }
  return pids.filter((pid) => loading.has(pid));
}

function signal(pids: readonly number[], name: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, name);
    } catch {
      // Gone already.
    }
  }
}

export interface StopWorkersOptions {
  /** SIGTERM, then SIGKILL after this long. */
  readonly termMs?: number;
  /** How long a SIGKILLed process may take to go. */
  readonly killMs?: number;
}

export interface StopWorkersReport {
  readonly stopped: readonly number[];
  /** Processes still running `executable` after SIGKILL and its deadline. */
  readonly survivors: readonly number[];
}

/**
 * ADR 016 "Restart": only Sondine's single core spawns the speech binary, so
 * at startup every process running it is an orphan. Each gets SIGTERM, then
 * SIGKILL after `termMs`; resolves once they have exited or the SIGKILL
 * deadline passed.
 */
export async function stopWorkerProcesses(
  executable: string,
  options: StopWorkersOptions = {},
): Promise<StopWorkersReport> {
  const found = await findWorkerProcesses(executable);
  if (found.length === 0) return { stopped: [], survivors: [] };
  /** The found pids still running our binary (an exited pid could be reused by another program). */
  const remaining = async () => {
    const running = new Set(await findWorkerProcesses(executable));
    return found.filter((pid) => running.has(pid));
  };
  const waitGone = async (ms: number) => {
    const deadline = Date.now() + ms;
    let left = await remaining();
    while (left.length > 0 && Date.now() < deadline) {
      await sleep(50);
      left = await remaining();
    }
    return left;
  };
  signal(found, "SIGTERM");
  const stubborn = await waitGone(options.termMs ?? 5_000);
  if (stubborn.length === 0) return { stopped: found, survivors: [] };
  signal(stubborn, "SIGKILL");
  const survivors = await waitGone(options.killMs ?? 5_000);
  return { stopped: found.filter((pid) => !survivors.includes(pid)), survivors };
}

/**
 * ADR 016 "Worker": at most one worker per model exists. Throws
 * `worker_running` while any process runs `executable` on `weights`; fails
 * closed when `ps` cannot answer.
 */
export async function assertNoWorkerProcess(executable: string, weights: string): Promise<void> {
  let pids: number[];
  try {
    pids = await findWorkerProcesses(executable, weights);
  } catch (error) {
    throw new EngineError("worker_running", "cannot list processes to check for a speech worker", {
      cause: error,
    });
  }
  if (pids.length > 0) {
    throw new EngineError(
      "worker_running",
      `a speech worker already runs (pid ${pids.join(", ")})`,
    );
  }
}

/**
 * ADR 016 "Restart": before core starts a worker, a pid recorded by an
 * attempt is killed if it still runs `executable` as a worker. A pid the
 * system gave to another program is left alone.
 */
export async function killStaleWorker(
  pid: number,
  executable: string,
  options: { readonly timeoutMs?: number } = {},
): Promise<StaleWorkerOutcome> {
  if (!Number.isInteger(pid) || pid <= 1 || !alive(pid)) return "not-running";
  let command: string;
  try {
    command = (await run("/bin/ps", ["-ww", "-o", "command=", "-p", String(pid)])).stdout.trim();
  } catch {
    return "not-running";
  }
  if (!command.startsWith(`${executable} `) || !command.includes(" worker ")) {
    return "other-process";
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return "not-running";
  }
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  while (alive(pid)) {
    if (Date.now() > deadline) throw new Error(`speech worker ${pid} survived SIGKILL`);
    await sleep(20);
  }
  return "killed";
}
