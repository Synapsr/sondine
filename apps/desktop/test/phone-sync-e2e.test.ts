import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  phoneRecordingEpisode,
  phoneRecordingReadings,
  phoneUpload,
  type Database as Db,
} from "@sondine/db";
import { createRouterClient } from "@orpc/server";
import { router } from "@sondine/api";
import {
  MemoryConversationAnswer,
  MemoryDayAnswer,
  MemorySearchAnswer,
  parsePairingUrl,
  PhoneResult,
} from "@sondine/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api } from "../src/core/api-services";
import { Database } from "../src/core/database";
import type { PhoneReceipt } from "../src/core/imports/imports-layer";
import { spawnRelay } from "../src/core/phone/lan-relay";
import { localDay } from "../src/core/phone/phone-results";
import { makeCoreRuntime } from "../src/core/runtime";
import { DATA_LAYOUT } from "../src/shared/data-layout";
import { engineLayer, fakeEngine, fakeSignals } from "./fake-engine";
import { writeJournal } from "./phone-support";
import { captureOptions, recordingMain, tempDataDir, waitUntil } from "./support";

// iPhone sync from end to end (ADR 008, plan § M5.2 to § M5.4), on this
// Mac without a device: the real core (its phone server, pairing, import and deletion) on a
// scratch data directory starts the real `sondine-lan` (TLS 1.3, its peer
// check with --allow-loopback, its byte copy), and the phone is
// `sondine-phone-e2e`, SondinePhone's real sync client and URLSession
// transport, pinned to the key core made. Between the phone and the relay, a
// TCP proxy of this test cuts the connection like Wi-Fi going off. The files
// are written by `sondine-phone-fixture` at test time, never committed; the
// fake engine transcribes them (« Bonjour Sondine » per stretch of sound), so
// the phone fetches results, sends names and notes, and plays by ranges, then
// searches and reads the Mac's memory live, writing nothing in its folder,
// and times its search against the same search on the Mac (plan § M5.4's
// exit, on loopback; `SONDINE_MEASURE_OUT` appends the numbers to a file).
// `pnpm test:native` builds the three and runs this file; plain `pnpm test`
// skips it.

const lanBinary = process.env["SONDINE_LAN"];
const phoneBinary = process.env["SONDINE_PHONE_E2E"];
const fixtureBinary = process.env["SONDINE_PHONE_FIXTURE"];
const ready = [lanBinary, phoneBinary, fixtureBinary].every(
  (path) => path !== undefined && existsSync(path),
);

/** Longer than the phone's 30 s upload timeout, so only `102 Processing` keeps it alive. */
const IMPORT_HOLD_MS = 35_000;
/** Core sends `102 Processing` every 20 s while it holds an answer. */
const PAIRING_HOLD_MS = 21_000;
/** How long core waits for a body byte before dropping an upload whose phone went away. */
const BODY_IDLE_MS = 5_000;
/** Searches timed on each side, after a few to warm both up. */
const TIMED_SEARCHES = 100;
const WARM_SEARCHES = 5;

/** The value under which `share` of the samples fall. */
const quantile = (values: readonly number[], share: number) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)] ?? 0;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/**
 * The phone's link to the Mac: forwards both ways, records when the Mac's bytes come, and cuts on
 * demand. It reaches the relay on 127.0.0.1, or on `::1`, which the relay of this test takes for a
 * peer through Tailscale (`--loopback-v6-as-tailnet`, debug builds only).
 */
