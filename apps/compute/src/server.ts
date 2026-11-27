import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { NEMOTRON_ARTIFACT, NEMOTRON_CAPABILITIES, NEMOTRON_MANIFEST } from "@sondine/engines";
import {
  CHUNK_BYTES,
  MAX_COMMAND_BYTES,
  MAX_OPEN_BYTES,
  NoiseError,
  Open,
  OPEN_WINDOW_MS,
  POLL_HOLD_MS,
  PROLOGUE,
  respond,
  TAG_BYTES,
  type AsrJob,
  type OpenReply,
  type RefusalCode,
  type Responded,
} from "@sondine/engines/remote";
import type { BillingService } from "./billing.ts";
import { isInvitedPlan, planOf, type ClientStore } from "./clients.ts";
import type { ServerLog, Sessions } from "./sessions.ts";

// The HTTP face (packages/engines/src/remote/wire.ts). Plain HTTP: every
// message is sealed for this server's key, whatever carries it (Tailscale, a
// tunnel, a local network). Nothing about a request is logged.

export interface BetaOptions {
  readonly places: number;
  readonly secondsPerMonth: number;
}

export interface ComputeServerOptions {
  readonly clients: ClientStore;
  readonly sessions: Sessions;
  readonly name: string;
  /** Null: no beta here. */
  readonly beta: BetaOptions | null;
  /** Null: this server takes no payment (ADR 047). */
  readonly billing?: BillingService | null;
  /** The header a trusted tunnel puts the caller's address in, to slow down claims. */
  readonly addressHeader?: string;
  readonly log?: ServerLog;
  readonly now?: () => number;
  readonly pollHoldMs?: number;
}

/** Claims one address may make in a day: a home with several Macs. */
export const CLAIMS_PER_DAY = 3;
const DAY_MS = 24 * 3_600_000;
/** First messages read in a second: past it, the key agreement itself would be the load. */
export const OPENS_PER_SECOND = 50;
/** Clients' first messages, and addresses, remembered at most. */
const MAX_REMEMBERED = 10_000;

