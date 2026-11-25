// One WXT build for the tests (global-setup.ts), in a plain Node process:
// loaded through Vitest's module runner, WXT fails to transform its own
// config (« code.charCodeAt is not a function »).
//
// Usage: node test/build-extension.ts <out-dir> <name> <browser> <mode>

import { fileURLToPath } from "node:url";
import { build, type Logger } from "wxt";

const [outDir, name, browser, mode] = process.argv.slice(2);
if (outDir === undefined || name === undefined || browser === undefined || mode === undefined) {
  throw new Error("usage: build-extension.ts <out-dir> <name> <browser> <mode>");
}

/** WXT's progress stays quiet; its warnings and errors still show. */
const logger: Logger = {
  debug: () => undefined,
  log: () => undefined,
  info: () => undefined,
  success: () => undefined,
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
  fatal: (...args: unknown[]) => console.error(...args),
  level: 3,
};

await build({
  root: fileURLToPath(new URL("..", import.meta.url)),
  outDir,
  outDirTemplate: name,
  browser,
  mode,
  logger,
});
