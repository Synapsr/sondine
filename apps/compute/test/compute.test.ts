import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EngineError,
  NEMOTRON_CAPABILITIES,
  NEMOTRON_MANIFEST,
  NEMOTRON_RESOURCES,
  type AsrEngine,
  type AsrRequest,
  type AsrResult,
  type TranscribeOptions,
} from "@sondine/engines";
import {
  CHUNK_BYTES,
  claimPlace,
  createRemoteAsrEngine,
  formatServerLink,
  generateKeyPair,
  hello,
  leavePlace,
  parseServerLink,
  type Fetch,
  type ServerLink,
} from "@sondine/engines/remote";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClientStore, PLACE_IDLE_MS } from "../src/clients.ts";
import {
  CLAIMS_PER_DAY,
  createComputeServer,
  OPENS_PER_SECOND,
  type BetaOptions,
} from "../src/server.ts";
import { Sessions, type SessionLimits } from "../src/sessions.ts";

const RATE = 16_000;
let state: string;
let cleanups: (() => Promise<void> | void)[];

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "sondine-compute-"));
  cleanups = [() => rmSync(state, { recursive: true, force: true })];
});

afterEach(async () => {
  for (const cleanup of cleanups.toReversed()) await cleanup();
});

type Transcribe = (request: AsrRequest, options: TranscribeOptions) => Promise<AsrResult>;

const heard = (request: AsrRequest, text = "bonjour"): AsrResult => ({
  requestId: request.id,
  text,
  stop: "complete",
  segments: [
    {
      startSec: 0,
      endSec: 0.5,
      text,
      speaker: 0,
      tokens: [{ startSec: 0, endSec: 0.5, text }],
    },
  ],
  languages: ["fr"],
  provenance: {
    engineId: NEMOTRON_MANIFEST.id,
    engineVersion: NEMOTRON_MANIFEST.version,
    runtime: "speech.cpp test",
    adapterClass: "product",
    modelSha256: "x",
    config: {},
  },
  metrics: { audioMs: 0, computeMs: 12 },
});

function fakeEngine(transcribe: Transcribe): AsrEngine & {
  unloads: number;
  /** When the last transcription ended and the model last left, by `performance.now()`. */
  doneAt: number;
  unloadAt: number;
} {
  let busy = false;
  const engine = {
    unloads: 0,
    doneAt: 0,
    unloadAt: 0,
    manifest: NEMOTRON_MANIFEST,
    capabilities: NEMOTRON_CAPABILITIES,
    resources: NEMOTRON_RESOURCES,
    state: () => (busy ? ("busy" as const) : ("ready" as const)),
    pid: () => undefined,
    load: async () => ({ loadMs: 0 }),
    unload: async () => {
      engine.unloads += 1;
      engine.unloadAt = performance.now();
    },
    transcribe: async (request: AsrRequest, options: TranscribeOptions = {}) => {
      if (busy) throw new EngineError("rejected", "two at once");
      busy = true;
      try {
        return await transcribe(request, options);
      } finally {
        busy = false;
        engine.doneAt = performance.now();
      }
    },
  };
  return engine;
}

