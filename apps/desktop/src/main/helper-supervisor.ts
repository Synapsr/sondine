import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { HelperProcessInfo } from "../shared/core-messages";
import { createRestartPolicy, type RestartPolicy } from "./restart-policy";

// Runs `sondine-audio serve` as main's child so macOS credits Sondine.app for
// microphone and system-audio access (ADR 003). Main holds only the helper's
// stdin: when main dies the pipe closes and the helper exits. Main writes
// `quit` on it first when it lets the helper go on purpose; a pipe that closes
// without it means main crashed, and the helper opens Sondine again
// (native/Sources/sondine-audio/relaunch.swift). Its stdout and stderr go
// straight to main's.

export interface HelperCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

export interface HelperSupervisorOptions {
  readonly command: HelperCommand;
  readonly onChange: (info: HelperProcessInfo) => void;
  readonly policy?: RestartPolicy;
  /** How long to wait for the helper to exit after its stdin closes. */
  readonly stopGraceMs?: number;
  /** Retry interval while the executable is missing. */
  readonly missingRetryMs?: number;
  readonly log?: (event: string, fields: Record<string, string | number | null>) => void;
}

export interface HelperSupervisor {
  start(): void;
  /**
   * Stops restarting without touching the running helper, so it can exit on
   * its own (after core's `shutdown`) without being restarted.
   */
  retire(): void;
  /** Closes stdin, then escalates to SIGTERM and SIGKILL. Resolves once the helper is gone. */
  stop(): Promise<void>;
  readonly info: () => HelperProcessInfo;
}

export function createHelperSupervisor(options: HelperSupervisorOptions): HelperSupervisor {
  const policy = options.policy ?? createRestartPolicy();
  const stopGraceMs = options.stopGraceMs ?? 5_000;
  const missingRetryMs = options.missingRetryMs ?? 30_000;
  const log = options.log ?? (() => undefined);
  /** The current child and a promise that settles once it is gone (exited or never spawned). */
  let child: { readonly process: ChildProcess; readonly gone: Promise<void> } | null = null;
  let startedAt = 0;
  let stopping = false;
  let timer: NodeJS.Timeout | null = null;
  let info: HelperProcessInfo = {
    state: "stopped",
    pid: null,
    restarts: 0,
    lastExit: null,
    nextAttemptAtMs: null,
  };

  const publish = (next: Partial<HelperProcessInfo>) => {
    info = { ...info, ...next };
    options.onChange(info);
  };

  const schedule = (delayMs: number, state: "restarting" | "crash-loop" | "missing") => {
    publish({ state, pid: null, nextAttemptAtMs: Date.now() + delayMs });
    timer = setTimeout(() => {
      timer = null;
      start();
    }, delayMs);
  };

  function start() {
    if (stopping || child !== null) return;
    if (!existsSync(options.command.executable)) {
      log("helper.missing", { path: options.command.executable });
      schedule(missingRetryMs, "missing");
      return;
    }
    publish({ state: "starting", nextAttemptAtMs: null });
    const spawned = spawn(options.command.executable, [...options.command.args], {
      stdio: ["pipe", "inherit", "inherit"],
      env: options.command.env ?? process.env,
    });
    startedAt = Date.now();
    let running = false;
    const gone = Promise.withResolvers<void>();
    child = { process: spawned, gone: gone.promise };

    // The one way a child ends: it exited, or it never spawned (`error`
    // without `exit`, such as EACCES). Runs once per child.
    let finished = false;
    const finish = (code: number | null, signal: string | null) => {
      if (finished) return;
      finished = true;
      if (child?.process === spawned) child = null;
      gone.resolve();
      const atMs = Date.now();
      const lastExit = { code, signal, atMs };
      log("helper.exit", { code, signal, uptimeMs: atMs - startedAt });
      if (stopping) {
        publish({ state: "stopped", pid: null, lastExit, nextAttemptAtMs: null });
        return;
      }
      const decision = policy.onCrash(atMs, atMs - startedAt);
      publish({ restarts: info.restarts + 1, lastExit });
      schedule(decision.delayMs, decision.crashLoop ? "crash-loop" : "restarting");
    };

    // An EPIPE on the lifetime pipe only means the helper is already gone.
    spawned.stdin?.on("error", () => undefined);
    spawned.once("spawn", () => {
      running = true;
      log("helper.spawned", { pid: spawned.pid ?? null });
      publish({ state: "running", pid: spawned.pid ?? null });
    });
    spawned.on("error", (error) => {
      // After a successful spawn, `error` (a failed kill) is not an exit.
      log(running ? "helper.error" : "helper.spawn-error", { message: error.message });
      if (!running) finish(null, null);
    });
    spawned.once("exit", (code, signal) => finish(code, signal));
  }

  function retire() {
    stopping = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    // Main quits on purpose: the helper must not bring it back when the pipe closes.
    child?.process.stdin?.write("quit\n");
  }

  async function stop() {
    retire();
    const current = child;
    if (current === null) {
      publish({ state: "stopped", pid: null, nextAttemptAtMs: null });
      return;
    }
    const running = current.process;
    const exited = current.gone;
    const within = (ms: number) =>
      Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
      ]);
    running.stdin?.end();
    if (await within(stopGraceMs)) return;
    log("helper.stop-escalate", { signal: "SIGTERM" });
    running.kill("SIGTERM");
    if (await within(2_000)) return;
    log("helper.stop-escalate", { signal: "SIGKILL" });
    running.kill("SIGKILL");
    await exited;
  }

  return {
    start: () => {
      stopping = false;
      start();
    },
    retire,
    stop,
    info: () => info,
  };
}
