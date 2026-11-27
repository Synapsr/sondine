import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NEMOTRON_CAPABILITIES,
  NEMOTRON_MANIFEST,
  NEMOTRON_RESOURCES,
  type AsrEngine,
} from "@sondine/engines";
import {
  billingPage,
  claimPlace,
  isStripePage,
  leavePlace,
  readQuota,
  readWave,
  RefusedError,
  startTrial,
  type ServerLink,
} from "@sondine/engines/remote";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BillingService, CONSENT } from "../src/billing.ts";
import { runCli } from "../src/cli.ts";
import { ClientStore, PLACE_IDLE_MS, TOPUP_SECONDS, TRIAL_SECONDS } from "../src/clients.ts";
import { CLAIMS_PER_DAY, createComputeServer } from "../src/server.ts";
import { Sessions } from "../src/sessions.ts";
import {
  createStripeHttp,
  encodeForm,
  LOOKUP_KEYS,
  signPayload,
  StripeError,
  STRIPE_VERSION,
  type FormValue,
  type StripeHttp,
} from "../src/stripe.ts";

// The Cloud's payment (ADR 047) against a Stripe of our own: what the server
// asks of Stripe, and what Stripe's signed events change for a place.

const SECRET = "whsec_test_secret";
const HOUR = 3_600;

let state: string;
let cleanups: (() => Promise<void> | void)[];

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "sondine-billing-"));
  cleanups = [() => rmSync(state, { recursive: true, force: true })];
});

afterEach(async () => {
  for (const cleanup of cleanups.toReversed()) await cleanup();
});

interface FakeSubscription {
  id: string;
  status: string;
  customer: string;
  metadata: Record<string, string>;
  cancel_at_period_end: boolean;
  cancel_at: number | null;
  items: { data: { current_period_start: number; current_period_end: number }[] };
}

/** Stripe, as far as the server uses it. */
class FakeStripe implements StripeHttp {
  readonly posts: { path: string; body: Readonly<Record<string, FormValue>>; key?: string }[] = [];
  readonly sessions = new Map<string, { mode: string; ref: string; quantity: number }>();
  readonly subscriptions = new Map<string, FakeSubscription>();
  failing = false;
  /** How long Stripe takes to answer a read: what it answers is what it held when asked. */
  slowMs = 0;
  pageUrl: (id: string) => string = (id) => `https://checkout.stripe.com/c/pay/${id}`;

  async get(path: string, query?: Readonly<Record<string, FormValue>>): Promise<unknown> {
    const answer = this.read(path, query);
    if (this.slowMs > 0) await new Promise((resolve) => setTimeout(resolve, this.slowMs));
    return answer;
  }

  private read(path: string, query?: Readonly<Record<string, FormValue>>): unknown {
    if (this.failing) throw new StripeError(503, "Stripe answered 503");
    if (path === "/v1/prices") {
      expect(query?.["lookup_keys"]).toEqual(Object.values(LOOKUP_KEYS));
      return {
        data: [
          { id: "price_founder", lookup_key: LOOKUP_KEYS.founder },
          { id: "price_topup", lookup_key: LOOKUP_KEYS.topup },
        ],
      };
    }
    const items = /^\/v1\/checkout\/sessions\/(cs_\w+)\/line_items$/.exec(path);
    if (items?.[1] !== undefined) {
      const session = this.sessions.get(items[1]);
      return {
        data: [{ quantity: session?.quantity ?? 1, price: { lookup_key: LOOKUP_KEYS.topup } }],
      };
    }
    const subscription = /^\/v1\/subscriptions\/(sub_\w+)$/.exec(path);
    if (subscription?.[1] !== undefined) {
      const found = this.subscriptions.get(subscription[1]);
      if (found === undefined) throw new StripeError(404, "Stripe answered 404");
      return structuredClone(found);
    }
    throw new StripeError(404, `unexpected GET ${path}`);
  }

