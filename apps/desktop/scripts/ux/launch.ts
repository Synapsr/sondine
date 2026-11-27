// Starts the app on a development data folder with fake audio hardware and
// connects to its window over the DevTools protocol, for the redesign's
// captures (shots.ts) and measurements (transcript-perf.ts). Nothing touches
// the user's data folder or real hardware.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { connect, type Page } from "./cdp.ts";

export const app = resolve(import.meta.dirname, "../..");

export interface Launched {
  readonly page: Page;
  /** Stops the app and waits for it (core may hold its files a moment longer). */
  stop(): Promise<void>;
}

/**
 * The app on `data`, in the window's locale. `preview` runs the production
 * build (`electron-vite build` first), which is what users get; otherwise the
 * development server.
 */
export async function launch({
  data,
  locale = "fr",
  width = 1280,
  height = 820,
  preview = false,
  beforeLoad,
}: {
  readonly data: string;
  readonly locale?: string;
  readonly width?: number;
  readonly height?: number;
  readonly preview?: boolean;
  /** Script run in the window before its own on every load. */
  readonly beforeLoad?: string;
}): Promise<Launched> {
  await run("node", ["scripts/compile-messages.mjs"]);
  if (preview) await run("npx", ["electron-vite", "build"]);
  const port = 9300 + Math.floor(Math.random() * 600);
  // The Swift helper on fake hardware when it is built; otherwise the
  // protocol fake, which takes no --hal.
  const helperBuilt = existsSync(resolve(app, "../../native/.build/release/sondine-audio"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(helperBuilt ? { SONDINE_HELPER_HAL: "fake" } : { SONDINE_FAKE_HELPER: "1" }),
    SONDINE_DATA_DIR: data,
    VITE_SONDINE_NO_EDITOR: "1",
  };
  delete env["ELECTRON_RUN_AS_NODE"];
  // The production build runs as `electron .` on `out/`, without a development server.
  const child = spawn(
    "npx",
    preview
      ? ["electron", ".", `--remote-debugging-port=${port}`]
      : ["electron-vite", "dev", "--remoteDebuggingPort", String(port)],
    { cwd: app, env, detached: true, stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-4000)));
  const stop = async () => {
    const exited = new Promise((done) => child.once("exit", done));
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
    } catch {
      // Gone already.
    }
    await Promise.race([exited, sleep(10_000)]);
    await sleep(1000);
  };
  try {
    const page = await connect(port, 90_000);
    if (beforeLoad !== undefined) await page.beforeLoad(beforeLoad);
    await page.size(width, height);
    await page.waitFor("document.querySelector('main, #welcome-title') !== null", 60_000);
    await page.eval(
      `localStorage.setItem("sondine.locale", ${JSON.stringify(locale)}); location.reload()`,
    );
    await sleep(500);
    await page.waitFor("document.querySelector('main, #welcome-title') !== null", 30_000);
    return { page, stop };
  } catch (error) {
    console.error(stderr);
    await stop();
    throw error;
  }
}

export function run(command: string, args: readonly string[]): Promise<string> {
  return new Promise((done, fail) => {
    const p = spawn(command, args, { cwd: app, stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    p.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    p.on("exit", (code) =>
      code === 0 ? done(out) : fail(new Error(`${command} ${args.join(" ")} exited ${code}`)),
    );
  });
}
