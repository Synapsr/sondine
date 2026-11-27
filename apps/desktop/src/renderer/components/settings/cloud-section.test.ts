import type { ComputeBillingInput, ComputeQuota } from "@sondine/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Cloud's plan as the window shows it (ADR 047), on a core that answers as
// compute-layer does. Stripe's pages open in the browser: here, only the
// page asked for is recorded. Sondine's controls are plain elements.

const core = vi.hoisted(() => ({
  quota: null as ComputeQuota | null,
  asked: [] as ComputeBillingInput[],
  outcome: "opened" as string,
  reset() {
    this.quota = null;
    this.asked = [];
    this.outcome = "opened";
  },
}));

vi.mock("../../core/orpc", () => ({
  errorMessage: String,
  orpc: {
    compute: {
      get: {
        queryOptions: () => ({
          queryKey: ["compute"],
          queryFn: () =>
            Promise.resolve({
              destination: "beta",
              own: null,
              beta: { available: true, joined: true, invited: false, reference: "0123456789ab" },
            }),
        }),
      },
      quota: {
        queryOptions: () => ({
          queryKey: ["compute", "quota"],
          queryFn: () => Promise.resolve(core.quota),
        }),
      },
      wave: {
        queryOptions: () => ({
          queryKey: ["compute", "wave"],
          queryFn: () => Promise.resolve(null),
        }),
      },
      openBilling: {
        mutationOptions: () => ({
          mutationFn: async (input: ComputeBillingInput) => {
            core.asked.push(input);
            return { outcome: core.outcome };
          },
        }),
      },
    },
  },
}));

vi.mock("../../i18n/locale", () => ({ useLocale: () => ({ locale: "fr" }) }));

vi.mock("@sondine/ui/components/meter", () => {
  const plain = ({ children }: { children?: ReactNode | (() => ReactNode) }) =>
    typeof children === "function" ? children() : children;
  return { Meter: plain, MeterLabel: plain, MeterValue: plain };
});

vi.mock("@sondine/ui/components/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => createElement("b", null, children),
}));

vi.mock("@sondine/ui/components/button", () => ({
  Button: (props: { onClick?: () => void; children: ReactNode }) =>
    createElement("button", { onClick: props.onClick }, props.children),
}));

const { m } = await import("../../paraglide/messages.js");
const { CloudSection } = await import("./cloud-section");

let root: Root;
let document: Document;
let client: QueryClient;

const DAY = 86_400_000;
const periodEnd = Date.UTC(2026, 11, 27, 12);

const trial = (usedSeconds: number): ComputeQuota => ({
  plan: "trial",
  period: "total",
  usedSeconds,
  limitSeconds: 3_600,
  extraSeconds: 0,
});

const founder = (
  subscription: NonNullable<ComputeQuota["subscription"]>,
  usedSeconds = 12 * 3_600,
  extraSeconds = 0,
): ComputeQuota => ({
  plan: subscription.status === "ended" ? "ended" : "cloud",
  period: "month",
  usedSeconds,
  limitSeconds: subscription.status === "ended" ? 0 : 40 * 3_600,
  extraSeconds,
  subscription,
});

async function render(quota: ComputeQuota): Promise<void> {
  core.quota = quota;
  const dom = parseHTML("<!doctype html><html><body><div></div></body></html>");
  ({ document } = dom);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", document);
  const container = document.querySelector("div");
  if (container === null) throw new Error("no container");
  client = new QueryClient();
  root = createRoot(container);
  root.render(createElement(QueryClientProvider, { client }, createElement(CloudSection)));
  await vi.waitFor(() => expect(text()).not.toBe(""));
}

const text = () => document.body.textContent ?? "";

function press(label: string): void {
  const button = [...document.querySelectorAll("button")].find((b) => b.textContent === label);
  if (button === undefined) throw new Error(`no button ${label}`);
  button.click();
}

beforeEach(() => core.reset());

afterEach(async () => {
  root.unmount();
  await new Promise((resolve) => setTimeout(resolve, 20));
  vi.unstubAllGlobals();
});

describe("the Cloud's plan", () => {
  it("shows the trial's minutes and the Founder plan, and opens Checkout in French", async () => {
    await render(trial(18 * 60));
    expect(text()).toContain(m.cloud_trial_left({ left: "42", total: "60" }));
    expect(text()).toContain(m.cloud_founder_detail());
    press(m.cloud_subscribe());
    await vi.waitFor(() => expect(core.asked).toEqual([{ page: "subscription", locale: "fr" }]));
    await vi.waitFor(() => expect(text()).toContain(m.cloud_waiting()));
  });

  it("updates by itself once paid, and stops waiting", async () => {
    await render(trial(3_600));
    expect(text()).toContain(m.cloud_trial_done());
    press(m.cloud_subscribe());
    await vi.waitFor(() => expect(text()).toContain(m.cloud_waiting()));
    core.quota = founder({ status: "active", periodEnd, cancelAtPeriodEnd: false }, 0);
    // The webhook reached the server: the next reading shows the plan.
    await client.refetchQueries({ queryKey: ["compute", "quota"] });
    await vi.waitFor(() => expect(text()).toContain(m.cloud_plan_founder()));
    expect(text()).not.toContain(m.cloud_waiting());
    expect(text()).toContain(m.cloud_renews({ date: "27 décembre" }));
  });

  it("shows a subscriber's hours, top-ups, and the two Stripe pages", async () => {
    await render(founder({ status: "active", periodEnd, cancelAtPeriodEnd: false }, 40 * 3_600, 0));
    expect(text()).toContain(m.cloud_hours({ used: "40", limit: "40" }));
    expect(text()).toContain(m.cloud_period_done({ date: "27 décembre" }));
    press(m.cloud_topup());
    press(m.cloud_manage());
    await vi.waitFor(() =>
      expect(core.asked).toEqual([
        { page: "topup", locale: "fr" },
        { page: "portal", locale: "fr" },
      ]),
    );
    expect(text()).not.toContain(m.cloud_subscribe());
  });

  it("says when a cancelled plan ends, and when a renewal failed", async () => {
    await render(founder({ status: "active", periodEnd, cancelAtPeriodEnd: true }));
    expect(text()).toContain(m.cloud_ends({ date: "27 décembre" }));
    root.unmount();
    await render(
      founder({ status: "past_due", periodEnd: periodEnd + DAY, cancelAtPeriodEnd: false }),
    );
    expect(text()).toContain(m.cloud_past_due_detail());
    press(m.cloud_update_card());
    await vi.waitFor(() => expect(core.asked).toEqual([{ page: "portal", locale: "fr" }]));
  });

  it("keeps an ended plan's top-ups and offers the plan again", async () => {
    await render(founder({ status: "ended", periodEnd, cancelAtPeriodEnd: false }, 0, 10 * 3_600));
    expect(text()).toContain(m.cloud_ended_detail());
    expect(text()).toContain(m.cloud_extra({ hours: "10" }));
    expect(text()).toContain(m.cloud_subscribe());
    expect(text()).not.toContain(m.cloud_topup());
  });

  it("names the place for the operator, never with its token", async () => {
    await render(trial(0));
    await vi.waitFor(() => expect(text()).toContain("0123456789ab"));
    expect(text()).toContain(m.cloud_reference_detail());
  });

  it("says why a page did not open", async () => {
    core.outcome = "unavailable";
    await render(trial(0));
    press(m.cloud_subscribe());
    await vi.waitFor(() => expect(text()).toContain(m.cloud_unavailable()));
    expect(text()).not.toContain(m.cloud_waiting());
  });
});
