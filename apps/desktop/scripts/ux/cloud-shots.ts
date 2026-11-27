// Captures the Cloud's screens (ADR 047) on invented data: a local
// `sondine-compute` with a model that never runs and a Stripe that answers from
// memory (apps/compute/scripts/fake-cloud.ts), the app on fake audio hardware
// and a fresh data folder, no browser opened. Each screen is captured by the
// window's own id (`screencapture -l`), in light and dark.
//
// Usage: pnpm ux:cloud-shots <output-folder> [--locale fr|en]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { app, launch, run } from "./launch.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { locale: { type: "string", default: "fr" } },
});
const out = resolve(positionals[0] ?? join(app, ".ux-shots", "cloud"));
mkdirSync(out, { recursive: true });

/** The windows on screen: `id pid layer owner width`. */
const WINDOWS = `
import CoreGraphics
let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
for w in list {
  let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
  print("\\(w[kCGWindowNumber as String] ?? 0) \\(w[kCGWindowOwnerPID as String] ?? 0) \\(w[kCGWindowLayer as String] ?? 0) \\(w[kCGWindowOwnerName as String] ?? "") \\(b["Width"] ?? 0) \\(b["Height"] ?? 0) \\(w[kCGWindowIsOnscreen as String] ?? 0)")
}
`;

/** This checkout's Electron window: other checkouts may run theirs beside it. */
async function ourWindow(): Promise<string> {
  const script = join(tmpdir(), "sondine-windows.swift");
  writeFileSync(script, WINDOWS);
  const listed = await run("swift", [script]);
  const ours = new Set(
    (await run("pgrep", ["-f", resolve(app, "../..", "node_modules/.pnpm/electron@")]))
      .split("\n")
      .filter((pid) => pid !== ""),
  );
  const windows = listed
    .split("\n")
    .map((line) => line.split(" "))
    .filter(
      ([, pid, layer, owner, width]) =>
        ours.has(pid ?? "") && layer === "0" && owner === "Electron" && Number(width) > 900,
    );
  if (windows.length !== 1) {
    const electron = listed.split("\n").filter((line) => line.includes("Electron"));
    throw new Error(
      `expected one window of ours, found ${windows.length} (ours: ${[...ours].join(",")}; ${electron.join(" | ")})`,
    );
  }
  return windows[0]?.[0] ?? "";
}

// The fake Cloud, driven by scenario names on its input.
const cloudState = mkdtempSync(join(tmpdir(), "sondine-cloud-"));
// Built into one file first, as the server itself: workspace packages import without extensions.
const compute = resolve(app, "../compute");
await new Promise<void>((done, fail) =>
  spawn(
    "npx",
    ["vite", "build", "--ssr", "scripts/fake-cloud.ts", "--outDir", join(cloudState, "bin")],
    { cwd: compute, stdio: "ignore" },
  ).on("exit", (code) => (code === 0 ? done() : fail(new Error(`build exited ${code}`)))),
);
const cloud = spawn(
  "node",
  [join(cloudState, "bin", "sondine-compute.js"), join(cloudState, "state"), "8790"],
  { stdio: ["pipe", "pipe", "inherit"] },
);
const lines = createInterface({ input: cloud.stdout })[Symbol.asyncIterator]();
async function next(): Promise<string> {
  const line = await lines.next();
  if (line.done === true) throw new Error("the fake Cloud stopped");
  return line.value;
}
const ready = (await next()).split(" ");
if (ready[0] !== "ready") throw new Error(`fake Cloud: ${ready.join(" ")}`);
async function scenario(name: string): Promise<void> {
  cloud.stdin.write(`${name}\n`);
  const answer = await next();
  if (answer !== `ok ${name}`) throw new Error(`fake Cloud: ${answer}`);
}

process.env["SONDINE_DEV_CLOUD"] = `${ready[1]} ${ready[2]}`;
process.env["SONDINE_DEV_NO_BROWSER"] = "1";
const data = mkdtempSync(join(tmpdir(), "sux-"));
const { page, stop } = await launch({ data, locale: values.locale, height: 1000 });