async function serve(
  transcribe: Transcribe = async (request) => heard(request),
  options: {
    readonly beta?: BetaOptions;
    readonly limits?: Partial<SessionLimits>;
    readonly now?: () => number;
  } = {},
) {
  const clients = new ClientStore(state, options.now);
  const engine = fakeEngine(transcribe);
  const sessions = new Sessions({
    engine,
    known: (id) => clients.has(id),
    onTranscribed: (id, seconds) => clients.charge(id, seconds),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  const server = createComputeServer({
    clients,
    sessions,
    name: "test",
    beta: options.beta ?? null,
    pollHoldMs: 50,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await sessions.stop();
  });
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const serverKey = clients.key().publicKey.toString("base64url");
  const link = (name = "mac"): ServerLink => ({
    endpoint,
    serverKey,
    token: clients.add("own", name).token,
  });
  return { clients, sessions, engine, endpoint, serverKey, link };
}

const remote = (link: ServerLink, extra: { fetch?: Fetch; patienceMs?: number } = {}) =>
  createRemoteAsrEngine({ link, locality: "own", retryMs: 5, patienceMs: 200, ...extra });

const audio = (samples: number) =>
  Int16Array.from({ length: samples }, (_, index) => (index * 7919) % 30_000);

const request = (samples: Int16Array, id = "r1"): AsrRequest => ({
  id,
  samples,
  sampleRate: RATE,
  speakers: true,
  timestamps: true,
});

describe("a transcription", () => {
  it("sends the same audio, in chunks, and brings the words back", async () => {
    let received: AsrRequest | null = null;
    const { link, sessions } = await serve(async (asked, { onProgress }) => {
      received = { ...asked, samples: asked.samples.slice() };
      onProgress?.(0.5);
      return heard(asked);
    });
    const samples = audio(Math.floor((CHUNK_BYTES * 2.5) / 2));
    const progress: number[] = [];
    const result = await remote(link()).transcribe(request(samples), {
      onProgress: (done) => progress.push(done),
    });
    expect(received).toMatchObject({ speakers: true, timestamps: true });
    expect(Buffer.compare(Buffer.from(received!.samples.buffer), Buffer.from(samples.buffer))).toBe(
      0,
    );
    expect(result).toMatchObject({ requestId: "r1", text: "bonjour", stop: "complete" });
    expect(result.segments[0]?.tokens).toHaveLength(1);
    expect(result.provenance.config).toMatchObject({ locality: "own" });
    expect(progress.length).toBeGreaterThan(0);
    await expect.poll(() => sessions.size).toBe(0);
  });

  it("never shows the audio, the token or the text on the wire", async () => {
    const { link } = await serve(async (asked) => heard(asked, "secret sentence"));
    const own = link();
    const seen: Buffer[] = [];
    const spy: Fetch = async (url, init) => {
      if (init.body instanceof Uint8Array) seen.push(Buffer.from(init.body));
      const response = await fetch(url, init);
      const body = Buffer.from(await response.arrayBuffer());
      seen.push(body);
      return new Response(response.status === 204 ? null : body, { status: response.status });
    };
    const samples = new Int16Array(RATE).fill(0x4142);
    await remote(own, { fetch: spy }).transcribe(request(samples));
    const wire = Buffer.concat(seen);
    expect(wire.includes(Buffer.from("secret sentence"))).toBe(false);
    expect(wire.includes(Buffer.from(own.token))).toBe(false);
    expect(wire.includes(Buffer.from("BABABABABABA"))).toBe(false);
  });

  it("keeps no trace of it on disk", async () => {
    const { link } = await serve(async (asked) => heard(asked, "secret sentence"));
    await remote(link()).transcribe(request(audio(RATE)));
    const files = readdirSync(state, { recursive: true, withFileTypes: true }).filter((entry) =>
      entry.isFile(),
    );
    for (const file of files) {
      expect(readFileSync(join(file.parentPath, file.name), "utf8")).not.toContain("secret");
    }
  });

  it("passes on the model's own failures, and calls the rest a crash", async () => {
    const errors = [
      new EngineError("invalid_output", "no times", { reason: "untimed" }),
      new EngineError("deadline", "too long"),
    ];
    const { link } = await serve(async () => {
      throw errors.shift() ?? new Error("none left");
    });
    const engine = remote(link());
    await expect(engine.transcribe(request(audio(RATE)))).rejects.toMatchObject({
      code: "invalid_output",
      reason: "untimed",
    });
    await expect(engine.transcribe(request(audio(RATE)))).rejects.toMatchObject({
      code: "crashed",
    });
  });

  it("refuses times outside the audio it sent", async () => {
    const { link } = await serve(async (asked) => {
      const result = heard(asked);
      return { ...result, segments: [{ ...result.segments[0]!, endSec: 90 }] };
    });
    await expect(remote(link()).transcribe(request(audio(RATE)))).rejects.toMatchObject({
      code: "invalid_output",
    });
  });

  it("sends nothing more once it may not, and the server forgets it", async () => {
    const { link, sessions } = await serve();
    let allowed = 2;
    const sending = remote(link()).transcribe(request(audio(CHUNK_BYTES * 2)), {
      maySend: () => allowed-- > 0,
    });
    await expect(sending).rejects.toMatchObject({ code: "cancelled" });
    await expect.poll(() => sessions.size, { timeout: 5_000 }).toBe(0);
  });

  it("cancels the server's work with the signal", async () => {
    let started = false;
    let stopped = false;
    const { link } = await serve(
      (_, { signal }) =>
        new Promise((_resolve, reject) => {
          started = true;
          signal?.addEventListener("abort", () => {
            stopped = true;
            reject(new EngineError("cancelled", "stopped"));
          });
        }),
    );
    const controller = new AbortController();
    const running = remote(link()).transcribe(request(audio(RATE)), {
      signal: controller.signal,
    });
    running.catch(() => undefined);
    // Once the server has the audio and works on it: sooner, there is no work to stop.
    await expect.poll(() => started, { timeout: 5_000 }).toBe(true);
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: "cancelled" });
    await expect.poll(() => stopped, { timeout: 5_000 }).toBe(true);
  });

  it("survives a connection that drops, and gives up on one that stays down", async () => {
    const { link } = await serve();
    let calls = 0;
    const flaky: Fetch = async (url, init) => {
      calls += 1;
      // The answer to every second chunk or poll is lost after the server took it.
      const response = await fetch(url, init);
      if (calls > 1 && calls % 2 === 0) {
        await response.arrayBuffer();
        throw new TypeError("dropped");
      }
      return response;
    };
    const result = await remote(link(), { fetch: flaky }).transcribe(
      request(audio(CHUNK_BYTES * 2)),
    );
    expect(result.text).toBe("bonjour");
    const down: Fetch = async () => {
      throw new TypeError("down");
    };
    await expect(
      remote(link(), { fetch: down }).transcribe(request(audio(RATE))),
    ).rejects.toMatchObject({ code: "network_unavailable" });
  });

  it("takes turns between Macs", async () => {
    const order: number[] = [];
    const gates: (() => void)[] = [];
    const { link } = await serve(async (asked) => {
      order.push(asked.samples.length);
      await new Promise<void>((resolve) => gates.push(resolve));
      return heard(asked);
    });
    const [first, second] = [link("a"), link("b")];
    // The first Mac sends two before the second sends one.
    const all = [remote(first).transcribe(request(audio(RATE + 1)))];
    await expect.poll(() => order.length).toBe(1);
    all.push(remote(first).transcribe(request(audio(RATE + 2))));
    await new Promise((resolve) => setTimeout(resolve, 80));
    all.push(remote(second).transcribe(request(audio(RATE + 3))));
    await new Promise((resolve) => setTimeout(resolve, 80));
    for (let count = 1; count <= 3; count += 1) {
      await expect.poll(() => gates.length).toBe(count);
      gates[count - 1]?.();
    }
    await Promise.all(all);
    expect(order).toEqual([RATE + 1, RATE + 3, RATE + 2]);
  });
});

