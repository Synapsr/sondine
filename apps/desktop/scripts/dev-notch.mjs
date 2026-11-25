// `pnpm dev:notch`: the notch lab (src/main/notch-lab.ts), in a development
// app that touches nothing of the user's: throwaway data, fake audio hardware,
// its own folder for native messaging manifests (ADR 023). Builds the notch helper first, in
// its debug build, which can move slower.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const desktop = resolve(import.meta.dirname, "..");
const run = (command, args, cwd) => {
  const { status } = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (status !== 0) process.exit(status ?? 1);
};

run("swift", ["build", "--product", "sondine-notch"], resolve(desktop, "../../native"));
run("swift", ["build", "--product", "sondine-audio"], resolve(desktop, "../../native"));
run(process.execPath, ["scripts/compile-messages.mjs"], desktop);

const data = mkdtempSync(join(tmpdir(), "sondine-notch-"));
const hosts = join(data, "native-hosts");
mkdirSync(hosts);
const env = {
  ...process.env,
  SONDINE_HELPER_HAL: "fake",
  SONDINE_DATA_DIR: data,
  SONDINE_NATIVE_HOSTS_DIR: hosts,
  SONDINE_OPEN_PATH: "/notch-lab",
  VITE_SONDINE_NO_EDITOR: "1",
};
delete env.ELECTRON_RUN_AS_NODE;
const app = spawn(join(desktop, "node_modules/.bin/electron-vite"), ["dev"], {
  cwd: desktop,
  env,
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => app.kill(signal));
app.on("exit", (code) => {
  rmSync(data, { recursive: true, force: true });
  process.exit(code ?? 0);
});
