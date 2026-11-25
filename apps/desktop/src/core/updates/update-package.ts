import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, rename } from "node:fs/promises";
import { basename, join } from "node:path";
import type { UpdateProblem } from "@sondine/api";
import { UPDATE_BUNDLE_ID, UPDATE_REQUIREMENT } from "../../shared/update-requirement";
import { isNewer } from "../../shared/updates";

// What core checks of a downloaded update before main may install it (ADR
// 045), with the tools macOS ships: the archive holds one Sondine.app, signed
// by Sondine's developer under the same identifier (nested code included),
// notarized by Apple, of the version announced, later than this one, for this
// macOS. Run when the archive arrives and again right before the install.

export const UPDATE_APP_NAME = "Sondine.app";

export class UpdateRefusal extends Error {
  override readonly name = "UpdateRefusal";
  constructor(
    readonly problem: Extract<
      UpdateProblem,
      "corrupt" | "signature" | "notarization" | "macos" | "version" | "disk_full"
    >,
    detail: string,
  ) {
    super(detail.slice(0, 500));
  }
}

export type RunTool = (
  tool: string,
  args: readonly string[],
  signal?: AbortSignal,
) => Promise<{ readonly ok: boolean; readonly output: string }>;

const TOOL_TIMEOUT_MS = 5 * 60_000;

export const runTool: RunTool = (tool, args, signal) =>
  new Promise((resolve) => {
    execFile(
      tool,
      [...args],
      {
        timeout: TOOL_TIMEOUT_MS,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        // Messages are read by no one but the log.
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" },
        ...(signal === undefined ? {} : { signal }),
      },
      (error, stdout, stderr) =>
        resolve({ ok: error === null, output: error === null ? stdout : `${stdout}${stderr}` }),
    );
  });

/**
 * Deletes a folder with an app in it. Not `fs.rm`: Electron's `fs` takes the
 * `.asar` archives of the app for folders, and leaves them.
 */
export async function removeTree(path: string): Promise<void> {
  const removed = await runTool("/bin/rm", ["-rf", path]);
  if (!removed.ok) throw new Error(`could not delete ${basename(path)}`);
}

export interface Expected {
  readonly version: string;
  /** This app's version. */
  readonly current: string;
  /** This Mac's macOS. */
  readonly macosVersion: string;
  /** Off in a test build only: what it installs was never sent to Apple. */
  readonly notarized: boolean;
}

/** Whether macOS `version` opens an app that asks for `minimum`. */
export function macosAtLeast(version: string, minimum: string): boolean {
  return version === minimum || !isNewer(minimum, version);
}

const value = (info: Record<string, unknown>, key: string) => {
  const found = info[key];
  return typeof found === "string" ? found : "";
};

/** Throws `UpdateRefusal` unless `app` is the update expected. */
export async function verifyUpdateApp(
  app: string,
  expected: Expected,
  run: RunTool = runTool,
  signal?: AbortSignal,
): Promise<void> {
  if (!(await lstat(app)).isDirectory()) throw new UpdateRefusal("corrupt", "no app");
  const signed = await run(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", `-R=${UPDATE_REQUIREMENT}`, app],
    signal,
  );
  signal?.throwIfAborted();
  if (!signed.ok) throw new UpdateRefusal("signature", signed.output);
  if (expected.notarized) {
    // The ticket stapled to every release: no request, unlike `--check-notarization`.
    const notarized = await run("/usr/bin/codesign", ["--verify", "-R=notarized", app], signal);
    signal?.throwIfAborted();
    if (!notarized.ok) throw new UpdateRefusal("notarization", notarized.output);
  }
  const plist = await run(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", join(app, "Contents", "Info.plist")],
    signal,
  );
  signal?.throwIfAborted();
  const info = plist.ok ? jsonRecord(plist.output) : null;
  if (info === null) throw new UpdateRefusal("corrupt", "no readable Info.plist");
  if (value(info, "CFBundleIdentifier") !== UPDATE_BUNDLE_ID) {
    throw new UpdateRefusal("signature", "another app");
  }
  const version = value(info, "CFBundleShortVersionString");
  if (version !== expected.version || !isNewer(version, expected.current)) {
    throw new UpdateRefusal("version", `version ${version.slice(0, 40)}`);
  }
  if (!macosAtLeast(expected.macosVersion, value(info, "LSMinimumSystemVersion"))) {
    throw new UpdateRefusal("macos", value(info, "LSMinimumSystemVersion").slice(0, 40));
  }
}

function jsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? { ...parsed } : null;
  } catch {
    return null;
  }
}

/**
 * Unpacks `archive` in `dir` and checks what came out; returns the app, whose
 * folder is renamed into place last: an app under `ready` was checked whole.
 */
export async function unpackUpdate(
  archive: string,
  dir: string,
  expected: Expected,
  run: RunTool = runTool,
  signal?: AbortSignal,
): Promise<string> {
  const unpacking = join(dir, "unpacking");
  const ready = join(dir, "ready");
  await removeTree(unpacking);
  await mkdir(unpacking, { recursive: true, mode: 0o700 });
  try {
    const unpacked = await run("/usr/bin/ditto", ["-x", "-k", archive, unpacking], signal);
    signal?.throwIfAborted();
    if (!unpacked.ok) {
      throw new UpdateRefusal(
        /No space left on device/u.test(unpacked.output) ? "disk_full" : "corrupt",
        unpacked.output,
      );
    }
    const names = await readdir(unpacking);
    if (names.length !== 1 || names[0] !== UPDATE_APP_NAME) {
      throw new UpdateRefusal("corrupt", "the archive is not one Sondine.app");
    }
    await verifyUpdateApp(join(unpacking, UPDATE_APP_NAME), expected, run, signal);
    await removeTree(ready);
    await rename(unpacking, ready);
  } catch (error) {
    await removeTree(unpacking);
    throw error;
  }
  return join(ready, UPDATE_APP_NAME);
}
