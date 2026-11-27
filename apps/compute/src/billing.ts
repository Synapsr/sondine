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
  /** The Cloud's terms in each language, linked from Checkout's consent. */
  readonly termsUrl: Readonly<Record<BillingLocale, string>>;
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
export const CONSENT: Readonly<
  Record<BillingLocale, Readonly<Record<BillingItem, (terms: string) => string>>>
> = {
  fr: {
    subscription: (terms) =>
      `J’accepte les [conditions](${terms}) et je demande que le service commence tout de suite, avant la fin du délai de rétractation de 14 jours. Si je me rétracte dans ce délai, je paierai les heures déjà transcrites, au prorata des 40 h.`,
    topup: (terms) =>
      `J’accepte les [conditions](${terms}) et je demande que les 10 heures soient créditées tout de suite, avant la fin du délai de rétractation de 14 jours. Si je me rétracte dans ce délai, je paierai les heures utilisées jusqu’à ce que je vous en informe.`,
  },
  en: {
    subscription: (terms) =>
      `I accept the [terms](${terms}) and ask for the service to start right away, before the 14-day withdrawal period ends. If I withdraw within that period, I will pay for the hours already transcribed, pro rata of the 40 h.`,
    topup: (terms) =>
      `I accept the [terms](${terms}) and ask for the 10 hours to be credited right away, before the 14-day withdrawal period ends. If I withdraw within that period, I will pay for the hours used until I tell you.`,
  },
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
const CheckoutPage = z.looseObject({
  id: z.string().regex(/^cs_[A-Za-z0-9_]{1,250}$/),
  url: z.url(),
});

/** Stripe's statuses, in ours: an unpaid first invoice is no subscription yet. */
function statusOf(status: string): "active" | "past_due" | "ended" | null {
  if (status === "active") return "active";
  if (status === "past_due") return "past_due";
  // No subscription yet, or one in a trial Sondine never offers: nothing to give.
  if (status === "incomplete" || status === "trialing") return null;
  return "ended";
}

/**
 * The top-up invoice's footer, its confirmation on a durable medium
 * (L.221-13): the terms accepted, on which day, and what withdrawing costs.
 * A subscription's invoices take the account's default footer instead.
 */
export const INVOICE_FOOTER: Readonly<
  Record<BillingLocale, (terms: string, day: string) => string>
> = {
  fr: (terms, day) =>
    `Conditions du Cloud Sondine acceptées le ${day} : ${terms}. Service commencé à votre demande ; en cas de rétractation dans les 14 jours, les heures utilisées restent dues au prorata du prix.`,
  en: (terms, day) =>
    `Sondine Cloud terms accepted on ${day}: ${terms}. Service started at your request; if you withdraw within 14 days, the hours used remain due in proportion to the price.`,
};

/** A pending Checkout page is given again until this close to its end. */
const PENDING_MARGIN_MS = 5 * 60_000;
/** How long a subscription's Checkout page stays open: Stripe's shortest. */
const PENDING_MS = 30 * 60_000;

export class BillingService {
  private readonly clients: ClientStore;
  private readonly options: BillingOptions;
  private readonly log: ServerLog;
  private readonly now: () => number;
  private prices: Promise<Readonly<Record<keyof typeof LOOKUP_KEYS, string>>> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(clients: ClientStore, options: BillingOptions) {
    this.clients = clients;
    this.options = options;
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? Date.now;
  }

  /** The Stripe page a place asked for, or why it may not have it. */
  async page(
    known: { readonly id: string; readonly client: Client },
    request: PageRequest,
  ): Promise<PageResult> {
    // One at a time with the webhook: a page reads and writes the place's state too.
    return this.serially(() => this.pageNow(known, request));
  }

  private async pageNow(
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
        // The owner's machine pays nothing; a subscription that goes on, or a gift, is enough.
        if (plan === "own" || plan === "cloud" || subscribed) return { refused: "not_allowed" };
        // The page already open, whatever the language: two pages could make two subscriptions.
        const pending = billing.pending;
        if (pending !== undefined && pending.expiresAt - this.now() > PENDING_MARGIN_MS) {
          return { url: pending.url };
        }
      } else if (!subscribed || billing.customer === undefined) {
        return { refused: "not_allowed" };
      }
      this.clients.setBilling(id, billing);
      const session = await this.checkout(billing, request.item, request.locale);
      if (request.item === "subscription") {
        this.clients.setBilling(id, { ...this.clients.billingOf(id), pending: session });
      }
      return { url: session.url };
    } catch (error) {
      if (!(error instanceof StripeError)) throw error;
      this.log("billing-unavailable", { status: error.status });
      return { refused: "billing_unavailable" };
    }
  }

  /**
   * One webhook call: its HTTP status. 400 for what Stripe did not sign; 500
   * when Stripe should send it again; 200 once handled, or known already.
   * Calls are handled one after the other, Stripe's answers included: two at
   * once could credit a session twice, or store an older subscription last.
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
    const { id, type, data } = event.data;
    return this.serially(async () => {
      if (this.clients.handled(id)) return 200;
      try {
        await this.handle(type, data.object);
      } catch (error) {
        if (!(error instanceof StripeError) && !(error instanceof z.ZodError)) throw error;
        this.log("billing-failed", { status: error instanceof StripeError ? error.status : 0 });
        return 500;
      }
      this.clients.markHandled(id);
      return 200;
    });
  }

  /** Runs `work` after every other billing work of this server, failures included. */
  private serially<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
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
        return this.sync(z.looseObject({ id: Id }).parse(object).id, false);
      case "invoice.paid":
      case "invoice.payment_failed": {
        const invoice = Invoice.parse(object);
        const subscription =
          idOf(invoice.subscription) ?? idOf(invoice.parent?.subscription_details?.subscription);
        // Only a paid invoice opens a period's hours; a failed one keeps the last paid period.
        if (subscription !== null) await this.sync(subscription, type === "invoice.paid");
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
    // The first customer stays: a late event of another page never replaces it.
    const customer = billing.customer ?? idOf(session.customer) ?? undefined;
    const { pending, ...rest } = billing;
    this.clients.setBilling(id, {
      ...(pending?.id === session.id ? rest : billing),
      ...(customer === undefined ? {} : { customer }),
    });
    const subscription = idOf(session.subscription);
    if (session.mode === "subscription" && subscription !== null) {
      await this.sync(subscription, session.payment_status === "paid");
      return;
    }
    if (session.mode !== "payment") return;
    if (this.clients.billingOf(id).credited?.includes(session.id) === true) return;
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
    if (latest.credited?.includes(session.id) === true) return;
    this.clients.setBilling(id, {
      ...latest,
      topupSeconds: (latest.topupSeconds ?? 0) + packs * TOPUP_SECONDS,
      credited: [...(latest.credited ?? []), session.id],
    });
    this.log("billing-topup");
  }

  /**
   * Reads the subscription from Stripe rather than the event: events come out
   * of order. `paid`: Stripe said its current period was paid, which alone
   * opens that period's hours.
   */
  private async sync(subscriptionId: string, paid: boolean): Promise<void> {
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
    const current = billing.subscription;
    // One subscription per place: another one that goes on is never taken in place of it.
    // The operator refunds and cancels the second one (it is logged).
    if (current !== undefined && current.id !== subscription.id && current.status !== "ended") {
      if (status !== "ended") this.log("billing-duplicate");
      return;
    }
    const item = subscription.items?.data[0];
    const start = subscription.current_period_start ?? item?.current_period_start ?? null;
    const end = subscription.current_period_end ?? item?.current_period_end ?? null;
    const same = current?.id === subscription.id;
    const before = same ? current.paidPeriodStart : null;
    const now = paid && start !== null ? start * 1000 : null;
    // A period only moves forward: an older answer never takes back the hours of a newer one.
    const paidPeriodStart = now === null ? before : before === null ? now : Math.max(before, now);
    this.clients.setBilling(id, {
      ...billing,
      ...(billing.customer === undefined && customer !== null ? { customer } : {}),
      subscription: {
        id: subscription.id,
        status,
        paidPeriodStart,
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
  ): Promise<{ readonly id: string; readonly url: string; readonly expiresAt: number }> {
    const prices = await this.priceIds();
    const expiresAt = this.now() + PENDING_MS;
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
          : {
              payment_intent_data: { metadata },
              invoice_creation: {
                enabled: true,
                invoice_data: {
                  footer: INVOICE_FOOTER[locale](
                    this.options.termsUrl[locale],
                    new Date(this.now()).toISOString().slice(0, 10),
                  ),
                  metadata,
                },
              },
            }),
        ...(customer === undefined
          ? {}
          : { customer, customer_update: { address: "auto", name: "auto" } }),
        expires_at: Math.ceil(expiresAt / 1000),
        success_url: `${base}/billing/done?lang=${locale}`,
        cancel_url: `${base}/billing/back?lang=${locale}`,
        locale,
        automatic_tax: { enabled: true },
        billing_address_collection: "required",
        tax_id_collection: { enabled: true },
        consent_collection: { terms_of_service: "required" },
        custom_text: {
          terms_of_service_acceptance: {
            message: CONSENT[locale][item](this.options.termsUrl[locale]),
          },
        },
      },
      // Two clicks in the same minute open the same page.
      `checkout-${billing.ref}-${item}-${locale}-${Math.floor(this.now() / 60_000)}`,
    );
    const page = CheckoutPage.parse(session);
    return { id: page.id, url: page.url, expiresAt };
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
