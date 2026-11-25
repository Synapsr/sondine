#!/usr/bin/env node
// Builds the design-system playground and screenshots the whole page in light
// and dark with headless Google Chrome, for visual review.
//
// Usage: node scripts/screenshot.mjs [output directory] [--section <id>]
// Default output: $TMPDIR/sondine-ui-shots. Writes design-system-{light,dark}.png,
// or design-system-<id>-{light,dark}.png cropped to one section.
//
// The page is captured from the top, beyond the viewport. The script fails
// when a section takes focus or scrolls the page on load, or the section id
// does not exist.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { build } from "vite";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chrome =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: { section: { type: "string" } },
});
const outDir = path.resolve(positionals[0] ?? path.join(os.tmpdir(), "sondine-ui-shots"));
const VIEWPORT = { width: 1440, height: 900 };
const TIMEOUT_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Chrome refuses module scripts over file://, so the entry chunk is inlined.
async function inlineEntryScript(buildDir) {
  const htmlPath = path.join(buildDir, "index.html");
  let html = await readFile(htmlPath, "utf8");
  const tag = /<script type="module" crossorigin src="\.\/(assets\/[^"]+\.js)"><\/script>/;
  const match = html.match(tag);
  if (!match?.[1]) throw new Error("entry <script> not found in the built index.html");
  const code = await readFile(path.join(buildDir, match[1]), "utf8");
  html = html
    .replace(tag, () => "")
    .replace("</body>", () => `<script type="module">${code}</script>\n</body>`);
  await writeFile(htmlPath, html);
}

/** Waits for Chrome to write the DevTools port into its profile. */
async function devToolsPort(profileDir) {
  const file = path.join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const [port] = (await readFile(file, "utf8")).split("\n");
      if (port) return Number(port);
    }
    await sleep(100);
  }
  throw new Error("Chrome did not open its DevTools port");
}

/** A minimal Chrome DevTools Protocol session over one page target. */
async function connect(port) {
  const deadline = Date.now() + TIMEOUT_MS;
  let target;
  while (target === undefined && Date.now() < deadline) {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    target = list.find((entry) => entry.type === "page");
    if (target === undefined) await sleep(100);
  }
  if (target === undefined) throw new Error("Chrome opened no page");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener("message", (message) => {
    const data = JSON.parse(String(message.data));
    if (data.id !== undefined) {
      const waiting = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) waiting?.reject(new Error(`${data.error.message} (${data.error.code})`));
      else waiting?.resolve(data.result);
    } else {
      for (const listener of listeners.get(data.method) ?? []) listener(data.params);
    }
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    once(method) {
      return new Promise((resolve) => {
        const set = listeners.get(method) ?? new Set();
        const listener = (params) => {
          set.delete(listener);
          resolve(params);
        };
        set.add(listener);
        listeners.set(method, set);
      });
    },
    close: () => socket.close(),
  };
}

async function evaluate(page, expression) {
  const { result, exceptionDetails } = await page.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? expression);
  return result.value;
}

// The element holding focus after load, described by its section, or null.
const focusThief = `(() => {
  const active = document.activeElement;
  if (active === null || active === document.body || active === document.documentElement) return null;
  const section = active.closest("section[id]");
  const slot = active.getAttribute("data-slot") ?? active.tagName.toLowerCase();
  return (section ? "#" + section.id : "outside any section") + " (" + slot + ")";
})()`;

// The section in view when the page is no longer at the top, or null.
const scrolledTo = `(() => {
  if (scrollY === 0) return null;
  const middle = innerHeight / 2;
  const section = [...document.querySelectorAll("section[id]")].find((element) => {
    const box = element.getBoundingClientRect();
    return box.top <= middle && box.bottom >= middle;
  });
  return (section ? "#" + section.id : "no section") + " at " + scrollY + "px";
})()`;

const sectionBox = (id) => `(() => {
  const element = document.getElementById(${JSON.stringify(id)});
  if (element === null) return null;
  const box = element.getBoundingClientRect();
  return { x: box.left + scrollX, y: box.top + scrollY, width: box.width, height: box.height };
})()`;

const settle = async (page) => {
  await evaluate(page, "document.fonts.ready.then(() => true)");
  // Two frames, then a pause, for popups that position after mount.
  await evaluate(page, "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
  await sleep(500);
};

const setViewportHeight = (page, height) =>
  page.send("Emulation.setDeviceMetricsOverride", {
    width: VIEWPORT.width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });

async function capture(page, url, file, section) {
  await setViewportHeight(page, VIEWPORT.height);
  const loaded = page.once("Page.loadEventFired");
  await page.send("Page.navigate", { url });
  await loaded;
  await settle(page);
  // A viewport as tall as the page puts every section on screen, so previews
  // that open once visible (Select) render open.
  const { cssContentSize } = await page.send("Page.getLayoutMetrics");
  await setViewportHeight(page, Math.ceil(cssContentSize.height));
  await settle(page);
  const thief = await evaluate(page, focusThief);
  if (thief !== null) throw new Error(`a section takes focus on load: ${thief}`);
  const scrolled = await evaluate(page, scrolledTo);
  if (scrolled !== null) throw new Error(`a section scrolled the page on load: ${scrolled}`);
  await evaluate(page, "(window.scrollTo(0, 0), true)");

  const { cssContentSize: content } = await page.send("Page.getLayoutMetrics");
  let clip = { x: 0, y: 0, width: VIEWPORT.width, height: Math.ceil(content.height) };
  if (section !== undefined) {
    const box = await evaluate(page, sectionBox(section));
    if (box === null) throw new Error(`no section with id "${section}"`);
    const margin = 16;
    clip = {
      x: Math.max(0, Math.floor(box.x - margin)),
      y: Math.max(0, Math.floor(box.y - margin)),
      width: Math.ceil(box.width + 2 * margin),
      height: Math.ceil(box.height + 2 * margin),
    };
  }
  const { data } = await page.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: { ...clip, scale: 1 },
  });
  await writeFile(file, Buffer.from(data, "base64"));
}

// Headless Chrome is stopped with its whole process group once done.
async function withChrome(profileDir, run) {
  const child = spawn(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--allow-file-access-from-files",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      "about:blank",
    ],
    { detached: true, stdio: "ignore" },
  );
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let page;
  try {
    page = await connect(await devToolsPort(profileDir));
    await page.send("Page.enable");
    return await run(page);
  } finally {
    page?.close();
    if (child.exitCode === null && child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
      await Promise.race([exited, sleep(5000)]);
    }
  }
}

async function main() {
  if (!existsSync(chrome))
    throw new Error(`Google Chrome not found at ${chrome} (set CHROME_PATH)`);
  await mkdir(outDir, { recursive: true });
  const workDir = await mkdtemp(path.join(os.tmpdir(), "sondine-ui-playground-"));
  const buildDir = path.join(workDir, "build");
  try {
    await build({
      configFile: path.join(packageDir, "playground/vite.config.ts"),
      logLevel: "warn",
      build: { outDir: buildDir, emptyOutDir: true },
    });
    await inlineEntryScript(buildDir);
    const page = pathToFileURL(path.join(buildDir, "index.html"));
    const name = flags.section === undefined ? "design-system" : `design-system-${flags.section}`;
    await withChrome(path.join(workDir, "chrome"), async (tab) => {
      for (const theme of ["light", "dark"]) {
        const file = path.join(outDir, `${name}-${theme}.png`);
        await capture(tab, `${page.href}?theme=${theme}`, file, flags.section);
        console.log(`screenshot: ${file}`);
      }
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

await main();
