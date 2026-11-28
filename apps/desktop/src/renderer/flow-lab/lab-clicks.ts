import type { LabClick } from "../../shared/flow-lab";

// The clicks a step makes once its page is there (shared/flow-lab.ts): a
// screen only a click opens, such as the first run's « Sur ce Mac ».

const PAUSE_MS = 450;
const WAIT_MS = 10_000;

function target(click: Exclude<LabClick, { type: "command-key" }>): HTMLElement | null {
  switch (click.type) {
    case "transcription-choice":
      return document.querySelector<HTMLElement>(
        `[role=radiogroup] label:nth-of-type(${click.index})`,
      );
    case "button":
      return (
        [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => {
          const text = button.textContent.trim();
          return (text === click.fr || text === click.en) && !button.disabled;
        }) ?? null
      );
  }
}

async function found(click: Exclude<LabClick, { type: "command-key" }>): Promise<HTMLElement> {
  for (let waited = 0; waited < WAIT_MS; waited += 100) {
    const element = target(click);
    if (element !== null) return element;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`clic introuvable : ${JSON.stringify(click)}`);
}

export async function runClicks(clicks: readonly LabClick[]): Promise<void> {
  for (const click of clicks) {
    await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
    if (click.type === "command-key") {
      const init = {
        key: click.key,
        code: `Key${click.key.toUpperCase()}`,
        metaKey: true,
        bubbles: true,
      };
      document.body.dispatchEvent(new KeyboardEvent("keydown", init));
      document.body.dispatchEvent(new KeyboardEvent("keyup", init));
      continue;
    }
    (await found(click)).click();
  }
}
