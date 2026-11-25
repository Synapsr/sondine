import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { MessageChannel } from "node:worker_threads";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import type { AppClient } from "@sondine/api";
import { openDatabase, usageState } from "@sondine/db";
import { UsageReport } from "@sondine/protocol";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Database } from "../src/core/database";
import { RpcHost } from "../src/core/rpc-host";
import { makeCoreRuntime } from "../src/core/runtime";
import { startOfDay } from "../src/core/usage/usage-days";
import { UsageStatistics } from "../src/core/usage/usage-layer";
import { statsEndpoint } from "../src/shared/stats";
import { startFakeHelper } from "./fake-helper/fake-helper";
import { captureOptions, recordingMain, tempDataDir, waitUntil } from "./support";

// The anonymous statistics (ADR 042) through the real core: the window's own
// calls, the real request, and a server that records every request it gets.

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  vi.restoreAllMocks();
});

async function setup(options: { readonly endpoint?: boolean } = {}) {
  const requests: { method: string; url: string; headers: IncomingHttpHeaders; body: string }[] =
    [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
  const { port } = server.address() as AddressInfo;

  const data = tempDataDir();
  cleanups.push(() => data.cleanup());
  const fake = await startFakeHelper({ socketPath: data.socketPath, autoplay: null });
  cleanups.push(() => fake.close());
  let now = startOfDay("2026-11-24") + 10 * 3_600_000;
  const fetched = vi.spyOn(globalThis, "fetch");
  const runtime = makeCoreRuntime(
    data.config({
      appVersion: "0.7.0",
      statsEndpoint: options.endpoint === false ? null : `http://127.0.0.1:${port}/v1/report`,
    }),
    recordingMain(),
    { ...captureOptions(data), usage: { now: () => now, random: () => 0.5 } },
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
  const usage = await runtime.runPromise(UsageStatistics);
  const stored = () => runtime.runPromise(Effect.map(Database, (db) => usageState(db)));
  return {
    client,
    usage,
    stored,
    stop,
    data,
    requests,
    fetched,
    goTo: (day: string, hour: number) => {
      now = startOfDay(day) + hour * 3_600_000;
    },
  };
}

describe("anonymous statistics through core", () => {
  it.each([
    ["without an answer", null],
    ["after a no", false],
  ] as const)("%s, nothing is kept and no request leaves", async (_, answer) => {
    const { client, usage, stored, stop, data, requests, fetched, goTo } = await setup();
    if (answer !== null) await client.usage.setSharing({ share: answer });
    await client.usage.windowOpened();
    await client.usage.conversationOpened();
    await client.search.query({ text: "four" });
    await client.usage.processCrashed({ process: "renderer" });
    for (const day of ["2026-11-25", "2026-11-26", "2026-11-27"]) {
      goTo(day, 20);
      await usage.look();
    }
    expect(requests).toEqual([]);
    expect(fetched).not.toHaveBeenCalled();
    expect(await stored()).toBeNull();
    expect(await client.usage.get()).toEqual({
      answer: answer === null ? null : "no",
      sends: true,
      today: null,
      waiting: [],
    });
    await stop();
    const db = openDatabase(data.config().databasePath, { migrate: false });
    expect(usageState(db)).toBeNull();
    db.close();
  });

  it("after a yes, sends exactly the report shown, once, and nothing else", async () => {
    const { client, usage, requests, fetched, goTo } = await setup();
    await client.usage.setSharing({ share: true });
    await client.usage.windowOpened();
    await client.usage.conversationOpened();
    await client.search.query({ text: "une phrase dite" });
    await client.usage.processCrashed({ process: "renderer" });
    goTo("2026-11-25", 1);
    await usage.look();
    const [shown] = (await client.usage.get()).waiting;
    expect(requests).toEqual([]);
    goTo("2026-11-25", 13);
    await usage.look();
    await waitUntil(() => requests.length === 1, { label: "the report" });
    await usage.look();
    expect(requests).toHaveLength(1);
    expect(fetched).toHaveBeenCalledTimes(1);
    const [request] = requests;
    expect(request).toMatchObject({ method: "POST", url: "/v1/report" });
    expect(UsageReport.parse(JSON.parse(request?.body ?? ""))).toEqual(shown);
    expect(shown).toMatchObject({
      day: "2026-11-24",
      app: "0.7.0",
      macos: "27.0",
      actions: {
        desktop: { window_opened: 1, conversation_opened: 1, transcripts_searched: 1 },
      },
      errors: { renderer_crashed: 1 },
    });
    expect(request?.body).not.toContain("phrase");
    expect(request?.headers["user-agent"]).toBe("Sondine");
    for (const header of ["cookie", "referer", "origin", "authorization", "x-forwarded-for"]) {
      expect(request?.headers, header).not.toHaveProperty(header);
    }
    expect(request?.headers["accept-language"] ?? "*").toBe("*");
  });

  it("a no after a yes deletes it all, in the file too", async () => {
    const { client, usage, stored, data, requests, goTo } = await setup();
    await client.usage.setSharing({ share: true });
    await client.usage.conversationOpened();
    goTo("2026-11-25", 1);
    await usage.look();
    const id = (await client.usage.get()).waiting[0]?.id ?? "missing";
    expect(await stored()).not.toBeNull();
    await client.usage.setSharing({ share: false });
    expect(await stored()).toBeNull();
    // Nor in the files: neither the database nor its write-ahead log.
    const { databasePath } = data.config();
    for (const path of [databasePath, `${databasePath}-wal`]) {
      const bytes = existsSync(path) ? readFileSync(path).toString("latin1") : "";
      for (const trace of [id, "closedThrough", "conversation_opened"]) {
        expect(bytes.includes(trace), `${path} ${trace}`).toBe(false);
      }
    }
    goTo("2026-11-25", 20);
    await usage.look();
    expect(requests).toEqual([]);
  });

  it("without the build's endpoint, a yes sends nothing", async () => {
    const { client, usage, requests, fetched, goTo } = await setup({ endpoint: false });
    await client.usage.setSharing({ share: true });
    await client.usage.conversationOpened();
    for (const day of ["2026-11-25", "2026-11-26"]) {
      goTo(day, 20);
      await usage.look();
    }
    expect(requests).toEqual([]);
    expect(fetched).not.toHaveBeenCalled();
    expect((await client.usage.get()).sends).toBe(false);
  });

  it("knows no endpoint outside a packaged release", () => {
    expect(statsEndpoint(false)).toBeNull();
    expect(statsEndpoint(true)).toBeNull();
    vi.stubGlobal("COMPILED_STATS_ENDPOINT", "https://stats.example/v1/report");
    expect(statsEndpoint(false)).toBeNull();
    expect(statsEndpoint(true)).toBe("https://stats.example/v1/report");
    for (const bad of ["", "http://stats.example/v1/report", "https://stats.example/other"]) {
      vi.stubGlobal("COMPILED_STATS_ENDPOINT", bad);
      expect(statsEndpoint(true), bad).toBeNull();
    }
    vi.unstubAllGlobals();
  });
});

describe("the diagnostic", () => {
  it("works after a no, and holds nothing but its closed list", async () => {
    const { client, requests } = await setup();
    await client.usage.setSharing({ share: false });
    const { text } = await client.diagnostics.report();
    expect(text).toMatch(/^Sondine 0\.7\.0, helper \S+, macOS 27\.0\.1$/mu);
    expect(text).toContain("Queue: 0 queued");
    expect(text).not.toMatch(/\/Users|\/private|\/var|@/u);
    expect(requests).toEqual([]);
  });
});
