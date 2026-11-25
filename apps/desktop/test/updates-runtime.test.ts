import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { MessageChannel } from "node:worker_threads";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import type { AppClient, UpdatesStatus } from "@sondine/api";
import { Effect, SubscriptionRef } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { SystemSignals } from "../src/core/analysis/analysis-layer";
import { Listening } from "../src/core/listening";
import { RpcHost } from "../src/core/rpc-host";
import { makeCoreRuntime } from "../src/core/runtime";
import { CoreState } from "../src/core/status/core-state";
import { runTool, type RunTool } from "../src/core/updates/update-package";
import { Updates } from "../src/core/updates/updates-layer";
import type { CoreToMain } from "../src/shared/core-messages";
import { updateArchiveName } from "../src/shared/updates";
import { startFakeHelper } from "./fake-helper/fake-helper";
import { captureOptions, tempDataDir, waitUntil } from "./support";

// Updates (ADR 045) through the real core: the real request, download and
// archive, against a server of this Mac; only codesign's answer is given.

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** A zip of a Sondine.app `version`, padded so that a download can be cut. */
function archiveOf(dir: string, version: string): Buffer {
  const tree = join(dir, `tree-${version}`);
  const contents = join(tree, "Sondine.app", "Contents");
  mkdirSync(contents, { recursive: true });
  writeFileSync(
    join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>app.sondine</string><key>CFBundleShortVersionString</key><string>${version}</string><key>LSMinimumSystemVersion</key><string>27.0</string></dict></plist>`,
  );
  writeFileSync(join(contents, "payload"), randomBytes(1_000_000));
  const zip = join(dir, `${version}.zip`);
  execFileSync("ditto", ["-c", "-k", "--keepParent", join(tree, "Sondine.app"), zip]);
  return readFileSync(zip);
}

interface Server {
  version: string;
  bytes: Buffer;
  sha256: string | null;
  /** Cuts the next archive after this many bytes. */
  cutAt: number | null;
  readonly requests: { url: string; headers: IncomingHttpHeaders }[];
}

async function setup(
  options: { readonly signed?: boolean; readonly version?: string; readonly macos?: string } = {},
) {
  const data = tempDataDir();
  cleanups.push(() => data.cleanup());
  const version = options.version ?? "0.8.0";
  const state: Server = {
    version,
    bytes: archiveOf(data.dir, version),
    sha256: null,
    cutAt: null,
    requests: [],
  };
  const http = createServer((req, res) => {
    state.requests.push({ url: req.url ?? "", headers: req.headers });
    if (req.url === "/sondine-mac.json") {
      res.end(
        JSON.stringify({
          format: "sondine-update",
          formatVersion: 1,
          version: state.version,
          minimumMacos: options.macos ?? "27.0",
          archive: {
            sizeBytes: state.bytes.byteLength,
            sha256: state.sha256 ?? createHash("sha256").update(state.bytes).digest("hex"),
          },
        }),
      );
      return;
    }
    const start = Number(/^bytes=(\d+)-$/u.exec(req.headers.range ?? "")?.[1] ?? 0);
    const total = state.bytes.byteLength;
    res.writeHead(start > 0 ? 206 : 200, {
      etag: '"one"',
      "content-length": total - start,
      ...(start > 0 ? { "content-range": `bytes ${start}-${total - 1}/${total}` } : {}),
    });
    if (state.cutAt !== null) {
      const cut = state.cutAt;
      state.cutAt = null;
      res.write(state.bytes.subarray(start, cut));
      setTimeout(() => res.destroy(), 200);
    } else res.end(state.bytes.subarray(start));
  });
  await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
  cleanups.push(() => new Promise<void>((done) => http.close(() => done())));
  const { port } = http.address() as AddressInfo;

  const fake = await startFakeHelper({ socketPath: data.socketPath, autoplay: null });
  cleanups.push(() => fake.close());
  const posted: CoreToMain[] = [];
  const codesign: RunTool = (tool, args, signal) =>
    tool === "/usr/bin/codesign"
      ? Promise.resolve({ ok: options.signed ?? true, output: "" })
      : runTool(tool, args, signal);
  const main = { network: "free" as "free" | "metered", idleSeconds: 0 };
  const start = async () => {
    const runtime = makeCoreRuntime(
      data.config({
        appVersion: "0.7.0",
        macosVersion: "27.0.1",
        updates: { blocked: null, testFeed: `http://127.0.0.1:${port}/sondine-mac.json` },
      }),
      {
        // Main's side: the network and the idle time, answered at once.
        post: (message) => {
          posted.push(message);
          if (message.type === "network-query") {
            answer(
              Effect.gen(function* () {
                (yield* Updates).receiveNetwork(main.network);
              }),
            );
          }
          if (message.type === "idle-query") {
            answer(
              Effect.gen(function* () {
                (yield* SystemSignals).receiveIdle({
                  idleSeconds: main.idleSeconds,
                  locked: false,
                  atMs: Date.now(),
                });
              }),
            );
          }
        },
      },
      { ...captureOptions(data), updates: { run: codesign, firstLookMs: 3_600_000 } },
    );
    // Core may be closing as main answers.
    const answer = (effect: Effect.Effect<void, never, Updates | SystemSignals>) =>
      void runtime.runPromise(effect).catch(() => undefined);
    // Main's first power snapshot, which the signals wait for.
    await runtime.runPromise(
      Effect.gen(function* () {
        yield* (yield* CoreState).update((status) => ({
          ...status,
          power: { onBattery: false, suspended: false, thermalState: "nominal" },
        }));
      }),
    );
    let stopped = false;
    const stop = async () => {
      if (!stopped) await runtime.dispose();
      stopped = true;
    };
    cleanups.push(stop);
    const host = await runtime.runPromise(RpcHost);
    const { port1, port2 } = new MessageChannel();
    host.attach(port1, "window-1");
    port2.start();
    cleanups.push(() => port2.close());
    const client: AppClient = createORPCClient(new RPCLink({ port: port2 }));
    const updates = (): Promise<UpdatesStatus> =>
      runtime.runPromise(
        Effect.gen(function* () {
          return (yield* SubscriptionRef.get((yield* CoreState).status)).updates;
        }),
      );
    const until = (phase: UpdatesStatus["phase"], problem: UpdatesStatus["problem"] = null) =>
      waitUntil(
        async () => {
          const status = await updates();
          return status.phase === phase && status.problem === problem && status.available !== null
            ? status
            : null;
        },
        { label: `${phase} ${problem ?? ""}` },
      );
    return { runtime, client, stop, updates, until };
  };
  const installs = () => posted.filter((message) => message.type === "install-update");
  return { data, state, main, start, installs };
}

