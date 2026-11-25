import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { waitUntil } from "../../test/support";
import type { HelperProcessInfo } from "../shared/core-messages";
import { createHelperSupervisor } from "./helper-supervisor";
import { createRestartPolicy } from "./restart-policy";

const dir = mkdtempSync(join(tmpdir(), "sondine-supervisor-"));

// Plain Node scripts stand in for the helper; ELECTRON_RUN_AS_NODE is not involved.
const crashing = join(dir, "crash.mjs");
writeFileSync(crashing, "process.exit(3);\n");
const lifetime = join(dir, "lifetime.mjs");
writeFileSync(
  lifetime,
  "process.stdin.on('end', () => process.exit(0)); process.stdin.resume(); setInterval(() => {}, 1000);\n",
);
// Exits at the end of stdin with what it read: 0 when main said `quit` first, 9 otherwise.
const listening = join(dir, "listening.mjs");
writeFileSync(
  listening,
  "let read = ''; process.stdin.on('data', (d) => (read += d)); process.stdin.on('end', () => process.exit(read.includes('quit') ? 0 : 9)); process.stdin.resume(); setInterval(() => {}, 1000);\n",
);
const stubborn = join(dir, "stubborn.mjs");
writeFileSync(stubborn, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n");
// Present but not executable: spawn fails with EACCES and never emits `exit`.
const notExecutable = join(dir, "not-executable");
writeFileSync(notExecutable, "#!/bin/sh\nexit 0\n");
chmodSync(notExecutable, 0o644);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function supervise(script: string, policyMs = 5) {
  const states: HelperProcessInfo[] = [];
  const supervisor = createHelperSupervisor({
    command: { executable: process.execPath, args: [script] },
    onChange: (info) => states.push(info),
    policy: createRestartPolicy({ minDelayMs: policyMs, maxDelayMs: policyMs * 4 }),
    stopGraceMs: 200,
  });
  return { supervisor, states };
}

describe("helper supervisor", () => {
  it("restarts a crashing helper with backoff and reports a crash loop", async () => {
    const { supervisor, states } = supervise(crashing);
    supervisor.start();
    await waitUntil(() => states.some((s) => s.state === "crash-loop"), { label: "crash loop" });
    await supervisor.stop();
    const loop = states.find((s) => s.state === "crash-loop");
    expect(loop?.restarts).toBe(3);
    expect(loop?.lastExit?.code).toBe(3);
    expect(states.at(-1)?.state).toBe("stopped");
  });

  it("stops a helper by closing its stdin (the lifetime pipe)", async () => {
    const { supervisor, states } = supervise(lifetime);
    supervisor.start();
    await waitUntil(() => supervisor.info().state === "running", { label: "running" });
    const pid = supervisor.info().pid;
    expect(pid).toBeTypeOf("number");
    await supervisor.stop();
    expect(states.at(-1)).toMatchObject({ state: "stopped", lastExit: { code: 0, signal: null } });
    expect(() => process.kill(pid ?? 0, 0)).toThrow();
  });

  it("says `quit` on the lifetime pipe before letting the helper go, so it relaunches nothing", async () => {
    const { supervisor, states } = supervise(listening);
    supervisor.start();
    await waitUntil(() => supervisor.info().state === "running", { label: "running" });
    await supervisor.stop();
    expect(states.at(-1)).toMatchObject({ state: "stopped", lastExit: { code: 0 } });
  });

  it("escalates to signals when the helper ignores its stdin", async () => {
    const { supervisor, states } = supervise(stubborn);
    supervisor.start();
    await waitUntil(() => supervisor.info().state === "running", { label: "running" });
    await supervisor.stop();
    expect(states.at(-1)).toMatchObject({ state: "stopped", lastExit: { signal: "SIGKILL" } });
  });

  it("retries a helper that fails to spawn, and stops without waiting for it", async () => {
    const states: HelperProcessInfo[] = [];
    const supervisor = createHelperSupervisor({
      command: { executable: notExecutable, args: [] },
      onChange: (info) => states.push(info),
      policy: createRestartPolicy({ minDelayMs: 5, maxDelayMs: 20 }),
    });
    supervisor.start();
    await waitUntil(() => states.some((s) => s.state === "crash-loop"), { label: "crash loop" });
    expect(states.find((s) => s.state === "restarting")).toMatchObject({ pid: null });
    await supervisor.stop();
    expect(states.at(-1)).toMatchObject({ state: "stopped", pid: null });
  });

  it("resolves stop() for a helper whose spawn has not failed yet", async () => {
    const failing = createHelperSupervisor({
      command: { executable: notExecutable, args: [] },
      onChange: () => undefined,
    });
    failing.start();
    // Stopping before the spawn error arrives must still settle.
    await failing.stop();
    expect(failing.info().state).toBe("stopped");
  });

  it("waits for a missing executable instead of crash-looping", async () => {
    const states: HelperProcessInfo[] = [];
    const supervisor = createHelperSupervisor({
      command: { executable: join(dir, "absent"), args: [] },
      onChange: (info) => states.push(info),
    });
    supervisor.start();
    expect(states.at(-1)).toMatchObject({ state: "missing", restarts: 0 });
    await supervisor.stop();
  });
});
