import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveByteRange } from "../shared/byte-range";
import type { MainToCore, MediaFailure } from "../shared/core-messages";
import {
  createMediaRelay,
  handleMediaRequest,
  MEDIA_READ_TIMEOUT_MS,
  type CoreMediaReply,
  type MediaRelay,
} from "./media-protocol";

// Main's half of the media scheme against a fake core that answers like the
// real one: one slice per read, from a WAV held here.

const URL_7 = "sondine-media://episode/7?g=2";
const APP = "sondine://app";

type MediaReadMessage = Extract<MainToCore, { type: "media-read" }>;

/** A core holding `wav`, answering each read with at most `slice` bytes. */
function fakeCore(wav: Uint8Array, options: { slice?: number; deferred?: boolean } = {}) {
  const slice = options.slice ?? 1_000;
  const sent: MainToCore[] = [];
  const waiting: (() => void)[] = [];
  const state: { failure: MediaFailure | null; wav: Uint8Array } = { failure: null, wav };
  const answer = (message: MediaReadMessage): CoreMediaReply => {
    const total = state.wav.byteLength;
    if (state.failure !== null) {
      return {
        type: "media-failed",
        requestId: message.requestId,
        reason: state.failure,
        total: null,
      };
    }
    const range = resolveByteRange(message.range, total);
    if (range === null) {
      return { type: "media-failed", requestId: message.requestId, reason: "unsatisfiable", total };
    }
    return {
      type: "media-bytes",
      mediaType: "audio/wav",
      requestId: message.requestId,
      total,
      start: range.start,
      end: range.end,
      bytes: state.wav.slice(range.start, Math.min(range.end + 1, range.start + slice)),
    };
  };
  const relay: MediaRelay = createMediaRelay({
    send: (message) => {
      sent.push(message);
      if (message.type === "media-read") {
        const reply = () => relay.receive(answer(message));
        if (options.deferred === true) waiting.push(reply);
        else queueMicrotask(reply);
      }
      return true;
    },
  });
  const reads = () => sent.filter((message) => message.type === "media-read");
  const flush = () => {
    for (const reply of waiting.splice(0)) reply();
  };
  return { relay, sent, reads, state, flush };
}

function wavOf(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index * 31 + 7) % 256);
}

function request(
  url = URL_7,
  init: { method?: string; range?: string | undefined; initiator?: string | null } = {},
): Request {
  const headers = new Headers();
  if (init.range !== undefined) headers.set("Range", init.range);
  const made = new Request(url, { method: init.method ?? "GET", headers });
  // Electron adds this to requests that web content makes.
  return init.initiator === null
    ? made
    : Object.assign(made, { initiatorOrigin: init.initiator ?? APP });
}

const serve = (relay: MediaRelay, req: Request) =>
  handleMediaRequest(req, { relay, isAllowedInitiator: (origin) => origin === APP });

async function body(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer());
}

afterEach(() => {
  vi.useRealTimers();
});

