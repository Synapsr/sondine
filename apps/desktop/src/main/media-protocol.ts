import { parseRangeHeader, type ByteRangeSpec } from "../shared/byte-range";
import type { CoreToMain, MainToCore, MediaFailure, MediaType } from "../shared/core-messages";
import {
  parseContextMediaUrl,
  parseEpisodeMediaUrl,
  type ContextMediaTarget,
  type EpisodeMediaTarget,
} from "../shared/media-url";
import { log } from "./log";

// The `sondine-media:` scheme in main (architecture §11). Main only parses
// the window's request and relays it to core, which owns the audio and the
// images added to conversations (ADR 024): each `media-read` or
// `context-read` on core's channel returns one slice of at most
// `MEDIA_SLICE_BYTES`. A response covers the whole range asked for, with its
// exact length (Chromium sizes a custom scheme's media from Content-Length,
// not Content-Range, so a short 206 would cut the episode), and its body
// pulls the next slice from core only when the window reads on: main holds
// one slice at a time, and a seek cancels the body. No Electron import, so
// it is unit-tested.

/** How long core gets to answer one read. */
export const MEDIA_READ_TIMEOUT_MS = 10_000;

export type MediaReply =
  | {
      readonly ok: true;
      readonly mediaType: MediaType;
      readonly total: number;
      readonly start: number;
      readonly end: number;
      readonly bytes: Uint8Array;
    }
  | {
      readonly ok: false;
      readonly reason: MediaFailure | "timeout";
      readonly total: number | null;
    };

export type CoreMediaReply = Extract<CoreToMain, { type: "media-bytes" | "media-failed" }>;

/** An episode's timeline, or a context image's preview. */
export type MediaTarget = EpisodeMediaTarget | ContextMediaTarget;

export type MediaRead = MediaTarget & { readonly range: ByteRangeSpec };

export interface MediaRelay {
  /** Asks core for one slice; `signal` drops it (core skips it if it has not started). */
  read(request: MediaRead, signal?: AbortSignal): Promise<MediaReply>;
  /** Core's answer to a read. */
  receive(message: CoreMediaReply): void;
  /** Core stopped: every pending read fails. */
  stop(): void;
  readonly pending: () => number;
}

export interface MediaRelayOptions {
  /** Posts to core at once; false while core is not running (nothing is queued). */
  readonly send: (message: MainToCore) => boolean;
  readonly timeoutMs?: number;
}

const failed = (reason: MediaFailure | "timeout"): MediaReply => ({
  ok: false,
  reason,
  total: null,
});

export function createMediaRelay(options: MediaRelayOptions): MediaRelay {
  const timeoutMs = options.timeoutMs ?? MEDIA_READ_TIMEOUT_MS;
  const pending = new Map<number, (reply: MediaReply) => void>();
  let nextId = 0;

  return {
    read(request, signal) {
      if (signal?.aborted === true) return Promise.resolve(failed("cancelled"));
      nextId += 1;
      const requestId = nextId;
      return new Promise<MediaReply>((resolve) => {
        const settle = (reply: MediaReply) => {
          if (!pending.delete(requestId)) return;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(reply);
        };
        const giveUp = (reason: "timeout" | "cancelled") => {
          settle(failed(reason));
          options.send({ type: "media-cancel", requestId });
        };
        const onAbort = () => giveUp("cancelled");
        const timer = setTimeout(() => giveUp("timeout"), timeoutMs);
        pending.set(requestId, settle);
        signal?.addEventListener("abort", onAbort, { once: true });
        const sent = options.send(
          "itemId" in request
            ? {
                type: "context-read",
                requestId,
                itemId: request.itemId,
                version: request.version,
                range: request.range,
              }
            : {
                type: "media-read",
                requestId,
                episodeId: request.episodeId,
                generation: request.generation,
                range: request.range,
              },
        );
        if (!sent) settle(failed("unavailable"));
      });
    },
    receive(message) {
      const settle = pending.get(message.requestId);
      if (settle === undefined) return;
      settle(
        message.type === "media-bytes"
          ? {
              ok: true,
              mediaType: message.mediaType,
              total: message.total,
              start: message.start,
              end: message.end,
              bytes: message.bytes,
            }
          : { ok: false, reason: message.reason, total: message.total },
      );
    },
    stop() {
      // Settling deletes the entry; a Map keeps iterating the ones left.
      for (const settle of pending.values()) settle(failed("unavailable"));
    },
    pending: () => pending.size,
  };
}