describe("the model on the card", () => {
  it("leaves the card a while after its last request", async () => {
    const { link, engine } = await serve(async (asked) => heard(asked), {
      limits: { unloadMs: 1_500 },
    });
    await remote(link()).transcribe(request(audio(RATE)));
    await expect.poll(() => engine.unloads, { timeout: 5_000 }).toBe(1);
    // Measured on the engine, not against the reply: a slow runner may hand
    // the result back after the model has already left.
    expect(engine.unloadAt - engine.doneAt).toBeGreaterThanOrEqual(1_500);
  });

  it("stays on the card when told to", async () => {
    const { link, engine } = await serve(async (asked) => heard(asked), {
      limits: { unloadMs: Number.POSITIVE_INFINITY },
    });
    await remote(link()).transcribe(request(audio(RATE)));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(engine.unloads).toBe(0);
  });
});

describe("what is between a Mac and its server", () => {
  /** Opens a session as a Mac does, then leaves it to the test. */
  async function opened() {
    const server = await serve(() => new Promise(() => undefined));
    const own = server.link();
    const urls: { url: string; init: RequestInit }[] = [];
    const controller = new AbortController();
    const spy: Fetch = (url, init) => {
      urls.push({ url, init });
      return fetch(url, init);
    };
    const running = remote(own, { fetch: spy }).transcribe(request(audio(RATE)), {
      signal: controller.signal,
    });
    running.catch(() => undefined);
    await expect.poll(() => urls.some(({ init }) => init.method === "PUT")).toBe(true);
    await expect.poll(() => urls.filter(({ init }) => init.method === "POST").length).toBe(2);
    const command = urls.findLast(({ init }) => init.method === "POST")!;
    return { ...server, own, controller, running, command };
  }

  it("cannot read, keep alive or drop a session by its address", async () => {
    const { sessions, command, controller } = await opened();
    for (const method of ["GET", "DELETE"]) {
      expect((await fetch(command.url, { method })).status).toBe(405);
    }
    expect((await fetch(command.url, { method: "POST", body: "x".repeat(40) })).status).toBe(400);
    // The Mac's own command, sent again.
    const again = await fetch(command.url, command.init);
    expect(again.status).toBe(400);
    expect(sessions.size).toBe(1);
    controller.abort();
    await expect.poll(() => sessions.size).toBe(0);
  });

  it("cannot pass off audio it dropped as arrived: it goes again", async () => {
    const { link } = await serve();
    let dropped = 0;
    const swallowing: Fetch = async (url, init) => {
      if (init.method === "PUT" && dropped < 2) {
        dropped += 1;
        return new Response(null, { status: 204 });
      }
      return fetch(url, init);
    };
    const result = await remote(link(), { fetch: swallowing }).transcribe(
      request(audio(CHUNK_BYTES)),
    );
    expect(result.text).toBe("bonjour");
    const never: Fetch = async (url, init) =>
      init.method === "PUT" ? new Response(null, { status: 204 }) : fetch(url, init);
    await expect(
      remote(link("b"), { fetch: never }).transcribe(request(audio(RATE))),
    ).rejects.toMatchObject({ code: "network_unavailable" });
  });

  it("cannot hold a Mac forever: no change ends the wait", async () => {
    const { link } = await serve(() => new Promise(() => undefined));
    await expect(
      createRemoteAsrEngine({ link: link(), locality: "own", stalledMs: 150 }).transcribe(
        request(audio(RATE)),
      ),
    ).rejects.toMatchObject({ code: "network_unavailable" });
  });

  it("never lets a server's words into an error", async () => {
    const { link } = await serve(async () => {
      throw new EngineError("invalid_output", "no", { reason: "a sentence someone said" });
    });
    const failure = await remote(link())
      .transcribe(request(audio(RATE)))
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "invalid_output", reason: undefined });
  });

  it("cannot fill the server's memory with strangers' first messages", async () => {
    const { link } = await serve();
    const stranger = { ...link(), token: Buffer.alloc(32, 3).toString("base64url") };
    const codes = await Promise.all(
      Array.from({ length: OPENS_PER_SECOND * 3 }, () =>
        hello(stranger).catch((error: EngineError) => error.code),
      ),
    );
    expect(codes).toContain("unauthorized");
    expect(codes).toContain("network_unavailable");
  });
});

