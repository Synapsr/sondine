import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { MessageChannel } from "node:worker_threads";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import type { AppClient } from "@sondine/api";
import type { HelperEvent } from "@sondine/protocol";
import { Effect, PubSub } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { Importer } from "../src/core/capture/importer";
import { Database } from "../src/core/database";
import { HelperClient } from "../src/core/helper/helper-client";
import { RpcHost } from "../src/core/rpc-host";
import { makeCoreRuntime } from "../src/core/runtime";
import { createHelperSupervisor } from "../src/main/helper-supervisor";
import type { HelperProcessInfo } from "../src/shared/core-messages";
import { captureOptions, recordingMain, tempDataDir, waitUntil } from "./support";

// Core against the real `sondine-audio serve` on the fake HAL: no audio
// hardware, no permission prompts. Skipped until `swift build -c release
// --package-path native` has produced the helper.
const helperPath = resolve(import.meta.dirname, "../../../native/.build/release/sondine-audio");

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(!existsSync(helperPath))("core against the real helper (--hal fake)", () => {
  it("connects, replays a snapshot, serves status, pauses, resumes and shuts down", async () => {
    const data = tempDataDir();
    cleanups.push(() => data.cleanup());
    // Main prepares the 0700 socket directory before it starts the helper.
    mkdirSync(dirname(data.socketPath), { mode: 0o700 });

    const infos: HelperProcessInfo[] = [];
    const supervisor = createHelperSupervisor({
      command: {
        executable: helperPath,
        args: ["serve", "--socket", data.socketPath, "--data", data.dir, "--hal", "fake"],
      },
      onChange: (info) => infos.push(info),
    });
    cleanups.push(() => supervisor.stop());

    const runtime = makeCoreRuntime(data.config(), recordingMain(), {
      ...captureOptions(data),
      helper: { helloTimeoutMs: 2_000, requestTimeoutMs: 5_000 },
    });
    let disposed = false;
    cleanups.push(async () => {
      if (!disposed) await runtime.dispose();
    });

    // Subscribed before the connection loop sees the helper, so no event is missed.
    const seen: HelperEvent[] = [];
    const subscribed = Promise.withResolvers<void>();
    runtime.runFork(
      Effect.gen(function* () {
        const helper = yield* HelperClient;
        const subscription = yield* PubSub.subscribe(helper.events);
        subscribed.resolve();
        yield* PubSub.take(subscription).pipe(
          Effect.map((event) => seen.push(event)),
          Effect.forever,
        );
      }).pipe(Effect.scoped),
    );
    await subscribed.promise;
    supervisor.start();

    const channel = new MessageChannel();
    (await runtime.runPromise(RpcHost)).attach(channel.port1, "test");
    channel.port2.start();
    cleanups.push(() => {
      channel.port1.close();
      channel.port2.close();
    });
    const client: AppClient = createORPCClient(new RPCLink({ port: channel.port2 }));

    // hello → ready, then config and snapshot.
    const connected = await waitUntil(
      async () => {
        const status = await client.status.get();
        return status.helper.connection === "connected" && status;
      },
      { timeoutMs: 10_000, label: "helper connection" },
    );
    expect(connected.helper.sessionId).not.toBeNull();

    const replies = (type: HelperEvent["type"]) =>
      seen.filter((event) => event.type === type && event.replyTo !== undefined);
    await waitUntil(() => replies("clock").length > 0, { label: "snapshot replay" });
    for (const type of ["permissions", "devices", "processes", "clock"] as const) {
      expect(replies(type), type).not.toHaveLength(0);
    }

    const status = await waitUntil(
      async () => {
        const next = await client.status.get();
        return next.permissions !== null && next;
      },
      { label: "permissions in status" },
    );
    expect(status.helper.connection).toBe("connected");
    expect(status.listening.effective).toBe("listening");

    const paused = await client.listening.pause({ scope: "all" });
    expect(paused.effective).toBe("paused");
    expect((await client.status.get()).listening.effective).toBe("paused");
    const resumed = await client.listening.resume({ scope: "all" });
    expect(resumed.effective).toBe("listening");

    // The fake HAL grants both permissions and never prompts.
    expect(await client.permissions.request({ kind: "microphone" })).toMatchObject({
      outcome: "already-granted",
    });
    // request.permissions on the wire: `permissions` with replyTo, then `ack`.
    const before = replies("permissions").length;
    await runtime.runPromise(
      Effect.flatMap(HelperClient, (helper) =>
        helper.request({ type: "request.permissions", scope: "all" }),
      ),
    );
    await waitUntil(() => replies("permissions").length > before, {
      label: "request.permissions reply",
    });

    // Core's shutdown: the helper acknowledges, commits, closes and exits.
    const pid = supervisor.info().pid;
    if (pid === null) throw new Error("the supervisor reports no helper pid");
    supervisor.retire();
    const sql = (text: string) =>
      runtime.runPromise(Effect.map(Database, (db) => db.statement(text).all()));
    // Both tracks recording again after the resume, each with a commit.
    const live = await waitUntil(
      async () => {
        const open = await sql(
          "SELECT r.uid FROM track_runs r WHERE r.state = 'open' AND EXISTS (SELECT 1 FROM chunks c WHERE c.track_run_id = r.id)",
        );
        return open.length === 2 && open.map((run) => String(run["uid"]));
      },
      { timeoutMs: 10_000, label: "two live runs with a commit" },
    );
    const drained = await runtime.runPromise(
      Effect.gen(function* () {
        const helper = yield* HelperClient;
        yield* helper.shutdown;
        return yield* (yield* Importer).drain(2_000);
      }),
    );
    // The last commits and closes came before the ack, and are in the database.
    expect(drained).toBe(true);
    const runs = await sql("SELECT uid, state, end_reason FROM track_runs");
    expect(runs.map((run) => run["state"])).not.toContain("open");
    // The runs the shutdown found open closed as stopped (the others with the pause).
    expect(
      runs.filter((run) => live.includes(String(run["uid"]))).map((run) => run["end_reason"]),
    ).toEqual(["stopped", "stopped"]);
    await runtime.dispose();
    disposed = true;
    await waitUntil(() => !alive(pid), { timeoutMs: 10_000, label: "helper exit" });
    await supervisor.stop();
    expect(infos.at(-1)?.lastExit).toMatchObject({ code: 0 });
  });

  it("closes a killed helper's runs at their last stored sample and records the outage", async () => {
    const data = tempDataDir();
    cleanups.push(() => data.cleanup());
    mkdirSync(dirname(data.socketPath), { mode: 0o700 });
    const supervisor = createHelperSupervisor({
      command: {
        executable: helperPath,
        args: [
          "serve",
          "--socket",
          data.socketPath,
          "--data",
          data.dir,
          "--hal",
          "fake",
          "--vad",
          "none",
        ],
      },
      onChange: () => undefined,
      // Restart at once, as main does after a first crash.
      policy: {
        onCrash: () => ({ delayMs: 100, crashLoop: false, recentCrashes: 1 }),
        reset: () => undefined,
      },
    });
    cleanups.push(() => supervisor.stop());
    const runtime = makeCoreRuntime(data.config(), recordingMain(), {
      ...captureOptions(data),
      helper: { helloTimeoutMs: 2_000, requestTimeoutMs: 5_000 },
    });
    cleanups.push(() => runtime.dispose());
    const query = <T>(sql: string) =>
      runtime.runPromise(Effect.map(Database, (db) => db.statement(sql).all() as unknown as T[]));
    supervisor.start();

    // Both tracks commit at least twice (2 s commits).
    await waitUntil(
      async () =>
        (
          await query<{ n: number }>(
            "SELECT count(*) AS n FROM chunks GROUP BY track_run_id HAVING n >= 2",
          )
        ).length === 2,
      { timeoutMs: 15_000, label: "two commits per track" },
    );
    const first = await query<{ uid: string; track_key: string }>(
      "SELECT uid, track_key FROM track_runs WHERE state = 'open'",
    );
    expect(first.map((run) => run.track_key).toSorted()).toEqual([
      "input:BuiltInMicrophoneDevice",
      "system:other",
    ]);
    const pid = supervisor.info().pid;
    if (pid === null) throw new Error("no helper pid");
    process.kill(pid, "SIGKILL");

    // The next helper recovers the spool; core reconciles once its snapshot ends.
    const closed = await waitUntil(
      async () => {
        const runs = await query<{ uid: string; end_reason: string; sample_end: number }>(
          `SELECT uid, end_reason, sample_end FROM track_runs WHERE uid IN (${first.map((run) => `'${run.uid}'`).join(",")}) AND state = 'closed'`,
        );
        return runs.length === 2 && runs;
      },
      { timeoutMs: 15_000, label: "killed runs closed" },
    );
    expect(closed.map((run) => run.end_reason)).toEqual(["helper_exit", "helper_exit"]);
    const outages = await query<{ track_key: string; wall_start_ms: number; wall_end_ms: number }>(
      "SELECT track_key, wall_start_ms, wall_end_ms FROM gaps WHERE reason = 'helper_exit' ORDER BY track_key",
    );
    expect(outages.map((gap) => gap.track_key)).toEqual([
      "input:BuiltInMicrophoneDevice",
      "system:other",
    ]);
    for (const gap of outages) {
      // Under 2 s of uncommitted audio plus the restart.
      expect(gap.wall_end_ms - gap.wall_start_ms).toBeGreaterThan(0);
      expect(gap.wall_end_ms - gap.wall_start_ms).toBeLessThan(10_000);
    }
    // Each run ends at a stored sample: its last chunk ends there.
    for (const run of closed) {
      const [last] = await query<{ end: number }>(
        `SELECT max(sample_start + sample_count) AS end FROM chunks JOIN track_runs ON track_runs.id = chunks.track_run_id WHERE uid = '${run.uid}'`,
      );
      expect(last?.end).toBe(run.sample_end);
    }
    // And the new helper records again.
    await waitUntil(
      async () =>
        (await query<{ n: number }>("SELECT count(*) AS n FROM track_runs WHERE state = 'open'"))[0]
          ?.n === 2,
      { label: "new runs" },
    );
  });
});