export interface MediaHandlerOptions {
  readonly relay: MediaRelay;
  /** The origins whose pages may play episodes (`request.initiatorOrigin`). */
  readonly isAllowedInitiator: (origin: string | undefined) => boolean;
}

// Never cached, never sniffed into something other than what core says it is.
const BASE_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

const failureStatus: Record<MediaFailure | "timeout", number> = {
  "not-found": 404,
  stale: 409,
  unsatisfiable: 416,
  busy: 503,
  unavailable: 503,
  cancelled: 503,
  failed: 500,
  timeout: 504,
};

function failureResponse(reply: MediaReply & { ok: false }): Response {
  const headers: Record<string, string> = { ...BASE_HEADERS };
  if (reply.reason === "unsatisfiable" && reply.total !== null) {
    headers["Content-Range"] = `bytes */${reply.total}`;
  }
  if (reply.reason === "busy") headers["Retry-After"] = "1";
  return new Response(null, { status: failureStatus[reply.reason], headers });
}

/** Electron adds `initiatorOrigin` to the requests web content makes. */
function initiatorOf(request: Request): string | undefined {
  return "initiatorOrigin" in request && typeof request.initiatorOrigin === "string"
    ? request.initiatorOrigin
    : undefined;
}

/**
 * Answers one request: `200` (no usable `Range`), `206`, or an error status
 * (`404` unknown or deleted episode or item, `409` stale generation, `416`,
 * `405` for anything but GET, `403` from another origin, `503`, `504`).
 */
export async function handleMediaRequest(
  request: Request,
  options: MediaHandlerOptions,
): Promise<Response> {
  if (request.method !== "GET") {
    return new Response(null, { status: 405, headers: { ...BASE_HEADERS, Allow: "GET" } });
  }
  if (!options.isAllowedInitiator(initiatorOf(request))) {
    return new Response(null, { status: 403, headers: BASE_HEADERS });
  }
  const target: MediaTarget | null =
    parseEpisodeMediaUrl(request.url) ?? parseContextMediaUrl(request.url);
  if (target === null) return new Response(null, { status: 404, headers: BASE_HEADERS });
  const asked = parseRangeHeader(request.headers.get("range"));
  const first = await options.relay.read({
    ...target,
    range: asked ?? { kind: "range", start: 0, end: null },
  });
  if (!first.ok) return failureResponse(first);
  const { total, start, end, bytes, mediaType } = first;
  // An episode is audio, a context item an image: never anything else.
  const expected = "itemId" in target ? mediaType !== "audio/wav" : mediaType === "audio/wav";
  if (!expected || bytes.byteLength === 0 || start + bytes.byteLength - 1 > end || end >= total) {
    log.warn("media.bad-reply", { start, end, total, bytes: bytes.byteLength });
    return new Response(null, { status: 500, headers: BASE_HEADERS });
  }
  const headers: Record<string, string> = {
    ...BASE_HEADERS,
    "Content-Type": mediaType,
    "Accept-Ranges": "bytes",
    "Content-Length": String(end - start + 1),
  };
  if (asked !== null) headers["Content-Range"] = `bytes ${start}-${end}/${total}`;
  return new Response(slices(options.relay, target, first), {
    status: asked === null ? 200 : 206,
    headers,
  });
}

/**
 * The response body: the first slice, then one more from core each time the
 * window reads on. A failed slice (the episode deleted or regrouped, core
 * gone) errors the body, so the audio element stops; cancelling it drops the
 * read under way.
 */
function slices(
  relay: MediaRelay,
  target: MediaTarget,
  first: MediaReply & { ok: true },
): ReadableStream<Uint8Array> {
  let next = first.start + first.bytes.byteLength;
  let reading: AbortController | null = null;
  let cancelled = false;
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        controller.enqueue(first.bytes);
        if (next > first.end) controller.close();
      },
      async pull(controller) {
        const abort = new AbortController();
        reading = abort;
        const reply = await relay.read(
          { ...target, range: { kind: "range", start: next, end: first.end } },
          abort.signal,
        );
        reading = null;
        if (cancelled) return;
        if (!reply.ok || reply.total !== first.total || reply.start !== next) {
          const reason = reply.ok ? "changed" : reply.reason;
          log.warn("media.stream-stopped", { reason });
          controller.error(new Error(`Playback stopped: ${reason}`));
          return;
        }
        controller.enqueue(reply.bytes);
        next += reply.bytes.byteLength;
        if (next > first.end) controller.close();
      },
      cancel() {
        cancelled = true;
        reading?.abort();
      },
    },
    { highWaterMark: 0 },
  );
}
