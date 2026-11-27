import { z } from "zod";

// What a Mac and a compute server (apps/compute) say to each other (ADR 040),
// inside the channel of noise.ts. Audio is raw PCM16 in sealed chunks, never
// JSON or base64.
//
//   POST /v1/open            first Noise message (Open) → second one (OpenReply)
//   PUT  /v1/s/<id>/<index>  one sealed chunk of PCM16 → 204
//   POST /v1/s/<id>          one sealed Command → the sealed SessionState, or 204
//
// Nothing outside the sealed messages counts: an id in an URL only finds the
// session, an HTTP status only says whether to try again. What the server
// holds, the client reads in a sealed state.

export const PROLOGUE = Buffer.from("sondine-compute/1");
export const PROTOCOL_VERSION = 1;

/** PCM16 bytes of one chunk before sealing; the last one may be shorter. */
export const CHUNK_BYTES = 2 * 1024 * 1024;
/** The longest first message a server reads. */
export const MAX_OPEN_BYTES = 8 * 1024;
/** The longest state a client reads: 55 min of speech carries every word's times. */
export const MAX_STATE_BYTES = 32 * 1024 * 1024;
/** How long a server holds a state request while nothing changes. */
export const POLL_HOLD_MS = 15_000;
/** A first message older or newer than this is a replay, or a clock that is wrong. */
export const OPEN_WINDOW_MS = 10 * 60_000;

export const CHUNK_LABEL = Buffer.from("chunk");
export const COMMAND_LABEL = Buffer.from("command");
/** Commands are counted from here, so a command and a chunk never share a counter. */
export const FIRST_COMMAND = 1n << 32n;
/** The longest command a server reads: its counter, and a few sealed words. */
export const MAX_COMMAND_BYTES = 256;
export const STATE_LABEL = Buffer.from("state");

const Base64Key = z.base64url().length(43);
export const Token = z.base64url().length(43);

/** What every transcription asks the server to run; another model is refused. */
export const AsrJob = z.strictObject({
  modelSha256: z.string().regex(/^[0-9a-f]{64}$/),
  engineVersion: z.string().min(1).max(32),
  samples: z.int().positive(),
  speakers: z.boolean(),
  timestamps: z.boolean(),
  language: z.string().max(16).optional(),
});
export type AsrJob = z.output<typeof AsrJob>;

/**
 * Quota tier of a compute client (ADR 040, 047). `ended`: a Cloud subscription
 * that stopped; its top-ups stay usable.
 */
export const QuotaPlan = z.enum(["own", "beta", "trial", "cloud", "ended"]);
export type QuotaPlan = z.output<typeof QuotaPlan>;

/** Whether a client's included seconds reset each month, never reset, or are unlimited. */
export const QuotaPeriod = z.enum(["total", "month", "unlimited"]);
export type QuotaPeriod = z.output<typeof QuotaPeriod>;

/** A place's subscription, as Stripe last told the server (ADR 047). */
export const Subscription = z.strictObject({
  /** `past_due`: a renewal failed and Stripe tries again; the service goes on. */
  status: z.enum(["active", "past_due", "ended"]),
  /** When the current period ends: the next renewal, or the end of a cancelled one. */
  periodEnd: z.int().nullable(),
  /** The subscription ends at `periodEnd` rather than renews. */
  cancelAtPeriodEnd: z.boolean(),
});
export type Subscription = z.output<typeof Subscription>;

export const QuotaSnapshot = z.strictObject({
  plan: QuotaPlan,
  period: QuotaPeriod,
  usedSeconds: z.number().nonnegative(),
  limitSeconds: z.number().nonnegative().nullable(),
  extraSeconds: z.number().nonnegative(),
  /** Null without a subscription, and on a server that takes no payment. */
  subscription: Subscription.nullable().optional(),
});
export type QuotaSnapshot = z.output<typeof QuotaSnapshot>;

/** What a place may buy (ADR 047): the Founder plan, or ten more hours. */
export const BillingItem = z.enum(["subscription", "topup"]);
export type BillingItem = z.output<typeof BillingItem>;

/** The language of the pages Stripe shows. */
export const BillingLocale = z.enum(["fr", "en"]);
export type BillingLocale = z.output<typeof BillingLocale>;

export const Open = z.discriminatedUnion("kind", [
  /** One of the beta's places, without an account. */
  z.strictObject({ v: z.literal(1), at: z.int(), kind: z.literal("claim") }),
  /** How full the Cloud's wave is, before taking a place (ADR 047). */
  z.strictObject({ v: z.literal(1), at: z.int(), kind: z.literal("wave") }),
  /** A place of the wave with its free trial, without an account. */
  z.strictObject({ v: z.literal(1), at: z.int(), kind: z.literal("trial") }),
  /** A Stripe page for this place: Checkout to buy `item`, or the customer portal. */
  z.strictObject({
    v: z.literal(1),
    at: z.int(),
    kind: z.literal("checkout"),
    token: Token,
    item: BillingItem,
    locale: BillingLocale,
  }),
  z.strictObject({
    v: z.literal(1),
    at: z.int(),
    kind: z.literal("portal"),
    token: Token,
    locale: BillingLocale,
  }),
  /** Is this server mine, and what does it run? */
  z.strictObject({ v: z.literal(1), at: z.int(), kind: z.literal("hello"), token: Token }),
  /** How much of this client's plan has been used. */
  z.strictObject({ v: z.literal(1), at: z.int(), kind: z.literal("quota"), token: Token }),
  z.strictObject({ v: z.literal(1), at: z.int(), kind: z.literal("leave"), token: Token }),
  z.strictObject({
    v: z.literal(1),
    at: z.int(),
    kind: z.literal("asr"),
    token: Token,
    job: AsrJob,
  }),
]);
export type Open = z.output<typeof Open>;

