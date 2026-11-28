import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import {
  ControlMessage,
  createJsonLinesDecoder,
  encodeJsonLine,
  HelperEvent,
  PROTOCOL_VERSION,
  type ClockAnchor,
  type ClockPoint,
  type PermissionState,
  type TrackOpenEvent,
} from "@sondine/protocol";

// A stand-in for `sondine-audio serve` that speaks the real protocol over a
// real Unix socket: hello/ready, acks, snapshot replays, and a synthetic
// microphone track with commits, speech regions and health windows. It never
// opens audio hardware and writes no PCM: commit events name files that do
// not exist, which core does not read in M0.

const TIMEBASE = { numer: 125, denom: 3 } as const;
const MIC_UID = "BuiltInMicrophoneDevice";
const MIC_KEY = `input:${MIC_UID}` as const;
const SAMPLES_PER_COMMIT = 32_000;

export type FakePermissions = "ask" | "granted" | "denied" | "restricted";

export interface FakeHelperOptions {
  readonly socketPath: string;
  /** Emit commits, regions and health on timers (dev mode). Tests drive events by hand. */
  readonly autoplay?: { commitEveryMs: number; healthEveryMs: number } | null;
  readonly protocol?: number;
  readonly startPaused?: boolean;
  /**
   * What the permissions say (the flow lab's variants, ADR 049): `ask`, the
   * default, has the microphone granted and system audio to ask for, which
   * the prompt grants; `denied` and `restricted` stay so whatever is asked.
   */
  readonly permissions?: FakePermissions;
  /**
   * Clocks follow the mic's sample positions instead of real time: a tick is
   * 2 s of capture time however fast the test runs. Tests read the matching
   * wall clock with `wallNowMs`.
   */
  readonly virtualClock?: boolean;
  /** Called after `shutdown` is acknowledged. */
  readonly onShutdown?: () => void;
}

export interface FakeHelper {
  readonly sessionId: string;
  readonly received: ControlMessage[];
  readonly connections: () => number;
  /** The open microphone run, if listening. */
  readonly micRun: () => TrackOpenEvent | null;
  /** Sends one event to every connected client; throws if it is not a valid event. */
  emit(event: HelperEvent): void;
  /**
   * Emits one commit (and, every fifth, a speech region) on the mic run;
   * `speech: false` commits silence only.
   */
  tick(options?: { readonly speech?: boolean }): void;
  /** Wall-clock ms on the helper's clock (ahead of real time with `virtualClock`). */
  wallNowMs(): number;
  /** The helper's clock now, as events carry it. */
  clockNow(): ClockPoint;
  /** Emits a health window. */
  health(): void;
  /** Drops every client connection (the socket keeps listening). */
  dropConnections(): void;
  /** Answers the next control message of `type` with an error instead of an ack. */
  rejectNext(
    type: ControlMessage["type"],
    code: "request.rejected" | "request.invalid" | "internal",
  ): void;
  /** Resolves once a control message of `type` has arrived (counting earlier ones). */
  waitFor(type: ControlMessage["type"], count?: number): Promise<ControlMessage>;
  close(): Promise<void>;
}

function encode(event: HelperEvent): string {
  const encoded = encodeJsonLine(HelperEvent, event);
  if (!encoded.ok) {
    throw new Error(
      `fake helper built an invalid ${event.type}: ${JSON.stringify(encoded.error.issues)}`,
    );
  }
  return encoded.line;
}

