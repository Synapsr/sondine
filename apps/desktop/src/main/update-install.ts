import { execFileSync, spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { UPDATE_REQUIREMENT } from "../shared/update-requirement";
import { isNewer, relaunchArgument, UPDATE_ACK_ARGUMENT, type Relaunch } from "../shared/updates";
import { UPDATE_APP_NAME } from "./update-target";

// Main's part of an update (ADR 045), once nothing would be cut: a small shell
// first, which waits for this process to go and opens the app again, behind
// the others unless it was in front; then Sondine's own processes stop, and
// the app core checked takes this app's place in one step.
// No Electron import, so it is unit-tested.

export interface UpdateRequest {
  readonly version: string;
  /** The app core checked. */
  readonly app: string;
}

/** Why main refuses what core asks; null when it may be installed. */
export function installRefusal(
  request: UpdateRequest,
  context: {
    readonly target: string | null;
    readonly current: string;
    /** The data directory's `updates` folder. */
    readonly updatesDirectory: string;
  },
): string | null {
  if (context.target === null) return "blocked";
  if (!isNewer(request.version, context.current)) return "not-newer";
  // Exactly `<updates>/<archive>/ready/Sondine.app`, with no link on the way.
  const inside = relative(context.updatesDirectory, request.app).split("/");
  if (
    inside.length !== 3 ||
    inside[0] === ".." ||
    inside[1] !== "ready" ||
    inside[2] !== UPDATE_APP_NAME
  ) {
    return "outside";
  }
  try {
    if (!lstatSync(request.app).isDirectory()) return "missing";
    const real = realpathSync(request.app);
    if (real !== join(realpathSync(context.updatesDirectory), ...inside)) return "outside";
  } catch {
    return "missing";
  }
  return null;
}

/** What the shell says when the new version does not start. */
export interface RelaunchTexts {
  readonly title: string;
  readonly body: string;
  readonly close: string;
  readonly open: string;
  /** The release's page. */
  readonly page: string;
}

// $1 this process, $2 the app, $3 how to open it, $4 its arguments' window, $5
// the acknowledgement's, $6 its file, $7… the texts. Started before Sondine
// stops: if main dies on the way, the app opens again all the same. The new
// version says itself that core runs; without it, the person is told, since
// nobody would see that Sondine is gone.
export const RELAUNCH_SCRIPT = `
n=0
while kill -0 "$1" 2>/dev/null && [ $n -lt 1200 ]; do sleep 0.1; n=$((n+1)); done
try=0
while [ $try -lt 3 ]; do
  if [ "$3" = front ]; then open "$2" --args "$4" "$5"; else open -g "$2" --args "$4" "$5"; fi
  n=0
  while [ $n -lt 240 ]; do
    if [ -e "$6" ]; then rm -f "$6"; exit 0; fi
    sleep 0.25
    n=$((n+1))
  done
  try=$((try+1))
done
osascript -e 'on run argv' \\
  -e 'set answer to display alert (item 1 of argv) message (item 2 of argv) as critical buttons {item 3 of argv, item 4 of argv} default button 2' \\
  -e 'if button returned of answer is (item 4 of argv) then return "open"' \\
  -e 'end run' "$7" "$8" "$9" "\${10}" | grep -q open && open "\${11}"
`;

export function relaunchCommand(
  pid: number,
  app: string,
  relaunch: Relaunch,
  ack: { readonly directory: string; readonly name: string },
  texts: RelaunchTexts,
): { readonly file: string; readonly args: readonly string[] } {
  return {
    file: "/bin/sh",
    args: [
      "-c",
      RELAUNCH_SCRIPT,
      "sondine-update",
      String(pid),
      app,
      relaunch.window === "front" ? "front" : "behind",
      relaunchArgument(relaunch),
      `${UPDATE_ACK_ARGUMENT}${ack.name}`,
      join(ack.directory, ack.name),
      texts.title,
      texts.body,
      texts.close,
      texts.open,
      texts.page,
    ],
  };
}

/** Starts the shell, which outlives this process; false when it could not. */
export function startRelaunch(command: ReturnType<typeof relaunchCommand>): boolean {
  const child = spawn(command.file, [...command.args], {
    cwd: "/",
    detached: true,
    stdio: "ignore",
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: process.env.HOME,
      USER: process.env.USER,
      LANG: "en_US.UTF-8",
    },
  });
  child.once("error", () => undefined);
  child.unref();
  return child.pid !== undefined;
}

/**
 * Whether what is about to take this app's place is still signed as core
 * checked it: the last look, with nothing between it and the exchange.
 */
export function stillSigned(app: string): boolean {
  try {
    execFileSync(
      "/usr/bin/codesign",
      ["--verify", "--deep", "--strict", `-R=${UPDATE_REQUIREMENT}`, app],
      { timeout: 60_000, stdio: "ignore", env: { PATH: "/usr/bin:/bin", LANG: "C" } },
    );
    return true;
  } catch {
    return false;
  }
}
