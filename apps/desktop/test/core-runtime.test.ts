import { MessageChannel } from "node:worker_threads";
import { createORPCClient, ORPCError, safe } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import type { AppClient, Status } from "@sondine/api";
import { PROTOCOL_VERSION } from "@sondine/protocol";
import { Effect, SubscriptionRef } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { Api } from "../src/core/api-services";
import { Database } from "../src/core/database";
import { HelperClient } from "../src/core/helper/helper-client";
import { RpcHost } from "../src/core/rpc-host";
import { makeCoreRuntime, type CoreRuntime } from "../src/core/runtime";
import { CoreState } from "../src/core/status/core-state";
import { startFakeHelper } from "./fake-helper/fake-helper";
import { captureOptions, recordingMain, tempDataDir, waitUntil, type TempDataDir } from "./support";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

function setup(options: { memory?: boolean } = {}) {
  const data = tempDataDir();
  cleanups.push(() => data.cleanup());
  const main = recordingMain();
  const config = data.config(options.memory === true ? { databasePath: ":memory:" } : {});
  const runtime = makeCoreRuntime(config, main, {
    ...captureOptions(data),
    helper: { helloTimeoutMs: 1_000, requestTimeoutMs: 2_000, incompatibleRetryMs: 200 },
    spans: { flushEvery: "1 seconds" },
  });
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await runtime.dispose();
  };
  cleanups.push(dispose);
  return { data, main, runtime, dispose };
}

async function helper(
  data: TempDataDir,
  options: Partial<Parameters<typeof startFakeHelper>[0]> = {},
) {
  const fake = await startFakeHelper({ socketPath: data.socketPath, autoplay: null, ...options });
  cleanups.push(() => fake.close());
  return fake;
}

const status = (runtime: CoreRuntime) =>
  runtime.runPromise(Effect.flatMap(CoreState, (state) => SubscriptionRef.get(state.status)));

const api = (runtime: CoreRuntime) => runtime.runPromise(Api);

const rows = (runtime: CoreRuntime, sql: string) =>
  runtime.runPromise(Effect.map(Database, (db) => db.statement(sql).all()));

const scalar = async (runtime: CoreRuntime, sql: string) => {
  const [row] = await rows(runtime, sql);
  return row === undefined ? undefined : Object.values(row)[0];
};

const connected = (runtime: CoreRuntime) =>
  waitUntil(async () => (await status(runtime)).helper.connection === "connected", {
    label: "helper connection",
  });

