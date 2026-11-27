import type { BillingItem, BillingLocale, RefusalCode } from "@sondine/engines/remote";
import { z } from "zod";
import { planOf, TOPUP_SECONDS, type Billing, type Client, type ClientStore } from "./clients.ts";
import type { ServerLog } from "./sessions.ts";
import { LOOKUP_KEYS, StripeError, verifySignature, type StripeHttp } from "./stripe.ts";

// Paying for the Cloud from the app (ADR 047). A place asks, in its sealed
// channel, for a Stripe page; the server makes it for that place and the Mac
// opens it in the browser. Stripe tells the server what was paid by its
// webhook, here too, so one process writes every place's state. Stripe knows
// a place by a random reference, never its token or the token's hash.

export interface BillingOptions {
  readonly stripe: StripeHttp;
  /** The webhook endpoint's signing secret (`whsec_…`). */
  readonly webhookSecret: string;
  /** Where Stripe sends the browser back: this server's public address. */
  readonly publicUrl: string;
  /** The Cloud's terms, linked from Checkout's consent. */
  readonly termsUrl: string;
  /** A customer portal configuration (`bpc_…`); Stripe's default without it. */
  readonly portalConfiguration?: string;
  readonly log?: ServerLog;
  readonly now?: () => number;
}

export type PageRequest =
  | { readonly kind: "checkout"; readonly item: BillingItem; readonly locale: BillingLocale }
  | { readonly kind: "portal"; readonly locale: BillingLocale };

export type PageResult = { readonly url: string } | { readonly refused: RefusalCode };

/**
 * What the buyer accepts in Checkout (ADR 047): an immediate start, and the
 * share already provided if they withdraw (Code de la consommation, L.221-25).
 */
export const CONSENT: Readonly<Record<BillingLocale, (terms: string) => string>> = {
  fr: (terms) =>
    `J’accepte les [conditions du Cloud Sondine](${terms}) et je demande que le service commence tout de suite. Si je me rétracte dans les 14 jours, je paierai la part du service déjà fournie.`,
  en: (terms) =>
    `I accept the [Sondine Cloud terms](${terms}) and ask for the service to start right away. If I withdraw within 14 days, I will pay for the share of the service already provided.`,
};

const Id = z.string().min(1).max(255);
const Metadata = z.record(z.string(), z.string()).nullish();
const Expandable = z.union([Id, z.looseObject({ id: Id })]).nullish();
const idOf = (value: z.output<typeof Expandable>): string | null =>
  value === null || value === undefined ? null : typeof value === "string" ? value : value.id;

const Event = z.looseObject({
  id: Id,
  type: z.string().max(255),
  data: z.looseObject({ object: z.looseObject({}) }),
});

const CheckoutSession = z.looseObject({
  id: Id,
  mode: z.enum(["payment", "setup", "subscription"]),
  payment_status: z.string(),
  client_reference_id: z.string().nullish(),
  metadata: Metadata,
  customer: Expandable,
  subscription: Expandable,
});

const Period = { current_period_start: z.int().nullish(), current_period_end: z.int().nullish() };
const StripeSubscription = z.looseObject({
  id: Id,
  status: z.string(),
  customer: Expandable,
  metadata: Metadata,
  cancel_at_period_end: z.boolean().nullish(),
  cancel_at: z.int().nullish(),
  ...Period,
  // Since 2025-03-31, the period is the items'.
  items: z.looseObject({ data: z.array(z.looseObject(Period)) }).nullish(),
});

const Invoice = z.looseObject({
  subscription: Expandable,
  parent: z
    .looseObject({
      subscription_details: z.looseObject({ subscription: Expandable }).nullish(),
    })
    .nullish(),
});

const LineItems = z.looseObject({
  data: z.array(
    z.looseObject({
      quantity: z.int().nullish(),
      price: z.looseObject({ lookup_key: z.string().nullish() }).nullish(),
    }),
  ),
});

const Prices = z.looseObject({
  data: z.array(z.looseObject({ id: Id, lookup_key: z.string().nullish() })),
});

const Page = z.looseObject({ url: z.url() });

/** Stripe's statuses, in ours: an unpaid first invoice is no subscription yet. */
function statusOf(status: string): "active" | "past_due" | "ended" | null {
  if (status === "active" || status === "trialing") return "active";
  if (status === "past_due") return "past_due";
  if (status === "incomplete") return null;
  return "ended";
}

