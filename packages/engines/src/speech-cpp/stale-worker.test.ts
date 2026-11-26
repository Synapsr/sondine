import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { EngineError } from "../contract.ts";
import { NEMOTRON_ARTIFACT } from "../models/catalog.ts";
import { createNemotronEngine } from "../nemotron.ts";
import { findWorkerProcesses, stopWorkerProcesses } from "./stale-worker.ts";

// Processes whose `ps` comm reads a fake speech binary's path: Node started
// with that path as argv[0], the way the system reports the real worker.
// Each test waits until its strays have said they are ready and `ps` lists
// them: a loaded machine can take seconds for either, so no test counts on a
// delay, and each has time for slow `ps` calls.

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

/** A stray worker, once its handlers are in place and `ps` lists it under `argv0`. */
async function stray(
  argv0: string,
  options: { readonly ignoreTerm?: boolean; readonly weights?: string } = {},
): Promise<ChildProcess> {
  const script = `${options.ignoreTerm === true ? "process.on('SIGTERM', () => {});" : ""} process.stdout.write("ready"); setInterval(() => {}, 1000)`;
  const args = ["-e", script, "worker", options.weights ?? "model.gguf", "--device", "gpu"];
  const child = spawn(process.execPath, args, {
    argv0,
    stdio: ["ignore", "pipe", "ignore"],
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout?.once("data", () => resolve());
    child.once("exit", () => reject(new Error("the stray worker exited before it was ready")));
  });
  await expect.poll(() => findWorkerProcesses(argv0), { timeout: 20_000 }).toContain(child.pid);
  return child;
}

const exited = (child: ChildProcess) =>
  new Promise<NodeJS.Signals | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.signalCode);
    else child.once("exit", (_code, signal) => resolve(signal));
  });

describe("speech worker processes", { timeout: 60_000 }, () => {
  it("finds processes by their exact executable path, never by name", async () => {
    const ours = await stray(binary);
    const other = await stray(join(dir, "elsewhere", "speech"));
    const found = await findWorkerProcesses(binary);
    expect(found).toContain(ours.pid);
    expect(found).not.toContain(other.pid);
    expect(await findWorkerProcesses(join(dir, "speech"))).toEqual([]);
  });

  it("stops every one with SIGTERM, then SIGKILL after the deadline", async () => {
    const polite = await stray(binary);
    const stubborn = await stray(binary, { ignoreTerm: true });
    // Deadlines, not measures: the stubborn one waits them out whatever the machine.
    const report = await stopWorkerProcesses(binary, { termMs: 2_000, killMs: 10_000 });
    expect(report.survivors).toEqual([]);
    expect([...report.stopped].toSorted()).toEqual([polite.pid, stubborn.pid].toSorted());
    expect(await exited(polite)).toBe("SIGTERM");
    expect(await exited(stubborn)).toBe("SIGKILL");
    expect(await findWorkerProcesses(binary)).toEqual([]);
  });

  it("tells workers apart by the model they load", async () => {
    const nemotron = await stray(binary, { weights: join(dir, "nemotron dir", "model.gguf") });
    const parakeet = await stray(binary, { weights: join(dir, "parakeet dir", "model.gguf") });
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
    const other = await stray(binary, { weights });
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