  async post(
    path: string,
    body: Readonly<Record<string, FormValue>>,
    key?: string,
  ): Promise<unknown> {
    if (this.failing) throw new StripeError(503, "Stripe answered 503");
    this.posts.push({ path, body, ...(key === undefined ? {} : { key }) });
    if (path === "/v1/checkout/sessions") {
      // As Stripe makes them: `cs_test_…`, an underscore after the mode.
      const id = `cs_test_${randomBytes(6).toString("hex")}`;
      this.sessions.set(id, {
        mode: String(body["mode"]),
        ref: String(body["client_reference_id"]),
        quantity: 1,
      });
      return { id, url: this.pageUrl(id) };
    }
    if (path === "/v1/billing_portal/sessions") {
      return { id: "bps_1", url: "https://billing.stripe.com/p/session/test_1" };
    }
    throw new StripeError(404, `unexpected POST ${path}`);
  }

  /** The subscription a paid Checkout made, as Stripe would keep it. */
  subscribe(ref: string, customer: string, startSec: number): FakeSubscription {
    const subscription: FakeSubscription = {
      id: `sub_${randomBytes(6).toString("hex")}`,
      status: "active",
      customer,
      metadata: { sondine_ref: ref },
      cancel_at_period_end: false,
      cancel_at: null,
      items: {
        data: [{ current_period_start: startSec, current_period_end: startSec + 30 * 86_400 }],
      },
    };
    this.subscriptions.set(subscription.id, subscription);
    return subscription;
  }
}

const idOf = (link: ServerLink) => createHash("sha256").update(link.token).digest("hex");

const silentEngine: AsrEngine = {
  manifest: NEMOTRON_MANIFEST,
  capabilities: NEMOTRON_CAPABILITIES,
  resources: NEMOTRON_RESOURCES,
  state: () => "ready",
  pid: () => undefined,
  load: async () => ({ loadMs: 0 }),
  unload: async () => undefined,
  transcribe: async () => {
    throw new Error("no transcription in these tests");
  },
};

async function serve(
  options: { places?: number; billing?: boolean; now?: () => number; beta?: null } = {},
) {
  const clients = new ClientStore(state, options.now);
  if (options.places !== undefined) clients.setWavePlaces(options.places);
  const stripe = new FakeStripe();
  const logged: string[] = [];
  const billing =
    options.billing === false
      ? null
      : new BillingService(clients, {
          stripe,
          webhookSecret: SECRET,
          publicUrl: "https://cloud.example",
          termsUrl: { en: "https://sondine.app/terms", fr: "https://sondine.app/fr/terms" },
          log: (event) => logged.push(event),
        });
  const sessions = new Sessions({ engine: silentEngine, known: (id) => clients.has(id) });
  const server = createComputeServer({
    clients,
    sessions,
    billing,
    name: "test",
    beta: options.beta === null ? null : { places: 5, secondsPerMonth: 40 * HOUR },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await sessions.stop();
  });
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const address = { endpoint, serverKey: clients.key().publicKey.toString("base64url") };
  const linkOf = (token: string): ServerLink => ({ ...address, token });

  /** Stripe calls the webhook, signed unless told otherwise. */
  let events = 0;
  async function send(
    type: string,
    object: Record<string, unknown>,
    sign: { secret?: string; atSec?: number; id?: string } = {},
  ): Promise<number> {
    const id = sign.id ?? `evt_${(events += 1)}`;
    const body = Buffer.from(JSON.stringify({ id, type, data: { object } }));
    const atSec = sign.atSec ?? Math.floor(Date.now() / 1000);
    const response = await fetch(`${endpoint}/v1/stripe`, {
      method: "POST",
      body,
      headers: { "stripe-signature": signPayload(body, sign.secret ?? SECRET, atSec) },
    });
    return response.status;
  }

  /** A place that took its trial and then paid, as Stripe tells it. */
  async function subscribed(locale: "fr" | "en" = "fr") {
    const link = linkOf(await startTrial(address));
    await billingPage(link, { kind: "checkout", item: "subscription", locale });
    const ref = clients.billing(idOf(link))?.ref ?? "";
    const startSec = Math.floor(Date.now() / 1000);
    const subscription = stripe.subscribe(ref, "cus_1", startSec);
    expect(
      await send("checkout.session.completed", {
        id: [...stripe.sessions.keys()].at(-1),
        mode: "subscription",
        payment_status: "paid",
        client_reference_id: ref,
        customer: "cus_1",
        subscription: subscription.id,
      }),
    ).toBe(200);
    return { link, ref, subscription };
  }

  return { clients, stripe, endpoint, address, linkOf, send, subscribed, logged };
}