describe("media requests", () => {
  it("answers a range with 206, the whole range's length, and the bytes slice by slice", async () => {
    const wav = wavOf(5_000);
    const core = fakeCore(wav);
    const response = await serve(core.relay, request(URL_7, { range: "bytes=1500-" }));
    expect(response.status).toBe(206);
    expect(Object.fromEntries(response.headers)).toEqual({
      "accept-ranges": "bytes",
      "cache-control": "no-store",
      "content-length": "3500",
      "content-range": "bytes 1500-4999/5000",
      "content-type": "audio/wav",
      "x-content-type-options": "nosniff",
    });
    // Only the first slice is read before the window asks for more.
    expect(core.reads()).toEqual([
      {
        type: "media-read",
        requestId: 1,
        episodeId: 7,
        generation: 2,
        range: { kind: "range", start: 1500, end: null },
      },
    ]);
    expect(await body(response)).toEqual(wav.subarray(1_500));
    expect(core.reads().map((read) => read.range)).toEqual([
      { kind: "range", start: 1_500, end: null },
      { kind: "range", start: 2_500, end: 4_999 },
      { kind: "range", start: 3_500, end: 4_999 },
      { kind: "range", start: 4_500, end: 4_999 },
    ]);
    expect(core.relay.pending()).toBe(0);
  });

  it("serves a closed range and a suffix", async () => {
    const wav = wavOf(5_000);
    const closed = await serve(fakeCore(wav).relay, request(URL_7, { range: "bytes=10-2009" }));
    expect(closed.status).toBe(206);
    expect(closed.headers.get("content-range")).toBe("bytes 10-2009/5000");
    expect(closed.headers.get("content-length")).toBe("2000");
    expect(await body(closed)).toEqual(wav.subarray(10, 2_010));
    const suffix = await serve(fakeCore(wav).relay, request(URL_7, { range: "bytes=-44" }));
    expect(suffix.headers.get("content-range")).toBe("bytes 4956-4999/5000");
    expect(await body(suffix)).toEqual(wav.subarray(4_956));
  });

  it("answers 200 with the whole WAV when there is no usable Range", async () => {
    const wav = wavOf(2_345);
    for (const range of [undefined, "bytes=0-5,10-20", "items=0-"]) {
      const response = await serve(fakeCore(wav).relay, request(URL_7, { range }));
      expect(response.status, range).toBe(200);
      expect(response.headers.get("content-length")).toBe("2345");
      expect(response.headers.get("content-range")).toBeNull();
      expect(response.headers.get("accept-ranges")).toBe("bytes");
      expect(await body(response)).toEqual(wav);
    }
  });

  it("answers 416 with the WAV's length for a range past its end", async () => {
    const core = fakeCore(wavOf(5_000));
    const response = await serve(core.relay, request(URL_7, { range: "bytes=5000-" }));
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */5000");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("maps core's refusals to statuses", async () => {
    const cases: [MediaFailure, number][] = [
      ["not-found", 404],
      ["stale", 409],
      ["busy", 503],
      ["unavailable", 503],
      ["failed", 500],
    ];
    for (const [failure, status] of cases) {
      const core = fakeCore(wavOf(100));
      core.state.failure = failure;
      const response = await serve(core.relay, request(URL_7, { range: "bytes=0-" }));
      expect(response.status, failure).toBe(status);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("retry-after")).toBe(failure === "busy" ? "1" : null);
    }
  });

  it("refuses other methods, other pages and other URLs before asking core", async () => {
    const core = fakeCore(wavOf(100));
    for (const method of ["HEAD", "POST", "PUT", "DELETE", "OPTIONS"]) {
      const response = await serve(core.relay, request(URL_7, { method }));
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow")).toBe("GET");
    }
    for (const initiator of [null, "https://example.com", "null"]) {
      const response = await serve(core.relay, request(URL_7, { initiator }));
      expect(response.status, String(initiator)).toBe(403);
    }
    for (const url of [
      "sondine-media://episode/7",
      "sondine-media://episode/7?g=2&x=1",
      "sondine-media://other/7?g=2",
      "sondine-media://episode/abc?g=2",
    ]) {
      expect((await serve(core.relay, request(url))).status, url).toBe(404);
    }
    expect(core.sent).toEqual([]);
  });

  it("stops the body when the episode is deleted between two slices", async () => {
    const core = fakeCore(wavOf(5_000));
    const response = await serve(core.relay, request(URL_7, { range: "bytes=0-" }));
    expect(response.status).toBe(206);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("expected a body");
    expect((await reader.read()).value?.byteLength).toBe(1_000);
    core.state.failure = "not-found";
    await expect(reader.read()).rejects.toThrow(/not-found/);
  });

  it("stops the body when the WAV changes length under it", async () => {
    const core = fakeCore(wavOf(5_000));
    const response = await serve(core.relay, request(URL_7, { range: "bytes=0-" }));
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("expected a body");
    await reader.read();
    core.state.wav = wavOf(6_000);
    await expect(reader.read()).rejects.toThrow(/changed/);
  });

  it("cancels the read under way when the window drops the body (a seek)", async () => {
    const core = fakeCore(wavOf(5_000), { deferred: true });
    const responding = serve(core.relay, request(URL_7, { range: "bytes=0-" }));
    core.flush();
    const response = await responding;
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("expected a body");
    await reader.read();
    // The window asks for more, then seeks away before core answers.
    const more = reader.read();
    await Promise.resolve();
    expect(core.relay.pending()).toBe(1);
    await reader.cancel();
    expect(core.sent.at(-1)).toEqual({ type: "media-cancel", requestId: 2 });
    expect(core.relay.pending()).toBe(0);
    expect((await more).done).toBe(true);
    // Core's late answer is dropped.
    core.flush();
    expect(core.relay.pending()).toBe(0);
  });
});

