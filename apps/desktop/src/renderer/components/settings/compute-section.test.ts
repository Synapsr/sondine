import type { ComputeDestination, ComputeStatus } from "@sondine/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The page as React and TanStack Query run it, on a core that behaves as
// compute-layer does: what the user chose must be what core keeps (2026-11-25:
// « Cloud » went back to this Mac 14 ms after each click). Sondine's
// controls are plain elements here: Base UI needs a whole browser.

/** Core's side: the last choice wins over a server's late answer. */
const core = vi.hoisted(() => {
  const initial = { destination: "device", own: false, joined: false, invited: false };
  return {
    state: { ...initial },
    choices: 0,
    /** Every `compute.choose` received. */
    chosen: [] as string[],
    /** Last invite link passed to `joinBeta`. */
    lastInvite: undefined as string | undefined,
    givenBack: 0,
    /** How full the wave is; null: the server has none. */
    waveData: null as { percent: number; full: boolean } | null,
    /** How many times the window asked how full the wave is. */
    waveAsked: 0,
    outcome: "joined",
    /** Resolves when the server answers. */
    answer: Promise.resolve(),
    reset() {
      this.state = { ...initial };
      this.choices = 0;
      this.chosen = [];
      this.lastInvite = undefined;
      this.givenBack = 0;
      this.waveData = null;
      this.waveAsked = 0;
      this.outcome = "joined";
      this.answer = Promise.resolve();
    },
    status() {
      const { destination, own, joined, invited } = this.state;
      return {
        destination,
        own: own ? { name: "atelier", host: "10.0.0.1:8443" } : null,
        beta: { available: true, joined, invited, reference: joined ? "0123456789ab" : null },
      };
    },
    choose(destination: string) {
      this.choices += 1;
      this.chosen.push(destination);
      this.state.destination = destination;
      return this.status();
    },
    async joinBeta(input: { link?: string } = {}) {
      this.lastInvite = input.link;
      const asked = ++this.choices;
      if (!this.state.joined || input.link !== undefined) {
        await this.answer;
        if (this.choices !== asked) {
          this.givenBack += 1;
          return { outcome: "cancelled", status: this.status() };
        }
        if (this.outcome !== "joined") return { outcome: this.outcome, status: this.status() };
      }
      this.state = {
        ...this.state,
        destination: "beta",
        joined: true,
        invited: input.link !== undefined || this.state.invited,
      };
      return { outcome: "joined", status: this.status() };
    },
    async connect() {
      const asked = ++this.choices;
      await this.answer;
      if (this.choices !== asked) return { outcome: "cancelled", status: this.status() };
      this.state = { ...this.state, destination: "own", own: true };
      return { outcome: "connected", status: this.status() };
    },
  };
});

vi.mock("../../core/orpc", () => {
  const mutation = (run: (input: { destination: string }) => unknown) => ({
    mutationOptions: (options: object = {}) => ({
      ...options,
      mutationFn: async (input: { destination: string }) => {
        const answer = await run(input);
        // Back over the port: meanwhile the page shows that it waits.
        await new Promise((resolve) => setTimeout(resolve, 15));
        return answer;
      },
    }),
  });
  return {
    errorMessage: String,
    orpc: {
      compute: {
        get: {
          queryKey: () => ["compute"],
          queryOptions: () => ({
            queryKey: ["compute"],
            queryFn: () => Promise.resolve(core.status()),
          }),
        },
        choose: mutation(({ destination }) => core.choose(destination)),
        connect: mutation(() => core.connect()),
        joinBeta: mutation((input) => core.joinBeta(input as { link?: string })),
        disconnect: mutation(() => core.status()),
        leaveBeta: mutation(() => core.status()),
        quota: {
          queryKey: () => ["compute", "quota"],
          queryOptions: () => ({
            queryKey: ["compute", "quota"],
            queryFn: () => Promise.resolve(null),
          }),
        },
        wave: {
          queryOptions: () => ({
            queryKey: ["compute", "wave"],
            queryFn: () => {
              core.waveAsked += 1;
              return Promise.resolve(core.waveData);
            },
          }),
        },
      },
    },
  };
});