describe("the wave's places", () => {
  it("says how full the wave is, as a share and never a count", async () => {
    const { address } = await serve({ places: 3 });
    expect(await readWave(address)).toEqual({ percent: 0, full: false });
    await startTrial(address);
    expect(await readWave(address)).toEqual({ percent: 33, full: false });
    for (let index = 0; index < 2; index += 1) await startTrial(address);
    expect(await readWave(address)).toEqual({ percent: 100, full: true });
    await expect(startTrial(address)).rejects.toMatchObject({ refusal: "full" });
  });

  it("is closed until the operator sets places, and closes the open beta then", async () => {
    const { address, clients } = await serve();
    await expect(readWave(address)).rejects.toMatchObject({ refusal: "closed" });
    await expect(startTrial(address)).rejects.toMatchObject({ refusal: "closed" });
    // Before a wave, the open beta still gives places.
    await claimPlace(address);
    clients.setWavePlaces(10);
    // An app that knows only the beta takes no place it could not pay.
    await expect(claimPlace(address)).rejects.toMatchObject({ refusal: "closed" });
    // The beta's places, the team's, do not count in the wave.
    expect(await readWave(address)).toEqual({ percent: 0, full: false });
  });

  it("gives a trial of 60 minutes, at most three a day from one address", async () => {
    const { address, linkOf } = await serve({ places: 10 });
    const token = await startTrial(address);
    expect(await readQuota(linkOf(token))).toEqual({
      plan: "trial",
      period: "total",
      usedSeconds: 0,
      limitSeconds: TRIAL_SECONDS,
      extraSeconds: 0,
    });
    for (let index = 1; index < CLAIMS_PER_DAY; index += 1) await startTrial(address);
    await expect(startTrial(address)).rejects.toMatchObject({ refusal: "busy" });
  });

  it("frees the place of a trial unused for two weeks, never a subscription's", async () => {
    let now = Date.now();
    const { address, subscribed } = await serve({ places: 2, now: () => now });
    await startTrial(address);
    await subscribed();
    expect(await readWave(address)).toEqual({ percent: 100, full: true });
    now += PLACE_IDLE_MS + 1;
    // The idle trial frees its place without losing it; the subscriber keeps theirs.
    expect(await readWave(address)).toEqual({ percent: 50, full: false });
  });

  it("is set and read by the operator", async () => {
    const lines: string[] = [];
    const env = { SONDINE_COMPUTE_STATE: state };
    expect(await runCli(["places", "10"], { env, out: (line) => lines.push(line) })).toBe(0);
    expect(await runCli(["places"], { env, out: (line) => lines.push(line) })).toBe(0);
    expect(lines).toEqual(["0 taken of 10 places", "0 taken of 10 places"]);
    expect(await runCli(["places", "many"], { env, err: () => undefined })).toBe(1);
  });
});

