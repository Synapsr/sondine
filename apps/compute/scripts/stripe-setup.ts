// Makes, or brings up to date, what the Cloud's payment needs in Stripe
// (ADR 047): the product, its three prices in euros VAT included, the customer
// portal's settings and, with --webhook, the endpoint Stripe calls. Safe to
// run again: it finds each by a fixed id, a lookup key or its metadata.
// Adapted from Loan Talvat's script for the site (Synapsr/Sondine-Website#1).
//
//   STRIPE_SECRET_KEY=sk_test_… node apps/compute/scripts/stripe-setup.ts \
//     --webhook=https://cloud.sondine.app/v1/stripe --secret-file=./whsec
//
// The webhook's signing secret is written to --secret-file, never printed.
// A live key is refused without --live.

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { z } from "zod";
import { createStripeHttp, LOOKUP_KEYS, STRIPE_VERSION, type StripeHttp } from "../src/stripe.ts";

const PRODUCT = "sondine_cloud";
const TAG = { sondine_cloud: "true" };
/** SaaS for personal use; to confirm with the accountant. */
const TAX_CODE = "txcd_10103001";

const PRICES = [
  { key: LOOKUP_KEYS.founder, cents: 1900, monthly: true, name: "Founder, 19 € a month" },
  { key: "sondine_cloud_monthly", cents: 2900, monthly: true, name: "Standard, 29 € a month" },
  { key: LOOKUP_KEYS.topup, cents: 1000, monthly: false, name: "10 hours, 10 €" },
] as const;

const WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
];

const List = z.looseObject({
  data: z.array(
    z.looseObject({
      id: z.string(),
      url: z.string().nullish(),
      active: z.boolean().nullish(),
      lookup_key: z.string().nullish(),
      unit_amount: z.int().nullish(),
      metadata: z.record(z.string(), z.string()).nullish(),
    }),
  ),
});

async function product(stripe: StripeHttp): Promise<void> {
  const wanted = {
    name: "Sondine Cloud",
    description: "Transcription in Sondine's cloud: 40 hours a month, and 10-hour top-ups.",
    tax_code: TAX_CODE,
  };
  try {
    await stripe.get(`/v1/products/${PRODUCT}`);
    await stripe.post(`/v1/products/${PRODUCT}`, { ...wanted, active: true });
    console.log(`kept     product ${PRODUCT}`);
  } catch {
    await stripe.post("/v1/products", { id: PRODUCT, ...wanted, metadata: TAG });
    console.log(`created  product ${PRODUCT}`);
  }
}

async function prices(stripe: StripeHttp): Promise<void> {
  for (const price of PRICES) {
    const found = List.parse(
      await stripe.get("/v1/prices", { lookup_keys: [price.key], active: true, limit: 1 }),
    ).data[0];
    if (found?.unit_amount === price.cents) {
      console.log(`kept     price ${price.key}`);
      continue;
    }
    await stripe.post("/v1/prices", {
      product: PRODUCT,
      currency: "eur",
      unit_amount: price.cents,
      tax_behavior: "inclusive",
      ...(price.monthly ? { recurring: { interval: "month" } } : {}),
      lookup_key: price.key,
      transfer_lookup_key: true,
      nickname: `Sondine Cloud: ${price.name}`,
      metadata: TAG,
    });
    console.log(`created  price ${price.key}`);
  }
}

async function portal(stripe: StripeHttp, publicUrl: string, siteUrl: string): Promise<string> {
  const settings = {
    business_profile: {
      headline: "Sondine Cloud",
      privacy_policy_url: `${siteUrl}/privacy-policy`,
      terms_of_service_url: `${siteUrl}/terms`,
    },
    default_return_url: `${publicUrl}/billing/back`,
    features: {
      customer_update: { enabled: true, allowed_updates: ["email", "address", "name", "tax_id"] },
      payment_method_update: { enabled: true },
      invoice_history: { enabled: true },
      subscription_cancel: { enabled: true, mode: "at_period_end" },
      subscription_update: { enabled: false },
    },
    metadata: TAG,
  };
  const found = List.parse(
    await stripe.get("/v1/billing_portal/configurations", { active: true, limit: 100 }),
  ).data.find((entry) => entry.metadata?.["sondine_cloud"] === "true");
  if (found !== undefined) {
    await stripe.post(`/v1/billing_portal/configurations/${found.id}`, settings);
    console.log(`updated  portal ${found.id}`);
    return found.id;
  }
  const created = z
    .looseObject({ id: z.string() })
    .parse(await stripe.post("/v1/billing_portal/configurations", settings));
  console.log(`created  portal ${created.id}`);
  return created.id;
}

async function webhook(stripe: StripeHttp, url: string, secretFile: string): Promise<void> {
  const found = List.parse(await stripe.get("/v1/webhook_endpoints", { limit: 100 })).data.find(
    (entry) => entry.url === url,
  );
  if (found !== undefined) {
    await stripe.post(`/v1/webhook_endpoints/${found.id}`, {
      enabled_events: WEBHOOK_EVENTS,
      disabled: false,
    });
    console.log(`updated  webhook ${found.id} (its secret is unchanged)`);
    return;
  }
  const created = z.looseObject({ id: z.string(), secret: z.string() }).parse(
    await stripe.post("/v1/webhook_endpoints", {
      url,
      enabled_events: WEBHOOK_EVENTS,
      api_version: STRIPE_VERSION,
      description: "Sondine Cloud",
      metadata: TAG,
    }),
  );
  writeFileSync(secretFile, created.secret, { mode: 0o600 });
  console.log(`created  webhook ${created.id}; its secret is in ${secretFile}`);
}

const { values } = parseArgs({
  options: {
    webhook: { type: "string" },
    "secret-file": { type: "string" },
    "public-url": { type: "string", default: "https://cloud.sondine.app" },
    "site-url": { type: "string", default: "https://sondine.app" },
    live: { type: "boolean", default: false },
  },
});
const apiKey = process.env["STRIPE_SECRET_KEY"] ?? "";
if (!/^[sr]k_(test|live)_/.test(apiKey)) {
  console.error("Set STRIPE_SECRET_KEY to a Stripe secret key.");
  process.exit(1);
}
if (apiKey.includes("_live_") && !values.live) {
  console.error("That is a live key: add --live once the maintainer said so.");
  process.exit(1);
}
if (values.webhook !== undefined && values["secret-file"] === undefined) {
  console.error("--webhook needs --secret-file, where its signing secret goes.");
  process.exit(1);
}
const stripe = createStripeHttp({
  apiKey,
  ...(process.env["STRIPE_API_BASE"] === undefined
    ? {}
    : { apiBase: process.env["STRIPE_API_BASE"] }),
});
console.log(`Sondine Cloud in Stripe, ${apiKey.includes("_live_") ? "LIVE" : "test"} mode`);
await product(stripe);
await prices(stripe);
const portalId = await portal(stripe, values["public-url"], values["site-url"]);
if (values.webhook !== undefined && values["secret-file"] !== undefined) {
  await webhook(stripe, values.webhook, values["secret-file"]);
}
console.log(`\nSONDINE_COMPUTE_STRIPE_PORTAL=${portalId}`);
console.log(
  "In the Dashboard: Settings › Public details › Terms of service URL (Checkout's consent needs it), and Tax › Registrations (France).",
);
