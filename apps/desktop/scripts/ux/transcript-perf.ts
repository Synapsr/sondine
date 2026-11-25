// Measures the episode screen on a long call: how long it takes to show,
// frame times while the transcript scrolls, and what a voice's « ✓ » costs
// (time to the answer on screen, React renders, frames). Seeds a fresh data
// folder (seed.ts) with an invented two-hour call (long-call.ts), or a call of
// a shape file's timing, and runs the app on it with fake audio hardware.
// Numbers go to stdout as JSON; nothing touches the user's data folder.
//
// Usage: node scripts/ux/transcript-perf.ts [--shape shape.json] [--preview] [--throttle 4]

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import type { Page } from "./cdp.ts";
import { launch, run } from "./launch.ts";

const { values } = parseArgs({
  options: {
    shape: { type: "string" },
    preview: { type: "boolean", default: false },
    throttle: { type: "string", default: "1" },
    keep: { type: "boolean", default: false },
  },
});

// React's DevTools hook, reduced to counting the components that rendered in
// each commit (as DevTools decides it: a fiber that performed work, in a
// subtree that did not bail out), only while `__perf.counting` is on.
const HOOK = `(() => {
  const counts = new Map();
  let commits = 0;
  const PERFORMED_WORK = 1;
  const nameOf = (fiber) => {
    const type = fiber.type;
    if (typeof type === "function") return type.displayName || type.name || null;
    if (type !== null && typeof type === "object") {
      const inner = type.type ?? type.render;
      return typeof inner === "function" ? inner.displayName || inner.name || null : null;
    }
    return null;
  };
  const walk = (fiber) => {
    for (let child = fiber.child; child !== null; child = child.sibling) {
      if ((child.flags & PERFORMED_WORK) !== 0) {
        const name = nameOf(child);
        if (name !== null) counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      if (child.alternate === null || child.child !== child.alternate.child) walk(child);
    }
  };
  window.__perf = {
    counting: false,
    reset() { counts.clear(); commits = 0; },
    read() { return { commits, renders: Object.fromEntries([...counts].sort((a, b) => b[1] - a[1])) }; },
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject() { return 1; },
    checkDCE() {},
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id, root) {
      if (!window.__perf.counting) return;
      commits += 1;
      walk(root.current);
    },
  };
})();`;

const round = (ms: number) => Math.round(ms * 10) / 10;

