import { EngineError, type EngineErrorCode } from "../contract.ts";
import { NEMOTRON_ARTIFACT } from "../models/catalog.ts";
import { NEMOTRON_MANIFEST } from "../nemotron.ts";
import { initiate, NoiseError, type Channel } from "./noise.ts";
import {
  MAX_OPEN_BYTES,
  OpenReply,
  PROLOGUE,
  PROTOCOL_VERSION,
  type AsrJob,
  type BillingItem,
  type BillingLocale,
  type QuotaSnapshot,
  type RefusalCode,
  type ServerLink,
} from "./wire.ts";

// Talks to a compute server (wire.ts). Every failure is an EngineError whose
// code says what to do next; messages never hold a token, an address or text.

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ServerAddress {
  readonly endpoint: string;
  /** Its static key, base64url. */
  readonly serverKey: string;
}

export const REQUEST_TIMEOUT_MS = 30_000;

const refusals: Readonly<Record<RefusalCode, EngineErrorCode>> = {
  unauthorized: "unauthorized",
  full: "server_busy",
  closed: "server_mismatch",
  mismatch: "server_mismatch",
  busy: "server_busy",
  quota: "quota_exhausted",
  clock: "server_mismatch",
  not_allowed: "server_mismatch",
  billing_unavailable: "network_unavailable",
  bad_request: "server_mismatch",
};

/** One HTTP exchange: no redirect, no cache, a timeout, and a bounded answer. */
export async function exchange(
  fetchImpl: Fetch,
  url: string,
  init: RequestInit,
  options: {
    readonly maxBytes: number;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<{ readonly status: number; readonly body: Buffer }> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
  try {
    const response = await fetchImpl(url, {
      ...init,
      signal,
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
    });
    const parts: Uint8Array[] = [];
    let size = 0;
    if (response.body !== null) {
      for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
        size += part.length;
        if (size > options.maxBytes) {
          throw new EngineError("server_mismatch", "the server's answer is too long");
        }
        parts.push(part);
      }
    }
    return { status: response.status, body: Buffer.concat(parts) };
  } catch (error) {
    if (error instanceof EngineError) throw error;
    if (options.signal?.aborted === true) throw new EngineError("cancelled", "cancelled");
    throw new EngineError("network_unavailable", "the server does not answer");
  }
}

export type OpenRequest =
  | { readonly kind: "claim" }
  | { readonly kind: "wave" }
  | { readonly kind: "trial" }
  | {
      readonly kind: "checkout";
      readonly token: string;
      readonly item: BillingItem;
      readonly locale: BillingLocale;
    }
  | { readonly kind: "portal"; readonly token: string; readonly locale: BillingLocale }
  | { readonly kind: "hello"; readonly token: string }
  | { readonly kind: "quota"; readonly token: string }
  | { readonly kind: "leave"; readonly token: string }
  | { readonly kind: "asr"; readonly token: string; readonly job: AsrJob };

export interface Opened {
  readonly reply: Exclude<OpenReply, { kind: "refused" }>;
  readonly channel: Channel;
}

/** The refusal a server answered, kept for callers that show it (`full`). */
export class RefusedError extends EngineError {
  readonly refusal: RefusalCode;
  constructor(refusal: RefusalCode) {
    super(refusals[refusal], `the server refused: ${refusal}`, { reason: refusal });
    this.refusal = refusal;
  }
}

export async function open(
  server: ServerAddress,
  request: OpenRequest,
  options: {
    readonly fetch?: Fetch | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly now?: (() => number) | undefined;
  } = {},
): Promise<Opened> {
  const payload = Buffer.from(
    JSON.stringify({ v: PROTOCOL_VERSION, at: (options.now ?? Date.now)(), ...request }),
  );
  let initiated;
  try {
    initiated = initiate(Buffer.from(server.serverKey, "base64url"), payload, PROLOGUE);
  } catch (error) {
    throw new EngineError("server_mismatch", "the server's key is not one", { cause: error });
  }
  const { status, body } = await exchange(
    options.fetch ?? fetch,
    `${server.endpoint}/v1/open`,
    { method: "POST", body: new Uint8Array(initiated.message), headers: octets },
    { maxBytes: MAX_OPEN_BYTES, signal: options.signal },
  );
  refuseStatus(status);
  let finished;
  try {
    finished = initiated.finish(body);
  } catch (error) {
    if (!(error instanceof NoiseError)) throw error;
    throw new EngineError("server_mismatch", "the server is not the one expected");
  }
  const reply = OpenReply.safeParse(parseJson(finished.payload));
  if (!reply.success) throw new EngineError("server_mismatch", "an answer this version can't read");
  if (reply.data.kind === "refused") throw new RefusedError(reply.data.code);
  return { reply: reply.data, channel: finished };
}

