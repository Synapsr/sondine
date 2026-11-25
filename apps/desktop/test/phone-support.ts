import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { request, type IncomingHttpHeaders } from "node:http";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  loadJournalSource,
  phoneRecordingEpisode,
  publishJournalRun,
  startJournalRun,
  type Database as Db,
} from "@sondine/db";
import {
  PairAnswer,
  parsePairingUrl,
  phoneAudioPath,
  PHONE_OFFSET_HEADER,
  UploadStatus,
} from "@sondine/protocol";
import { expect } from "vitest";
import { Api } from "../src/core/api-services";
import { Database } from "../src/core/database";
import type { RelayProcess } from "../src/core/phone/lan-relay";
import type { PairingClock } from "../src/core/phone/pairing";
import { pairingDigits } from "../src/core/phone/pairing-digits";
import type { PhoneOptions } from "../src/core/phone/phone-layer";
import { makeCoreRuntime, type CoreLayerOptions } from "../src/core/runtime";
import { DATA_LAYOUT } from "../src/shared/data-layout";
import { engineLayer, fakeEngine, fakeSignals } from "./fake-engine";
import { captureOptions, recordingMain, tempDataDir, waitUntil } from "./support";

// A phone talking to the real core (ADR 008), for the runtime tests: the
// relay is a fake that only says it listens; the phone is the test, speaking
// HTTP on `run/phone.sock` after the relay's line, as `sondine-lan` relays
// it. The recordings are CAF files with Sondine's header in their info
// chunk, which `afinfo` and `afconvert` read as they read the app's m4a.

/** What each test leaves to close; the test file runs them after each test. */
export const cleanups: (() => Promise<void> | void)[] = [];

/** Real time for sockets, moved by hand for the pairing's minutes and the blocks. */
export function testClock(): PairingClock & { advance(ms: number): void } {
  let offset = 0;
  const timers = new Set<{ at: number; fn: () => void }>();
  const now = () => Date.now() + offset;
  return {
    now,
    after(ms, fn) {
      const timer = { at: now() + ms, fn };
      timers.add(timer);
      return () => timers.delete(timer);
    },
    advance(ms) {
      offset += ms;
      for (const timer of [...timers].toSorted((a, b) => a.at - b.at)) {
        if (timer.at <= now() && timers.delete(timer)) timer.fn();
      }
    },
  };
}

/** `sondine-lan` as core sees it: it says it listens, and exits when its stdin ends. */
export function fakeRelay() {
  const runs: { args: readonly string[]; running: boolean }[] = [];
  const spawn = (_binary: string, args: readonly string[]): RelayProcess => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const run = { args, running: true };
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr: new PassThrough(),
      kill: () => true,
    });
    stdin.on("finish", () => {
      run.running = false;
      child.emit("exit", 0, null);
    });
    setImmediate(() => stdout.write(`${JSON.stringify({ event: "listening", port: 49_321 })}\n`));
    runs.push(run);
    return child;
  };
  return { spawn, runs, running: () => runs.filter((run) => run.running).length };
}

/** Core with a fake relay; `core` adds layer options (an analysis engine, say). */
export function setup(
  phone: Omit<PhoneOptions, "spawn" | "clock"> = {},
  core: Omit<CoreLayerOptions, "phone"> = {},
) {
  const data = tempDataDir();
  cleanups.push(() => data.cleanup());
  const relay = fakeRelay();
  const clock = testClock();
  const start = () =>
    makeCoreRuntime(
      data.config({ phoneRelay: { path: "/fake/sondine-lan", allowLoopback: true } }),
      recordingMain(),
      { ...captureOptions(data), ...core, phone: { spawn: relay.spawn, clock, ...phone } },
    );
  const socketPath = join(data.dir, DATA_LAYOUT.phoneSocket);
  const s = {
    data,
    runtime: start(),
    relay,
    clock,
    socketPath,
    /** Core stopped and started again on the same data; `meanwhile` runs while it is down. */
    async restart(meanwhile?: () => void) {
      await s.runtime.dispose();
      meanwhile?.();
      s.runtime = start();
      await s.runtime.runPromise(Api);
    },
  };
  cleanups.push(() => s.runtime.dispose());
  return s;
}

export type Setup = ReturnType<typeof setup>;

export interface Answer {
  readonly status: number;
  readonly body: unknown;
  readonly headers: IncomingHttpHeaders;
}

export interface PhoneRequest {
  readonly method?: "POST" | "PUT" | "GET";
  readonly path: string;
  readonly body?: unknown;
  readonly bytes?: Buffer;
  readonly credential?: string;
  readonly headers?: Record<string, string>;
  readonly peer?: string;
  readonly via?: "lan" | "tailnet" | "loopback";
}