describe("paying from the app", () => {
  it("opens Checkout for the place that asks, known to Stripe by a reference of its own", async () => {
    const { address, linkOf, stripe, clients } = await serve({ places: 10 });
    const link = linkOf(await startTrial(address));
    const url = await billingPage(link, { kind: "checkout", item: "subscription", locale: "en" });
    expect(isStripePage(url)).toBe(true);
    const asked = stripe.posts[0];
    const ref = clients.billing(idOf(link))?.ref;
    expect(ref).toMatch(/^[0-9a-f]{32}$/);
    expect(asked?.body).toMatchObject({
      mode: "subscription",
      line_items: [{ price: "price_founder", quantity: 1 }],
      client_reference_id: ref,
      subscription_data: { metadata: { sondine_ref: ref } },
      success_url: "https://cloud.example/billing/done?lang=en",
      cancel_url: "https://cloud.example/billing/back?lang=en",
      locale: "en",
      automatic_tax: { enabled: true },
      consent_collection: { terms_of_service: "required" },
      custom_text: {
        terms_of_service_acceptance: {
          message: CONSENT.en.subscription("https://sondine.app/terms"),
        },
      },
    });
    expect(asked?.key).toMatch(/^checkout-/);
    // Stripe never learns the token, nor what the server knows the place by.
    const sent = JSON.stringify(stripe.posts);
    expect(sent).not.toContain(link.token);
    expect(sent).not.toContain(idOf(link));
  });

  it("turns a paid trial into 40 hours a period, and gives them back at each renewal", async () => {
    const { linkOf, subscribed, clients, send, stripe } = await serve({ places: 10 });
    const { link, subscription } = await subscribed();
    clients.charge(idOf(link), 2 * HOUR);
    let quota = await readQuota(linkOf(link.token));
    expect(quota).toMatchObject({
      plan: "cloud",
      usedSeconds: 2 * HOUR,
      limitSeconds: 40 * HOUR,
      subscription: { status: "active", cancelAtPeriodEnd: false },
    });
    expect(quota.subscription?.periodEnd).toBe(
      (subscription.items.data[0]?.current_period_end ?? 0) * 1000,
    );
    // The renewal is paid: a new period, its hours back.
    const next = (subscription.items.data[0]?.current_period_end ?? 0) + 1;
    subscription.items.data[0] = {
      current_period_start: next,
      current_period_end: next + 30 * 86_400,
    };
    stripe.subscriptions.set(subscription.id, subscription);
    expect(
      await send("invoice.paid", {
        parent: { subscription_details: { subscription: subscription.id } },
      }),
    ).toBe(200);
    quota = await readQuota(link);
    expect(quota).toMatchObject({ plan: "cloud", usedSeconds: 0, limitSeconds: 40 * HOUR });
  });

  it("sells ten hours to a subscriber only, once per paid session", async () => {
    const { address, linkOf, subscribed, send, stripe } = await serve({ places: 10 });
    const trial = linkOf(await startTrial(address));
    await expect(
      billingPage(trial, { kind: "checkout", item: "topup", locale: "fr" }),
    ).rejects.toMatchObject({ refusal: "not_allowed" });

    const { link, ref } = await subscribed();
    await billingPage(link, { kind: "checkout", item: "topup", locale: "fr" });
    const topup = stripe.posts.at(-1);
    expect(topup?.body).toMatchObject({
      mode: "payment",
      line_items: [{ price: "price_topup", quantity: 1 }],
      customer: "cus_1",
      invoice_creation: {
        enabled: true,
        invoice_data: { footer: expect.stringContaining("https://sondine.app/fr/terms") },
      },
    });
    const paid = {
      id: [...stripe.sessions.keys()].at(-1),
      mode: "payment",
      payment_status: "paid",
      client_reference_id: ref,
      customer: "cus_1",
    };
    expect(await send("checkout.session.completed", paid, { id: "evt_topup" })).toBe(200);
    // Stripe sends an event again, or another for the same session: still ten hours.
    expect(await send("checkout.session.completed", paid, { id: "evt_topup" })).toBe(200);
    expect(await send("checkout.session.async_payment_succeeded", paid)).toBe(200);
    expect((await readQuota(link)).extraSeconds).toBe(TOPUP_SECONDS);
  });

  it("refuses a subscription twice, and the owner's own machine", async () => {
    const { subscribed, clients, linkOf } = await serve({ places: 10 });
    const { link } = await subscribed();
    await expect(
      billingPage(link, { kind: "checkout", item: "subscription", locale: "fr" }),
    ).rejects.toMatchObject({ refusal: "not_allowed" });
    const own = linkOf(clients.add("own", "mine").token);
    await expect(
      billingPage(own, { kind: "checkout", item: "subscription", locale: "fr" }),
    ).rejects.toMatchObject({ refusal: "not_allowed" });
  });

  it("opens the customer portal once the place has paid", async () => {
    const { address, linkOf, subscribed, stripe } = await serve({ places: 10 });
    const trial = linkOf(await startTrial(address));
    await expect(billingPage(trial, { kind: "portal", locale: "fr" })).rejects.toMatchObject({
      refusal: "not_allowed",
    });
    const { link } = await subscribed();
    expect(await billingPage(link, { kind: "portal", locale: "fr" })).toBe(
      "https://billing.stripe.com/p/session/test_1",
    );
    expect(stripe.posts.at(-1)?.body).toEqual({
      customer: "cus_1",
      return_url: "https://cloud.example/billing/back?lang=fr",
      locale: "fr",
    });
  });

  it("keeps the service while a renewal fails, and ends it with the subscription", async () => {
    const { subscribed, send, stripe, clients } = await serve({ places: 10 });
    const { link, subscription } = await subscribed();
    clients.setBilling(idOf(link), {
      ...clients.billingOf(idOf(link)),
      topupSeconds: TOPUP_SECONDS,
    });
    subscription.status = "past_due";
    expect(await send("invoice.payment_failed", { subscription: subscription.id })).toBe(200);
    expect(await readQuota(link)).toMatchObject({
      plan: "cloud",
      limitSeconds: 40 * HOUR,
      subscription: { status: "past_due" },
    });
    subscription.status = "active";
    subscription.cancel_at_period_end = true;
    expect(await send("customer.subscription.updated", { id: subscription.id })).toBe(200);
    expect((await readQuota(link)).subscription).toMatchObject({ cancelAtPeriodEnd: true });

    subscription.status = "canceled";
    expect(await send("customer.subscription.deleted", { id: subscription.id })).toBe(200);
    // No hours of its own any more; the ten bought stay.
    expect(await readQuota(link)).toMatchObject({
      plan: "ended",
      limitSeconds: 0,
      extraSeconds: TOPUP_SECONDS,
      subscription: { status: "ended" },
    });
    // A click cannot delete what was paid; the place may subscribe again.
    await expect(leavePlace(link)).rejects.toBeInstanceOf(RefusedError);
    await billingPage(link, { kind: "checkout", item: "subscription", locale: "fr" });
    expect(stripe.posts.at(-1)?.body).toMatchObject({ customer: "cus_1" });
  });

  it("asks again for what Stripe failed to give, and takes only Stripe's pages", async () => {
    const { address, linkOf, stripe } = await serve({ places: 10 });
    const link = linkOf(await startTrial(address));
    stripe.failing = true;
    await expect(
      billingPage(link, { kind: "checkout", item: "subscription", locale: "fr" }),
    ).rejects.toMatchObject({ refusal: "billing_unavailable" });
    stripe.failing = false;
    stripe.pageUrl = () => "https://checkout.stripe.com.evil.example/pay";
    await expect(
      billingPage(link, { kind: "checkout", item: "subscription", locale: "fr" }),
    ).rejects.toThrow("not a Stripe page");
    expect(isStripePage("https://billing.stripe.com/p/session/x")).toBe(true);
    expect(isStripePage("http://checkout.stripe.com/x")).toBe(false);
    expect(isStripePage("https://user@checkout.stripe.com/x")).toBe(false);
  });

  it("takes no payment where the operator set none", async () => {
    const { address, linkOf, endpoint } = await serve({ places: 10, billing: false });
    const link = linkOf(await startTrial(address));
    await expect(
      billingPage(link, { kind: "checkout", item: "subscription", locale: "fr" }),
    ).rejects.toMatchObject({ refusal: "closed" });
    expect((await fetch(`${endpoint}/v1/stripe`, { method: "POST", body: "{}" })).status).toBe(404);
  });
});

