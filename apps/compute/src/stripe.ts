import { createHmac, timingSafeEqual } from "node:crypto";

// The few calls to Stripe the Cloud's billing makes (ADR 047), by plain
// fetch: no SDK. Only the server talks to Stripe; a Mac never does, and opens
// the pages it gets in the browser. A restricted key is enough: Checkout and
// portal sessions to write, prices and subscriptions to read.

/** The API version every call and every event is read in. */
export const STRIPE_VERSION = "2025-03-31.basil";
const TIMEOUT_MS = 20_000;

/** The prices by their lookup keys (apps/compute/scripts/stripe-setup.ts makes them). */
export const LOOKUP_KEYS = {
  founder: "sondine_cloud_founder_monthly",
  topup: "sondine_cloud_topup_10h",
} as const;

export type FormValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly FormValue[]
  | { readonly [key: string]: FormValue };

/** Stripe's form encoding, nested keys in brackets. */
export function encodeForm(input: Readonly<Record<string, FormValue>>): URLSearchParams {
  const params = new URLSearchParams();
  const append = (prefix: string, value: FormValue) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((item: FormValue, index) => append(`${prefix}[${index}]`, item));
    } else if (typeof value === "object") {
      for (const [key, nested] of Object.entries(value)) append(`${prefix}[${key}]`, nested);
    } else {
      params.append(prefix, String(value));
    }
  };
  for (const [key, value] of Object.entries(input)) append(key, value);
  return params;
}

export class StripeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface StripeHttp {
  get(path: string, query?: Readonly<Record<string, FormValue>>): Promise<unknown>;
  /** `idempotencyKey`: the same key twice makes one object. */
  post(
    path: string,
    body: Readonly<Record<string, FormValue>>,
    idempotencyKey?: string,
  ): Promise<unknown>;
}

export function createStripeHttp(options: {
  readonly apiKey: string;
  readonly apiBase?: string;
  readonly fetch?: typeof fetch;
}): StripeHttp {
  const base = (options.apiBase ?? "https://api.stripe.com").replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? fetch;
  const headers = {
    authorization: `Bearer ${options.apiKey}`,
    "stripe-version": STRIPE_VERSION,
  };
  async function call(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new StripeError(0, "Stripe does not answer");
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      // Stripe's own message, never the key or what was sent.
      const error =
        typeof body === "object" && body !== null && "error" in body ? body.error : null;
      const type =
        typeof error === "object" && error !== null && "type" in error ? String(error.type) : "";
      throw new StripeError(response.status, `Stripe answered ${response.status} ${type}`.trim());
    }
    return body;
  }
  return {
    get: (path, query) => {
      const search = query === undefined ? "" : `?${encodeForm(query).toString()}`;
      return call(`${base}${path}${search}`, { method: "GET", headers });
    },
    post: (path, body, idempotencyKey) =>
      call(`${base}${path}`, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/x-www-form-urlencoded",
          ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
        },
        body: encodeForm(body).toString(),
      }),
  };
}

/** Seconds a signed event may be old: Stripe's own default. */
export const SIGNATURE_TOLERANCE_SEC = 300;

/** Checks `Stripe-Signature` (`t=…,v1=…`) over the raw body, in constant time. */
export function verifySignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
  nowSec: number,
): boolean {
  if (header === undefined || secret === "") return false;
  let timestamp: number | null = null;
  const signatures: Buffer[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2).map((text) => text.trim());
    if (key === "t" && value !== undefined && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    if (key === "v1" && value !== undefined && /^[0-9a-f]{64}$/i.test(value)) {
      signatures.push(Buffer.from(value, "hex"));
    }
  }
  if (timestamp === null || signatures.length === 0) return false;
  if (Math.abs(nowSec - timestamp) > SIGNATURE_TOLERANCE_SEC) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest();
  return signatures.some(
    (signature) => signature.length === expected.length && timingSafeEqual(signature, expected),
  );
}

/** A signature header for `rawBody`, as Stripe makes it: for tests and the local mock. */
export function signPayload(rawBody: Buffer, secret: string, nowSec: number): string {
  const signature = createHmac("sha256", secret).update(`${nowSec}.`).update(rawBody).digest("hex");
  return `t=${nowSec},v1=${signature}`;
}
