import { describe, expect, it } from "vitest";
import { cn } from "./cn";
import { mergeClassName } from "./class-name";

describe("cn", () => {
  it.each([
    [["px-l", "px-m"], "px-m"],
    [["gap-xs", "gap-s"], "gap-s"],
    [["text-body-s", "text-body-m"], "text-body-m"],
    [["text-body-s", "text-display-m"], "text-display-m"],
    [["tracking-l", "tracking-s"], "tracking-s"],
    [["corner-s", "corner-full"], "corner-full"],
    [["corner-t-s", "corner-m"], "corner-m"],
    [["corner-s", "rounded-none"], "rounded-none"],
    [["edge-m", "border-0"], "border-0"],
    [["shadow-s", "shadow-m"], "shadow-m"],
    [["ring-s", "ring-none"], "ring-none"],
    [["bg-neutral-3", "bg-color-1"], "bg-color-1"],
    [["font-regular", "font-heavy"], "font-heavy"],
    [["font-body", "font-display"], "font-display"],
    [["duration-motion", "duration-motion-large"], "duration-motion-large"],
  ])("lets %j resolve to %s", (classes, expected) => {
    expect(cn(...classes)).toBe(expected);
  });

  it.each([
    ["text-body-s", "text-neutral-10"],
    ["font-body", "font-medium"],
    ["corner-m", "corner-t-s"],
    ["ring-s", "ring-neutral-4-transparent"],
    ["inset-ring-s", "ring-s"],
  ])("keeps %s and %s, which set different properties", (first, second) => {
    expect(cn(first, second)).toBe(`${first} ${second}`);
  });

  it("drops falsy values", () => {
    expect(cn("p-s", false, undefined, null, "", "m-xs")).toBe("p-s m-xs");
  });
});

describe("mergeClassName", () => {
  it("merges a string className", () => {
    expect(mergeClassName("px-l text-body-s", "px-m")).toBe("text-body-s px-m");
  });

  it("wraps a state function", () => {
    const merged = mergeClassName<{ disabled: boolean }>("px-l", (state) =>
      state.disabled ? "px-s" : undefined,
    );
    expect(typeof merged).toBe("function");
    if (typeof merged === "function") {
      expect(merged({ disabled: true })).toBe("px-s");
      expect(merged({ disabled: false })).toBe("px-l");
    }
  });
});