/** One request from a phone, on its own connection, through the relay's line. */
export function send(socketPath: string, call: PhoneRequest): Promise<Answer> {
  const payload =
    call.bytes ?? (call.body === undefined ? undefined : Buffer.from(JSON.stringify(call.body)));
  let opened: Socket | null = null;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        method: call.method ?? "POST",
        path: call.path,
        // No agent: `createConnection` is used only then.
        headers: {
          // As URLSession does: Node's client says `close` without an agent.
          connection: "keep-alive",
          ...(payload === undefined ? {} : { "content-length": String(payload.length) }),
          ...(call.credential === undefined ? {} : { authorization: `Bearer ${call.credential}` }),
          ...call.headers,
        },
        createConnection: () => {
          const socket = connect(socketPath);
          opened = socket;
          socket.write(
            `${JSON.stringify({ v: 1, via: call.via ?? "lan", peer: call.peer ?? "192.168.1.20" })}\n`,
          );
          return socket;
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          // One connection per request: core holds 16, and a phone keeps one.
          opened?.destroy();
          resolve({
            status: res.statusCode ?? 0,
            body: text === "" ? null : JSON.parse(text),
            headers: res.headers,
          });
        });
      },
    );
    req.on("error", (error) =>
      reject(new Error(`${call.method ?? "POST"} ${call.path}: ${error.message}`)),
    );
    req.end(payload);
  });
}

export const api = (s: Setup) => s.runtime.runPromise(Api);
export const database = (s: Setup): Promise<Db> => s.runtime.runPromise(Database);

export const PIN_LENGTH = 64;

/** Opens a pairing on the Mac: its token and pin, read from the QR's text. */
export async function openPairing(s: Setup) {
  const status = await (await api(s)).phone.pair();
  const invite = parsePairingUrl(status.pairing?.url ?? "");
  if (invite === null) throw new Error("no QR");
  expect(invite.pin).toHaveLength(PIN_LENGTH);
  return invite;
}

/** Pairs a phone: it presents the token, the user answers « Appairer ». */
export async function pairPhone(s: Setup, deviceId = randomUUID(), name = "iPhone de Téo") {
  const invite = await openPairing(s);
  const services = await api(s);
  const held = send(s.socketPath, {
    path: "/v1/pair",
    body: { v: 1, token: invite.token, deviceId, deviceName: name },
  });
  const asked = await waitUntil(
    async () => {
      const pairing = (await services.phone.status()).pairing;
      return pairing?.phase === "asked" ? pairing : null;
    },
    { label: "the phone asks" },
  );
  expect(asked.digits).toBe(pairingDigits(invite.token, deviceId, invite.pin));
  expect(asked.deviceName).toBe(name);
  await services.phone.answer({ accept: true });
  const answer = await held;
  expect(answer.status).toBe(200);
  return { deviceId, credential: PairAnswer.parse(answer.body).credential };
}

export type Phone = Awaited<ReturnType<typeof pairPhone>>;

/** A recording as the iPhone app makes it: Sondine's header in the comment, 16 kHz mono. */
export function phoneFile(
  phone: Phone,
  recordingId = randomUUID(),
  seconds = 3,
  tone = 10,
): Buffer {
  const samples = new Int16Array(16_000 * seconds);
  for (let i = 0; i < samples.length; i += 1) samples[i] = Math.round(8_000 * Math.sin(i / tone));
  return cafFile(phone, recordingId, samples);
}

/** A phone file with two stretches of sound and a silence between: two voices. */
export function twoTurns(phone: Phone, recordingId: string, seconds = 16): Buffer {
  const rate = 16_000;
  const samples = new Int16Array(rate * seconds);
  for (let i = 0; i < samples.length; i += 1) {
    const second = i / rate;
    const sounding = second < 3 || second >= seconds - 3;
    samples[i] = sounding ? Math.round(8_000 * Math.sin(i / 10)) : 0;
  }
  return cafFile(phone, recordingId, samples);
}

/** A CAF chunk: its type, its length, its body. */
function cafChunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(12);
  head.write(type, 0, "latin1");
  head.writeBigInt64BE(BigInt(body.length), 4);
  return Buffer.concat([head, body]);
}

