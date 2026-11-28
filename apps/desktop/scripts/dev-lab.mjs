// `pnpm dev:lab`: the flow lab (ADR 049), a development app that touches
// nothing of the user's and reaches no network. Its folder,
// `~/.sondine-flow-lab` (short: macOS limits a socket's path to 103 bytes, and
// a worktree's is long) or SONDINE_FLOW_LAB_ROOT, holds its data, a home of its own (models, agents'
// settings, browsers' manifests), the fake Cloud's state and a fake `claude`.
// The HUD (⌃⌥⌘L) moves between the journeys' steps.
//
//   pnpm --filter @sondine/desktop dev:lab [--fresh]
//
// `--fresh` empties the folder first. SONDINE_LAB_DEBUG_PORT opens the
// window's DevTools protocol on that port (for the captures).
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const desktop = resolve(import.meta.dirname, "..");
const compute = resolve(desktop, "../compute");
const root = process.env.SONDINE_FLOW_LAB_ROOT ?? join(homedir(), ".sondine-flow-lab");
const run = (command, args, cwd) => {
  const { status } = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (status !== 0) process.exit(status ?? 1);
};

if (process.argv.includes("--fresh")) rmSync(root, { recursive: true, force: true });
for (const dir of ["data", "home", "bin", "cloud", "native-hosts"]) {
  mkdirSync(join(root, dir), { recursive: true });
}
const permissions = join(root, "permissions");
if (!existsSync(permissions)) writeFileSync(permissions, "ask");

// The engines' fake `claude`, run by this Node: the lab's agent, never the user's.
const claude = join(root, "bin", "claude");
const fakeClaude = resolve(desktop, "../../packages/engines/test/fake-claude.ts");
writeFileSync(claude, `#!/bin/sh\nexec "${process.execPath}" "${fakeClaude}" "$@"\n`);
chmodSync(claude, 0o755);

run(process.execPath, ["scripts/compile-messages.mjs"], desktop);
// The fake Cloud (apps/compute/scripts/fake-cloud.ts), built into one file as the server itself.
run(
  "npx",
  [
    "vite",
    "build",
    "--ssr",
    "scripts/fake-cloud.ts",
    "--outDir",
    join(root, "cloud-bin"),
    "--logLevel",
    "warn",
  ],
  compute,
);

const freePort = () =>
  new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });

const cloud = spawn(
  process.execPath,
  [
    join(root, "cloud-bin", "sondine-compute.js"),
    join(root, "cloud", "state"),
    String(await freePort()),
  ],
  { stdio: ["pipe", "pipe", "inherit"] },
);
const answers = createInterface({ input: cloud.stdout })[Symbol.asyncIterator]();
const first = await answers.next();
const [said, endpoint, key] = first.done === true ? [] : first.value.split(" ");
if (said !== "ready" || endpoint === undefined || key === undefined) {
  console.error(`[dev-lab] the fake Cloud did not start: ${first.value ?? "no answer"}`);
  cloud.kill();
  process.exit(1);
}

// Main sends the fake Cloud its scenarios through this socket, one a line,
// each answered in order.
const control = join(root, "cloud.sock");
rmSync(control, { force: true });
const waiting = [];
void (async () => {
  for await (const line of { [Symbol.asyncIterator]: () => answers }) {
    waiting.shift()?.write(`${line}\n`);
  }
})();
const server = createServer((socket) => {
  createInterface({ input: socket }).on("line", (line) => {
    if (line.trim() === "") return;
    waiting.push(socket);
    cloud.stdin.write(`${line.trim()}\n`);
  });
  socket.on("error", () => undefined);
});
server.listen(control);

const env = {
  ...process.env,
  HOME: join(root, "home"),
  SONDINE_DATA_DIR: join(root, "data"),
  SONDINE_NATIVE_HOSTS_DIR: join(root, "native-hosts"),
  SONDINE_FAKE_HELPER: "1",
  SONDINE_FAKE_PERMISSIONS_FILE: permissions,
  SONDINE_FLOW_LAB_DIR: root,
  // What the first core reaches, before the HUD puts its step back (core/flow-lab.ts).
  SONDINE_FLOW_LAB: JSON.stringify({
    cloud: { endpoint, key },
    offline: false,
    update: null,
    agent: { executable: claude, mode: "normal" },
  }),
  SONDINE_DEV_CLOUD: `${endpoint} ${key}`,
  SONDINE_DEV_NO_BROWSER: "1",
  SONDINE_UX_BACKUP_FILE: join(root, "backup.sondine"),
  VITE_SONDINE_NO_EDITOR: "1",
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.SONDINE_HELPER_HAL;
const debugPort = process.env.SONDINE_LAB_DEBUG_PORT;
const app = spawn(
  join(desktop, "node_modules/.bin/electron-vite"),
  ["dev", ...(debugPort === undefined ? [] : ["--remoteDebuggingPort", debugPort])],
  { cwd: desktop, env, stdio: "inherit" },
);
console.log(`[dev-lab] ${root}, fake Cloud ${endpoint}, pid ${process.pid}`);

const stop = () => {
  server.close();
  cloud.stdin.end();
  cloud.kill();
};
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => app.kill(signal));
app.on("exit", (code) => {
  stop();
  process.exit(code ?? 0);
});