interface Decision {
  readonly reply: OpenReply;
  readonly session?: { readonly id: string; readonly clientId: string; readonly job: AsrJob };
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

export function createComputeServer(options: ComputeServerOptions): Server {
  const { clients, sessions, beta } = options;
  const billing = options.billing ?? null;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const key = clients.key();
  /** First messages seen, by their ephemeral key: one sent again is refused. */
  const seen = new Map<string, number>();
  /** Claims by address, hashed with a salt of this run. */
  const claims = new Map<string, number[]>();
  const salt = randomBytes(16);

  let second = 0;
  let opens = 0;

  function slowDown(): void {
    const current = Math.floor(now() / 1000);
    opens = current === second ? opens + 1 : 1;
    second = current;
    if (opens > OPENS_PER_SECOND) throw new HttpError(429);
  }

  /** Oldest first, as they came: what is past its time, or too many. */
  function trim<T>(entries: Map<string, T>, isOld: (value: T) => boolean): void {
    for (const [id, value] of entries) {
      if (!isOld(value) && entries.size <= MAX_REMEMBERED) return;
      entries.delete(id);
    }
  }

  function mayClaim(request: IncomingMessage): boolean {
    const header =
      options.addressHeader === undefined ? undefined : request.headers[options.addressHeader];
    const address =
      (Array.isArray(header) ? header[0] : header) ?? request.socket.remoteAddress ?? "";
    const id = createHash("sha256").update(salt).update(address).digest("hex");
    const recent = (claims.get(id) ?? []).filter((time) => now() - time < DAY_MS);
    if (recent.length >= CLAIMS_PER_DAY) return false;
    // Last in the map's order: the newest.
    claims.delete(id);
    claims.set(id, [...recent, now()]);
    trim(claims, (times) => times.every((time) => now() - time > DAY_MS));
    return true;
  }

  /** The answer, and for a session what to hold for it. */
  async function decide(request: IncomingMessage, received: Responded): Promise<Decision> {
    const refuse = (code: RefusalCode): Decision => ({ reply: { kind: "refused", code } });
    let parsed: unknown;
    try {
      parsed = JSON.parse(received.payload.toString("utf8"));
    } catch {
      return refuse("bad_request");
    }
    const opened = Open.safeParse(parsed);
    if (!opened.success) return refuse("mismatch");
    const message = opened.data;
    if (Math.abs(now() - message.at) > OPEN_WINDOW_MS) return refuse("clock");
    // Remembered only for who may act: a stranger's messages cost no memory.
    const first = () => {
      const once = received.clientKey.toString("base64");
      if (seen.has(once)) return false;
      seen.set(once, now());
      trim(seen, (at) => now() - at > 2 * OPEN_WINDOW_MS);
      return true;
    };

    if (message.kind === "wave") {
      const { places, taken } = clients.wave();
      if (places === 0) return refuse("closed");
      return {
        reply: {
          kind: "wave",
          percent: Math.min(100, Math.floor((taken * 100) / places)),
          full: taken >= places,
        },
      };
    }
    if (message.kind === "trial") {
      const { places, taken } = clients.wave();
      if (places === 0) return refuse("closed");
      // A full wave costs no claim of the address's.
      if (taken >= places) return refuse("full");
      if (!first()) return refuse("bad_request");
      if (!mayClaim(request)) return refuse("busy");
      const token = clients.trial();
      log(token === null ? "wave-full" : "trial-started");
      return token === null ? refuse("full") : { reply: { kind: "claimed", token } };
    }
    if (message.kind === "claim") {
      // A wave replaces the open beta: an app that knows only the beta takes no trial it could not pay.
      if (beta === null || clients.wave().places > 0) return refuse("closed");
      if (!first()) return refuse("bad_request");
      if (!mayClaim(request)) return refuse("busy");
      const token = clients.claim(beta.places);
      log(token === null ? "beta-full" : "beta-claimed");
      return token === null ? refuse("full") : { reply: { kind: "claimed", token } };
    }
    const known = clients.find(message.token);
    if (known === null) return refuse("unauthorized");
    if (!first()) return refuse("bad_request");
    // The open beta is closed: self-claimed beta places wait, while invited plans keep running.
    if (planOf(known.client) === "beta" && beta === null && message.kind !== "leave") {
      return refuse("closed");
    }
    switch (message.kind) {
      case "hello":
        return {
          reply: {
            kind: "hello",
            modelSha256: NEMOTRON_ARTIFACT.sha256,
            engineVersion: NEMOTRON_MANIFEST.version,
            name: options.name,
          },
        };
      case "quota": {
        const snapshot = clients.quota(known.id, beta?.secondsPerMonth ?? null);
        if (snapshot === null) return refuse("unauthorized");
        return { reply: { kind: "quota", ...snapshot } };
      }
      case "checkout":
      case "portal": {
        if (billing === null) return refuse("closed");
        const page = await billing.page(
          known,
          message.kind === "checkout"
            ? { kind: "checkout", item: message.item, locale: message.locale }
            : { kind: "portal", locale: message.locale },
        );
        return "url" in page ? { reply: { kind: "page", url: page.url } } : refuse(page.refused);
      }
      case "leave":
        // Invited and paid plans cannot be deleted by a client click; only the operator removes them.
        if (isInvitedPlan(planOf(known.client, clients.billing(known.id)))) {
          return refuse("bad_request");
        }
        sessions.dropClient(known.id);
        clients.remove(known.id);
        return { reply: { kind: "left" } };
      case "asr": {
        const { job } = message;
        if (
          job.modelSha256 !== NEMOTRON_ARTIFACT.sha256 ||
          job.engineVersion !== NEMOTRON_MANIFEST.version
        ) {
          return refuse("mismatch");
        }
        const seconds = job.samples / 16_000;
        if (seconds > NEMOTRON_CAPABILITIES.maxRequestSeconds) {
          return refuse("bad_request");
        }
        const snapshot = clients.quota(known.id, beta?.secondsPerMonth ?? null);
        if (snapshot !== null && snapshot.limitSeconds !== null) {
          const remaining =
            Math.max(0, snapshot.limitSeconds - snapshot.usedSeconds) + snapshot.extraSeconds;
          if (sessions.pendingSeconds(known.id) + seconds > remaining) return refuse("quota");
        }
        if (!sessions.hasRoom(known.id, job.samples * 2)) {
          return refuse("busy");
        }
        const id = sessions.newId();
        return { reply: { kind: "session", id }, session: { id, clientId: known.id, job } };
      }
    }
  }

  async function openSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
    slowDown();
    const body = await readBody(request, MAX_OPEN_BYTES);
    const received = respond(key, body, PROLOGUE);
    const { reply, session } = await decide(request, received);
    const { message, ...channel } = received.answer(Buffer.from(JSON.stringify(reply)));
    if (session !== undefined) sessions.add(session.id, session.clientId, channel, session.job);
    send(response, 200, message);
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? "").split("?")[0] ?? "";
    if (path === "/healthz" && request.method === "GET") return send(response, 204);
    if (path === "/v1/open" && request.method === "POST") return openSession(request, response);
    if (path === "/v1/stripe" && request.method === "POST" && billing !== null) {
      const body = await readBody(request, MAX_WEBHOOK_BYTES);
      const signature = request.headers["stripe-signature"];
      const status = await billing.webhook(
        body,
        Array.isArray(signature) ? signature[0] : signature,
      );
      return send(response, status);
    }
    if ((path === "/billing/done" || path === "/billing/back") && request.method === "GET") {
      return sendPage(response, path === "/billing/done" ? "done" : "back", request.url ?? "");
    }
    const match = /^\/v1\/s\/([0-9a-f]{32})(?:\/(\d{1,4}))?$/.exec(path);
    const id = match?.[1];
    if (id === undefined) throw new HttpError(404);
    const index = match?.[2];
    if (!sessions.has(id)) throw new HttpError(404);
    if (request.method === "PUT" && index !== undefined) {
      const body = await readBody(request, CHUNK_BYTES + TAG_BYTES);
      if (!sessions.has(id)) throw new HttpError(404);
      return send(response, sessions.receive(id, Number(index), body) ? 204 : 400);
    }
    if (request.method === "POST" && index === undefined) {
      const command = sessions.command(id, await readBody(request, MAX_COMMAND_BYTES));
      if (command === null) throw new HttpError(400);
      if (command === "drop") {
        sessions.drop(id);
        return send(response, 204);
      }
      const gone = new AbortController();
      response.on("close", () => gone.abort());
      const state = await sessions.state(id, options.pollHoldMs ?? POLL_HOLD_MS, gone.signal);
      if (state === null) throw new HttpError(404);
      return send(response, 200, state);
    }
    throw new HttpError(405);
  }

  const server = createServer(
    { requestTimeout: 180_000, headersTimeout: 30_000, maxHeaderSize: 16 * 1024 },
    (request, response) => {
      handle(request, response).catch((error: unknown) => {
        if (response.destroyed) return;
        const status =
          error instanceof HttpError ? error.status : error instanceof NoiseError ? 400 : 500;
        if (status === 500) log("error");
        if (!response.headersSent) send(response, status);
        else response.destroy();
      });
    },
  );
  server.maxConnections = 200;
  return server;
}