/** A CAF with Sondine's header in its info chunk, 16 kHz mono PCM. */
export function cafFile(phone: Phone, recordingId: string, samples: Int16Array): Buffer {
  const header = JSON.stringify({
    sondine: "phone-recording",
    v: 1,
    recordingId,
    sessionId: randomUUID(),
    part: 1,
    startedWallMs: Date.now() - 600_000,
    utcOffsetMin: 60,
    deviceId: phone.deviceId,
    input: "built-in",
    previous: null,
    app: "0.1.0 (12)",
  });
  const desc = Buffer.alloc(32);
  desc.writeDoubleBE(16_000, 0);
  desc.write("lpcm", 8, "latin1");
  desc.writeUInt32BE(2, 12); // little endian
  desc.writeUInt32BE(2, 16);
  desc.writeUInt32BE(1, 20);
  desc.writeUInt32BE(1, 24);
  desc.writeUInt32BE(16, 28);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(1);
  return Buffer.concat([
    Buffer.from("caff", "latin1"),
    Buffer.from([0, 1, 0, 0]),
    cafChunk("desc", desc),
    cafChunk("info", Buffer.concat([count, Buffer.from(`comments\0${header}\0`, "utf8")])),
    cafChunk("data", Buffer.concat([Buffer.alloc(4), Buffer.from(samples.buffer)])),
  ]);
}

export const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export const announce = (s: Setup, phone: Phone, recordingId: string, file: Buffer) =>
  send(s.socketPath, {
    path: "/v1/recordings/announce",
    credential: phone.credential,
    body: { recordingId, bytes: file.length, sha256: sha(file) },
  });

export const put = (s: Setup, phone: Phone, recordingId: string, bytes: Buffer, offset: number) =>
  send(s.socketPath, {
    method: "PUT",
    path: phoneAudioPath(recordingId),
    credential: phone.credential,
    headers: { [PHONE_OFFSET_HEADER]: String(offset) },
    bytes,
  });

export const states = (s: Setup, phone: Phone, recordingIds: string[]) =>
  send(s.socketPath, {
    path: "/v1/recordings/states",
    credential: phone.credential,
    body: { recordingIds },
  });

export const remove = (s: Setup, phone: Phone, recordingId: string, operationId = randomUUID()) =>
  send(s.socketPath, {
    path: "/v1/recordings/delete",
    credential: phone.credential,
    body: { operationId, recordingId },
  });

export const upload = (answer: Answer) => UploadStatus.parse(answer.body);

/** Announces and sends a whole file: the Mac's last answer. */
export async function sync(s: Setup, phone: Phone, recordingId: string, file: Buffer) {
  const first = upload(await announce(s, phone, recordingId, file));
  if (first.status !== "send") return first;
  return upload(await put(s, phone, recordingId, file.subarray(first.offset), first.offset));
}

/** Core's analysis with the fake engine, which hears « Bonjour Sondine » in each stretch of sound. */
export const analysis = {
  analysis: {
    engine: engineLayer(() => fakeEngine()),
    signals: fakeSignals().layer,
    timing: { admissionIntervalMs: 30, idleUnloadMs: 150, rssIntervalMs: 30, noModelPollMs: 30 },
  },
};

/** Sends a two-voice recording and waits for its transcript: the recording's id and episode. */
export async function readyRecording(
  s: Setup,
  phone: Phone,
  recordingId = randomUUID(),
  seconds = 16,
) {
  expect(await sync(s, phone, recordingId, twoTurns(phone, recordingId, seconds))).toEqual({
    status: "stored",
  });
  const db = await database(s);
  const episodeId = phoneRecordingEpisode(db, recordingId);
  if (episodeId === null) throw new Error("not stored");
  await waitUntil(
    async () => {
      const answer = await states(s, phone, [recordingId]);
      return JSON.stringify(answer.body).includes('"ready"');
    },
    { label: "the transcript", timeoutMs: 20_000 },
  );
  return { recordingId, episodeId };
}

/** The journal written (again) for an episode, as the journal's work publishes it. */
export function writeJournal(
  db: Db,
  episodeId: number,
  text: string,
  segmentIds: readonly number[],
  labels: readonly string[],
) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const source = loadJournalSource(db, episodeId, zone, Date.now());
  if (source === null) throw new Error("nothing to write about");
  const runId = startJournalRun(db, {
    episodeId,
    asrRunId: source.asrRunId,
    inputHash: source.inputHash,
    configKey: "test",
    engineId: "engine",
    modelSha256: null,
    speakerRefs: Object.fromEntries(labels.map((label, index) => [`P${index + 1}`, label])),
    nowMs: Date.now(),
  });
  const published = publishJournalRun(db, {
    runId,
    items: [
      {
        kind: "event",
        text,
        whoRef: null,
        toRef: null,
        due: null,
        dueText: null,
        segmentIds: [segmentIds[0] ?? 0],
      },
      {
        kind: "commitment",
        text: "{P2} envoie le tableau à {P1}",
        whoRef: "P2",
        toRef: "P1",
        due: "2026-11-20",
        dueText: "jeudi",
        segmentIds: [segmentIds.at(-1) ?? 0],
      },
    ],
    metrics: {},
    timeZone: zone,
    nowMs: Date.now(),
  });
  expect(published).toMatchObject({ published: true });
}
