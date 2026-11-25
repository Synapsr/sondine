// Checks that a period's header keeps still (Téo, 2026-11-20): on invented
// data, at one width, today, yesterday and an older day, in each zoom, put
// the title, the line under it, every control after the filter and the
// column beside the thread at the same place, to the pixel. The zoom and the
// arrows also stay put from a day to its week and its month. Run at a wide
// and a narrow width; exits 1 on any move.
//
// Usage: pnpm ux:header [--width 1280,900]

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { launch, run } from "./launch.ts";
import { periods } from "./periods.ts";

const { values } = parseArgs({ options: { width: { type: "string", default: "1280,900" } } });

type Box = Readonly<Record<string, readonly number[]>>;

/** Each part's edges that must not move: the start and top of everything, the size of controls. */
const MEASURE = `(() => {
  const box = (element) => {
    const r = element.getBoundingClientRect();
    return [Math.round(r.left * 2) / 2, Math.round(r.top * 2) / 2, Math.round(r.width * 2) / 2, Math.round(r.height * 2) / 2];
  };
  const header = document.querySelector("[data-slot=period-header]");
  if (header === null) return null;
  const out = {};
  const title = box(header.querySelector("[data-slot=period-title]"));
  out.title = [title[0], title[1], title[3]];
  const subtitle = box(header.querySelector("[data-slot=period-subtitle]"));
  out.subtitle = [subtitle[0], subtitle[1], subtitle[3]];
  const controls = [...header.querySelector("[data-slot=period-controls]").children];
  // From the zoom on: the filter, first, may change its own width with its label.
  const from = controls.findIndex((child) => child.tagName === "NAV");
  controls.slice(from).forEach((child, index) => (out["control-" + index] = box(child)));
  const beside = document.querySelector("[data-slot=day-beside]");
  if (beside !== null) out.beside = box(beside).slice(0, 3);
  const next = header.nextElementSibling;
  if (next !== null) out.below = [box(next)[1]];
  return out;
})()`;

const data = mkdtempSync(join(tmpdir(), "sux-"));
await run("node", ["scripts/ux/seed.ts", data]);
let failures = 0;
for (const width of values.width.split(",").map(Number)) {
  const { page, stop } = await launch({ data, width });
  try {
    const seen = new Map<string, { name: string; box: Box }>();
    let dayControls: { name: string; box: Box } | null = null;
    for (const period of periods) {
      await page.go(period.route);
      await page.waitFor("document.querySelector('[data-slot=period-header]') !== null");
      await sleep(900);
      const box = await page.eval<Box | null>(MEASURE);
      if (box === null) throw new Error(`no header on ${period.route}`);
      const name = `${period.zoom} ${period.name}`;
      const first = seen.get(period.zoom);
      if (first === undefined) seen.set(period.zoom, { name, box });
      else failures += compare(width, first, { name, box }, Object.keys(first.box));
      if (period.zoom === "day" && dayControls === null) dayControls = { name, box };
      else if (period.zoom !== "day" && dayControls !== null) {
        // From a day to its week or month: the zoom, « Aujourd'hui », the arrows and the « ⋯ »'s place.
        const shared = Object.keys(box).filter(
          (key) => key.startsWith("control-") || key === "title",
        );
        failures += compare(width, dayControls, { name, box }, shared);
      }
    }
    console.log(`${width} px: checked ${periods.length} periods`);
  } finally {
    page.close();
    await stop();
  }
}
rmSync(data, { recursive: true, force: true, maxRetries: 5 });
if (failures > 0) {
  console.error(`${failures} part(s) moved`);
  process.exit(1);
}
console.log("The header keeps still.");

function compare(
  width: number,
  a: { name: string; box: Box },
  b: { name: string; box: Box },
  keys: readonly string[],
): number {
  let moved = 0;
  for (const key of keys) {
    const left = a.box[key];
    const right = b.box[key];
    if (left === undefined || right === undefined || left.join() !== right.join()) {
      console.error(`${width} px: ${key} moved from ${a.name} ${left} to ${b.name} ${right}`);
      moved += 1;
    }
  }
  return moved;
}