vi.mock("@sondine/ui/components/alert-dialog", () => {
  let close = () => undefined as void;
  const plain = ({ children }: { children?: ReactNode }) => children;
  return {
    AlertDialog: (props: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children: ReactNode;
    }) => {
      if (!props.open) return null;
      close = () => props.onOpenChange(false);
      return createElement("section", { role: "alertdialog" }, props.children);
    },
    AlertDialogClose: () => createElement("button", { id: "dismiss", onClick: () => close() }),
    AlertDialogDescription: plain,
    AlertDialogFooter: plain,
    AlertDialogPopup: plain,
    AlertDialogTitle: plain,
  };
});

vi.mock("@sondine/ui/components/radio-group", () => {
  let choose = (_value: string) => undefined as void;
  let value = "";
  return {
    RadioGroup: (props: {
      value: string;
      onValueChange: (value: string) => void;
      children: ReactNode;
    }) => {
      ({ value, onValueChange: choose } = props);
      return createElement("div", { id: "choice", "data-value": props.value }, props.children);
    },
    Radio: (props: { value: string }) =>
      createElement("button", {
        id: `radio-${props.value}`,
        "data-checked": props.value === value,
        onClick: () => choose(props.value),
      }),
    RadioLabel: ({ children }: { children: ReactNode }) => children,
  };
});

vi.mock("@sondine/ui/components/button", () => ({
  Button: (props: {
    onClick?: () => void;
    type?: "submit";
    isPending?: boolean;
    children: ReactNode;
  }) =>
    createElement(
      "button",
      {
        type: props.type,
        onClick: props.onClick,
        // As the real button: the page shows that it waits.
        "aria-busy": props.isPending === true ? true : undefined,
      },
      props.children,
    ),
}));

vi.mock("@sondine/ui/components/meter", () => {
  const plain = ({ children }: { children?: ReactNode | (() => ReactNode) }) =>
    typeof children === "function" ? children() : children;
  return { Meter: plain, MeterLabel: plain, MeterValue: plain };
});

