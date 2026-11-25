import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { EngineError } from "../contract.ts";
import { NEMOTRON_ARTIFACT } from "../models/catalog.ts";
import { createNemotronEngine } from "../nemotron.ts";
import { findWorkerProcesses, stopWorkerProcesses } from "./stale-worker.ts";

// Processes whose `ps` comm reads a fake speech binary's path: Node started
// with that path as argv[0], the way the system reports the real worker.

let dir: string;
let binary: string;
const children: ChildProcess[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sondine-stale-"));
  mkdirSync(join(dir, "Sondine Speech.app", "Contents", "MacOS"), { recursive: true });
  binary = join(dir, "Sondine Speech.app", "Contents", "MacOS", "speech");
  writeFileSync(binary, "#!/bin/sh\nexit 1\n");
  chmodSync(binary, 0o755);
});
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function stray(
  argv0: string,
  options: { readonly ignoreTerm?: boolean; readonly weights?: string } = {},
): ChildProcess {
  const script = `${options.ignoreTerm === true ? "process.on('SIGTERM', () => {});" : ""} setInterval(() => {}, 1000)`;
  const args = ["-e", script, "worker", options.weights ?? "model.gguf", "--device", "gpu"];
  const child = spawn(process.execPath, args, {
    argv0,
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

const exited = (child: ChildProcess) =>
  new Promise<NodeJS.Signals | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.signalCode);
    else child.once("exit", (_code, signal) => resolve(signal));
  });

describe("speech worker processes", () => {
  it("finds processes by their exact executable path, never by name", async () => {
    const ours = stray(binary);
    const other = stray(join(dir, "elsewhere", "speech"));
    await sleep(200);
    const found = await findWorkerProcesses(binary);
    expect(found).toContain(ours.pid);
    expect(found).not.toContain(other.pid);
    expect(await findWorkerProcesses(join(dir, "speech"))).toEqual([]);
  });

  it("stops every one with SIGTERM, then SIGKILL after the deadline", async () => {
    const polite = stray(binary);
    const stubborn = stray(binary, { ignoreTerm: true });
    await sleep(300);
    const report = await stopWorkerProcesses(binary, { termMs: 300, killMs: 2_000 });
    expect(report.survivors).toEqual([]);
    expect([...report.stopped].toSorted()).toEqual([polite.pid, stubborn.pid].toSorted());
    expect(await exited(polite)).toBe("SIGTERM");
    expect(await exited(stubborn)).toBe("SIGKILL");
    expect(await findWorkerProcesses(binary)).toEqual([]);
  });

  it("tells workers apart by the model they load", async () => {
    const nemotron = stray(binary, { weights: join(dir, "nemotron dir", "model.gguf") });
    const parakeet = stray(binary, { weights: join(dir, "parakeet dir", "model.gguf") });
    await sleep(200);
    expect(await findWorkerProcesses(binary, join(dir, "nemotron dir", "model.gguf"))).toEqual([
      nemotron.pid,
    ]);
    expect(await findWorkerProcesses(binary, join(dir, "parakeet dir", "model.gguf"))).toEqual([
      parakeet.pid,
    ]);
    // A path that only starts the same way is another model.
    expect(await findWorkerProcesses(binary, join(dir, "parakeet"))).toEqual([]);
    nemotron.kill("SIGKILL");
    parakeet.kill("SIGKILL");
    await Promise.all([exited(nemotron), exited(parakeet)]);
  });

  it("starts no second Nemotron worker while another process runs the speech binary on its model", async () => {
    const weights = join(dir, "model.gguf");
    writeFileSync(weights, "GGUF");
    const other = stray(binary, { weights });
    await sleep(200);
    const engine = createNemotronEngine({
      speechBinary: binary,
      artifact: {
        artifactId: NEMOTRON_ARTIFACT.artifactId,
        version: NEMOTRON_ARTIFACT.version,
        dir,
        path: weights,
        sizeBytes: 4,
        sha256: NEMOTRON_ARTIFACT.sha256,
        licenseId: NEMOTRON_ARTIFACT.license.id,
      },
    });
    const error = await engine.load().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EngineError);
    expect(error).toMatchObject({ code: "worker_running" });
    expect(engine.state()).toBe("absent");
    expect(engine.pid()).toBeUndefined();
    expect(await findWorkerProcesses(binary)).toEqual([other.pid]);
  });
});
