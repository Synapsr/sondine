import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The first run's transcription step as React and TanStack Query run it
// (ADR 040): the choice first, then the chosen place's screen, and nothing
// sent to a server before that screen's button. Sondine's controls are plain
// elements here: Base UI needs a whole browser.

const core = vi.hoisted(() => ({
  destination: "device",
  tooBig: false,
  /** Every call that could send something, or change the place in force. */
  calls: [] as string[],
  lastInvite: undefined as string | undefined,
  reset() {
    this.destination = "device";
    this.tooBig = false;
    this.calls = [];
    this.lastInvite = undefined;
  },
  status() {
    return {
      destination: this.destination,
      own: null,
      beta: {
        available: true,
        joined: this.destination === "beta",
        invited: false,
        reference: null,
      },
    };
  },
}));

vi.mock("../../core/orpc", () => {
  const mutation = (name: string, run: (input: { destination?: string }) => unknown) => ({
    mutationOptions: (options: object = {}) => ({
      ...options,
      mutationFn: async (input: { destination?: string }) => {
        core.calls.push(name);
        return run(input);
      },
    }),
  });
  const query = (key: string, read: () => unknown) => ({
    queryKey: () => [key],
    queryOptions: () => ({ queryKey: [key], queryFn: () => Promise.resolve(read()) }),
  });
  return {
    errorMessage: String,
    orpc: {
      compute: {
        get: query("compute", () => core.status()),
        choose: mutation("choose", ({ destination }) => {
          core.destination = destination ?? "device";
          return core.status();
        }),
        connect: mutation("connect", () => ({ outcome: "connected", status: core.status() })),
        joinBeta: mutation("joinBeta", (input) => {
          core.lastInvite = (input as { link?: string }).link;
          core.destination = "beta";
          return { outcome: "joined", status: core.status() };
        }),
        disconnect: mutation("disconnect", () => core.status()),
        leaveBeta: mutation("leaveBeta", () => core.status()),
        quota: query("compute-quota", () => null),
        wave: query("compute-wave", () => ({ percent: 30, full: false })),
      },
      onboarding: {
        get: query("onboarding", () => ({ step: "model" })),
        advance: mutation("advance", () => ({ step: "model" })),
      },
    },
  };
});

vi.mock("../models/model-panel", () => ({
  ModelPanel: () => createElement("div", { id: "model-panel" }),
  useModels: () => ({ data: {} }),
}));

vi.mock("../models/model-view", () => ({
  modelsBusy: () => false,
  modelsReady: () => false,
  modelsTooBig: () => core.tooBig,
  memoryAsked: () => ({ needed: 32, memory: 16 }),
}));

vi.mock("../models/small-mac", () => ({ setSmallMac: () => undefined, useSmallMac: () => false }));

const plain = ({ children }: { children?: ReactNode }) => children;

vi.mock("@sondine/ui/components/radio-group", () => {
  let choose = (_value: string) => undefined as void;
  let value = "";
  return {
    RadioGroup: (props: {
      value: string | null;
      onValueChange: (value: string) => void;
      children: ReactNode;
    }) => {
      value = props.value ?? "";
      choose = props.onValueChange;
      return createElement("div", { id: "choice", "data-value": value }, props.children);
    },
    Radio: (props: { value: string; disabled?: boolean }) =>
      createElement("button", {
        id: `radio-${props.value}`,
        disabled: props.disabled === true,
        "data-checked": props.value === value,
        onClick: () => choose(props.value),
      }),
    RadioLabel: plain,
  };
});

vi.mock("@sondine/ui/components/button", () => ({
  Button: (props: {
    onClick?: () => void;
    type?: "submit";
    form?: string;
    variant?: string;
    children: ReactNode;
  }) =>
    createElement(
      "button",
      { type: props.type, form: props.form, onClick: props.onClick },
      props.children,
    ),
}));

vi.mock("@sondine/ui/components/dialog", () => ({
  Dialog: plain,
  DialogClose: plain,
  DialogDescription: plain,
  DialogFooter: plain,
  DialogPopup: plain,
  DialogTitle: plain,
  DialogTrigger: plain,
}));
vi.mock("@sondine/ui/components/badge", () => ({ Badge: plain }));

vi.mock("@sondine/ui/components/alert-dialog", () => ({
  AlertDialog: () => null,
  AlertDialogClose: plain,
  AlertDialogDescription: plain,
  AlertDialogFooter: plain,
  AlertDialogPopup: plain,
  AlertDialogTitle: plain,
}));

vi.mock("@sondine/ui/components/field", () => ({ Field: plain, FieldLabel: plain }));
vi.mock("../../i18n/locale", () => ({ useLocale: () => ({ locale: "fr" }) }));
vi.mock("@sondine/ui/components/meter", () => {
  const meter = ({ children }: { children?: ReactNode | (() => ReactNode) }) =>
    typeof children === "function" ? children() : children;
  return { Meter: meter, MeterLabel: meter, MeterValue: meter };
});
vi.mock("@sondine/ui/components/input", () => ({
  Input: (props: { value?: string; onChange?: (event: { target: { value: string } }) => void }) =>
    createElement("input", {
      value: props.value ?? "",
      onInput: (event: Event) =>
        props.onChange?.({ target: { value: (event.target as HTMLInputElement).value } }),
    }),
}));