describe("Stripe's webhook", () => {
  it("refuses what Stripe did not sign, or signed too long ago", async () => {
    const { send, logged } = await serve({ places: 10 });
    expect(await send("invoice.paid", {}, { secret: "whsec_other" })).toBe(400);
    expect(await send("invoice.paid", {}, { atSec: Math.floor(Date.now() / 1000) - 3_600 })).toBe(
      400,
    );
    expect(await send("invoice.paid", {})).toBe(200);
    expect(logged).toEqual([]);
  });

  it("answers 500 while Stripe fails, so it sends the event again, and handles it then", async () => {
    const { address, linkOf, send, stripe, clients } = await serve({ places: 10 });
    const link = linkOf(await startTrial(address));
    await billingPage(link, { kind: "checkout", item: "subscription", locale: "fr" });
    const ref = clients.billing(idOf(link))?.ref ?? "";
    const subscription = stripe.subscribe(ref, "cus_9", Math.floor(Date.now() / 1000));
    const paid = {
      id: "cs_test_x1",
      mode: "subscription",
      payment_status: "paid",
      client_reference_id: ref,
      customer: "cus_9",
      subscription: subscription.id,
    };
    stripe.failing = true;
    expect(await send("checkout.session.completed", paid, { id: "evt_retry" })).toBe(500);
    expect((await readQuota(link)).plan).toBe("trial");
    stripe.failing = false;
    expect(await send("checkout.session.completed", paid, { id: "evt_retry" })).toBe(200);
    expect((await readQuota(link)).plan).toBe("cloud");
  });

  it("waits for the payment of an unpaid session, and forgets a place it does not know", async () => {
    const { send, logged } = await serve({ places: 10 });
    expect(
      await send("checkout.session.completed", {
        id: "cs_test_u1",
        mode: "subscription",
        payment_status: "unpaid",
        client_reference_id: "f".repeat(32),
      }),
    ).toBe(200);
    expect(
      await send("checkout.session.completed", {
        id: "cs_live_v1",
        mode: "payment",
        payment_status: "paid",
        client_reference_id: "f".repeat(32),
      }),
    ).toBe(200);
    expect(logged).toEqual(["billing-unknown-place"]);
  });
});

