import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { waitUntil } from "../../../test/support";
import {
  makeRelaySupervisor,
  relayCommand,
  type RelayArguments,
  type RelayProcess,
} from "./lan-relay";

const ARGS: RelayArguments = {
  bundlePath: "/data/lan/identity.p12",
  passwordPath: "/data/lan/identity.pass",
  socketPath: "/data/run/phone.sock",
  name: "Sondine K7Q2",
  port: null,
  tailnet: false,
  allowLoopback: true,
};

/** A relay that says it listens, and exits when its stdin ends. */
function fakeRelays(port = 49_321) {
  const started: {
    args: readonly string[];
    child: RelayProcess & EventEmitter;
    stdout: PassThrough;
  }[] = [];
  const spawn = (_binary: string, args: readonly string[]) => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr: new PassThrough(),
      kill: () => {
        child.emit("exit", null, "SIGKILL");
        return true;
      },
    });
    stdin.on("finish", () => child.emit("exit", 0, null));
    setImmediate(() => stdout.write(`${JSON.stringify({ event: "listening", port })}\n`));
    started.push({ args, child, stdout });
    return child;
  };
  return { spawn, started };
}

describe("the relay supervisor", () => {
  it("passes the relay its contract's arguments", () => {
    expect(relayCommand({ ...ARGS, port: 49_321, tailnet: true })).toEqual([
      "serve",
      "--identity",
      "/data/lan/identity.p12",
      "--password-file",
      "/data/lan/identity.pass",
      "--socket",
      "/data/run/phone.sock",
      "--name",
      "Sondine K7Q2",
      "--port",
      "49321",
      "--tailnet",
      "--allow-loopback",
    ]);
    expect(relayCommand({ ...ARGS, allowLoopback: false })).not.toContain("--allow-loopback");
    expect(relayCommand(ARGS)).toContain("0");
  });

  it("starts it, keeps its port, restarts it for new arguments but not for its port, and stops it", async () => {
    const relays = fakeRelays();
    const ports: number[] = [];
    const supervisor = makeRelaySupervisor({
      binary: "/fake/sondine-lan",
      spawn: relays.spawn,
      onListening: (port) => ports.push(port),
    });
    supervisor.want(ARGS);
    await expect(supervisor.listening(1_000)).resolves.toBe(49_321);
    expect(ports).toEqual([49_321]);
    expect(supervisor.state()).toEqual({ phase: "listening", port: 49_321, problem: null });
    supervisor.want({ ...ARGS, port: 49_321 });
    expect(relays.started).toHaveLength(1);
    // Tailscale turned on: the relay starts again with `--tailnet`.
    supervisor.want({ ...ARGS, port: 49_321, tailnet: true });
    await waitUntil(() => relays.started.length === 2, { label: "restart" });
    expect(relays.started[1]?.args).toContain("--tailnet");
    expect(relays.started[1]?.args.join(" ")).toContain("--port 49321");
    supervisor.want(null);
    await waitUntil(() => supervisor.state().phase === "off", { label: "stopped" });
  });

  it("starts a relay that exits on its own again, and says why", async () => {
    const relays = fakeRelays();
    const supervisor = makeRelaySupervisor({
      binary: "/fake/sondine-lan",
      spawn: relays.spawn,
      onListening: () => undefined,
    });
    supervisor.want(ARGS);
    await supervisor.listening(1_000);
    const first = relays.started[0];
    first?.stdout.write(`${JSON.stringify({ event: "error", message: "port taken" })}\n`);
    first?.child.emit("exit", 1, null);
    expect(supervisor.state()).toMatchObject({ phase: "failed", problem: "port taken" });
    await waitUntil(() => relays.started.length === 2, { label: "restart", timeoutMs: 3_000 });
    await supervisor.listening(1_000);
    await supervisor.stop();
    expect(supervisor.state().phase).toBe("off");
  });
});
