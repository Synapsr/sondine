import { accessSync, constants, existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root (three levels above this file: apps/bench/src). */
export const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

/** Git-ignored (root .gitignore: bench/results/local). */
export const defaultResultsDirectory = join(repoRoot, "bench", "results", "local");

/** pnpm runs package scripts from apps/bench; INIT_CWD keeps the caller's directory. */
export function userPath(path: string): string {
  if (isAbsolute(path)) return path;
  return resolve(process.env["INIT_CWD"] ?? process.cwd(), path);
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** --meter, then $SONDINE_METER, then the release and debug builds of native/. */
export function findMeter(explicit: string | undefined): string {
  if (explicit !== undefined) {
    const path = userPath(explicit);
    if (!isExecutable(path)) throw new Error(`--meter ${path} is not an executable`);
    return path;
  }
  const candidates = [
    process.env["SONDINE_METER"],
    join(repoRoot, "native", ".build", "release", "sondine-meter"),
    join(repoRoot, "native", ".build", "debug", "sondine-meter"),
  ].filter((candidate): candidate is string => candidate !== undefined && candidate !== "");
  const found = candidates.find((candidate) => existsSync(candidate) && isExecutable(candidate));
  if (found === undefined) {
    throw new Error(
      "sondine-meter not found: build it with `swift build -c release --product sondine-meter --package-path native`, or pass --meter",
    );
  }
  return found;
}