/** The longest webhook call read: Stripe's events are a few kilobytes. */
const MAX_WEBHOOK_BYTES = 256 * 1024;

const PAGES = {
  done: {
    fr: ["Paiement reçu", "Vous pouvez revenir dans Sondine : il se met à jour seul."],
    en: ["Payment received", "You can go back to Sondine: it updates by itself."],
  },
  back: {
    fr: ["Retour à Sondine", "Vous pouvez fermer cette page et revenir dans Sondine."],
    en: ["Back to Sondine", "You can close this page and go back to Sondine."],
  },
} as const;

/** Where Stripe sends the browser back: a still page, no script, nothing loaded. */
function sendPage(response: ServerResponse, page: keyof typeof PAGES, url: string): void {
  const lang = new URLSearchParams(url.split("?")[1] ?? "").get("lang") === "en" ? "en" : "fr";
  const [title, text] = PAGES[page][lang];
  const body = Buffer.from(
    `<!doctype html><html lang="${lang}"><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
      `<title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:20vh auto;padding:0 1rem;color:#1d1d1f;background:#fff}` +
      `@media(prefers-color-scheme:dark){body{color:#f5f5f7;background:#1d1d1f}}</style>` +
      `<h1>${title}</h1><p>${text}</p></html>`,
  );
  response.writeHead(200, {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    "referrer-policy": "no-referrer",
    "content-type": "text/html; charset=utf-8",
    "content-length": body.length,
  });
  response.end(body);
}

function send(response: ServerResponse, status: number, body?: Buffer): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...(body === undefined
      ? {}
      : { "content-type": "application/octet-stream", "content-length": body.length }),
  });
  response.end(body);
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  if (Number(request.headers["content-length"] ?? 0) > limit) {
    // Nothing of it is read: the connection closes with the answer.
    throw new HttpError(413);
  }
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of request as AsyncIterable<Buffer>) {
    size += part.length;
    if (size > limit) throw new HttpError(413);
    parts.push(part);
  }
  return Buffer.concat(parts);
}
