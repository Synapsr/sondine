// A Cloud of invented data for the app's captures (apps/desktop
// scripts/ux/cloud-shots.ts): the real server, with a model that never runs
// and a Stripe that answers from memory. Nothing reaches Stripe or a card.
//
//   (cd apps/compute && npx vite build --ssr scripts/fake-cloud.ts --outDir <dir>)
//   node <dir>/sondine-compute.js <state-folder> <port>
//
// It prints `ready <endpoint> <key>`, then reads one scenario a line on its
// input and answers `ok <scenario>` once the state on disk says it:
//   wave-70 | wave-full | trial | trial-done | subscribed | cancelling | past-due

import { createInterface } from "node:readline";
import { NEMOTRON_CAPABILITIES, NEMOTRON_MANIFEST, NEMOTRON_RESOURCES } from "@sondine/engines";
import { BillingService } from "../src/billing.ts";
import { ClientStore } from "../src/clients.ts";
import { createComputeServer } from "../src/server.ts";
import { Sessions } from "../src/sessions.ts";
import type { StripeHttp } from "../src/stripe.ts";

const [stateDir, port = "8790"] = process.argv.slice(2);
if (stateDir === undefined) {
  console.error("fake-cloud.ts <state-folder> [port]");
  process.exit(1);
}

const HOUR = 3_600;
const DAY_MS = 86_400_000;
const clients = new ClientStore(stateDir);

const stripe: StripeHttp = {
  get: async () => ({ data: [] }),
  post: async (path) => ({
    id: "cs_test_shots",
    url: path.includes("portal")
      ? "https://billing.stripe.com/p/session/test_shots"
      : "https://checkout.stripe.com/c/pay/cs_test_shots",
  }),
};
// The prices are looked up once; a fake Stripe gives them straight away.
stripe.get = async (path) =>
  path === "/v1/prices"
    ? {
        data: [
          { id: "price_founder", lookup_key: "sondine_cloud_founder_monthly" },
          { id: "price_topup", lookup_key: "sondine_cloud_topup_10h" },
        ],
      }
    : { data: [] };

const billing = new BillingService(clients, {
  stripe,
  webhookSecret: "whsec_shots",
  publicUrl: `http://127.0.0.1:${port}`,
  termsUrl: { en: "https://sondine.app/terms", fr: "https://sondine.app/fr/terms" },
});
const sessions = new Sessions({
  engine: {
    manifest: NEMOTRON_MANIFEST,
    capabilities: NEMOTRON_CAPABILITIES,
    resources: NEMOTRON_RESOURCES,
    state: () => "ready",
    pid: () => undefined,
    load: async () => ({ loadMs: 0 }),
    unload: async () => undefined,
    transcribe: async () => {
      throw new Error("nothing is transcribed in the captures");
    },
  },
  known: (id) => clients.has(id),
});
const server = createComputeServer({ clients, sessions, billing, name: "Sondine", beta: null });

/** The place the app took: the newest trial that is not a filler. */
function appPlace(): string | null {
  const own = clients
    .list()
    .filter(({ client }) => client.name === "trial")
    .toSorted((a, b) => b.client.createdAt - a.client.createdAt);
  return own[0]?.id ?? null;
}

/** Places of other people, so that the wave is as full as asked. */
function fill(taken: number): void {
  clients.setWavePlaces(10);
  for (const { id, client } of clients.list()) if (client.name === "filler") clients.remove(id);
  for (let index = 0; index < taken; index += 1) clients.add("beta", "filler", { plan: "trial" });
}

function subscribe(id: string, status: "active" | "past_due", cancelAtPeriodEnd: boolean): void {
  const now = Date.now();
  clients.setBilling(id, {
    ...clients.billingOf(id),
    customer: "cus_shots",
    subscription: {
      id: "sub_shots",
      status,
      paidPeriodStart: now - 9 * DAY_MS,
      periodEnd: now + 21 * DAY_MS,
      cancelAtPeriodEnd,
    },
    topupSeconds: 10 * HOUR,
  });
}

function apply(scenario: string): void {
  const id = appPlace();
  switch (scenario) {
    case "wave-70":
      return fill(7);
    case "wave-full":
      return fill(10);
    case "trial":
    case "trial-done":
      if (id === null) throw new Error("no place yet");
      clients.charge(
        id,
        scenario === "trial" ? 18 * 60 : 60 * 60 - (clients.quota(id)?.usedSeconds ?? 0),
      );
      return;
    case "subscribed":
    case "cancelling":
    case "past-due":
      if (id === null) throw new Error("no place yet");
      subscribe(id, scenario === "past-due" ? "past_due" : "active", scenario === "cancelling");
      // This period's hours: 12 h 40 used.
      clients.charge(id, 12 * HOUR + 40 * 60 - (clients.quota(id)?.usedSeconds ?? 0));
      return;
    default:
      throw new Error(`no scenario ${scenario}`);
  }
}

server.listen(Number(port), "127.0.0.1", () => {
  console.log(`ready http://127.0.0.1:${port} ${clients.key().publicKey.toString("base64url")}`);
});
for await (const line of createInterface({ input: process.stdin })) {
  const scenario = line.trim();
  if (scenario === "") continue;
  try {
    apply(scenario);
    console.log(`ok ${scenario}`);
  } catch (error) {
    console.log(`error ${scenario} ${String(error)}`);
  }
}
server.closeAllConnections();
server.close();
await sessions.stop();