describe("context images", () => {
  it("relays a context URL as `context-read` and serves the image with core's type", async () => {
    const sent: MainToCore[] = [];
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2]);
    const relay: MediaRelay = createMediaRelay({
      send: (message) => {
        sent.push(message);
        if (message.type === "context-read") {
          queueMicrotask(() =>
            relay.receive({
              type: "media-bytes",
              requestId: message.requestId,
              mediaType: "image/png",
              total: png.byteLength,
              start: 0,
              end: png.byteLength - 1,
              bytes: png.slice(),
            }),
          );
        }
        return true;
      },
    });
    const response = await serve(relay, request("sondine-media://context/3?v=0123456789abcdef"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await body(response)).toEqual(png);
    expect(sent[0]).toMatchObject({ type: "context-read", itemId: 3, version: "0123456789abcdef" });
  });

  it("refuses audio for a context URL", async () => {
    const relay: MediaRelay = createMediaRelay({
      send: (message) => {
        if (message.type === "context-read") {
          queueMicrotask(() =>
            relay.receive({
              type: "media-bytes",
              requestId: message.requestId,
              mediaType: "audio/wav",
              total: 2,
              start: 0,
              end: 1,
              bytes: Uint8Array.from([1, 2]),
            }),
          );
        }
        return true;
      },
    });
    const response = await serve(relay, request("sondine-media://context/3?v=0123456789abcdef"));
    expect(response.status).toBe(500);
  });
});

describe("media relay", () => {
  it("fails at once while core is down, and fails what is pending when it stops", async () => {
    const down = createMediaRelay({ send: () => false });
    expect(
      await down.read({ episodeId: 1, generation: 1, range: { kind: "suffix", length: 1 } }),
    ).toEqual({ ok: false, reason: "unavailable", total: null });
    expect(down.pending()).toBe(0);

    const up = createMediaRelay({ send: () => true });
    const first = up.read({
      episodeId: 1,
      generation: 1,
      range: { kind: "range", start: 0, end: null },
    });
    const second = up.read({
      episodeId: 2,
      generation: 1,
      range: { kind: "range", start: 0, end: null },
    });
    expect(up.pending()).toBe(2);
    up.stop();
    expect(await first).toMatchObject({ ok: false, reason: "unavailable" });
    expect(await second).toMatchObject({ ok: false, reason: "unavailable" });
    // Answers for reads already settled, or never made, are ignored.
    up.receive({ type: "media-failed", requestId: 1, reason: "stale", total: null });
    up.receive({ type: "media-failed", requestId: 99, reason: "stale", total: null });
    expect(up.pending()).toBe(0);
  });

  it("gives up on core after the timeout and tells it to skip the read", async () => {
    vi.useFakeTimers();
    const sent: MainToCore[] = [];
    const relay = createMediaRelay({ send: (message) => sent.push(message) > 0 });
    const reply = relay.read({ episodeId: 1, generation: 1, range: { kind: "suffix", length: 4 } });
    vi.advanceTimersByTime(MEDIA_READ_TIMEOUT_MS - 1);
    expect(relay.pending()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(await reply).toEqual({ ok: false, reason: "timeout", total: null });
    expect(sent.at(-1)).toEqual({ type: "media-cancel", requestId: 1 });
  });

  it("answers 504 when core does not answer in time", async () => {
    vi.useFakeTimers();
    const relay = createMediaRelay({ send: () => true });
    const responding = serve(relay, request(URL_7, { range: "bytes=0-" }));
    vi.advanceTimersByTime(MEDIA_READ_TIMEOUT_MS);
    expect((await responding).status).toBe(504);
  });

  it("drops a read whose signal aborts", async () => {
    const sent: MainToCore[] = [];
    const relay = createMediaRelay({ send: (message) => sent.push(message) > 0 });
    const abort = new AbortController();
    const reply = relay.read(
      { episodeId: 1, generation: 1, range: { kind: "suffix", length: 4 } },
      abort.signal,
    );
    abort.abort();
    expect(await reply).toEqual({ ok: false, reason: "cancelled", total: null });
    expect(sent.map((message) => message.type)).toEqual(["media-read", "media-cancel"]);
    const already = relay.read(
      { episodeId: 1, generation: 1, range: { kind: "suffix", length: 4 } },
      abort.signal,
    );
    expect(await already).toMatchObject({ reason: "cancelled" });
    expect(sent).toHaveLength(2);
  });
});