function cuttingProxy(target: () => number) {
  const open = new Set<Socket>();
  let host = "127.0.0.1";
  /** Bytes the phone may still send before the cut; null: no cut armed. */
  let remaining: number | null = null;
  let cuts = 0;
  const fromMac: number[] = [];
  const server = createServer((phone) => {
    const mac = connect(target(), host);
    open.add(phone);
    open.add(mac);
    /** Wi-Fi went off under this connection: the Mac hears nothing more, not even a close. */
    let silent = false;
    const close = () => {
      phone.destroy();
      open.delete(phone);
      if (silent) return;
      mac.destroy();
      open.delete(mac);
    };
    phone.on("data", (chunk: Buffer) => {
      if (remaining !== null && chunk.length >= remaining) {
        mac.write(chunk.subarray(0, remaining));
        remaining = null;
        cuts += 1;
        silent = true;
        phone.destroy();
        return;
      }
      if (remaining !== null) remaining -= chunk.length;
      mac.write(chunk);
    });
    mac.on("data", (chunk: Buffer) => {
      if (silent) return;
      fromMac.push(Date.now());
      phone.write(chunk);
    });
    phone.on("close", close);
    mac.on("close", close);
    phone.on("error", close);
    mac.on("error", close);
  });
  return {
    listen: () =>
      new Promise<number>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          resolve(typeof address === "object" && address !== null ? address.port : 0);
        });
      }),
    /** The phone at home (127.0.0.1) or away through Tailscale (`::1`), from its next connection. */
    path(path: "home" | "tailnet") {
      host = path === "home" ? "127.0.0.1" : "::1";
      for (const socket of open) socket.destroy();
    },
    /** Cuts the phone's connection once it has sent this many more bytes; the Mac's side stays open, silent. */
    cutAfter(bytes: number) {
      remaining = bytes;
    },
    cuts: () => cuts,
    /** Whether the Mac sent bytes between these two times (a `102` inside TLS, while an answer is held). */
    heardBetween: (from: number, to: number) => fromMac.some((at) => at > from && at < to),
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** `sondine-phone-e2e`: one JSON command per line, one JSON answer per line. */
function phoneProcess(root: string, mac: string) {
  const child: ChildProcessWithoutNullStreams = spawn(phoneBinary ?? "", [
    "--root",
    root,
    "--mac",
    mac,
  ]);
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const lines: Record<string, unknown>[] = [];
  const waiting: {
    resolve: (line: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }[] = [];
  let exited: Error | null = null;
  createInterface({ input: child.stdout }).on("line", (text) => {
    const line = JSON.parse(text) as Record<string, unknown>;
    const next = waiting.shift();
    if (next === undefined) lines.push(line);
    else next.resolve(line);
  });
  child.once("exit", (code) => {
    exited = new Error(`sondine-phone-e2e exited (${code}): ${stderr.slice(-2_000)}`);
    for (const next of waiting.splice(0)) next.reject(exited);
  });
  const read = (): Promise<Record<string, unknown>> => {
    const line = lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (exited !== null) return Promise.reject(exited);
    return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
  };
  return {
    /** Sends a command; its answer comes with `read`. */
    send(command: Record<string, unknown>) {
      child.stdin.write(`${JSON.stringify(command)}\n`);
    },
    read,
    async run(command: Record<string, unknown>) {
      child.stdin.write(`${JSON.stringify(command)}\n`);
      const answer = await read();
      if ("error" in answer)
        throw new Error(`${String(command["cmd"])}: ${String(answer["error"])}`);
      return answer;
    },
    stop() {
      child.stdin.end();
      child.kill();
    },
  };
}

interface PhoneRecording {
  readonly id: string;
  readonly hasAudio: boolean;
  readonly stored: boolean;
  readonly mac: string | null;
  readonly sha256: string | null;
}

describe.skipIf(!ready)("iPhone sync from end to end", () => {
  /** Imports held, or refused for room once, by recording id. */
  const holds = new Map<string, number>();
  const noRoomOnce = new Set<string>();
  const held: { recordingId: string; from: number; to: number }[] = [];
  let relayPort = 0;
  const proxy = cuttingProxy(() => relayPort);
  let data: ReturnType<typeof tempDataDir>;
  let phoneRoot: string;
  let files: string;
  let runtime: ReturnType<typeof makeCoreRuntime>;
  let phone: ReturnType<typeof phoneProcess>;
  let db: Db;

  /** Core on the scratch data directory, its real relay, and the fake engine. */
  const startCore = () =>
    makeCoreRuntime(
      data.config({ phoneRelay: { path: lanBinary ?? "", allowLoopback: true } }),
      recordingMain(),
      {
        ...captureOptions(data),
        phone: {
          // `::1` stands for a peer through Tailscale (M5.5).
          spawn: (binary, args) => spawnRelay(binary, [...args, "--loopback-v6-as-tailnet"]),
          // Every request comes through the proxy on loopback; `hello` says so.
          addresses: () => ["127.0.0.1"],
          // Shorter than core's 30 s and 1 minute, so the test waits less for them.
          limits: { blockMs: 3_000, bodyIdleMs: BODY_IDLE_MS },
          receive: async (path, expected, imported): Promise<PhoneReceipt> => {
            if (noRoomOnce.delete(expected.recordingId))
              return { outcome: "refused", reason: "no-room" };
            const hold = holds.get(expected.recordingId);
            if (hold !== undefined) {
              holds.delete(expected.recordingId);
              const from = Date.now();
              await sleep(hold);
              held.push({ recordingId: expected.recordingId, from, to: Date.now() });
            }
            return imported(path, expected);
          },
        },
        analysis: {
          engine: engineLayer(() => fakeEngine()),
          signals: fakeSignals().layer,
          timing: {
            admissionIntervalMs: 30,
            idleUnloadMs: 150,
            rssIntervalMs: 30,
            noModelPollMs: 30,
          },
        },
      },
    );

  beforeAll(async () => {
    data = tempDataDir();
    phoneRoot = mkdtempSync(join(tmpdir(), "sondine-phone-"));
    files = mkdtempSync(join(tmpdir(), "sondine-phone-files-"));
    runtime = startCore();
    db = await runtime.runPromise(Database);
    const proxyPort = await proxy.listen();
    phone = phoneProcess(phoneRoot, `127.0.0.1:${proxyPort}`);
  });

  afterAll(async () => {
    phone?.stop();
    await proxy.close();
    await runtime?.dispose();
    data?.cleanup();
    rmSync(phoneRoot, { recursive: true, force: true });
    rmSync(files, { recursive: true, force: true });
  });

  const api = () => runtime.runPromise(Api);
  const recordings = async () =>
    (await phone.run({ cmd: "list" }))["recordings"] as PhoneRecording[];
  const onPhone = async (id: string) => (await recordings()).find((entry) => entry.id === id);
  const phoneRow = (id: string) =>
    db
      .statement("SELECT device_id, state, sha256 FROM phone_recordings WHERE recording_id = ?")
      .all(id);
  const partSize = (id: string) =>
    statSync(join(data.dir, DATA_LAYOUT.phoneInboxDir, `${id}.part`), { throwIfNoEntry: false })
      ?.size ?? null;

  /** A recording as the app leaves one, written by the Swift fixture for this phone. */
  async function record(deviceId: string, seconds: number, startedMs: number) {
    const file = join(files, `${startedMs}.m4a`);
    const run = spawnSync(
      fixtureBinary ?? "",
      [
        "--out",
        file,
        "--seconds",
        String(seconds),
        "--device-id",
        deviceId,
        "--started-ms",
        String(startedMs),
      ],
      { encoding: "utf8" },
    );
    expect(run.status).toBe(0);
    const bytes = readFileSync(file);
    const added = await phone.run({ cmd: "add", file, header: run.stdout.trim() });
    return { id: String(added["recordingId"]), bytes };
  }

  it(
    "pairs, sends, resumes, reads results, deletes both ways, and revokes",
    { timeout: 240_000 },
    async () => {
      let services = await api();
      const deviceId = String((await phone.run({ cmd: "device" }))["deviceId"]);

      // Pairing: the real relay listens with the key core made; both screens show the same digits.
      const opened = await services.phone.pair();
      const invite = parsePairingUrl(opened.pairing?.url ?? "");
      if (invite === null) throw new Error("no QR");
      relayPort = invite.port;
      phone.send({ cmd: "pair", url: opened.pairing?.url });
      const digits = await phone.read();
      const asked = await waitUntil(
        async () => {
          const pairing = (await services.phone.status()).pairing;
          return pairing?.phase === "asked" ? pairing : null;
        },
        { label: "the phone asks", timeoutMs: 15_000 },
      );
      expect(asked.digits).toBe(digits["digits"]);
      expect(asked.deviceName).toBe("iPhone de Téo");
      // « Appairer » after more than 20 s: the phone waits through core's `102 Processing`.
      const askedAt = Date.now();
      await sleep(PAIRING_HOLD_MS);
      await services.phone.answer({ accept: true });
      const paired = await phone.read();
      expect(paired).toMatchObject({ pin: invite.pin });
      expect(proxy.heardBetween(askedAt + 1_000, askedAt + PAIRING_HOLD_MS - 500)).toBe(true);
      expect((await services.phone.status()).phones.map((entry) => entry.deviceId)).toEqual([
        deviceId,
      ]);

      // Bonjour: the relay's service carries core's pin; the app's finder resolves it.
      const found = await phone.run({ cmd: "find", pin: invite.pin });
      expect(found["endpoints"]).toContainEqual(expect.objectContaining({ port: invite.port }));

      // A transfer cut at half resumes, and its import, held past the phone's 30 s, ends in `stored`.
      const now = Date.now();
      const first = await record(deviceId, 10, now - 600_000);
      proxy.cutAfter(Math.floor(first.bytes.length / 2));
      expect((await phone.run({ cmd: "sync" }))["outcome"]).toBe("unreachable");
      expect(proxy.cuts()).toBe(1);
      const cut = await waitUntil(() => partSize(first.id), { label: "the part" });
      expect(cut).toBeGreaterThan(0);
      expect(cut).toBeLessThan(first.bytes.length);
      expect(phoneUpload(db, first.id)).toMatchObject({
        bytes: first.bytes.length,
        sha256: sha(first.bytes),
      });
      expect(await onPhone(first.id)).toMatchObject({
        hasAudio: true,
        stored: false,
        sha256: sha(first.bytes),
      });
      // Back at once, the Mac still holds the dead upload: busy, until its body times out.
      expect((await phone.run({ cmd: "sync" }))["outcome"]).toBe("busy");
      expect(await phone.run({ cmd: "state" })).toMatchObject({ paired: true, credential: true });
      await sleep(BODY_IDLE_MS + 500);

      holds.set(first.id, IMPORT_HOLD_MS);
      expect((await phone.run({ cmd: "sync" }))["outcome"]).toBe("done");
      const hold = held.find((entry) => entry.recordingId === first.id);
      expect(hold).toBeDefined();
      expect(proxy.heardBetween((hold?.from ?? 0) + 1_000, (hold?.to ?? 0) - 500)).toBe(true);
      expect(phoneRow(first.id)).toEqual([
        { device_id: deviceId, state: "stored", sha256: sha(first.bytes) },
      ]);
      expect(phoneRecordingEpisode(db, first.id)).not.toBeNull();
      expect(await onPhone(first.id)).toMatchObject({ hasAudio: false, stored: true });

      // A whole part the import refused for room: the next pass sends an empty PUT and it is stored.
      const second = await record(deviceId, 3, now - 300_000);
      noRoomOnce.add(second.id);
      expect((await phone.run({ cmd: "sync" }))["outcome"]).toBe("mac-full");
      expect(partSize(second.id)).toBe(second.bytes.length);
      expect((await phone.run({ cmd: "sync" }))["outcome"]).toBe("done");
      expect(phoneRow(second.id)).toEqual([
        { device_id: deviceId, state: "stored", sha256: sha(second.bytes) },
      ]);
      expect(await onPhone(second.id)).toMatchObject({ hasAudio: false, stored: true });

      // States: the phone holds what core reads.
      const readings = phoneRecordingReadings(db, deviceId, [first.id, second.id]);
      expect([(await onPhone(first.id))?.mac, (await onPhone(second.id))?.mac]).toEqual(readings);

      // Results (M5.3): fetched once ready, and again only when the revision moves.
      await waitUntil(() => phoneRecordingReadings(db, deviceId, [first.id])[0] === "ready", {
        label: "the transcript",
        timeoutMs: 20_000,
      });
      const fetched = async () => {
        expect((await phone.run({ cmd: "sync" }))["outcome"]).toBe("done");
        const kept = await phone.run({ cmd: "result", id: first.id });
        return { revision: String(kept["revision"]), result: PhoneResult.parse(kept["result"]) };
      };
      const ready = await fetched();
      expect(ready.result.sentences.map((sentence) => sentence.text.trim())).toContain(
        "Bonjour Sondine",
      );
      expect((await fetched()).revision).toBe(ready.revision);
      const resultEpisode = phoneRecordingEpisode(db, first.id) ?? 0;
      const detail = await services.episodes.get({ episodeId: resultEpisode });
      const runId = detail.analysis?.runId ?? 0;
      const [sentence] = detail.segments;
      const [voice] = detail.speakers;
      if (sentence === undefined || voice === undefined) throw new Error("no transcript");
      // A correction, its undo, a voice named, the journal written again: each moves it.
      await services.transcript.edit({
        episodeId: resultEpisode,
        runId,
        segmentId: sentence.id,
        text: "Corrigé",
      });
      const corrected = await fetched();
      expect(corrected.result.sentences[0]?.text).toBe("Corrigé");
      await services.history.undo();
      expect((await fetched()).revision).toBe(ready.revision);
      await services.speakers.name({
        episodeId: resultEpisode,
        runId,
        label: voice.label,
        person: { kind: "new", name: "Marie" },
      });
      const named = await fetched();
      expect(named.result.speakers[0]).toMatchObject({ name: "Marie" });
      writeJournal(db, resultEpisode, "{P1} salue", [sentence.id], [voice.label]);
      const journaled = await fetched();
      writeJournal(db, resultEpisode, "{P1} salue encore", [sentence.id], [voice.label]);
      const rewritten = await fetched();
      expect(journaled.revision).not.toBe(named.revision);
      expect(rewritten.result.journal[0]).toMatchObject({
        kind: "line",
        text: "{P1} salue encore",
      });
      // Named and noted on the phone: found on the Mac after the next sync, the note once.
      await phone.run({ cmd: "rename", id: first.id, name: "Réunion budget" });
      await phone.run({ cmd: "note", id: first.id, text: "Relancer Marie vendredi" });
      expect(await phone.run({ cmd: "state" })).toMatchObject({ outbox: 2 });
      const noted = await fetched();
      expect(await phone.run({ cmd: "state" })).toMatchObject({ outbox: 0 });
      const onMac = await services.episodes.get({ episodeId: resultEpisode });
      expect(onMac.episode.phone).toEqual({ timeUncertain: false, name: "Réunion budget" });
      expect(onMac.context.map((item) => item.text)).toEqual(["Relancer Marie vendredi"]);
      expect(noted.result).toMatchObject({
        name: "Réunion budget",
        notes: [{ text: "Relancer Marie vendredi" }],
      });
      // Playback: a byte range through the pinned session; another generation is refused.
      const audio = noted.result.audio;
      if (audio === null) throw new Error("no audio");
      expect(
        await phone.run({
          cmd: "audio",
          id: first.id,
          generation: audio.generation,
          from: 0,
          to: 4095,
        }),
      ).toMatchObject({ status: 206, bytes: 4096, total: expect.any(Number) });
      expect(
        await phone.run({
          cmd: "audio",
          id: first.id,
          generation: audio.generation + 1,
          from: 0,
          to: 9,
        }),
      ).toEqual({ status: 409, refusal: "stale" });
      // Core restarted: nothing it shows changed, so neither did its revision.
      await runtime.dispose();
      runtime = startCore();
      db = await runtime.runPromise(Database);
      services = await api();
      await waitUntil(async () => (await services.phone.status()).relay.phase === "listening", {
        label: "the relay again",
        timeoutMs: 15_000,
      });
      expect((await fetched()).revision).toBe(noted.revision);

      // The Mac's memory (M5.4), read live as the app's screens read it; the phone's folder unchanged.
      const filesBefore = (await phone.run({ cmd: "files" }))["files"];
      const searched = MemorySearchAnswer.parse(
        (await phone.run({ cmd: "search", text: "Bonjour" }))["answer"],
      );
      if (searched.status !== "results") throw new Error("withheld");
      expect(
        searched.episodes.find((entry) => entry.episode.episodeId === resultEpisode)?.episode.phone,
      ).toEqual({ name: "Réunion budget", recordingId: first.id });
      const day = localDay(onMac.episode.startedAtMs);
      const overview = MemoryDayAnswer.parse((await phone.run({ cmd: "day", day }))["answer"]);
      if (overview.status !== "day") throw new Error("withheld");
      expect(overview.day).toBe(day);
      expect(overview.conversations.length + overview.moments).toBeGreaterThanOrEqual(1);
      const text = MemoryConversationAnswer.parse(
        (await phone.run({ cmd: "conversation", episodeId: resultEpisode }))["answer"],
      );
      if (text.status !== "conversation") throw new Error("not read");
      expect(text.sentences.map((sentence) => sentence.id)).toEqual(
        noted.result.sentences.map((sentence) => sentence.id),
      );
      expect((await phone.run({ cmd: "files" }))["files"]).toEqual(filesBefore);

      // Search on the phone within 300 ms of the same search on the Mac (p95), here on loopback.
      const onMacSearch = createRouterClient(router, { context: { services } });
      const macMs: number[] = [];
      for (let index = 0; index < WARM_SEARCHES + TIMED_SEARCHES; index += 1) {
        const started = performance.now();
        await onMacSearch.search.query({ text: "Bonjour", limit: 20 });
        if (index >= WARM_SEARCHES) macMs.push(performance.now() - started);
      }
      await phone.run({ cmd: "time-search", text: "Bonjour", count: WARM_SEARCHES });
      const phoneMs = (
        await phone.run({ cmd: "time-search", text: "Bonjour", count: TIMED_SEARCHES })
      )["ms"] as number[];
      const measured = {
        measure: "phone-search",
        at: new Date().toISOString(),
        path: "loopback, sondine-lan with TLS 1.3, core",
        searches: TIMED_SEARCHES,
        macMs: { p50: quantile(macMs, 0.5), p95: quantile(macMs, 0.95) },
        phoneMs: { p50: quantile(phoneMs, 0.5), p95: quantile(phoneMs, 0.95) },
      };
      const overMs = measured.phoneMs.p95 - measured.macMs.p95;
      console.log(JSON.stringify({ ...measured, overMs }));
      const out = process.env["SONDINE_MEASURE_OUT"];
      if (out !== undefined) appendFileSync(out, `${JSON.stringify({ ...measured, overMs })}\n`);
      expect(overMs).toBeLessThan(300);

      // Too many wrong credentials from the phone's address: `busy`, and the phone keeps its credential.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await wrongCredential(join(data.dir, DATA_LAYOUT.phoneSocket));
      }
      expect((await phone.run({ cmd: "sync" }))["outcome"]).toBe("busy");
      expect(await phone.run({ cmd: "state" })).toMatchObject({ paired: true, credential: true });
      await sleep(3_100);
      expect((await phone.run({ cmd: "sync" }))["outcome"]).toBe("done");

      // Deleted on the phone: the Mac's deletion runs at the next sync.
      await phone.run({ cmd: "delete", id: first.id });
      expect(await phone.run({ cmd: "state" })).toMatchObject({ outbox: 1 });
      expect((await phone.run({ cmd: "sync" }))["outcome"]).toBe("done");
      expect(await phone.run({ cmd: "state" })).toMatchObject({ outbox: 0 });
      expect(phoneRow(first.id)).toEqual([{ device_id: deviceId, state: "deleted", sha256: null }]);
      expect(phoneRecordingEpisode(db, first.id)).toBeNull();

      // Deleted on the Mac: the phone removes its folder at the next sync.
      const episodeId = phoneRecordingEpisode(db, second.id);
      if (episodeId === null) throw new Error("no episode");
      await services.episodes.delete({ episodeId });
      expect(await onPhone(second.id)).toBeDefined();
      expect((await phone.run({ cmd: "sync" }))["outcome"]).toBe("done");
      expect(await onPhone(second.id)).toBeUndefined();

      // Away from home through Tailscale (M5.5): the proxy now reaches the relay on `::1`.
      proxy.path("tailnet");
      // Switch off (the default): the relay refuses the peer before TLS.
      expect((await services.phone.status()).tailnet).toBe(false);
      expect((await phone.run({ cmd: "sync" }))["outcome"]).toBe("unreachable");
      // On: the relay starts again with --tailnet on the same port, and the phone syncs through it.
      await services.phone.setTailnet({ enabled: true });
      await waitUntil(async () => (await phone.run({ cmd: "sync" }))["outcome"] === "done", {
        label: "a sync through Tailscale",
        timeoutMs: 20_000,
      });
      expect(await phone.run({ cmd: "state" })).toMatchObject({ paired: true, path: "tailnet" });
      expect((await services.phone.status()).phones[0]?.lastVia).toBe("tailnet");
      const away = await record(deviceId, 3, Date.now() - 120_000);
      expect((await phone.run({ cmd: "sync" }))["outcome"]).toBe("done");
      expect(phoneRow(away.id)).toEqual([
        { device_id: deviceId, state: "stored", sha256: sha(away.bytes) },
      ]);
      expect(await onPhone(away.id)).toMatchObject({ hasAudio: false, stored: true });
      // Pairing is refused on that path, and the phone keeps its pairing.
      const tailnetInvite = (await services.phone.pair()).pairing?.url;
      phone.send({ cmd: "pair", url: tailnetInvite });
      await phone.read();
      expect(await phone.read()).toEqual({ error: "tailnet" });
      expect(await phone.run({ cmd: "state" })).toMatchObject({ paired: true, credential: true });
      // A phone without a credential is refused there too, through the real relay and TLS.
      expect(await tlsHello("::1", relayPort, `sdp_${"C".repeat(43)}`)).toBe(401);
      // Off again: refused, by core at once and by the relay once it started again without
      // --tailnet; back home, the same phone syncs at home.
      await services.phone.setTailnet({ enabled: false });
      expect((await phone.run({ cmd: "sync" }))["outcome"]).toBe("unreachable");
      proxy.path("home");
      await waitUntil(async () => (await phone.run({ cmd: "sync" }))["outcome"] === "done", {
        label: "a sync at home",
        timeoutMs: 20_000,
      });
      expect(await phone.run({ cmd: "state" })).toMatchObject({ path: "home" });
      expect((await services.phone.status()).phones[0]?.lastVia).toBe("loopback");

      // Revoked on the Mac (a pairing for the next phone keeps the relay up): refused at the
      // next request, and the credential is gone.
      await services.phone.pair();
      await services.phone.revoke({ deviceId });
      // The revocation closed the phone's connection at once: a request racing that close is lost
      // (`unreachable`), and the next pass reads `revoked`.
      let outcome = (await phone.run({ cmd: "sync" }))["outcome"];
      if (outcome === "unreachable") outcome = (await phone.run({ cmd: "sync" }))["outcome"];
      expect(outcome).toBe("revoked");
      expect(await phone.run({ cmd: "state" })).toMatchObject({
        paired: false,
        credential: false,
        revoked: true,
      });
    },
  );
});