/** Checks that the link's server answers, knows its token and runs this Mac's model. */
export async function hello(
  link: ServerLink,
  options: Parameters<typeof open>[2] = {},
): Promise<Extract<OpenReply, { kind: "hello" }>> {
  const { reply } = await open(link, { kind: "hello", token: link.token }, options);
  if (reply.kind !== "hello") throw new EngineError("server_mismatch", "not a greeting");
  if (
    reply.modelSha256 !== NEMOTRON_ARTIFACT.sha256 ||
    reply.engineVersion !== NEMOTRON_MANIFEST.version
  ) {
    throw new EngineError("server_mismatch", "the server runs another model or version");
  }
  return reply;
}

/** Reads this client's plan and remaining quota from its server. */
export async function readQuota(
  link: ServerLink,
  options: Parameters<typeof open>[2] = {},
): Promise<QuotaSnapshot> {
  const { reply } = await open(link, { kind: "quota", token: link.token }, options);
  if (reply.kind !== "quota") throw new EngineError("server_mismatch", "not a quota");
  const { kind: _kind, ...snapshot } = reply;
  return snapshot;
}

/** How full the server's wave is (ADR 047); `RefusedError("closed")` when it has none. */
export async function readWave(
  server: ServerAddress,
  options: Parameters<typeof open>[2] = {},
): Promise<{ readonly percent: number; readonly full: boolean }> {
  const { reply } = await open(server, { kind: "wave" }, options);
  if (reply.kind !== "wave") throw new EngineError("server_mismatch", "not a wave");
  return { percent: reply.percent, full: reply.full };
}

/** Takes a place of the wave with its trial; `RefusedError("full")` when none is left. */
export async function startTrial(
  server: ServerAddress,
  options: Parameters<typeof open>[2] = {},
): Promise<string> {
  const { reply } = await open(server, { kind: "trial" }, options);
  if (reply.kind !== "claimed") throw new EngineError("server_mismatch", "not a place");
  return reply.token;
}

/** Only Stripe's own pages: anything else a server answers is refused. */
export function isStripePage(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  return (
    parsed.protocol === "https:" &&
    (parsed.hostname === "checkout.stripe.com" || parsed.hostname === "billing.stripe.com") &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.port === ""
  );
}

/** The Stripe page that buys `item` for this place, or its customer portal. */
export async function billingPage(
  link: ServerLink,
  page:
    | { readonly kind: "checkout"; readonly item: BillingItem; readonly locale: BillingLocale }
    | { readonly kind: "portal"; readonly locale: BillingLocale },
  options: Parameters<typeof open>[2] = {},
): Promise<string> {
  const { reply } = await open(link, { ...page, token: link.token }, options);
  if (reply.kind !== "page" || !isStripePage(reply.url)) {
    throw new EngineError("server_mismatch", "not a Stripe page");
  }
  return reply.url;
}

/** Takes one of the beta's places; `RefusedError("full")` when none is left. */
export async function claimPlace(
  server: ServerAddress,
  options: Parameters<typeof open>[2] = {},
): Promise<string> {
  const { reply } = await open(server, { kind: "claim" }, options);
  if (reply.kind !== "claimed") throw new EngineError("server_mismatch", "not a place");
  return reply.token;
}

/** Gives a place back; best effort. */
export async function leavePlace(
  link: ServerLink,
  options: Parameters<typeof open>[2] = {},
): Promise<void> {
  await open(link, { kind: "leave", token: link.token }, options);
}

export const octets = { "content-type": "application/octet-stream" };

/** HTTP says only whether the server, or something before it, took the request. */
export function refuseStatus(status: number): void {
  if (status >= 200 && status < 300) return;
  // Something before the server (a tunnel, a proxy) answers for it while it is down.
  if (status === 429 || status >= 500) {
    throw new EngineError("network_unavailable", `the server answered ${status}`);
  }
  throw new EngineError("server_mismatch", `the server answered ${status}`);
}

export function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return undefined;
  }
}