export const RefusalCode = z.enum([
  /** This client's token is unknown or was revoked. */
  "unauthorized",
  /** No place left in the beta. */
  "full",
  /** This server has no beta, or it is closed. */
  "closed",
  /** Another model, engine version or protocol. */
  "mismatch",
  /** Too many sessions now. */
  "busy",
  /** This client's hours for the month are used up. */
  "quota",
  /** The client's clock is too far off. */
  "clock",
  /** This place may not buy that now: already subscribed, or a top-up without a plan. */
  "not_allowed",
  /** Stripe did not answer; try again later. */
  "billing_unavailable",
  "bad_request",
]);
export type RefusalCode = z.output<typeof RefusalCode>;

export const OpenReply = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("refused"), code: RefusalCode }),
  z.strictObject({ kind: z.literal("claimed"), token: Token }),
  z.strictObject({ kind: z.literal("left") }),
  z.strictObject({
    kind: z.literal("hello"),
    modelSha256: z.string(),
    engineVersion: z.string(),
    name: z.string().max(64),
  }),
  z.strictObject({ kind: z.literal("quota"), ...QuotaSnapshot.shape }),
  /** The share of the wave's places taken, rounded down: no count is given. */
  z.strictObject({ kind: z.literal("wave"), percent: z.int().min(0).max(100), full: z.boolean() }),
  /** A Stripe page to open in the browser. */
  z.strictObject({ kind: z.literal("page"), url: z.url() }),
  z.strictObject({ kind: z.literal("session"), id: z.string().regex(/^[0-9a-f]{32}$/) }),
]);
export type OpenReply = z.output<typeof OpenReply>;

const Seconds = z
  .number()
  .nonnegative()
  .max(24 * 3600);
const RemoteToken = z.strictObject({ startSec: Seconds, endSec: Seconds, text: z.string() });
const RemoteSegment = z.strictObject({
  startSec: Seconds,
  endSec: Seconds,
  text: z.string(),
  speaker: z.int().nonnegative().max(63).nullable(),
  tokens: z.array(RemoteToken),
});
export const RemoteResult = z.strictObject({
  text: z.string(),
  stop: z.enum(["complete", "model_limit"]),
  segments: z.array(RemoteSegment),
  languages: z.array(z.string().max(16)).max(64),
  runtime: z.string().max(64),
  computeMs: z.number().nonnegative(),
});
export type RemoteResult = z.output<typeof RemoteResult>;

export const Command = z.strictObject({
  /** `state`: waits for a change, then answers. `drop`: forget this session. */
  command: z.enum(["state", "drop"]),
});
export type Command = z.output<typeof Command>;

/** The chunks a state lists as missing, at most. */
export const MAX_MISSING = 64;

/** Failures that are the request's own: the same audio would fail again. */
export const FailureCode = z.enum(["invalid_output", "rejected", "failed"]);

/** Why the model's output was refused (speech-cpp/output.ts, worker-engine.ts). */
export const FailureReason = z.enum([
  "malformed-end",
  "no-segments",
  "no-tokens",
  "text-mismatch",
  "time-not-finite",
  "time-past-audio",
  "time-reversed",
  "unknown-stop",
  "unmappable",
  "untimed",
]);

export const SessionState = z.discriminatedUnion("state", [
  /** `missing`: the first chunks not here yet. */
  z.strictObject({
    state: z.literal("uploading"),
    missing: z.array(z.int().nonnegative().max(9_999)).max(MAX_MISSING),
  }),
  /** `ahead`: requests that run before this one. */
  z.strictObject({ state: z.literal("queued"), ahead: z.int().nonnegative() }),
  z.strictObject({ state: z.literal("running"), progress: z.number().min(0).max(1) }),
  z.strictObject({ state: z.literal("done"), result: RemoteResult }),
  z.strictObject({
    state: z.literal("failed"),
    code: FailureCode,
    /** One of our own words, or nothing: a server's text never reaches a log. */
    reason: FailureReason.nullable().catch(null),
  }),
]);
export type SessionState = z.output<typeof SessionState>;

/**
 * Where a server is and how to talk to it, in one line to paste. It holds the
 * client's token: whoever has the link can use the server.
 */
export interface ServerLink {
  /** `http://host:port` or `https://host[:port]`, no path. */
  readonly endpoint: string;
  readonly serverKey: string;
  readonly token: string;
}

export function formatServerLink(link: ServerLink): string {
  const fields = new URLSearchParams({ e: link.endpoint, k: link.serverKey, t: link.token });
  return `sondine-compute://connect?${fields.toString()}`;
}

/** An `http(s)://host[:port]` address; null for anything else. */
export function parseEndpoint(text: string): string | null {
  if (!URL.canParse(text)) return null;
  const url = new URL(text);
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "")
    return null;
  return url.pathname === "/" ? url.origin : null;
}

export function parseServerLink(text: string): ServerLink | null {
  const trimmed = text.trim();
  if (!URL.canParse(trimmed)) return null;
  const url = new URL(trimmed);
  if (url.protocol !== "sondine-compute:" || url.host !== "connect") return null;
  const endpoint = parseEndpoint(url.searchParams.get("e") ?? "");
  const serverKey = Base64Key.safeParse(url.searchParams.get("k"));
  const token = Token.safeParse(url.searchParams.get("t"));
  if (endpoint === null || !serverKey.success || !token.success) return null;
  return { endpoint, serverKey: serverKey.data, token: token.data };
}