describe("who may use a server", () => {
  it("greets a Mac it knows, and refuses another token, key or model", async () => {
    const { link, clients, endpoint } = await serve();
    const own = link();
    await expect(hello(own)).resolves.toMatchObject({ kind: "hello", name: "test" });
    const stranger = { ...own, token: Buffer.alloc(32, 1).toString("base64url") };
    await expect(hello(stranger)).rejects.toMatchObject({ code: "unauthorized" });
    const impostor = { ...own, serverKey: generateKeyPair().publicKey.toString("base64url") };
    await expect(hello(impostor)).rejects.toMatchObject({ code: "server_mismatch" });
    const id = clients.find(own.token)?.id ?? "";
    clients.remove(id);
    await expect(hello(own)).rejects.toMatchObject({ code: "unauthorized" });
    await expect(remote(own).transcribe(request(audio(RATE)))).rejects.toMatchObject({
      code: "unauthorized",
    });
    // Every body that is not ours is refused without a word.
    const junk = await fetch(`${endpoint}/v1/open`, { method: "POST", body: "hello" });
    expect(junk.status).toBe(400);
    expect((await fetch(`${endpoint}/v1/open`)).status).toBe(404);
    expect((await fetch(`${endpoint}/v1/s/${"0".repeat(32)}`)).status).toBe(404);
  });

  it("stops what a removed Mac already started", async () => {
    let started = false;
    let stopped = false;
    const { link, clients, sessions } = await serve(
      (_, { signal }) =>
        new Promise((_resolve, reject) => {
          started = true;
          signal?.addEventListener("abort", () => {
            stopped = true;
            reject(new EngineError("cancelled", "stopped"));
          });
        }),
    );
    const own = link();
    const running = remote(own).transcribe(request(audio(RATE)));
    running.catch(() => undefined);
    // The session opens before the audio is in: wait for the work itself.
    await expect.poll(() => started, { timeout: 5_000 }).toBe(true);
    clients.remove(clients.find(own.token)!.id);
    await expect(running).rejects.toMatchObject({ code: "server_busy" });
    await expect.poll(() => stopped, { timeout: 5_000 }).toBe(true);
    await expect.poll(() => sessions.size, { timeout: 5_000 }).toBe(0);
  });

  it("refuses a first message sent again, or from a clock too far off", async () => {
    const { link } = await serve();
    const own = link();
    let captured: RequestInit | null = null;
    const spy: Fetch = (url, init) => {
      captured = init;
      return fetch(url, init);
    };
    await hello(own, { fetch: spy });
    const again: Fetch = (url) => fetch(url, captured!);
    // The answer is sealed for the first asker: the replay reads nothing.
    await expect(hello(own, { fetch: again })).rejects.toMatchObject({ code: "server_mismatch" });
    await expect(hello(own, { now: () => Date.now() - 3_600_000 })).rejects.toMatchObject({
      reason: "clock",
    });
  });

  it("says it is busy rather than hold too much", async () => {
    const { link } = await serve(() => new Promise(() => undefined), {
      limits: { maxPerClient: 1 },
    });
    const own = link();
    const controller = new AbortController();
    const first = remote(own).transcribe(request(audio(RATE)), { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await expect(remote(own).transcribe(request(audio(RATE)))).rejects.toMatchObject({
      code: "server_busy",
    });
    controller.abort();
    await expect(first).rejects.toMatchObject({ code: "cancelled" });
  });

  it("forgets a session its Mac left", async () => {
    let at = 1_000_000;
    const { sessions, link } = await serve(undefined, { now: () => Date.now() });
    const own = link();
    expect(own.token).toHaveLength(43);
    const idle = new Sessions({
      engine: fakeEngine(async (asked) => heard(asked)),
      now: () => at,
      limits: { idleMs: 10 },
    });
    cleanups.push(() => idle.stop());
    expect(sessions.size).toBe(0);
    const channel = {
      toServer: { wipe: () => undefined },
      toClient: { wipe: () => undefined },
    } as never;
    idle.add("a".repeat(32), "c", channel, {
      modelSha256: "0".repeat(64),
      engineVersion: "2",
      samples: 10,
      speakers: true,
      timestamps: true,
    });
    at += 100;
    await expect.poll(() => idle.size, { timeout: 8_000 }).toBe(0);
  }, 10_000);
});

describe("the beta's places", () => {
  const beta = { places: 2, secondsPerMonth: 3 };

  it("gives one in one call, up to the limit, and back when left", async () => {
    const { endpoint, serverKey } = await serve(undefined, { beta });
    const server = { endpoint, serverKey };
    const first = await claimPlace(server);
    await claimPlace(server);
    await expect(claimPlace(server)).rejects.toMatchObject({ refusal: "full" });
    await leavePlace({ ...server, token: first });
    // The address used its claims of the day: the limit holds whatever is free.
    expect(CLAIMS_PER_DAY).toBe(3);
    await expect(claimPlace(server)).rejects.toMatchObject({ refusal: "busy" });
  });

  it("has none unless it is opened", async () => {
    const { endpoint, serverKey } = await serve();
    await expect(claimPlace({ endpoint, serverKey })).rejects.toMatchObject({
      refusal: "closed",
    });
  });

  it("takes a place back once closed", async () => {
    const { endpoint, serverKey, clients } = await serve();
    const { id, token } = clients.add("beta", "beta");
    await leavePlace({ endpoint, serverKey, token });
    expect(clients.has(id)).toBe(false);
  });

  it("frees a place nobody used for two weeks, never one in use", () => {
    let at = Date.UTC(2026, 10, 24);
    const clients = new ClientStore(state, () => at);
    const first = clients.claim(2)!;
    const second = clients.claim(2)!;
    expect(clients.claim(2)).toBeNull();
    at += PLACE_IDLE_MS + 1;
    clients.charge(clients.find(second)!.id, 1);
    expect(clients.claim(2)).not.toBeNull();
    expect(clients.find(first)).toBeNull();
    expect(clients.find(second)).not.toBeNull();
    expect(clients.claim(2)).toBeNull();
  });

  it("stops at the month's hours, counted again the next month", async () => {
    let at = Date.now();
    const { endpoint, serverKey, clients } = await serve(undefined, { beta, now: () => at });
    const link = { endpoint, serverKey, token: await claimPlace({ endpoint, serverKey }) };
    const engine = remote(link);
    await engine.transcribe(request(audio(RATE * 2)));
    expect(clients.usage(clients.find(link.token)!.id).seconds).toBe(2);
    await expect(engine.transcribe(request(audio(RATE * 2)))).rejects.toMatchObject({
      code: "quota_exhausted",
    });
    at += 40 * 24 * 3_600_000;
    expect(clients.usage(clients.find(link.token)!.id).seconds).toBe(0);
  });
});

describe("a link", () => {
  it("is read back as written, and nothing else is", () => {
    const link = {
      endpoint: "http://server.example.ts.net:8443",
      serverKey: generateKeyPair().publicKey.toString("base64url"),
      token: Buffer.alloc(32, 7).toString("base64url"),
    };
    expect(parseServerLink(` ${formatServerLink(link)}\n`)).toEqual(link);
    expect(parseServerLink("https://sondine.app")).toBeNull();
    expect(parseServerLink(formatServerLink({ ...link, endpoint: "file:///etc" }))).toBeNull();
    expect(parseServerLink(formatServerLink({ ...link, endpoint: "http://a@b" }))).toBeNull();
    expect(parseServerLink(formatServerLink({ ...link, token: "short" }))).toBeNull();
  });
});
