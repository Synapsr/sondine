import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StarIcon } from "../icon";
import { Toggle } from "./toggle";

function attributesOf(markup: string): string {
  return markup.slice(0, markup.indexOf(">"));
}

/** Matches the attribute itself, not a class such as `data-pressed:bg-…`. */
function hasAttribute(tag: string, name: string): boolean {
  return new RegExp(`\\s${name}(=|\\s|>|$)`).test(tag);
}

describe("Toggle", () => {
  it("renders an unpressed Base UI toggle button with the spec's rest styling", () => {
    const markup = renderToStaticMarkup(<Toggle>Épingler</Toggle>);
    const root = attributesOf(markup);
    expect(root).toMatch(/^<button/);
    expect(root).toContain('type="button"');
    expect(root).toContain('data-slot="toggle"');
    expect(root).toContain('data-size="default"');
    expect(root).toContain('aria-pressed="false"');
    expect(hasAttribute(root, "data-pressed")).toBe(false);
    for (const token of [
      "corner-s",
      "px-s py-xs",
      "bg-transparent",
      "text-neutral-10",
      "font-body font-medium text-body-s",
      "ring-none ring-transparent",
      "focus-ring",
    ]) {
      expect(root).toContain(token);
    }
    expect(markup).toContain('data-slot="toggle-label"');
    expect(markup).toContain("gap-xs");
  });

  it("styles hover, toggled-on, focus, disabled and the pointer press separately", () => {
    const root = attributesOf(renderToStaticMarkup(<Toggle>Épingler</Toggle>));
    expect(root).toContain("control-hover:bg-neutral-3");
    expect(root).toContain("data-pressed:bg-neutral-3");
    expect(root).toContain("control-focus:ring-color-1");
    expect(root).toContain("control-disabled:text-neutral-6");
    expect(root).toContain("motion-safe:control-pressed:translate-y-(--motion-press-distance)");
    expect(root).toContain("duration-motion ease-motion motion-reduce:transition-none");
  });

  it("exposes the pressed state accessibly", () => {
    const root = attributesOf(renderToStaticMarkup(<Toggle defaultPressed>Épingler</Toggle>));
    expect(root).toContain('aria-pressed="true"');
    expect(hasAttribute(root, "data-pressed")).toBe(true);
  });

  it("disables the native button and keeps the pressed state", () => {
    const root = attributesOf(
      renderToStaticMarkup(
        <Toggle disabled defaultPressed>
          Épingler
        </Toggle>,
      ),
    );
    expect(hasAttribute(root, "disabled")).toBe(true);
    expect(hasAttribute(root, "data-disabled")).toBe(true);
    expect(hasAttribute(root, "data-pressed")).toBe(true);
  });

  it("renders an icon-only square with a line-height label box", () => {
    const markup = renderToStaticMarkup(
      <Toggle size="icon" aria-label="Favori">
        <StarIcon />
      </Toggle>,
    );
    const root = attributesOf(markup);
    expect(root).toContain('data-size="icon"');
    expect(root).toContain('aria-label="Favori"');
    expect(root).toContain("p-xs");
    expect(root).not.toContain("px-s");
    expect(markup).toContain("size-(--line-s)");
    expect(markup).toContain('data-slot="icon"');
  });

  it("merges className strings and state functions", () => {
    const merged = attributesOf(renderToStaticMarkup(<Toggle className="px-m">Épingler</Toggle>));
    expect(merged).toContain("px-m");
    expect(merged).not.toContain("px-s");

    const fromState = attributesOf(
      renderToStaticMarkup(
        <Toggle defaultPressed className={(state) => (state.pressed ? "is-on" : "is-off")}>
          Épingler
        </Toggle>,
      ),
    );
    expect(fromState).toContain("is-on");
    expect(fromState).toContain("corner-s");
  });
});
