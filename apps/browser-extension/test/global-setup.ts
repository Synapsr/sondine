// Builds the extension with WXT once per test run, as `pnpm build` and
// `pnpm zip` do, into a temporary folder: the tests read and run what the
// browsers and the stores get.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";
import { STORE_MODE } from "../scripts/manifest.ts";

/** Each build lands in `<extensionBuilds>/<name>`. */
export const BUILDS = [
  // `pnpm build`: the unpacked extension Sondine ships.
  { name: "unpacked", browser: "chrome", mode: "production" },
  // What `pnpm zip` puts in the Chrome Web Store's zip.
  { name: "chromeStore", browser: "chrome", mode: STORE_MODE },
  // What `pnpm zip` puts in Firefox Add-ons' zip.
  { name: "firefoxStore", browser: "firefox", mode: STORE_MODE },
] as const;

export type BuildName = (typeof BUILDS)[number]["name"];

declare module "vitest" {
  export interface ProvidedContext {
    /** The folder holding the builds. */
    extensionBuilds: string;
  }
}

const buildScript = fileURLToPath(new URL("build-extension.ts", import.meta.url));

export default async function setup(project: TestProject): Promise<() => void> {
  const outDir = mkdtempSync(join(tmpdir(), "sondine-extension-test-"));
  const remove = () => rmSync(outDir, { recursive: true, force: true });
  try {
    for (const { name, browser, mode } of BUILDS) {
      execFileSync(process.execPath, [buildScript, outDir, name, browser, mode], {
        stdio: "inherit",
      });
    }
  } catch (error) {
    remove();
    throw error;
  }
  project.provide("extensionBuilds", outDir);
  return remove;
}