describe.skipIf(process.platform !== "darwin")("updates through core", () => {
  it("nothing leaves without a yes, and a check downloads nothing", async () => {
    const { state, start, data } = await setup();
    const { client, updates } = await start();
    expect(state.requests).toEqual([]);
    await client.updates.check();
    expect(state.requests.map(({ url }) => url)).toEqual(["/sondine-mac.json"]);
    expect((await updates()).available?.version).toBe("0.8.0");
    expect(existsSync(join(data.dir, "updates"))).toBe(false);
  });

  it("downloads, checks, waits for an idle Mac, then hands over; nothing but the file is asked", async () => {
    const { state, main, start, installs, data } = await setup();
    const { client, until, updates } = await start();
    await client.updates.setAutomatic({ automatic: true });
    await until("ready");
    await waitUntil(async () => (await updates()).waitingFor.join() === "in-use");
    expect(state.requests.map(({ url }) => url)).toEqual([
      "/sondine-mac.json",
      `/${updateArchiveName("0.8.0")}`,
    ]);
    for (const { headers } of state.requests) {
      const { host: _host, connection: _connection, ...sent } = headers;
      expect(sent["user-agent"]).toBe("Sondine");
      expect(Object.keys(sent).toSorted()).toEqual([
        "accept",
        "accept-encoding",
        "accept-language",
        "sec-fetch-mode",
        "user-agent",
      ]);
      expect(sent["accept-language"]).toBe("*");
    }
    expect(installs()).toEqual([]);
    // « Redémarrer et mettre à jour »: no idle wait.
    main.idleSeconds = 0;
    await client.updates.install();
    await waitUntil(() => installs().length > 0, { label: "install" });
    const [install] = installs();
    if (install?.type !== "install-update") throw new Error("no install");
    expect(install.version).toBe("0.8.0");
    expect(install.app.startsWith(join(data.dir, "updates"))).toBe(true);
    expect(existsSync(join(install.app, "Contents", "Info.plist"))).toBe(true);
  });

  it("resumes a cut download where it stopped, after a relaunch", async () => {
    const { state, start } = await setup();
    state.cutAt = 60_000;
    const first = await start();
    await first.client.updates.setAutomatic({ automatic: true });
    await first.until("idle", "network");
    await first.stop();
    const second = await start();
    await second.client.updates.check();
    await second.until("ready");
    const ranges = state.requests.filter(({ url }) => url !== "/sondine-mac.json");
    expect(ranges).toHaveLength(2);
    expect(ranges[1]?.headers.range).toMatch(/^bytes=[1-9]\d*-$/u);
  });

  it.each([
    ["a wrong hash", { sha256: "0".repeat(64) }, {}, "corrupt"],
    ["another signature", {}, { signed: false }, "signature"],
    ["a later macOS", {}, { macos: "28.0" }, "macos"],
  ] as const)("installs nothing with %s", async (_, server, options, problem) => {
    const { state, start, installs, data } = await setup(options);
    Object.assign(state, server);
    const { client, until } = await start();
    await client.updates.setAutomatic({ automatic: true });
    await until("idle", problem);
    expect(installs()).toEqual([]);
    expect(existsSync(join(data.dir, "updates", "ready"))).toBe(false);
  });

  it("never offers an older version", async () => {
    const { start, state } = await setup({ version: "0.6.0" });
    const { client, updates } = await start();
    await client.updates.setAutomatic({ automatic: true });
    await waitUntil(async () => (await updates()).checkedAtMs, { label: "checked" });
    expect((await updates()).available).toBeNull();
    expect(state.requests).toHaveLength(1);
  });

  it("leaves the listening intent alone, a timed pause included", async () => {
    const { main, start, installs } = await setup();
    const { client, until, runtime } = await start();
    const untilMs = Date.now() + 3_600_000;
    await client.listening.pause({ scope: "all", untilMs });
    const intent = () =>
      runtime.runPromise(
        Effect.gen(function* () {
          return yield* (yield* Listening).intent;
        }),
      );
    const before = await intent();
    await client.updates.setAutomatic({ automatic: true });
    await until("ready");
    main.idleSeconds = 900;
    await client.updates.install();
    await waitUntil(() => installs().length > 0, { label: "install" });
    expect(await intent()).toEqual(before);
  });
});
