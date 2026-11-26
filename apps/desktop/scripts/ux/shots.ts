// Captures the window on invented data (docs/ux-redesign.md §8): seeds a
// fresh development data folder, starts the app with fake audio hardware,
// then screenshots each screen in light and dark through the DevTools
// protocol. Nothing touches the user's data folder or real hardware.
//
// Usage: pnpm ux:shots [output-folder] [--only <name,...>] [--light|--dark] [--locale fr|en]
//        [--first-run]: an empty data folder, and the first run's steps instead
//        [--ask]: the question about anonymous statistics not answered yet (ADR 042)

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import type { Page } from "./cdp.ts";
import { app, launch, run } from "./launch.ts";
import { periods } from "./periods.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    only: { type: "string" },
    light: { type: "boolean", default: false },
    dark: { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
    locale: { type: "string", default: "fr" },
    "first-run": { type: "boolean", default: false },
    ask: { type: "boolean", default: false },
    width: { type: "string", default: "1280" },
  },
});

export interface Shot {
  readonly name: string;
  readonly route: string;
  /** Runs after the route has rendered, before the capture. */
  readonly prepare?: (page: Page) => Promise<void>;
}

/**
 * The header at one width, for today, yesterday and an older day, in each
 * zoom: nothing in it may move from one to the next (`pnpm ux:header`).
 */
const headerShots: readonly Shot[] = periods.map((period) => ({
  name: `header-${period.zoom}-${period.name}`,
  route: period.route,
}));

const shots: readonly Shot[] = [
  { name: "today", route: "/" },
  ...headerShots,
  {
    name: "listening-menu",
    route: "/",
    prepare: (page) => page.click("#listening-menu"),
  },
  // The fake hardware recorded no audio: the player's « nothing to hear » goes.
  { name: "episode", route: "/episode/1", prepare: closePlayer },
  {
    name: "episode-share",
    route: "/episode/1",
    prepare: async (page) => {
      await closePlayer(page);
      await page.click("main header button[aria-haspopup=menu]");
    },
  },
  // ADR 039: an episode's tags, the tag popover, the search on one tag.
  {
    name: "episode-tags",
    route: "/episode/1",
    prepare: async (page) => {
      await closePlayer(page);
      await page.click("main header button[aria-label=Taguer], main header button[aria-label=Tag]");
    },
  },
  { name: "search-tag", route: "/search?tag=id%C3%A9es" },
  { name: "search", route: "/search?q=four" },
  { name: "people", route: "/people" },
  {
    name: "person-menu",
    route: "/people/2",
    prepare: (page) => page.click("main button[aria-haspopup=menu]"),
  },
  { name: "person", route: "/people/2" },
  {
    name: "agent",
    route: "/episode/1",
    prepare: async (page) => {
      await closePlayer(page);
      await openAgent(page);
    },
  },
  {
    name: "agent-limit",
    route: "/episode/1",
    prepare: async (page) => {
      await closePlayer(page);
      await openAgent(page);
      await page.waitFor("document.querySelector('aside[aria-label] button[aria-haspopup=menu]')");
      await page.click("aside[aria-label] button[aria-haspopup=menu]");
    },
  },
  { name: "imported", route: "/imports" },
  { name: "search-empty", route: "/search" },
  {
    name: "agent-today",
    route: "/",
    prepare: async (page) => {
      await openAgent(page);
      await page.waitFor("document.querySelector('aside[aria-label] button[aria-haspopup=menu]')");
      await page.click("aside[aria-label] button[aria-haspopup=menu]");
    },
  },
  { name: "settings", route: "/settings" },
  { name: "settings-general", route: "/settings/general" },
  { name: "settings-voices", route: "/settings?tab=voices" },
  { name: "settings-devices", route: "/settings?tab=devices" },
  { name: "settings-listening", route: "/settings?tab=listening" },
  { name: "settings-transcription", route: "/settings/transcription" },
  {
    name: "settings-compute",
    route: "/settings/transcription",
    prepare: async (page) => {
      await page.click("[role=radiogroup] label:nth-of-type(2)");
      await page.waitFor("document.querySelector('[role=alertdialog]') !== null");
    },
  },
  { name: "settings-advanced", route: "/settings?tab=advanced" },
  { name: "settings-privacy", route: "/settings/privacy" },
  { name: "settings-vocabulary", route: "/settings/vocabulary" },
  // What a correction taught, and a name it could not learn (ADR 046).
  { name: "vocabulary-toasts", route: "/episode/1", prepare: correctSentence },
  {
    name: "usage-report",
    route: "/settings/privacy",
    prepare: (page) => page.click("Voir ce qui est envoyé"),
  },
  {
    name: "diagnostic",
    route: "/settings/advanced",
    prepare: async (page) => {
      await page.eval(
        "[...document.querySelectorAll('main button')].at(-1)?.scrollIntoView({ block: 'center' })",
      );
      await page.click("Envoyer un diagnostic…");
      await page.waitFor("document.querySelector('[role=dialog] pre') !== null");
    },
  },
  { name: "statistics", route: "/settings?tab=statistics" },
  // Last: core keeps the fold for the shots after it.
  {
    name: "today-commitments-folded",
    route: "/",
    prepare: (page) =>
      page.eval(
        "document.querySelector('#journal-commitments button[aria-expanded=true]')?.click()",
      ),
  },
];

