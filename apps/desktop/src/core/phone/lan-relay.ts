import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import * as z from "zod";
import { log } from "../log";

// `sondine-lan` (ADR 008), the only Sondine process with a TCP port: core
// starts it while a pairing is open or a phone is paired and the user's
// switch is on, holds its stdin (its end means exit), and reads its JSON
// lines: `listening` once with its port, `error` with a message. A relay
// that exits while wanted is started again, later each time.

export interface RelayProcess {
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export type RelaySpawner = (binary: string, args: readonly string[]) => RelayProcess;

export const spawnRelay: RelaySpawner = (binary, args) =>
  spawn(binary, [...args], { stdio: ["pipe", "pipe", "pipe"], env: {} });

export interface RelayArguments {
  readonly bundlePath: string;
  readonly passwordPath: string;
  readonly socketPath: string;
  readonly name: string;
  /** The port kept from the last run; null lets the system choose. */
  readonly port: number | null;
  readonly tailnet: boolean;
  /** Development builds accept loopback peers. */
  readonly allowLoopback: boolean;
}

/** The relay's command line (its contract with core). */
export function relayCommand(args: RelayArguments): string[] {
  return [
    "serve",
    "--identity",
    args.bundlePath,
    "--password-file",
    args.passwordPath,
    "--socket",
    args.socketPath,
    "--name",
    args.name,
    "--port",
    String(args.port ?? 0),
    ...(args.tailnet ? ["--tailnet"] : []),
    ...(args.allowLoopback ? ["--allow-loopback"] : []),
  ];
}

const RelayLine = z.union([
  z.object({ event: z.literal("listening"), port: z.int().min(1).max(65_535) }),
  z.object({ event: z.literal("error"), message: z.string() }),
]);

export type RelayPhase = "off" | "starting" | "listening" | "failed";

export interface RelayState {
  readonly phase: RelayPhase;
  readonly port: number | null;
  /** The relay's last error, in its words; null while all is well. */
  readonly problem: string | null;
}

export interface RelaySupervisor {
  /**
   * Runs the relay with these arguments (started again when they change, but
   * for the port), or stops it with null.
   */
  want(args: RelayArguments | null): void;
  state(): RelayState;
  /** The port once the relay listens; rejects after `timeoutMs` or when it exits first. */
  listening(timeoutMs: number): Promise<number>;
  /** Stops it and waits for its exit. */
  stop(): Promise<void>;
}

const STOP_GRACE_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
/** A relay that listened this long resets the backoff. */
const HEALTHY_MS = 60_000;

interface Running {
  readonly key: string;
  readonly child: RelayProcess;
  readonly gone: Promise<void>;
  readonly startedAtMs: number;
  stopping: boolean;
}

export function makeRelaySupervisor(options: {
  readonly binary: string;
  readonly spawn?: RelaySpawner;
  /** The relay listens on this port: kept for its next start. */
  readonly onListening: (port: number) => void;
}): RelaySupervisor {
  const start = options.spawn ?? spawnRelay;
  let wanted: { readonly key: string; readonly args: RelayArguments } | null = null;
  let running: Running | null = null;
  let state: RelayState = { phase: "off", port: null, problem: null };
  let backoffMs = 1_000;
  let retry: NodeJS.Timeout | null = null;
  const waiters = new Set<{
    readonly resolve: (port: number) => void;
    readonly reject: (error: Error) => void;
  }>();

  const settleWaiters = (outcome: { port: number } | { error: Error }) => {
    for (const waiter of waiters) {
      if ("port" in outcome) waiter.resolve(outcome.port);
      else waiter.reject(outcome.error);
    }
    waiters.clear();
  };

  const halt = (current: Running) => {
    if (current.stopping) return current.gone;
    current.stopping = true;
    current.child.stdin?.end();
    const killer = setTimeout(() => current.child.kill("SIGKILL"), STOP_GRACE_MS);
    killer.unref();
    return current.gone.finally(() => clearTimeout(killer));
  };

  const launch = () => {
    const target = wanted;
    if (target === null || running !== null) return;
    let child: RelayProcess;
    try {
      child = start(options.binary, relayCommand(target.args));
    } catch (error) {
      state = {
        phase: "failed",
        port: null,
        problem: error instanceof Error ? error.message : "spawn",
      };
      log.warn("phone.relay-spawn-failed", {});
      schedule();
      return;
    }
    const gone = Promise.withResolvers<void>();
    const current: Running = {
      key: target.key,
      child,
      gone: gone.promise,
      startedAtMs: Date.now(),
      stopping: false,
    };
    running = current;
    state = { phase: "starting", port: null, problem: null };
    log.info("phone.relay-started", { tailnet: target.args.tailnet });
    child.stdin?.on("error", () => undefined);
    // The relay's own lines say what it accepted, refused and closed, with an
    // address's class only (never the address): kept in core's log.
    if (child.stderr !== null) {
      createInterface({ input: child.stderr }).on("line", (line) => {
        log.info("phone.relay-says", { line: line.slice(0, 200) });
      });
    }
    if (child.stdout !== null) {
      createInterface({ input: child.stdout }).on("line", (line) => {
        let parsed: z.output<typeof RelayLine> | null = null;
        try {
          const result = RelayLine.safeParse(JSON.parse(line));
          parsed = result.success ? result.data : null;
        } catch {
          parsed = null;
        }
        if (parsed === null || running !== current) return;
        if (parsed.event === "listening") {
          state = { phase: "listening", port: parsed.port, problem: null };
          log.info("phone.relay-listening", { port: parsed.port });
          options.onListening(parsed.port);
          settleWaiters({ port: parsed.port });
        } else {
          state = { ...state, problem: parsed.message.slice(0, 300) };
          log.warn("phone.relay-error", { message: parsed.message.slice(0, 300) });
        }
      });
    }
    let finished = false;
    const finish = (code: number | null, signal: string | null) => {
      if (finished) return;
      finished = true;
      gone.resolve();
      if (running !== current) return;
      running = null;
      if (current.stopping) {
        state = { phase: "off", port: null, problem: null };
        return;
      }
      log.warn("phone.relay-exited", { code, signal });
      state = {
        phase: "failed",
        port: null,
        problem: state.problem ?? `exited with ${code ?? signal}`,
      };
      settleWaiters({ error: new Error("the relay exited") });
      if (Date.now() - current.startedAtMs > HEALTHY_MS) backoffMs = 1_000;
      schedule();
    };
    child.once("exit", finish);
    child.once("error", () => finish(null, "spawn-error"));
  };

  function schedule() {
    if (retry !== null || wanted === null) return;
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    retry = setTimeout(() => {
      retry = null;
      launch();
    }, delay);
    retry.unref();
  }

  const apply = () => {
    const current = running;
    if (current !== null && (wanted === null || wanted.key !== current.key)) {
      void halt(current).then(() => {
        if (running === null) launch();
      });
      return;
    }
    if (current === null && wanted !== null && retry === null) launch();
  };

  return {
    want(args) {
      // The port it was given is not a reason to start it again: it is the one it chose.
      const key = args === null ? null : JSON.stringify({ ...args, port: null });
      if (key === wanted?.key || (key === null && wanted === null)) return;
      wanted = args === null || key === null ? null : { key, args };
      if (wanted === null) {
        if (retry !== null) clearTimeout(retry);
        retry = null;
        backoffMs = 1_000;
        settleWaiters({ error: new Error("the relay was stopped") });
      }
      apply();
    },
    state: () => state,
    listening(timeoutMs) {
      if (state.phase === "listening" && state.port !== null) return Promise.resolve(state.port);
      return new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error("the relay did not start listening in time"));
        }, timeoutMs);
        const waiter = {
          resolve: (port: number) => {
            clearTimeout(timer);
            resolve(port);
          },
          reject: (error: Error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        waiters.add(waiter);
      });
    },
    async stop() {
      wanted = null;
      if (retry !== null) clearTimeout(retry);
      retry = null;
      settleWaiters({ error: new Error("the relay was stopped") });
      if (running !== null) await halt(running);
      state = { phase: "off", port: null, problem: null };
    },
  };
}
