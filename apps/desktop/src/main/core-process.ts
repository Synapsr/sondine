import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import type { AppClient } from "@sondine/api";
import {
  MessageChannelMain,
  utilityProcess,
  type MessagePortMain,
  type UtilityProcess,
} from "electron";
import { coreArgv, CoreToMain, type CoreArguments, type MainToCore } from "../shared/core-messages";
import { log } from "./log";
import { createRestartPolicy } from "./restart-policy";

// Runs `core` as a utility process (ADR 003) and restarts it with backoff if
// it dies. Main keeps its own oRPC client over a private port for the tray.

export interface CoreProcessOptions {
  readonly modulePath: string;
  readonly args: CoreArguments;
  readonly onMessage: (message: CoreToMain) => void;
  /** A new core is up and ready: re-send state and re-broker renderer ports. */
  readonly onStarted: (client: AppClient) => void;
  /** Core exited on its own; a restart is scheduled. Its client and status are gone. */
  readonly onStopped: (info: { readonly crashLoop: boolean }) => void;
}

export interface CoreProcess {
  post(message: MainToCore, ports?: MessagePortMain[]): void;
  /** Posts only while core runs and is ready; false otherwise (nothing is queued). */
  send(message: MainToCore): boolean;
  readonly pid: () => number | null;
  readonly client: () => AppClient | null;
  /** Asks core to shut down cleanly, then kills it after `timeoutMs`. */
  stop(timeoutMs?: number): Promise<void>;
  /** Starts core again once `stop` returned (the flow lab's steps, ADR 049). */
  startAgain(): void;
}

function send(target: UtilityProcess, message: MainToCore, ports: MessagePortMain[]): void {
  target.postMessage(message, ports);
}

export function startCoreProcess(options: CoreProcessOptions): CoreProcess {
  const policy = createRestartPolicy();
  let child: UtilityProcess | null = null;
  let client: AppClient | null = null;
  let ready = false;
  let stopping = false;
  let startedAt = 0;
  let restartTimer: NodeJS.Timeout | null = null;
  let queue: { message: MainToCore; ports: MessagePortMain[] }[] = [];

  function spawn() {
    restartTimer = null;
    if (stopping) return;
    startedAt = Date.now();
    ready = false;
    const forked = utilityProcess.fork(options.modulePath, coreArgv(options.args), {
      serviceName: "Sondine Core",
      stdio: "inherit",
    });
    child = forked;
    forked.on("spawn", () => log.info("core.spawned", { pid: forked.pid ?? null }));
    forked.on("message", (data: unknown) => {
      const parsed = CoreToMain.safeParse(data);
      if (!parsed.success) {
        log.warn("core.invalid-message");
        return;
      }
      if (parsed.data.type === "ready") {
        ready = true;
        const { port1, port2 } = new MessageChannelMain();
        send(forked, { type: "main-port" }, [port1]);
        port2.start();
        client = createORPCClient(new RPCLink({ port: port2 }));
        for (const pending of queue) send(forked, pending.message, pending.ports);
        queue = [];
        options.onStarted(client);
      }
      options.onMessage(parsed.data);
    });
    forked.once("exit", (code) => {
      child = null;
      client = null;
      ready = false;
      log.info("core.exit", { code });
      if (stopping) return;
      const decision = policy.onCrash(Date.now(), Date.now() - startedAt);
      log.warn("core.restart", { inMs: decision.delayMs, crashLoop: decision.crashLoop });
      restartTimer = setTimeout(spawn, decision.delayMs);
      options.onStopped({ crashLoop: decision.crashLoop });
    });
  }

  spawn();

  return {
    post(message, ports = []) {
      if (child !== null && ready) {
        send(child, message, ports);
        return;
      }
      if (message.type === "shutdown") return;
      // While core starts only the newest message of each kind matters: a
      // renderer port belongs to the newest page, the others are snapshots.
      for (const pending of queue) {
        if (pending.message.type === message.type) for (const port of pending.ports) port.close();
      }
      queue = [
        ...queue.filter((pending) => pending.message.type !== message.type),
        { message, ports },
      ];
    },
    send(message) {
      if (child === null || !ready) return false;
      send(child, message, []);
      return true;
    },
    pid: () => child?.pid ?? null,
    client: () => client,
    async stop(timeoutMs = 8_000) {
      stopping = true;
      if (restartTimer !== null) clearTimeout(restartTimer);
      restartTimer = null;
      const running = child;
      if (running === null) return;
      const exited = new Promise<void>((resolve) => running.once("exit", () => resolve()));
      running.postMessage({ type: "shutdown" } satisfies MainToCore);
      const timer = setTimeout(() => {
        log.warn("core.kill", { reason: "shutdown timed out" });
        running.kill();
      }, timeoutMs);
      await exited;
      clearTimeout(timer);
    },
    startAgain() {
      if (child !== null || !stopping) return;
      stopping = false;
      spawn();
    },
  };
}
