import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";

// Processes of the assistant CLIs (ADR 027): found on the login shell's PATH,
// started with an allowlisted environment in a process group of their own,
// and read as JSON lines. A CLI exits when its input closes, so a core that
// dies leaves none running; `stopGroup` ends the group (MCP relays included).

/** Variables a CLI gets from Sondine's own environment. */
const INHERITED = ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "SHELL"] as const;
/** Variables taken from the login shell, where the user exports them. */
const FROM_LOGIN = ["PATH", "LANG", "CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const;
/** Where installers put the CLIs, after the login shell's own PATH. */
const KNOWN_DIRECTORIES = [
  "~/.local/bin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "~/.npm-global/bin",
];

/** A login shell (`-lc`): about 4 s on Téo's Mac. An interactive one also reads `.zshrc` (21 s there). */
const LOGIN_TIMEOUT_MS = 10_000;
const MARKER = "__sondine_login_environment__";

export type Environment = Readonly<Record<string, string>>;

/** The login shell's values of `FROM_LOGIN`, or none when it cannot be asked in time. */
export async function readLoginShell(
  shell: string,
  options: { readonly interactive?: boolean; readonly timeoutMs?: number } = {},
): Promise<Record<string, string>> {
  const timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS;
  // POSIX parameter expansion: zsh and bash read it the same way.
  const script = `printf '%s' '${MARKER}'; printf '%s\\0' ${FROM_LOGIN.map((name) => `"${name}=\${${name}-}"`).join(" ")}; printf '%s' '${MARKER}'`;
  return await new Promise((resolve) => {
    const child = spawn(shell, [options.interactive === true ? "-ilc" : "-lc", script], {
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (values: Record<string, string>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(values);
    };
    const timer = setTimeout(() => {
      stopGroup(child.pid, "SIGKILL");
      finish({});
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => finish({}));
    child.on("close", () => finish(parseLoginOutput(Buffer.concat(chunks).toString("utf8"))));
  });
}

export function parseLoginOutput(output: string): Record<string, string> {
  const start = output.indexOf(MARKER);
  const end = output.lastIndexOf(MARKER);
  if (start === -1 || end <= start) return {};
  const values: Record<string, string> = {};
  for (const entry of output.slice(start + MARKER.length, end).split("\0")) {
    const equals = entry.indexOf("=");
    if (equals <= 0) continue;
    const name = entry.slice(0, equals);
    const value = entry.slice(equals + 1);
    if ((FROM_LOGIN as readonly string[]).includes(name) && value !== "") values[name] = value;
  }
  return values;
}

/**
 * The environment the CLIs get: a few of Sondine's variables, the login
 * shell's PATH and provider folders, and the known install folders. Never an
 * API key, so a subscription is what gets used.
 */
export function assistantEnvironment(
  inherited: NodeJS.ProcessEnv,
  login: Readonly<Record<string, string>>,
): Environment {
  const env: Record<string, string> = {};
  for (const name of INHERITED) {
    const value = inherited[name];
    if (value !== undefined && value !== "") env[name] = value;
  }
  for (const [name, value] of Object.entries(login)) env[name] = value;
  const home = env["HOME"] ?? "";
  const paths = [
    ...(login["PATH"] ?? "").split(delimiter),
    ...(inherited["PATH"] ?? "").split(delimiter),
    ...KNOWN_DIRECTORIES.map((directory) => directory.replace(/^~(?=\/)/u, home)),
  ].filter((entry) => entry.startsWith("/"));
  env["PATH"] = [...new Set(paths)].join(delimiter);
  return env;
}

/** The first executable file named `name` on `PATH`, or null. */
export async function findExecutable(name: string, env: Environment): Promise<string | null> {
  for (const directory of (env["PATH"] ?? "").split(delimiter)) {
    if (!directory.startsWith("/")) continue;
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Not here.
    }
  }
  return null;
}

/** Starts a CLI in its own process group, with exactly `env`. */
export function startProcess(
  command: string,
  args: readonly string[],
  options: { readonly env: Environment; readonly cwd?: string },
): ChildProcessWithoutNullStreams {
  return spawn(command, [...args], {
    cwd: options.cwd,
    env: { ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
}

/** Signals a process group; a group already gone is fine. */
export function stopGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // Already exited.
  }
}

/** Closes a CLI's input, then ends its group: SIGTERM, and SIGKILL after `graceMs`. */
export async function endProcess(
  child: ChildProcessWithoutNullStreams,
  graceMs = 2_000,
): Promise<void> {
  // A spawn that failed has no pid and never exits.
  if (child.pid === undefined) return;
  if (child.exitCode !== null || child.signalCode !== null) {
    stopGroup(child.pid, "SIGKILL");
    return;
  }
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.stdin.end();
  stopGroup(child.pid, "SIGTERM");
  const timer = setTimeout(() => stopGroup(child.pid, "SIGKILL"), graceMs);
  await exited;
  clearTimeout(timer);
  // Grandchildren (an MCP relay) may outlive their parent by a moment.
  stopGroup(child.pid, "SIGKILL");
}

/** The longest line a CLI may send: a tool result can carry a 5 MiB file as base64. */
export const MAX_LINE_CHARS = 32 * 1024 * 1024;

/** Splits a stream into lines and hands each parsed JSON object to `onMessage`. */
export function readJsonLines(
  stream: NodeJS.ReadableStream,
  onMessage: (message: Record<string, unknown>) => void,
  onInvalid: (reason: "not-json" | "too-long") => void,
): void {
  let buffered = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffered += chunk;
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line !== "") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          parsed = undefined;
        }
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          onMessage(parsed as Record<string, unknown>);
        } else onInvalid("not-json");
      }
      newline = buffered.indexOf("\n");
    }
    if (buffered.length > MAX_LINE_CHARS) {
      buffered = "";
      onInvalid("too-long");
    }
  });
}