export class BillingService {
  private readonly clients: ClientStore;
  private readonly options: BillingOptions;
  private readonly log: ServerLog;
  private readonly now: () => number;
  private prices: Promise<Readonly<Record<keyof typeof LOOKUP_KEYS, string>>> | null = null;

  constructor(clients: ClientStore, options: BillingOptions) {
    this.clients = clients;
    this.options = options;
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? Date.now;
  }

  /** The Stripe page a place asked for, or why it may not have it. */
  async page(
    { id, client }: { readonly id: string; readonly client: Client },
    request: PageRequest,
  ): Promise<PageResult> {
    const billing = this.clients.billingOf(id);
    const plan = planOf(client, this.clients.billing(id));
    const subscribed =
      billing.subscription !== undefined && billing.subscription.status !== "ended";
    try {
      if (request.kind === "portal") {
        if (billing.customer === undefined) return { refused: "not_allowed" };
        return { url: await this.portal(billing.customer, request.locale) };
      }
      if (request.item === "subscription") {
        // The owner's machine pays nothing; a subscription or a gift is enough.
        if (plan === "own" || plan === "cloud") return { refused: "not_allowed" };
      } else if (!subscribed || billing.customer === undefined) {
        return { refused: "not_allowed" };
      }
      this.clients.setBilling(id, billing);
      return { url: await this.checkout(billing, request.item, request.locale) };
    } catch (error) {
      if (!(error instanceof StripeError)) throw error;
      this.log("billing-unavailable", { status: error.status });
      return { refused: "billing_unavailable" };
    }
  }