vi.mock("@sondine/ui/components/field", () => {
  const plain = ({ children }: { children?: ReactNode }) => children;
  return { Field: plain, FieldLabel: plain };
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
const { ComputeSection } = await import("./compute-section");

let root: Root;
let client: QueryClient;
let document: Document;

beforeEach(async () => {
  core.reset();
  const dom = parseHTML("<!doctype html><html><body><div></div></body></html>");
  ({ document } = dom);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("HTMLIFrameElement", dom.window["HTMLIFrameElement"]);
  const container = document.querySelector("div");
  if (container === null) throw new Error("no container");
  client = new QueryClient();
  root = createRoot(container);
  root.render(createElement(QueryClientProvider, { client }, createElement(ComputeSection)));
  await vi.waitFor(() => expect(shown()).toBe("device"));
});

afterEach(async () => {
  root.unmount();
  await new Promise((resolve) => setTimeout(resolve, 20));
  vi.unstubAllGlobals();
});

const shown = () => document.querySelector("#choice")?.getAttribute("data-value");
const dialog = () => document.querySelector("[role=alertdialog]");
/** The dialog's button shows it waits: the page knows the answer is due. */
const waiting = () =>
  vi.waitFor(() =>
    expect(document.querySelector("[role=alertdialog] [aria-busy=true]")).not.toBeNull(),
  );

function click(selector: string): void {
  const element = document.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`no ${selector}`);
  element.click();
}

/** The dialog's own button, last: the invite link's comes before it. */
function pressDialog(): void {
  const buttons = [
    ...document.querySelectorAll<HTMLElement>("[role=alertdialog] button:not(#dismiss)"),
  ];
  const button = buttons.at(-1);
  if (button === undefined) throw new Error("no dialog button");
  button.click();
}

/** Opens a destination's dialog and presses its button. */
async function ask(destination: Exclude<ComputeDestination, "device">): Promise<void> {
  click(`#radio-${destination}`);
  await vi.waitFor(() => expect(dialog()).not.toBeNull());
  if (destination === "beta") {
    pressDialog();
    return;
  }
  const form = document.querySelector("form");
  form?.dispatchEvent(
    new document.defaultView!.Event("submit", { bubbles: true, cancelable: true }),
  );
}

/** Holds the server's answer until the returned function is called. */
function held(): () => void {
  let release = () => undefined as void;
  core.answer = new Promise((resolve) => (release = resolve));
  return release;
}

/** As the window does when it has the focus again: what core keeps, read anew. */
async function reread(): Promise<ComputeStatus["destination"] | null | undefined> {
  await client.refetchQueries({ queryKey: ["compute"] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  return shown() as ComputeStatus["destination"] | null | undefined;
}

describe("choosing where transcription runs", () => {
  it("keeps the cloud once a place is taken", async () => {
    const answer = held();
    await ask("beta");
    answer();
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(await reread()).toBe("beta");
    expect(core.chosen).toEqual([]);
    expect(core.givenBack).toBe(0);
  });

  it("keeps the cloud with a place taken before, which answers at once", async () => {
    core.state.joined = true;
    await ask("beta");
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(await reread()).toBe("beta");
    expect(core.chosen).toEqual([]);
  });

  it("keeps the user's machine once it answered", async () => {
    const answer = held();
    await ask("own");
    answer();
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(await reread()).toBe("own");
    expect(core.chosen).toEqual([]);
  });

  it.each(["beta", "own"] as const)(
    "changes nothing when the %s dialog is closed before the answer",
    async (destination) => {
      const answer = held();
      await ask(destination);
      await vi.waitFor(() => expect(core.choices).toBe(1));
      await waiting();
      click("#dismiss");
      await vi.waitFor(() => expect(core.chosen).toEqual(["device"]));
      answer();
      await vi.waitFor(() => expect(dialog()).toBeNull());
      expect(await reread()).toBe("device");
      expect(core.givenBack).toBe(destination === "beta" ? 1 : 0);
    },
  );

  it("shows what core keeps when the answer came before the closing", async () => {
    const answer = held();
    await ask("beta");
    await waiting();
    answer();
    click("#dismiss");
    await vi.waitFor(() => expect(dialog()).toBeNull());
    await vi.waitFor(() => expect(client.isMutating()).toBe(0));
    await vi.waitFor(() => expect(shown()).toBe(core.state.destination));
  });

  it("stays open on a refusal, and closing it then chooses nothing", async () => {
    core.outcome = "full";
    await ask("beta");
    await vi.waitFor(() => expect(document.querySelector("[role=alert]")).not.toBeNull());
    expect(dialog()).not.toBeNull();
    click("#dismiss");
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(core.chosen).toEqual([]);
    expect(await reread()).toBe("device");
  });

  it("asks nothing of the wave until the Cloud is chosen", async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(core.waveAsked).toBe(0);
  });

  it("shows how full the wave is before a place is taken, and the trial's button", async () => {
    core.waveData = { percent: 70, full: false };
    click("#radio-beta");
    await vi.waitFor(() =>
      expect(dialog()?.textContent).toContain(m.cloud_wave_taken({ percent: "70" })),
    );
    expect(dialog()?.textContent).toContain(m.compute_trial_start());
    expect(dialog()?.textContent).toContain(m.compute_trial_terms());
  });

  it("says a full wave is full, and where to be told of the next one", async () => {
    core.waveData = { percent: 100, full: true };
    click("#radio-beta");
    await vi.waitFor(() => expect(dialog()?.textContent).toContain(m.cloud_wave_full_detail()));
  });

  it("sends the invite code typed in Settings, and offers Disconnect instead of Leave", async () => {
    click("#radio-beta");
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    // The field hides behind its link.
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent === m.compute_beta_invite_open())
      ?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const input = document.querySelector<HTMLInputElement>("[role=alertdialog] input");
    expect(input).not.toBeNull();
    input!.value = "invite-token-123";
    input!.dispatchEvent(new document.defaultView!.Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    pressDialog();
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(core.lastInvite).toBe("invite-token-123");
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(m.compute_cloud_disconnect()),
    );
  });
});