/** Keeps the last bytes of stderr, for logs only (it can hold private text). */
export function stderrTail(stream: NodeJS.ReadableStream, limit = 4_096): () => string {
  let tail = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    tail = (tail + chunk).slice(-limit);
  });
  return () => tail;
}

/** A small typed view of untrusted JSON. */
export const field = {
  string(value: unknown, key: string): string | null {
    if (typeof value !== "object" || value === null) return null;
    const found = (value as Record<string, unknown>)[key];
    return typeof found === "string" ? found : null;
  },
  object(value: unknown, key: string): Record<string, unknown> | null {
    if (typeof value !== "object" || value === null) return null;
    const found = (value as Record<string, unknown>)[key];
    return typeof found === "object" && found !== null && !Array.isArray(found)
      ? (found as Record<string, unknown>)
      : null;
  },
  array(value: unknown, key: string): unknown[] {
    if (typeof value !== "object" || value === null) return [];
    const found = (value as Record<string, unknown>)[key];
    return Array.isArray(found) ? found : [];
  },
  number(value: unknown, key: string): number | null {
    if (typeof value !== "object" || value === null) return null;
    const found = (value as Record<string, unknown>)[key];
    return typeof found === "number" ? found : null;
  },
  boolean(value: unknown, key: string): boolean | null {
    if (typeof value !== "object" || value === null) return null;
    const found = (value as Record<string, unknown>)[key];
    return typeof found === "boolean" ? found : null;
  },
};

export interface Located {
  readonly executable: string | null;
  readonly env: Environment;
}

/**
 * Finds the CLIs once and remembers: the login shell (`-lc`) first; when one
 * of `names` is not on its PATH, the interactive shell (`-ilc`), which also
 * reads `.zshrc`. `refresh` forgets, for a CLI installed meanwhile.
 */
export function makeLocator(options: {
  readonly names: readonly string[];
  readonly inherited: NodeJS.ProcessEnv;
  readonly shell?: string;
  readonly readShell?: typeof readLoginShell;
}) {
  const read = options.readShell ?? readLoginShell;
  const shell = options.shell ?? options.inherited["SHELL"] ?? "/bin/zsh";
  let resolved: Promise<{ env: Environment; found: Map<string, string | null> }> | null = null;
  const findAll = async (env: Environment) =>
    new Map(
      await Promise.all(
        options.names.map(async (name) => [name, await findExecutable(name, env)] as const),
      ),
    );
  const resolve = async () => {
    let env = assistantEnvironment(options.inherited, await read(shell));
    let found = await findAll(env);
    if ([...found.values()].some((path) => path === null)) {
      env = assistantEnvironment(
        options.inherited,
        await read(shell, { interactive: true, timeoutMs: 30_000 }),
      );
      found = await findAll(env);
    }
    return { env, found };
  };
  return {
    async locate(name: string): Promise<Located> {
      resolved ??= resolve();
      const { env, found } = await resolved;
      return { executable: found.get(name) ?? null, env };
    },
    refresh() {
      resolved = null;
    },
  };
}
