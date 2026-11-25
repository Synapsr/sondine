import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { largeTransition, popupScale, pressDistance, smallTransition } from "./motion";

// The theme's motion lives in Graphical's generated variables; Motion for
// React reads the copies in motion.ts, which must follow it.
const themeCss = await readFile(
  new URL("../../../../graphical/generated/theme.css", import.meta.url),
  "utf8",
);
const root = themeCss.split(/^\[data-theme=/m)[0] ?? "";
const variable = (name: string) =>
  root.match(new RegExp(`^\\s*${name}:\\s*([^;]+);`, "m"))?.[1]?.trim() ?? "";
const seconds = (value: string) => Number.parseFloat(value) / 1000;
const bezier = (value: string) =>
  value
    .replace(/^cubic-bezier\(|\)$/g, "")
    .split(",")
    .map(Number);

describe("motion constants", () => {
  it("equal the theme's motion variables", () => {
    expect(smallTransition.duration).toBe(seconds(variable("--motion-duration")));
    expect([...smallTransition.ease]).toEqual(bezier(variable("--motion-easing")));
    expect(largeTransition.duration).toBe(seconds(variable("--motion-large-duration")));
    expect([...largeTransition.ease]).toEqual(bezier(variable("--motion-large-easing")));
    expect(popupScale).toBe(Number(variable("--motion-popup-scale")));
    expect(`${pressDistance}px`).toBe(variable("--motion-press-distance"));
  });
});