export async function startFakeHelper(options: FakeHelperOptions): Promise<FakeHelper> {
  const sessionId = randomUUID();
  const received: ControlMessage[] = [];
  const clients = new Set<Socket>();
  const waiters: {
    type: ControlMessage["type"];
    count: number;
    resolve: (m: ControlMessage) => void;
  }[] = [];
  const started = process.hrtime.bigint();
  const startedWallNs = BigInt(Date.now()) * 1_000_000n;
  const bootContinuousNs = 12_000_000_000_000n;
  /** With `virtualClock`: capture time elapsed since the helper started. */
  let virtualNs = 0n;
  /** With `virtualClock`: the mic run's sample 0 on that clock. */
  let micStartNs = 0n;
  let paused = {
    microphone: options.startPaused ?? false,
    systemAudio: options.startPaused ?? false,
  };
  let mic: TrackOpenEvent | null = null;
  /** A core sent `config`; the mic stays closed before (the real helper's `captureAllowed`). */
  let configured = false;
  let micSamples = 0;
  let commitSeq = 0;
  let epoch = 0;
  let region: { regionId: string; startSample: number } | null = null;
  let ticks = 0;
  let timers: NodeJS.Timeout[] = [];
  const rejections = new Map<
    ControlMessage["type"],
    "request.rejected" | "request.invalid" | "internal"
  >();

  const elapsedNs = () =>
    options.virtualClock === true ? virtualNs : process.hrtime.bigint() - started;
  const now = (): ClockPoint => {
    const continuousNs = bootContinuousNs + elapsedNs();
    return {
      hostTicks: (continuousNs * BigInt(TIMEBASE.denom)) / BigInt(TIMEBASE.numer),
      continuousNs,
    };
  };
  const anchor = (): ClockAnchor => ({
    ...now(),
    wallNs:
      options.virtualClock === true ? startedWallNs + virtualNs : BigInt(Date.now()) * 1_000_000n,
  });
  /** The clock of a mic sample; with a real clock, now. */
  const atSample = (sample: number): ClockPoint => {
    if (options.virtualClock !== true) return now();
    virtualNs = micStartNs + (BigInt(sample) * 1_000_000_000n) / 16_000n;
    return now();
  };

  /** Calls seen (`call.seen`), replayed in snapshots like the real helper's. */
  const seenCalls = new Map<string, HelperEvent>();
  const broadcast = (event: HelperEvent) => {
    const line = encode(event);
    if (event.type === "call.seen") {
      if (event.state === "active") seenCalls.set(event.callId, event);
      else seenCalls.delete(event.callId);
    }
    for (const client of clients) client.write(line);
  };
  const reply = (client: Socket, event: HelperEvent) => client.write(encode(event));

  const given = options.permissions ?? "ask";
  const fixed: PermissionState | null =
    given === "denied" || given === "restricted"
      ? { status: given, evidence: "authorization-status" }
      : null;
  let systemAudio: PermissionState =
    fixed ??
    (given === "granted"
      ? { status: "granted", evidence: "tcc-preflight" }
      : { status: "not-determined", evidence: "authorization-status" });
  const permissions = (replyTo?: string): HelperEvent => ({
    type: "permissions",
    ...(replyTo === undefined ? {} : { replyTo }),
    microphone: fixed ?? { status: "granted-verified", evidence: "first-signal" },
    systemAudio,
  });

  const devices = (replyTo?: string): HelperEvent => ({
    type: "devices",
    ...(replyTo === undefined ? {} : { replyTo }),
    defaultInputUid: MIC_UID,
    defaultOutputUid: "BuiltInSpeakerDevice",
    devices: [
      {
        uid: MIC_UID,
        name: "MacBook Pro Microphone",
        transport: "built-in",
        transportCode: "bltn",
        input: true,
        output: false,
        alive: true,
        nominalRate: 48_000,
        dataSource: "imic",
        loopback: false,
      },
    ],
  });

  const openMic = () => {
    epoch += 1;
    micStartNs = virtualNs;
    const at = anchor();
    mic = {
      type: "track.open",
      trackKey: MIC_KEY,
      runId: randomUUID(),
      epoch,
      start: { hostTicks: at.hostTicks, continuousNs: at.continuousNs },
      anchor: at,
      format: { rate: 16_000, channels: 1, sampleFormat: "s16le" },
      nominalRate: 48_000,
      measuredRate: 48_000.2,
      stream: "running",
      source: {
        kind: "input",
        deviceUid: MIC_UID,
        name: "MacBook Pro Microphone",
        transport: "built-in",
        selection: "default",
      },
    };
    micSamples = 0;
    commitSeq = 0;
    region = null;
    broadcast(mic);
  };

  const closeMic = (reason: "paused" | "shutdown") => {
    if (mic === null) return;
    const run = mic;
    if (region !== null) {
      broadcast({
        type: "region.close",
        trackKey: MIC_KEY,
        runId: run.runId,
        regionId: region.regionId,
        startSample: region.startSample,
        endSample: Math.max(region.startSample + 1, micSamples),
        closeReason: "track-closed",
        speechProbability: { mean: 0.8, max: 0.97 },
        level: { mean: -32, peak: -12 },
        at: now(),
        foreground: [],
      });
      region = null;
    }
    broadcast({
      type: "track.close",
      trackKey: MIC_KEY,
      runId: run.runId,
      epoch: run.epoch,
      endSample: micSamples,
      at: now(),
      reason,
    });
    mic = null;
  };

  const tick = (tickOptions: { readonly speech?: boolean } = {}) => {
    if (mic === null) return;
    const speech = tickOptions.speech ?? true;
    ticks += 1;
    const sampleIndex = micSamples;
    micSamples += SAMPLES_PER_COMMIT;
    const committedAt = atSample(sampleIndex);
    broadcast({
      type: "commit",
      trackKey: MIC_KEY,
      runId: mic.runId,
      file: `input-${MIC_UID}/${mic.runId}/0000.pcm`,
      seq: commitSeq,
      epoch: mic.epoch,
      committedOffset: micSamples * 2,
      sampleIndex,
      sampleCount: SAMPLES_PER_COMMIT,
      crc32: (ticks * 2_654_435_761) >>> 0,
      at: committedAt,
      gaps: [],
    });
    commitSeq += 1;
    if (!speech) {
      atSample(micSamples);
      return;
    }
    if (ticks % 5 === 1 && region === null) {
      region = { regionId: randomUUID(), startSample: sampleIndex + 4_000 };
      broadcast({
        type: "region.open",
        regionId: region.regionId,
        trackKey: MIC_KEY,
        runId: mic.runId,
        epoch: mic.epoch,
        startSample: region.startSample,
        at: atSample(region.startSample),
      });
    } else if (ticks % 5 === 3 && region !== null) {
      broadcast({
        type: "region.close",
        trackKey: MIC_KEY,
        runId: mic.runId,
        regionId: region.regionId,
        startSample: region.startSample,
        endSample: micSamples - 2_000,
        closeReason: "silence",
        speechProbability: { mean: 0.82, max: 0.99 },
        level: { mean: -31.5, peak: -9.25 },
        at: atSample(micSamples - 2_000),
        // Said while Sondine was in front.
        foreground: [
          {
            bundleId: "app.sondine",
            name: "Sondine",
            startSample: region.startSample,
            endSample: micSamples - 2_000,
          },
        ],
      });
      region = null;
    }
    atSample(micSamples);
  };

  const health = () => {
    const tracks = mic === null ? [] : [mic];
    broadcast({
      type: "health",
      at: now(),
      windowMs: 60_000,
      process: { footprintBytes: 31_457_280, cpuNs: 180_000_000, wakeups: 1_520 },
      tracks: tracks.map((track) => ({
        trackKey: track.trackKey,
        runId: track.runId,
        stream: "running" as const,
        measuredRate: 48_000.3,
        level: -52.5 + (ticks % 7),
        zeroRunMs: 0,
        ringHighWaterMs: 120,
        ringOverflows: 0,
        droppedSamples: 0,
        overloads: 0,
      })),
      stages: [
        {
          stage: "io-callback",
          trackKey: MIC_KEY,
          count: 1_406,
          sum: 8_436_000,
          p50: 5_200,
          p95: 9_800,
          max: 41_000,
        },
        {
          stage: "vad",
          trackKey: MIC_KEY,
          count: 234,
          sum: 70_200_000,
          p50: 290_000,
          p95: 410_000,
          max: 980_000,
        },
        {
          stage: "spool-fsync",
          trackKey: null,
          count: 30,
          sum: 27_000_000,
          p50: 800_000,
          p95: 1_500_000,
          max: 4_200_000,
        },
      ],
    });
  };

  const applyPause = (scope: "all" | "microphone" | "system-audio", value: boolean) => {
    if (scope !== "system-audio") paused = { ...paused, microphone: value };
    if (scope !== "microphone") paused = { ...paused, systemAudio: value };
    if (paused.microphone) closeMic("paused");
    else if (mic === null && configured) openMic();
  };

  const onMessage = (client: Socket, message: ControlMessage) => {
    received.push(message);
    const rejection = rejections.get(message.type);
    if (rejection !== undefined) {
      rejections.delete(message.type);
      reply(client, {
        type: "error",
        replyTo: message.id,
        code: rejection,
        message: `fake helper refused ${message.type}`,
        fatal: false,
      });
      notify(message);
      return;
    }
    switch (message.type) {
      case "hello":
        if ((options.protocol ?? PROTOCOL_VERSION) !== message.protocol) {
          reply(client, {
            type: "error",
            replyTo: message.id,
            code: "protocol.unsupported",
            message: "This helper speaks another protocol.",
            fatal: true,
          });
          client.end();
          break;
        }
        reply(client, {
          type: "ready",
          replyTo: message.id,
          protocol: PROTOCOL_VERSION,
          sessionId,
          helper: { version: "0.0.0-fake", build: "fake" },
          os: { version: "27.0.1", build: "26A434" },
          timebase: TIMEBASE,
          paused,
          capabilities: { appTaps: false, maxAppTaps: 0, vad: { engine: "fake", version: "1" } },
        });
        break;
      case "snapshot":
        reply(client, permissions(message.id));
        reply(client, devices(message.id));
        if (mic !== null) reply(client, { ...mic, replyTo: message.id });
        if (mic !== null && region !== null) {
          reply(client, {
            type: "region.open",
            replyTo: message.id,
            regionId: region.regionId,
            trackKey: MIC_KEY,
            runId: mic.runId,
            epoch: mic.epoch,
            startSample: region.startSample,
            at: now(),
          });
        }
        reply(client, { type: "clock", replyTo: message.id, reason: "request", anchor: anchor() });
        for (const call of seenCalls.values()) reply(client, { ...call, replyTo: message.id });
        reply(client, { type: "ack", replyTo: message.id });
        break;
      case "config":
        // Like the real helper, sources open only once core sent its config.
        configured = true;
        if (!paused.microphone && mic === null) openMic();
        reply(client, { type: "ack", replyTo: message.id });
        break;
      case "pause":
      case "resume":
        applyPause(message.scope, message.type === "pause");
        reply(client, { type: "ack", replyTo: message.id });
        break;
      case "request.permissions":
        // Stands for the user granting the prompt.
        if (message.scope !== "microphone" && fixed === null)
          systemAudio = { status: "granted", evidence: "tcc-preflight" };
        reply(client, permissions(message.id));
        reply(client, { type: "ack", replyTo: message.id });
        break;
      case "shutdown":
        closeMic("shutdown");
        reply(client, { type: "ack", replyTo: message.id });
        client.end();
        options.onShutdown?.();
        break;
      default:
        reply(client, { type: "ack", replyTo: message.id });
    }
    notify(message);
  };

  function notify(message: ControlMessage) {
    const seen = received.filter((m) => m.type === message.type).length;
    const due = waiters.filter((waiter) => waiter.type === message.type && seen >= waiter.count);
    for (const waiter of due) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(message);
    }
  }

  mkdirSync(dirname(options.socketPath), { recursive: true, mode: 0o700 });
  rmSync(options.socketPath, { force: true });
  const server: Server = createServer((client) => {
    clients.add(client);
    const decoder = createJsonLinesDecoder(ControlMessage);
    client.on("data", (chunk: Buffer) => {
      for (const result of decoder.push(chunk)) {
        if (result.ok) onMessage(client, result.value);
        else {
          reply(client, {
            type: "error",
            code: "request.invalid",
            message: `line ${result.line}: ${result.error.kind}`.slice(0, 1024),
            fatal: false,
          });
        }
      }
    });
    client.on("error", () => clients.delete(client));
    client.on("close", () => clients.delete(client));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => resolve());
  });
  chmodSync(options.socketPath, 0o600);

  if (options.autoplay) {
    timers = [
      setInterval(tick, options.autoplay.commitEveryMs),
      setInterval(health, options.autoplay.healthEveryMs),
    ];
  }

  return {
    sessionId,
    received,
    connections: () => clients.size,
    micRun: () => mic,
    emit: broadcast,
    tick,
    wallNowMs: () => Number(anchor().wallNs / 1_000_000n),
    clockNow: now,
    health,
    dropConnections() {
      for (const client of clients) client.destroy();
      clients.clear();
    },
    rejectNext(type, code) {
      rejections.set(type, code);
    },
    waitFor(type, count = 1) {
      const seen = received.filter((message) => message.type === type);
      const hit = seen[count - 1];
      if (hit !== undefined) return Promise.resolve(hit);
      return new Promise((resolve) => waiters.push({ type, count, resolve }));
    },
    async close() {
      for (const timer of timers) clearInterval(timer);
      for (const client of clients) client.destroy();
      clients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(options.socketPath, { force: true });
    },
  };
}