const { m } = await import("../../paraglide/messages.js");
const { TranscriptionStep } = await import("./transcription-step");

let root: Root;
let document: Document;
let steps: string[];

async function render(): Promise<void> {
  const dom = parseHTML("<!doctype html><html><body><div></div></body></html>");
  ({ document } = dom);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("HTMLIFrameElement", dom.window["HTMLIFrameElement"]);
  const container = document.querySelector("div");
  if (container === null) throw new Error("no container");
  root = createRoot(container);
  root.render(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(TranscriptionStep, {
        onBack: () => steps.push("back"),
        onNext: () => steps.push("next"),
      }),
    ),
  );
  await vi.waitFor(() => expect(title()).toBe(m.welcome_where_title()));
}

beforeEach(() => {
  core.reset();
  steps = [];
});

afterEach(async () => {
  root.unmount();
  await new Promise((resolve) => setTimeout(resolve, 20));
  vi.unstubAllGlobals();
});

const title = () => document.querySelector("h1")?.textContent;
const picked = () => document.querySelector("#choice")?.getAttribute("data-value");

function press(text: string): void {
  const button = [...document.querySelectorAll("button")].find((b) => b.textContent === text);
  if (button === undefined) throw new Error(`no button « ${text} »`);
  button.click();
}

async function open(destination: "device" | "own" | "beta"): Promise<void> {
  document.querySelector<HTMLElement>(`#radio-${destination}`)?.click();
  await vi.waitFor(() => expect(picked()).toBe(destination));
  press(m.welcome_continue());
}

describe("the first run's transcription step", () => {
  it("only asks where, with this Mac picked and no download", async () => {
    await render();
    expect(picked()).toBe("device");
    expect(document.querySelector("#model-panel")).toBeNull();
    expect(document.querySelector("#radio-beta")).not.toBeNull();
  });

  it("shows the model only once this Mac is chosen", async () => {
    await render();
    await open("device");
    await vi.waitFor(() => expect(title()).toBe(m.compute_device()));
    expect(document.querySelector("#model-panel")).not.toBeNull();
    expect(core.calls).toEqual([]);
  });

  it("shows the wave and the Cloud's terms in the page, and takes nothing before the trial's button", async () => {
    await render();
    await open("beta");
    await vi.waitFor(() => expect(title()).toBe(m.compute_beta_title()));
    // The short version: one paragraph, the price, and the rest on the site.
    expect(document.body.textContent).toContain(m.compute_trial_summary());
    expect(document.body.textContent).toContain(m.compute_trial_privacy());
    expect(document.body.textContent).not.toContain(m.compute_beta_others());
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(m.cloud_wave_taken({ percent: "30" })),
    );
    expect(core.calls).toEqual([]);
    press(m.compute_trial_start());
    await vi.waitFor(() => expect(steps).toEqual(["next"]));
    expect(core.calls).toEqual(["joinBeta"]);
  });

  it("goes back to the choice from a server's screen, with nothing sent", async () => {
    await render();
    await open("own");
    await vi.waitFor(() => expect(title()).toBe(m.compute_own()));
    expect(document.body.textContent).toContain(m.compute_own_confirm());
    expect(document.querySelector("form#welcome-connect")).not.toBeNull();
    press(m.welcome_back());
    await vi.waitFor(() => expect(title()).toBe(m.welcome_where_title()));
    expect(steps).toEqual([]);
    expect(core.calls).toEqual([]);
  });

  it("reopens on the choice with the place in force, and goes on from it", async () => {
    core.destination = "beta";
    await render();
    expect(picked()).toBe("beta");
    await open("beta");
    await vi.waitFor(() => expect(title()).toBe(m.compute_beta_title()));
    press(m.welcome_continue());
    expect(steps).toEqual(["next"]);
    expect(core.calls).toEqual([]);
  });

  it("goes back to this Mac without a server's consent", async () => {
    core.destination = "beta";
    await render();
    await open("device");
    await vi.waitFor(() => expect(core.calls).toEqual(["choose"]));
    expect(core.destination).toBe("device");
  });

  it("shows this Mac unavailable when it is too small, and why", async () => {
    core.tooBig = true;
    await render();
    expect(picked()).toBe("");
    expect(document.querySelector<HTMLButtonElement>("#radio-device")?.disabled).toBe(true);
    expect(document.body.textContent).toContain(m.welcome_cloud_title());
    expect(document.body.textContent).toContain(
      m.welcome_device_why_detail({ needed: "32", memory: "16" }),
    );
    press(m.welcome_without_model());
    expect(steps).toEqual(["next"]);
  });

  it("lets a user join with a Cloud invite link or code during the first run", async () => {
    await render();
    await open("beta");
    await vi.waitFor(() => expect(title()).toBe(m.compute_beta_title()));
    // The field hides behind its link.
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent === m.compute_beta_invite_open())
      ?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const input = document.querySelector<HTMLInputElement>("input");
    expect(input).not.toBeNull();
    input!.value = "wave1-invite-token";
    input!.dispatchEvent(new document.defaultView!.Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    press(m.compute_beta_use());
    await vi.waitFor(() => expect(steps).toEqual(["next"]));
    expect(core.calls).toEqual(["joinBeta"]);
    expect(core.lastInvite).toBe("wave1-invite-token");
  });
});
