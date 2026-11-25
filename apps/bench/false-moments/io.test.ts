import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { acquire, command, sha256 } from "./io.ts";

function stopOwnedProcess(pid: number | undefined) {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

it("kills its own grandchild when a wrapper exceeds its deadline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sondine-bench-timeout-"));
  const pidFile = join(dir, "child.pid");
  let descendant: number | undefined;
  try {
    await expect(
      command(
        process.execPath,
        [
          "-e",
          `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync(process.argv[1],String(child.pid)); setInterval(()=>{},1000);`,
          pidFile,
        ],
        500,
      ),
    ).rejects.toThrow("stopped or timed out");
    descendant = Number(await readFile(pidFile, "utf8"));
    let alive = true;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        process.kill(descendant, 0);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") {
          alive = false;
          break;
        }
        throw error;
      }
      await delay(10);
    }
    expect(alive).toBe(false);
  } finally {
    stopOwnedProcess(descendant);
    await rm(dir, { recursive: true, force: true });
  }
});

it("uses a verified cached object offline and refuses a corrupted object", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sondine-bench-cache-"));
  try {
    await mkdir(join(dir, "objects"));
    const hash = sha256("fixture");
    const destination = join(dir, "objects", hash);
    await writeFile(destination, "fixture");
    expect(await acquire("https://invalid.example/not-requested", hash, dir)).toBe(destination);
    await writeFile(destination, "changed");
    await expect(acquire("https://invalid.example/not-requested", hash, dir)).rejects.toThrow(
      "Corrupt cached object",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
