import { describe, expect, it } from "vitest";
import { discoverProcesses } from "../src/budget/discovery.ts";
import type { ListedProcess } from "../src/meter/meter-schema.ts";

const app = "/Applications/Sondine.app/Contents";

function listed(
  pid: number,
  ppid: number,
  path: string | null,
  args: string[] | null = null,
  uid = 501,
): ListedProcess {
  const name = path === null ? "unknown" : (path.split("/").at(-1) ?? "");
  return {
    pid,
    ppid,
    uid,
    startUs: pid * 10,
    name,
    path,
    access: uid === 501 ? "rusage" : "setuid-tools",
    arguments: args,
  };
}

const helper = `${app}/Frameworks/Sondine Helper.app/Contents/MacOS/Sondine Helper`;

const snapshot: ListedProcess[] = [
  listed(1, 0, "/sbin/launchd", null, 0),
  listed(50, 1, "/usr/sbin/coreaudiod", null, 202),
  listed(100, 1, `${app}/MacOS/Sondine`),
  listed(101, 100, `${app}/Resources/bin/sondine-audio`),
  listed(
    102,
    100,
    `${app}/Frameworks/Sondine Helper (GPU).app/Contents/MacOS/Sondine Helper (GPU)`,
    ["x", "--type=gpu-process"],
  ),
  listed(103, 100, helper, [
    "x",
    "--type=utility",
    "--utility-sub-type=network.mojom.NetworkService",
  ]),
  listed(104, 100, helper, ["x", "--type=utility", "--utility-sub-type=node.mojom.NodeService"]),
  listed(105, 104, "/opt/engines/speech-server"),
  listed(300, 1, "/Applications/Safari.app/Contents/MacOS/Safari"),
];

describe("discoverProcesses", () => {
  it("assigns roles from the bundle path, Chromium flags and the process tree", () => {
    const discovery = discoverProcesses(snapshot, { appName: "Sondine" });
    expect(discovery.sondine.map((process) => [process.pid, process.role])).toEqual([
      [100, "main"],
      [101, "audio-helper"],
      [102, "gpu"],
      [103, "network-service"],
      [104, "core"],
      [105, "engine-worker"],
    ]);
    expect(discovery.coreaudiod).toMatchObject({ pid: 50, role: "coreaudiod" });
    expect(discovery.warnings).toEqual([
      "an engine worker is alive: let the queue drain (workers exit after 90 s idle); it is excluded from the total",
    ]);
  });

  it("finds the dev build under its Electron name and through Launch Services", () => {
    const dev = [
      listed(50, 1, "/usr/sbin/coreaudiod", null, 202),
      listed(400, 1, "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
    ];
    expect(
      discoverProcesses(dev, { appName: "Electron" }).sondine.map((process) => process.role),
    ).toEqual(["main"]);
    const renamed = [listed(401, 1, "/elsewhere/sondine-dev")];
    expect(
      discoverProcesses(renamed, { appName: "Sondine", bundleMainPids: [401] }).sondine.map(
        (process) => process.pid,
      ),
    ).toEqual([401]);
  });

  it("reports a machine where Sondine is not running", () => {
    const discovery = discoverProcesses(
      [listed(50, 1, "/usr/sbin/coreaudiod", null, 202), snapshot[8] as ListedProcess],
      { appName: "Sondine" },
    );
    expect(discovery.sondine).toEqual([]);
    expect(discovery.coreaudiod?.pid).toBe(50);
    expect(discovery.warnings).toContain("no Sondine main process found");
    expect(discovery.warnings).toContain("no sondine-audio process found");
  });

  it("warns about a window or MCP left open", () => {
    const extra = [
      ...snapshot.slice(0, 5),
      listed(
        106,
        100,
        `${app}/Frameworks/Sondine Helper (Renderer).app/Contents/MacOS/Sondine Helper (Renderer)`,
      ),
      listed(107, 104, `${app}/Resources/bin/sondine-mcp`),
    ];
    const { warnings } = discoverProcesses(extra, { appName: "Sondine" });
    expect(warnings.some((warning) => warning.startsWith("a window is open"))).toBe(true);
    expect(warnings.some((warning) => warning.startsWith("sondine-mcp is running"))).toBe(true);
    expect(warnings).toContain("no core utility process found");
  });
});