  /**
   * One webhook call: its HTTP status. 400 for what Stripe did not sign; 500
   * when Stripe should send it again; 200 once handled, or known already.
   */
  async webhook(rawBody: Buffer, signature: string | undefined): Promise<number> {
    const nowSec = Math.floor(this.now() / 1000);
    if (!verifySignature(rawBody, signature, this.options.webhookSecret, nowSec)) return 400;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return 400;
    }
    const event = Event.safeParse(parsed);
    if (!event.success) return 400;
    if (this.clients.handled(event.data.id)) return 200;
    try {
      await this.handle(event.data.type, event.data.data.object);
    } catch (error) {
      if (!(error instanceof StripeError) && !(error instanceof z.ZodError)) throw error;
      this.log("billing-failed", { status: error instanceof StripeError ? error.status : 0 });
      return 500;
    }
    this.clients.markHandled(event.data.id);
    return 200;
  }

  private async handle(type: string, object: unknown): Promise<void> {
    switch (type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        return this.completed(CheckoutSession.parse(object));
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        // Only its id: the subscription is read again from Stripe.
        return this.sync(z.looseObject({ id: Id }).parse(object).id);
      case "invoice.paid":
      case "invoice.payment_failed": {
        const invoice = Invoice.parse(object);
        const subscription =
          idOf(invoice.subscription) ?? idOf(invoice.parent?.subscription_details?.subscription);
        if (subscription !== null) await this.sync(subscription);
        return;
      }
      default:
        return;
    }
  }

  private async completed(session: z.output<typeof CheckoutSession>): Promise<void> {
    if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") {
      return;
    }
    const ref = session.client_reference_id ?? session.metadata?.["sondine_ref"] ?? null;
    const id = this.clients.findBilling({ ref });
    if (id === null) {
      this.log("billing-unknown-place");
      return;
    }
    const billing = this.clients.billingOf(id);
    const customer = idOf(session.customer) ?? billing.customer;
    const withCustomer: Billing = customer === undefined ? billing : { ...billing, customer };
    this.clients.setBilling(id, withCustomer);
    const subscription = idOf(session.subscription);
    if (session.mode === "subscription" && subscription !== null) {
      await this.sync(subscription);
      return;
    }
    if (session.mode !== "payment") return;
    if (withCustomer.credited?.includes(session.id) === true) return;
    const items = LineItems.parse(
      await this.options.stripe.get(
        `/v1/checkout/sessions/${encodeURIComponent(session.id)}/line_items`,
        { limit: 20, expand: ["data.price"] },
      ),
    );
    const packs = items.data
      .filter((item) => item.price?.lookup_key === LOOKUP_KEYS.topup)
      .reduce((sum, item) => sum + Math.max(1, Math.min(item.quantity ?? 1, 10)), 0);
    if (packs === 0) return;
    const latest = this.clients.billingOf(id);
    this.clients.setBilling(id, {
      ...latest,
      topupSeconds: (latest.topupSeconds ?? 0) + packs * TOPUP_SECONDS,
      credited: [...(latest.credited ?? []), session.id].slice(-64),
    });
    this.log("billing-topup");
  }

  /** Reads the subscription from Stripe rather than the event: events come out of order. */
  private async sync(subscriptionId: string): Promise<void> {
    const subscription = StripeSubscription.parse(
      await this.options.stripe.get(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`),
    );
    const customer = idOf(subscription.customer);
    const id =
      this.clients.findBilling({ ref: subscription.metadata?.["sondine_ref"] ?? null }) ??
      this.clients.findBilling({ subscription: subscription.id }) ??
      this.clients.findBilling({ customer });
    const status = statusOf(subscription.status);
    if (id === null || status === null) return;
    const billing = this.clients.billingOf(id);
    // An older subscription's events never replace a newer one that goes on.
    const current = billing.subscription;
    if (
      current !== undefined &&
      current.id !== subscription.id &&
      current.status !== "ended" &&
      status === "ended"
    ) {
      return;
    }
    const item = subscription.items?.data[0];
    const start = subscription.current_period_start ?? item?.current_period_start ?? null;
    const end = subscription.current_period_end ?? item?.current_period_end ?? null;
    this.clients.setBilling(id, {
      ...billing,
      ...(customer === null ? {} : { customer }),
      subscription: {
        id: subscription.id,
        status,
        periodStart: start === null ? null : start * 1000,
        periodEnd: end === null ? null : end * 1000,
        cancelAtPeriodEnd:
          subscription.cancel_at_period_end === true ||
          (subscription.cancel_at !== null && subscription.cancel_at !== undefined),
      },
    });
    this.log(`billing-${status}`);
  }

  private priceIds(): Promise<Readonly<Record<keyof typeof LOOKUP_KEYS, string>>> {
    this.prices ??= this.options.stripe
      .get("/v1/prices", { lookup_keys: Object.values(LOOKUP_KEYS), active: true, limit: 10 })
      .then((body) => {
        const prices = Prices.parse(body).data;
        const find = (key: string) => {
          const price = prices.find((entry) => entry.lookup_key === key);
          if (price === undefined) throw new StripeError(404, `no price ${key}`);
          return price.id;
        };
        return { founder: find(LOOKUP_KEYS.founder), topup: find(LOOKUP_KEYS.topup) };
      })
      .catch((error: unknown) => {
        this.prices = null;
        throw error;
      });
    return this.prices;
  }

  private async checkout(
    billing: Billing,
    item: BillingItem,
    locale: BillingLocale,
  ): Promise<string> {
    const prices = await this.priceIds();
    const base = this.options.publicUrl;
    const metadata = { sondine_ref: billing.ref };
    const customer = billing.customer;
    const session = await this.options.stripe.post(
      "/v1/checkout/sessions",
      {
        mode: item === "subscription" ? "subscription" : "payment",
        line_items: [
          { price: item === "subscription" ? prices.founder : prices.topup, quantity: 1 },
        ],
        client_reference_id: billing.ref,
        metadata,
        ...(item === "subscription"
          ? { subscription_data: { metadata } }
          : { payment_intent_data: { metadata }, invoice_creation: { enabled: true } }),
        ...(customer === undefined
          ? {}
          : { customer, customer_update: { address: "auto", name: "auto" } }),
        success_url: `${base}/billing/done?lang=${locale}`,
        cancel_url: `${base}/billing/back?lang=${locale}`,
        locale,
        automatic_tax: { enabled: true },
        billing_address_collection: "required",
        tax_id_collection: { enabled: true },
        consent_collection: { terms_of_service: "required" },
        custom_text: {
          terms_of_service_acceptance: { message: CONSENT[locale](this.options.termsUrl) },
        },
      },
      // Two clicks in the same minute open the same page.
      `checkout-${billing.ref}-${item}-${locale}-${Math.floor(this.now() / 60_000)}`,
    );
    return Page.parse(session).url;
  }

  private async portal(customer: string, locale: BillingLocale): Promise<string> {
    const session = await this.options.stripe.post("/v1/billing_portal/sessions", {
      customer,
      return_url: `${this.options.publicUrl}/billing/back?lang=${locale}`,
      locale,
      ...(this.options.portalConfiguration === undefined
        ? {}
        : { configuration: this.options.portalConfiguration }),
    });
    return Page.parse(session).url;
  }
}