/** Frame intervals and long tasks while `during` runs. */
async function frames(page: Page, during: () => Promise<void>) {
  await page.eval(`(() => {
    const state = { stamps: [], long: [], on: true };
    window.__frames = state;
    const tick = (t) => { if (!state.on) return; state.stamps.push(t); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    state.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) state.long.push(entry.duration);
    });
    state.observer.observe({ type: "longtask" });
  })()`);
  await during();
  const { stamps, long } = await page.eval<{ stamps: number[]; long: number[] }>(`(() => {
    const state = window.__frames;
    state.on = false;
    state.observer.disconnect();
    return { stamps: state.stamps, long: state.long };
  })()`);
  const gaps = stamps.slice(1).map((t, i) => t - (stamps[i] ?? t));
  const sorted = gaps.toSorted((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return {
    frames: gaps.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted.at(-1) ?? 0),
    // A 60 Hz frame is 16.7 ms: over 25 ms, at least one frame was missed.
    missed: gaps.filter((gap) => gap > 25).length,
    longTasks: long.length,
    longTaskMs: round(long.reduce((sum, ms) => sum + ms, 0)),
  };
}

async function open(page: Page, episodeId: number) {
  await page.go("/");
  await sleep(500);
  const ms = await page.eval<number>(`(async () => {
    const start = performance.now();
    location.hash = "#/episode/${episodeId}";
    while (document.querySelectorAll("[data-segment-id]").length === 0) {
      if (performance.now() - start > 30000) {
        throw new Error("no transcript: " + document.getElementById("main")?.innerText.slice(0, 300));
      }
      await new Promise((done) => setTimeout(done, 5));
    }
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    return performance.now() - start;
  })()`);
  await sleep(800);
  // The fake hardware recorded no audio: the player's « nothing to hear » goes.
  await page.eval("document.querySelector('[data-slot=player] > button:last-of-type')?.click()");
  await sleep(300);
  const nodes = await page.eval<number>("document.querySelectorAll('*').length");
  return { openMs: Math.round(ms), domNodes: nodes };
}

async function scroll(page: Page) {
  const box = await page.eval<{ x: number; y: number }>(`(() => {
    const r = document.getElementById("main").getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  return frames(page, async () => {
    // About four seconds of a steady trackpad scroll down, then back up.
    for (const direction of [1, -1]) {
      for (let step = 0; step < 120; step += 1) {
        await page.wheel(box.x, box.y, direction * 120);
        await sleep(16);
      }
    }
  });
}

/** « ✓ » on the first voice to confirm, in the header: time until it shows as named. */
async function confirm(page: Page) {
  const found = await page.eval<boolean>(
    'document.querySelector(\'header button[aria-label^="Confirmer"], header button[aria-label^="Confirm"]\') !== null',
  );
  if (!found) return null;
  await page.eval("window.__perf.reset(); window.__perf.counting = true");
  const result = await page.eval<{
    answerMs: number;
    settledMs: number;
    states: string[];
  }>(`(async () => {
    const button = document.querySelector('header button[aria-label^="Confirmer"], header button[aria-label^="Confirm"]');
    const voices = () => document.querySelector("header ul")?.innerText.replace(/\\s+/g, " ") ?? "";
    const states = [voices()];
    const start = performance.now();
    let answerMs = -1;
    button.click();
    while (performance.now() - start < 5000) {
      await new Promise((done) => requestAnimationFrame(done));
      const now = voices();
      if (now !== states.at(-1)) states.push(now);
      const pending = document.querySelector('header button[aria-label^="Confirmer"], header button[aria-label^="Confirm"]');
      if (answerMs < 0 && (pending === null || pending.disabled === false && states.length > 1)) answerMs = performance.now() - start;
    }
    return { answerMs: Math.round(answerMs), settledMs: 5000, states };
  })()`);
  await page.eval("window.__perf.counting = false");
  const renders = await page.eval<{ commits: number; renders: Record<string, number> }>(
    "window.__perf.read()",
  );
  return {
    answerMs: result.answerMs,
    // Each distinct look of the voice badges after the click: more than one change is a flicker.
    badgeStates: result.states.length - 1,
    commits: renders.commits,
    renders: Object.fromEntries(Object.entries(renders.renders).slice(0, 8)),
  };
}

const data = mkdtempSync(join(tmpdir(), "sux-"));
await run("node", ["scripts/ux/seed.ts", data]);
const episodes: Record<string, number> = {
  random: Number((await run("node", ["scripts/ux/long-call.ts", data])).trim()),
};
if (values.shape !== undefined) {
  episodes["shape"] = Number(
    (await run("node", ["scripts/ux/long-call.ts", data, values.shape])).trim(),
  );
}
const { page, stop } = await launch({ data, preview: values.preview, beforeLoad: HOOK });
try {
  await page.throttle(Number(values.throttle));
  const report: Record<string, unknown> = {
    build: values.preview ? "production" : "development",
    throttle: Number(values.throttle),
  };
  for (const [name, id] of Object.entries(episodes)) {
    console.error(`measuring ${name} (episode ${id})`);
    const opened = await open(page, id);
    const scrolled = await scroll(page);
    await page.eval("window.__perf.reset(); window.__perf.counting = true");
    await scroll(page);
    await page.eval("window.__perf.counting = false");
    const scrollRenders = await page.eval("window.__perf.read()");
    report[name] = { episodeId: id, ...opened, scroll: scrolled, scrollRenders };
  }
  for (const [name, id] of Object.entries(episodes)) {
    await open(page, id);
    const confirmed = await confirm(page);
    report[`${name}Confirm`] = confirmed;
  }
  console.log(JSON.stringify(report, null, 2));
  page.close();
} finally {
  await stop();
  if (!values.keep) rmSync(data, { recursive: true, force: true, maxRetries: 5 });
}