/** The agent panel stays open across screens: open it only when it is closed. */
async function openAgent(page: Page): Promise<void> {
  const open = await page.eval<boolean>("document.querySelector('aside[aria-label]') !== null");
  if (!open) await page.click("button[aria-pressed]");
}

/**
 * « Corriger ce passage » on the first sentence: a word written as a name
 * that sounds the same (« chiffre » → « Chiffres »: learned), and another
 * as a name that does not (« Kalia »).
 */
async function correctSentence(page: Page): Promise<void> {
  await closePlayer(page);
  // The focus arms the sentence's actions, as the pointer does.
  await page.eval(`document.querySelector("[data-segment-id]").focus()`);
  await sleep(300);
  await page.click(`button[aria-label="Actions de la phrase"]`);
  await sleep(1000);
  // The menu's items, found in shadow roots too.
  const item = await page.eval<{ x: number; y: number } | null>(`(() => {
    const walk = (root) => {
      for (const element of root.querySelectorAll("*")) {
        if (element.getAttribute("role") === "menuitem" && element.textContent.includes("Corriger")) {
          const box = element.getBoundingClientRect();
          return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        }
        const inner = element.shadowRoot && walk(element.shadowRoot);
        if (inner) return inner;
      }
      return null;
    };
    return walk(document);
  })()`);
  if (item === null) throw new Error("no « Corriger ce passage »");
  await page.clickAt(item.x, item.y);
  await sleep(400);
  await page.eval(`(() => {
    const field = document.querySelector("textarea");
    const words = [...field.value.matchAll(/(?<=\\s)\\p{Ll}{5,}/gu)].map((match) => match[0]);
    const sounding = words.find((word) => word.endsWith("e")) ?? words[0];
    const other = words.find((word) => word !== sounding);
    const next = field.value
      .replace(sounding, sounding[0].toUpperCase() + sounding.slice(1) + "s")
      .replace(other, "Kalia");
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    set.call(field, next);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  // Leaving the field saves it.
  await page.click("h1");
  await sleep(1500);
}

async function closePlayer(page: Page): Promise<void> {
  await sleep(800);
  await page.eval("document.querySelector('[data-slot=player] > button:last-of-type')?.click()");
}

/** The first run, step by step: each shot moves on from the one before. */
const firstRun: readonly Shot[] = [
  { name: "welcome-goal", route: "" },
  {
    name: "welcome-statistics",
    route: "",
    prepare: (page) => page.click("main button[aria-pressed], button[aria-pressed]"),
  },
  {
    name: "welcome-permissions",
    route: "",
    prepare: (page) => page.click("Non"),
  },
  { name: "welcome-model", route: "", prepare: (page) => page.click("Continuer") },
  { name: "welcome-voice", route: "", prepare: (page) => page.click("Continuer") },
];

const out = resolve(positionals[0] ?? join(app, ".ux-shots"));
const only = values.only?.split(",");
const modes = values.light ? ["light"] : values.dark ? ["dark"] : ["light", "dark"];
// A short folder: the core socket path has a 103-byte limit.
const data = mkdtempSync(join(tmpdir(), "sux-"));

if (!values["first-run"]) {
  await run("node", ["scripts/ux/seed.ts", data, ...(values.ask ? ["--ask"] : [])]);
}
const { page, stop } = await launch({
  data,
  locale: values.locale,
  width: Number(values.width),
});

try {
  mkdirSync(out, { recursive: true });
  const list = values["first-run"] ? firstRun : shots;
  for (const mode of modes) {
    await page.colorScheme(mode === "dark" ? "dark" : "light");
    if (values["first-run"]) await page.go("/welcome");
    for (const shot of list) {
      if (only !== undefined && !only.includes(shot.name)) continue;
      if (shot.route !== "") await page.go(shot.route);
      // Only the agent's shots show its panel.
      if (!shot.name.startsWith("agent") && values["first-run"] !== true) {
        const open = await page.eval<boolean>(
          "document.querySelector('aside[aria-label]') !== null",
        );
        if (open) await page.click("button[aria-pressed]");
      }
      await shot.prepare?.(page);
      await sleep(600);
      const file = join(out, `${shot.name}-${mode}.png`);
      writeFileSync(file, await page.screenshot());
      console.log(file);
    }
  }
  page.close();
} finally {
  await stop();
  if (!values.keep) rmSync(data, { recursive: true, force: true, maxRetries: 5 });
}