try {
  await sleep(1500);
  await ourWindow();

  async function shot(name: string, settingsPart = false): Promise<void> {
    for (const mode of ["light", "dark"] as const) {
      await page.colorScheme(mode);
      await sleep(700);
      if (settingsPart) {
        await page.waitFor(
          `document.location.hash.includes("settings") || document.location.pathname.includes("settings")`,
          10_000,
        );
        await toCloudPart();
        await sleep(400);
      }
      const file = join(out, `${name}-${mode}.png`);
      // The window's id, found again: a reload may give the window a new one.
      for (let attempt = 1; ; attempt += 1) {
        try {
          await run("screencapture", ["-x", "-o", `-l${await ourWindow()}`, file]);
          break;
        } catch (error) {
          if (attempt === 3) throw error;
          await sleep(1000);
        }
      }
      console.log(file);
    }
  }

  /** From the choice of where to transcribe to the Cloud's page; the click is tried again until it lands. */
  async function pickCloud(): Promise<void> {
    const cont = values.locale === "fr" ? "Continuer" : "Continue";
    for (let attempt = 1; ; attempt += 1) {
      await sleep(500);
      await page.click("[role=radiogroup] label:nth-of-type(3)");
      await sleep(500);
      await page.click(cont);
      await sleep(1200);
      const there = await page.eval<boolean>(
        "document.querySelector('#welcome-title')?.textContent.includes('Cloud') === true",
      );
      if (there) return;
      if (attempt === 4) throw new Error("the Cloud's page did not open");
      await page.click(values.locale === "fr" ? "Retour" : "Back");
    }
  }

  /** The first run, from where it stands to the Cloud's page. */
  async function toCloudStep(): Promise<void> {
    await page.go("/welcome");
    await page.waitFor("document.querySelector('#welcome-title') !== null", 20_000);
    const continueLabel = values.locale === "fr" ? "Continuer" : "Continue";
    // Each step until the choice of where transcription runs; a reload resumes where it was.
    for (let step = 0; step < 6; step += 1) {
      await sleep(600);
      const choice = await page.eval<boolean>(
        "document.querySelector('[role=radiogroup] label:nth-of-type(3)') !== null",
      );
      if (choice) break;
      const pressed = await page.eval<boolean>(
        "document.querySelector('button[aria-pressed]') !== null",
      );
      if (pressed) await page.click("button[aria-pressed]");
      else {
        const no = values.locale === "fr" ? "Non" : "No";
        const hasNo = await page.eval<boolean>(
          `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === ${JSON.stringify(no)})`,
        );
        await page.click(hasNo ? no : continueLabel);
      }
    }
    await pickCloud();
  }

  await scenario("wave-70");
  await toCloudStep();
  await shot("first-run-wave");

  await scenario("wave-full");
  await page.eval("location.reload()");
  await sleep(1500);
  await toCloudStep();
  await shot("first-run-wave-full");

  // A place for this Mac: back to the choice, then the trial's button, with places left.
  await scenario("wave-70");
  await page.click(values.locale === "fr" ? "Retour" : "Back");
  await sleep(600);
  await pickCloud();
  const trialLabel = values.locale === "fr" ? "Essayer 60 min gratuites" : "Try 60 minutes free";
  await page.waitFor(
    `[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === ${JSON.stringify(trialLabel)})`,
    20_000,
  );
  await page.click(trialLabel);
  await sleep(1500);
  // The rest of the first run: Settings open only once it is done.
  for (let step = 0; step < 6; step += 1) {
    const inWelcome = await page.eval<boolean>("document.querySelector('#welcome-title') !== null");
    if (!inWelcome) break;
    const label = await page.eval<string | null>(`(() => {
      const names = ["Passer", "Skip", "Continuer", "Continue", "Commencer l’écoute", "Start listening"];
      const button = [...document.querySelectorAll("button")].find((b) => names.includes(b.textContent.trim()));
      return button ? button.textContent.trim() : null;
    })()`);
    if (label === null) break;
    await page.click(label);
    await sleep(1200);
  }

  /** The Cloud's part of Settings ▸ Transcription, read again from the server. */
  const toCloudPart = () =>
    page.eval(`(() => {
      const title = [...document.querySelectorAll("h2")].findLast((h) =>
        ["Cloud Sondine", "Sondine Cloud"].includes(h.textContent.trim()),
      );
      if (!title) return false;
      let box = title.parentElement;
      while (box && box.scrollHeight <= box.clientHeight + 1) box = box.parentElement;
      if (!box) return false;
      // Room below the last part, so that it may come to the top of a short window.
      if (!box.querySelector("[data-shots-room]")) {
        const room = document.createElement("div");
        room.dataset.shotsRoom = "";
        room.style.height = "720px";
        box.firstElementChild?.append(room);
      }
      box.scrollTop += title.getBoundingClientRect().top - box.getBoundingClientRect().top - 24;
      return true;
    })()`);
  const settings = async () => {
    await page.go("/");
    await sleep(500);
    await page.go("/settings/transcription");
    await sleep(1500);
    await toCloudPart();
  };
  await scenario("trial");
  await settings();
  await shot("settings-trial", true);

  await scenario("trial-done");
  await settings();
  await shot("settings-trial-done", true);

  await page.click(values.locale === "fr" ? "S’abonner" : "Subscribe");
  await sleep(1200);
  await toCloudPart();
  await shot("settings-waiting", true);

  // The webhook reached the server: the window reads it again by itself.
  await scenario("subscribed");
  await sleep(7000);
  await toCloudPart();
  await shot("settings-subscribed", true);

  await scenario("cancelling");
  await settings();
  await shot("settings-cancelling", true);

  await scenario("past-due");
  await settings();
  await shot("settings-past-due", true);
  page.close();
} catch (error) {
  // What the window showed when a step failed, beside the captures.
  writeFileSync(join(out, "failed-step.png"), await page.screenshot());
  throw error;
} finally {
  await stop();
  cloud.stdin.end();
  cloud.kill();
  rmSync(data, { recursive: true, force: true, maxRetries: 5 });
  rmSync(cloudState, { recursive: true, force: true });
}