describe("core against a fake helper over a Unix socket", () => {
  it("negotiates, configures, and imports capture events idempotently", async () => {
    const { data, runtime } = setup();
    const fake = await helper(data);
    await runtime.runPromise(Effect.void);
    await connected(runtime);

    await fake.waitFor("snapshot");
    expect(fake.received.map((message) => message.type).slice(0, 3)).toEqual([
      "hello",
      "config",
      "snapshot",
    ]);

    // The snapshot's replies arrive after the request; wait for them.
    const current = await waitUntil(
      async () => {
        const next = await status(runtime);
        return next.permissions !== null && next.tracks.length > 0 && next;
      },
      { label: "snapshot replay" },
    );
    expect(current.helper.sessionId).toBe(fake.sessionId);
    expect(current.permissions?.microphone.status).toBe("granted-verified");
    expect(current.tracks.map((track) => track.trackKey)).toEqual([
      "input:BuiltInMicrophoneDevice",
    ]);

    for (let i = 0; i < 6; i++) fake.tick();
    fake.health();
    // The sixth tick commits, then opens a region: wait for both.
    await waitUntil(
      async () =>
        (await scalar(runtime, "SELECT count(*) FROM chunks")) === 6 &&
        (await scalar(runtime, "SELECT count(*) FROM speech_regions")) === 2,
      { label: "six chunks and two regions" },
    );
    expect(await scalar(runtime, "SELECT count(*) FROM track_runs")).toBe(1);
    expect(await scalar(runtime, "SELECT count(*) FROM spool_files")).toBe(1);
    expect(await rows(runtime, "SELECT state, end_reason FROM speech_regions")).toEqual([
      { state: "closed", end_reason: "silence" },
      { state: "open", end_reason: null },
    ]);
    await waitUntil(async () => (await status(runtime)).lastHealth !== null, { label: "health" });
    expect((await status(runtime)).tracks[0]?.level).not.toBeNull();

    // Drop the connection: core reconnects, gets a new snapshot replaying the
    // open run and region, and the replay adds no row.
    fake.dropConnections();
    await waitUntil(() => fake.received.filter((m) => m.type === "snapshot").length >= 2, {
      label: "second snapshot",
    });
    await connected(runtime);
    const run = fake.micRun();
    if (run === null) throw new Error("fake mic is closed");
    // A replay of the first block carries the clock reading it was committed with.
    const [first] = await rows(
      runtime,
      "SELECT cast(host_ticks AS text) AS ticks, continuous_us FROM chunks WHERE byte_offset = 0",
    );
    if (typeof first?.["ticks"] !== "string" || typeof first["continuous_us"] !== "number")
      throw new Error("no first chunk");
    fake.emit({
      type: "commit",
      trackKey: run.trackKey,
      runId: run.runId,
      file: `input-BuiltInMicrophoneDevice/${run.runId}/0000.pcm`,
      seq: 0,
      epoch: run.epoch,
      committedOffset: 64_000,
      sampleIndex: 0,
      sampleCount: 32_000,
      crc32: 2_654_435_761,
      at: {
        hostTicks: BigInt(first["ticks"]),
        continuousNs: BigInt(first["continuous_us"]) * 1_000n,
      },
      gaps: [],
    });
    fake.tick();
    await waitUntil(async () => (await scalar(runtime, "SELECT count(*) FROM chunks")) === 7, {
      label: "seventh chunk",
    });
    expect(await scalar(runtime, "SELECT count(*) FROM track_runs")).toBe(1);
    expect(await scalar(runtime, "SELECT count(*) FROM speech_regions")).toBe(2);
    expect((await status(runtime)).importer.errors).toBe(0);
  });

  it("pauses through the API, persists the intent, and re-applies it to a restarted helper", async () => {
    const { data, runtime } = setup();
    let fake = await helper(data);
    await connected(runtime);
    // `connected` comes before the snapshot request: a pause sent now could
    // close the mic before core learns of it, and the fake keeps no manifest
    // to recover it from.
    await waitUntil(async () => (await scalar(runtime, "SELECT count(*) FROM track_runs")) === 1, {
      label: "mic run imported",
    });
    const services = await api(runtime);

    const paused = await services.listening.pause({ scope: "all" });
    expect(paused).toMatchObject({ desired: "paused", effective: "paused" });
    await waitUntil(
      async () => (await scalar(runtime, "SELECT state FROM track_runs")) === "closed",
      {
        label: "run closed",
      },
    );
    expect(await scalar(runtime, "SELECT end_reason FROM track_runs")).toBe("paused");

    // A fresh helper starts unpaused; core pauses it as soon as it connects.
    await fake.close();
    fake = await helper(data);
    await fake.waitFor("pause");
    await waitUntil(async () => (await status(runtime)).listening.effective === "paused", {
      label: "paused again",
    });

    const resumed = await services.listening.resume({ scope: "all" });
    expect(resumed).toMatchObject({ desired: "listening", effective: "listening" });
    expect(fake.micRun()).not.toBeNull();
  });

  it("closes promptly while no helper ever answered", async () => {
    const { runtime, dispose } = setup();
    await runtime.runPromise(Effect.void);
    // Long enough for the reconnect loop to be waiting on its schedule.
    await new Promise((resolve) => setTimeout(resolve, 600));
    const started = Date.now();
    await dispose();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("keeps the intent while the helper is away and reports it as unconfirmed", async () => {
    const { runtime } = setup({ memory: true });
    const services = await api(runtime);
    const result = await services.listening.pause({ scope: "microphone" });
    expect(result).toMatchObject({
      desired: "listening",
      effective: "unknown",
      microphonePaused: null,
    });
    expect((await status(runtime)).helper.connection).not.toBe("connected");
  });

  it("forwards Sondine's PIDs now and after every reconnect", async () => {
    const { data, runtime } = setup();
    const fake = await helper(data);
    await connected(runtime);
    await runtime.runPromise(
      Effect.flatMap(HelperClient, (client) => client.setExcludedPids([4120, 4121])),
    );
    const first = await fake.waitFor("exclude.pids");
    expect(first).toMatchObject({ pids: [4120, 4121] });
    fake.dropConnections();
    const again = await fake.waitFor("exclude.pids", 2);
    expect(again).toMatchObject({ pids: [4120, 4121] });
  });

  it("marks a helper that speaks another protocol as incompatible", async () => {
    const { data, runtime } = setup({ memory: true });
    await helper(data, { protocol: PROTOCOL_VERSION + 1 });
    await waitUntil(async () => (await status(runtime)).helper.connection === "incompatible", {
      label: "incompatible",
    });
    expect((await status(runtime)).helper.lastError?.code).toMatch(
      /^(protocol\.unsupported|helper\.incompatible)$/,
    );
  });

  it("asks the helper to shut down and closes the database with the runtime", async () => {
    const { data, runtime, dispose } = setup();
    const fake = await helper(data);
    await connected(runtime);
    await runtime.runPromise(Effect.flatMap(HelperClient, (client) => client.shutdown));
    expect(fake.received.at(-1)?.type).toBe("shutdown");
    const db = await runtime.runPromise(Database);
    await dispose();
    expect(db.client.isOpen).toBe(false);
    await waitUntil(() => fake.connections() === 0, { label: "socket closed" });
  });
});

describe("router over a MessagePort, with an in-memory database", () => {
  async function connect(runtime: CoreRuntime) {
    const channel = new MessageChannel();
    const host = await runtime.runPromise(RpcHost);
    host.attach(channel.port1, "test");
    channel.port2.start();
    cleanups.push(() => {
      channel.port1.close();
      channel.port2.close();
    });
    const client: AppClient = createORPCClient(new RPCLink({ port: channel.port2 }));
    return client;
  }

  it("serves status, diagnostics and permissions", async () => {
    const { data, main, runtime } = setup({ memory: true });
    const fake = await helper(data);
    const client = await connect(runtime);
    await connected(runtime);

    const current: Status = await client.status.get();
    expect(current.helper.connection).toBe("connected");
    expect(current.listening.effective).toBe("listening");

    fake.health();
    await waitUntil(async () => (await client.diagnostics.health()).windows.length === 1, {
      label: "health window",
    });
    const [window] = (await client.diagnostics.health({ limit: 1 })).windows;
    expect(window?.stages.map((stage) => stage.stage)).toEqual([
      "io-callback",
      "vad",
      "spool-fsync",
    ]);

    const { spans } = await client.diagnostics.spans({ name: "api." });
    expect(spans.map((span) => span.name)).toContain("api.status.get");
    expect(spans.every((span) => span.status === "ok" && span.durationMs >= 0)).toBe(true);

    await expect(client.permissions.request({ kind: "microphone" })).resolves.toMatchObject({
      outcome: "already-granted",
    });
    fake.rejectNext("request.permissions", "request.rejected");
    await expect(client.permissions.request({ kind: "systemAudio" })).resolves.toMatchObject({
      outcome: "opened-settings",
    });
    expect(main.posted).toContainEqual({ type: "open-privacy-settings", pane: "system-audio" });
    await expect(client.permissions.request({ kind: "systemAudio" })).resolves.toMatchObject({
      outcome: "requested",
      permissions: { systemAudio: { status: "granted" } },
    });
    expect(fake.received.map((message) => message.type)).toContain("request.permissions");
  });

  it("streams status changes until the client stops", async () => {
    const { data, runtime } = setup({ memory: true });
    await helper(data);
    const client = await connect(runtime);
    const iterator = await client.status.watch();
    const seen: Status["helper"]["connection"][] = [];
    for await (const next of iterator) {
      seen.push(next.helper.connection);
      if (next.helper.connection === "connected" && next.tracks.length > 0) break;
    }
    expect(seen.at(-1)).toBe("connected");
  });

  it("returns typed errors when the helper rejects a request", async () => {
    const { data, runtime } = setup({ memory: true });
    const fake = await helper(data);
    const client = await connect(runtime);
    await connected(runtime);
    fake.rejectNext("pause", "request.rejected");
    const [error] = await safe(client.listening.pause());
    expect(error).toBeInstanceOf(ORPCError);
    expect(error instanceof ORPCError && [error.code, error.data]).toEqual([
      "HELPER_REJECTED",
      { code: "request.rejected" },
    ]);
    // The intent is kept; the helper still listens.
    const current = await client.status.get();
    expect(current.listening).toMatchObject({ desired: "paused", effective: "listening" });
  });
});
