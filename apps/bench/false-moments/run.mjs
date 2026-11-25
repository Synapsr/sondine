#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, realpath, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const options = new Map();
let skipCheck = false;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--skip-check") {
    skipCheck = true;
    continue;
  }
  if (!["--cache", "--output", "--seed"].includes(arg) || !process.argv[i + 1])
    throw new Error(`Unknown or incomplete option ${arg}`);
  options.set(arg, process.argv[++i]);
}
const seed = Number(options.get("--seed") ?? 20261106);
if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
  throw new Error("Seed must be uint32");
if (process.platform !== "darwin") throw new Error("This benchmark requires the macOS file helper");
const cache = resolve(
  options.get("--cache") ?? join(homedir(), "Library/Caches/sondine-false-moments"),
);
await mkdir(cache, { recursive: true });
const within = (parent, child) => {
  const part = relative(parent, child);
  return part === "" || (!part.startsWith("..") && !isAbsolute(part));
};
if (within(await realpath(root), await realpath(cache)))
  throw new Error("Audio cache must be outside the repository");
const output = resolve(
  options.get("--output") ??
    join(
      root,
      "bench/results/local",
      `false-moments-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`,
    ),
);
if (within(root, output) && !within(join(root, "bench/results"), output))
  throw new Error("In-repository output belongs under bench/results");
try {
  await access(join(output, "results.json"));
  throw new Error("Result already exists; choose a new output directory");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await mkdir(output, { recursive: true });
const children = new Set();
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    for (const child of children) {
      if (child.pid) {
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
    }
    process.exitCode = 130;
  });
async function run(command, args, env = process.env) {
  console.log(`> ${command} ${args.join(" ")}`);
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit", detached: true });
    children.add(child);
    child.once("error", (error) => {
      children.delete(child);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      children.delete(child);
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} failed (${code ?? signal})`));
    });
  });
}
try {
  await access(join(root, "node_modules/.bin/oxlint"));
} catch {
  await run("pnpm", ["install", "--frozen-lockfile"]);
}
await run("ffmpeg", ["-version"]);
await run("git", ["diff", "--exit-code", "HEAD", "--", "native", "packages", "apps/desktop"]);
const build = join(cache, "swift-build");
await run("swift", [
  "build",
  "--package-path",
  join(root, "native"),
  "--scratch-path",
  build,
  "-c",
  "release",
  "--product",
  "sondine-audio",
]);
await run("bash", [join(root, "native/scripts/fetch-models.sh"), join(cache, "models")]);
const config = {
  root,
  cache,
  output,
  helper: join(build, "release/sondine-audio"),
  model: join(cache, "models/silero-vad/silero_vad.onnx"),
  seed,
};
const configPath = join(output, "run-config.json");
await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
await run("pnpm", [
  "--filter",
  "@sondine/bench",
  "exec",
  "tsc",
  "--noEmit",
  "-p",
  "false-moments/tsconfig.json",
]);
await run(
  "pnpm",
  [
    "--filter",
    "@sondine/bench",
    "exec",
    "vitest",
    "run",
    "false-moments/execute.test.ts",
    "--maxWorkers",
    "1",
    "--no-file-parallelism",
  ],
  { ...process.env, SONDINE_FALSE_MOMENTS_CONFIG: configPath },
);
if (!skipCheck) {
  await run("pnpm", ["--filter", "@sondine/desktop", "messages"]);
  await run("pnpm", ["check"]);
}
const result = JSON.parse(await readFile(join(output, "results.json"), "utf8"));
console.log(`${result.measurements.length} measurements. Report: ${join(output, "rapport-fr.md")}`);