describe("what the server keeps", () => {
  it("writes the Stripe ids and the reference, never the token, a name or an e-mail", async () => {
    const { subscribed } = await serve({ places: 10 });
    const { link, ref } = await subscribed();
    const billing = readdirSync(join(state, "billing"));
    expect(billing).toHaveLength(1);
    const kept = readFileSync(join(state, "billing", billing[0] ?? ""), "utf8");
    expect(JSON.parse(kept)).toMatchObject({ ref, customer: "cus_1" });
    expect(kept).not.toContain(link.token);
    expect(kept).not.toContain("@");
  });

  it("gives a lost Mac's place a new link, with its plan and subscription", async () => {
    const { subscribed, linkOf, endpoint } = await serve({ places: 10 });
    const { link } = await subscribed();
    const lines: string[] = [];
    const id = createHash("sha256").update(link.token).digest("hex");
    const env = { SONDINE_COMPUTE_STATE: state };
    expect(
      await runCli(["rekey", id.slice(0, 12), "--endpoint", endpoint], {
        env,
        out: (line) => lines.push(line),
      }),
    ).toBe(0);
    const token = new URL(lines[0] ?? "").searchParams.get("t") ?? "";
    expect((await readQuota(linkOf(token))).plan).toBe("cloud");
    await expect(readQuota(link)).rejects.toMatchObject({ refusal: "unauthorized" });
  });

  it("serves the pages Stripe sends the browser back to, with nothing to run", async () => {
    const { endpoint } = await serve({ places: 10 });
    const done = await fetch(`${endpoint}/billing/done?lang=en`);
    expect(done.status).toBe(200);
    expect(done.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
    expect(await done.text()).toContain("Payment received");
    expect(await (await fetch(`${endpoint}/billing/back`)).text()).toContain("Retour à Sondine");
  });
});

describe("the calls to Stripe", () => {
  it("are form-encoded, in one API version, with the key only in its header", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const http = createStripeHttp({
      apiKey: "rk_test_key",
      apiBase: "https://stripe.test",
      fetch: async (url, init) => {
        seen.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    await http.post("/v1/checkout/sessions", { line_items: [{ price: "p", quantity: 1 }] }, "k1");
    await http.get("/v1/prices", { lookup_keys: ["a", "b"] });
    const [post, get] = seen;
    expect(post?.init.body).toBe(
      encodeForm({ line_items: [{ price: "p", quantity: 1 }] }).toString(),
    );
    expect(decodeURIComponent(String(post?.init.body))).toBe(
      "line_items[0][price]=p&line_items[0][quantity]=1",
    );
    expect(post?.init.headers).toMatchObject({
      authorization: "Bearer rk_test_key",
      "stripe-version": STRIPE_VERSION,
      "idempotency-key": "k1",
    });
    expect(decodeURIComponent(get?.url ?? "")).toBe(
      "https://stripe.test/v1/prices?lookup_keys[0]=a&lookup_keys[1]=b",
    );
  });

  it("say what Stripe refused without repeating the key", async () => {
    const http = createStripeHttp({
      apiKey: "rk_test_secret",
      fetch: async () =>
        new Response(
          JSON.stringify({ error: { type: "invalid_request_error", message: "rk_test_secret" } }),
          {
            status: 400,
          },
        ),
    });
    const error = await http.get("/v1/prices").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StripeError);
    expect(String(error)).toContain("invalid_request_error");
    expect(String(error)).not.toContain("rk_test_secret");
  });

  it("are refused at start when the payment settings are incomplete", async () => {
    const errors: string[] = [];
    const code = await runCli(["serve"], {
      env: {
        SONDINE_COMPUTE_STATE: state,
        SONDINE_COMPUTE_MODEL: join(state, "missing"),
        SONDINE_COMPUTE_STRIPE_KEY: "rk_test_x",
      },
      err: (line) => errors.push(line),
    });
    expect(code).toBe(1);
    expect(errors.join("")).toMatch(/payment needs/);
  });
});

// Codex Astra's review of the PR (2026-11-27): each case it found, as a test.
describe("money under concurrency and out of order", () => {
  it("credits ten hours once, whatever Stripe sends at the same time", async () => {
    const { subscribed, send, stripe } = await serve({ places: 10 });
    const { link, ref } = await subscribed();
    await billingPage(link, { kind: "checkout", item: "topup", locale: "fr" });
    const paid = {
      id: [...stripe.sessions.keys()].at(-1),
      mode: "payment",
      payment_status: "paid",
      client_reference_id: ref,
      customer: "cus_1",
    };
    stripe.slowMs = 30;
    const answers = await Promise.all([
      send("checkout.session.completed", paid, { id: "evt_same" }),
      send("checkout.session.completed", paid, { id: "evt_same" }),
      send("checkout.session.async_payment_succeeded", paid),
    ]);
    expect(answers).toEqual([200, 200, 200]);
    expect((await readQuota(link)).extraSeconds).toBe(TOPUP_SECONDS);
  });

  it("stores the subscription as Stripe last said it, not as a slower answer did", async () => {
    const { subscribed, send, stripe } = await serve({ places: 10 });
    const { link, subscription } = await subscribed();
    stripe.slowMs = 40;
    const first = send("customer.subscription.updated", { id: subscription.id });
    // Stripe cancels it while the first answer is on its way.
    await new Promise((resolve) => setTimeout(resolve, 5));
    subscription.status = "canceled";
    const second = send("customer.subscription.deleted", { id: subscription.id });
    expect(await Promise.all([first, second])).toEqual([200, 200]);
    expect((await readQuota(link)).plan).toBe("ended");
  });

  it("gives a period's hours only once it is paid", async () => {
    const { address, linkOf, send, stripe, clients } = await serve({ places: 10 });
    const link = linkOf(await startTrial(address));
    await billingPage(link, { kind: "checkout", item: "subscription", locale: "fr" });
    const ref = clients.billing(idOf(link))?.ref ?? "";
    const subscription = stripe.subscribe(ref, "cus_2", Math.floor(Date.now() / 1000));
    // Active by its status alone, before any paid invoice: still the trial.
    expect(await send("customer.subscription.created", { id: subscription.id })).toBe(200);
    expect((await readQuota(link)).plan).toBe("trial");
    expect(await send("invoice.paid", { subscription: subscription.id })).toBe(200);
    expect(await readQuota(link)).toMatchObject({ plan: "cloud", usedSeconds: 0 });

    clients.charge(idOf(link), 40 * HOUR);
    // The renewal fails: a new period at Stripe, but no hours for it.
    const next = (subscription.items.data[0]?.current_period_end ?? 0) + 1;
    subscription.items.data[0] = {
      current_period_start: next,
      current_period_end: next + 30 * 86_400,
    };
    subscription.status = "past_due";
    expect(await send("invoice.payment_failed", { subscription: subscription.id })).toBe(200);
    expect(await readQuota(link)).toMatchObject({ plan: "cloud", usedSeconds: 40 * HOUR });
    subscription.status = "active";
    expect(await send("invoice.paid", { subscription: subscription.id })).toBe(200);
    expect(await readQuota(link)).toMatchObject({ usedSeconds: 0 });
  });

  it("opens one subscription page at a time, and never takes a second subscription", async () => {
    const { address, linkOf, send, stripe, clients } = await serve({ places: 10 });
    const link = linkOf(await startTrial(address));
    const first = await billingPage(link, { kind: "checkout", item: "subscription", locale: "fr" });
    const again = await billingPage(link, { kind: "checkout", item: "subscription", locale: "en" });
    expect(again).toBe(first);
    expect(stripe.posts.filter((post) => post.path === "/v1/checkout/sessions")).toHaveLength(1);

    const ref = clients.billing(idOf(link))?.ref ?? "";
    const kept = stripe.subscribe(ref, "cus_3", Math.floor(Date.now() / 1000));
    expect(await send("invoice.paid", { subscription: kept.id })).toBe(200);
    // A second subscription for the same place (a page paid twice): logged, never taken.
    const other = stripe.subscribe(ref, "cus_4", Math.floor(Date.now() / 1000) + 99);
    expect(await send("invoice.paid", { subscription: other.id })).toBe(200);
    other.status = "canceled";
    expect(await send("customer.subscription.deleted", { id: other.id })).toBe(200);
    expect(await readQuota(link)).toMatchObject({ plan: "cloud" });
    expect(clients.billing(idOf(link))).toMatchObject({
      customer: "cus_3",
      subscription: { id: kept.id },
    });
  });

  it("keeps a place that opened a Checkout page, and a paid beta place once the beta closes", async () => {
    const { address, linkOf, clients } = await serve({ places: 10, beta: null });
    const link = linkOf(await startTrial(address));
    await billingPage(link, { kind: "checkout", item: "subscription", locale: "fr" });
    await expect(leavePlace(link)).rejects.toMatchObject({ refusal: "bad_request" });

    const beta = clients.add("beta", "team");
    clients.setBilling(beta.id, {
      ref: "a".repeat(32),
      customer: "cus_5",
      subscription: {
        id: "sub_5",
        status: "active",
        paidPeriodStart: Date.now(),
        periodEnd: Date.now() + 86_400_000,
        cancelAtPeriodEnd: false,
      },
    });
    expect((await readQuota(linkOf(beta.token))).plan).toBe("cloud");
    await expect(readQuota(linkOf(clients.add("beta", "unpaid").token))).rejects.toMatchObject({
      refusal: "closed",
    });
  });

  it("moves no place's files while a server runs on them", async () => {
    const { subscribed, endpoint, clients } = await serve({ places: 10 });
    const { link } = await subscribed();
    clients.beat();
    const errors: string[] = [];
    const code = await runCli(["rekey", idOf(link).slice(0, 12), "--endpoint", endpoint], {
      env: { SONDINE_COMPUTE_STATE: state },
      err: (line) => errors.push(line),
    });
    expect(code).toBe(1);
    expect(errors.join("")).toContain("stop the server first");
    expect((await readQuota(link)).plan).toBe("cloud");
  });
});