/** `hello` through the real relay's pinned-less TLS, with this credential: the answer's status. */
function tlsHello(host: string, port: number, credential: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect(
      { host, port, rejectUnauthorized: false, minVersion: "TLSv1.3" },
      () => {
        const body = JSON.stringify({ v: 1, clockMs: Date.now(), recordingIds: [] });
        socket.write(
          `POST /v1/hello HTTP/1.1\r\nhost: mac\r\nauthorization: Bearer ${credential}\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n${body}`,
        );
      },
    );
    let text = "";
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("latin1");
      const status = /^HTTP\/1\.1 (\d{3})/.exec(text)?.[1];
      if (status !== undefined) {
        socket.destroy();
        resolve(Number(status));
      }
    });
    socket.on("error", reject);
    socket.on("close", () => reject(new Error("closed before an answer")));
  });
}

/** A request with a credential the Mac never gave, from the phone's address, as the relay relays it. */
function wrongCredential(socketPath: string): Promise<void> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    socket.write(`${JSON.stringify({ v: 1, via: "loopback", peer: "127.0.0.1" })}\n`);
    socket.write(
      `POST /v1/hello HTTP/1.1\r\nhost: mac\r\nauthorization: Bearer sdp_${"A".repeat(43)}\r\ncontent-length: 2\r\n\r\n{}`,
    );
    socket.on("data", () => socket.destroy());
    socket.on("close", () => resolve());
    socket.on("error", () => resolve());
  });
}
