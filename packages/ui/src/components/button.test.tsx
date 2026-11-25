import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlusIcon } from "../icon";
import { Button } from "./button";

function attributesOf(markup: string): string {
  return markup.slice(0, markup.indexOf(">"));
}

describe("Button", () => {
  it("renders a primary Base UI button with data slots", () => {
    const markup = renderToStaticMarkup(<Button>Save</Button>);
    const root = attributesOf(markup);
    expect(root).toMatch(/^<button/);
    expect(root).toContain('type="button"');
    expect(root).toContain('data-slot="button"');
    expect(root).toContain('data-variant="primary"');
    expect(root).toContain('data-size="default"');
    expect(root).toContain("bg-color-1");
    expect(root).toContain("text-cte-accent-text");
    expect(root).toContain("px-l py-s");
    expect(root).toContain("corner-s");
    expect(root).not.toContain("data-pending");
    expect(markup).toContain('data-slot="button-label"');
    expect(markup).not.toContain("button-loader");
  });

  it.each([
    ["secondary", "bg-neutral-3"],
    ["outline", "ring-neutral-4-transparent"],
    ["ghost", "ring-transparent"],
    ["danger", "bg-error"],
  ] as const)("applies the %s variant", (variant, expected) => {
    const root = attributesOf(renderToStaticMarkup(<Button variant={variant}>Go</Button>));
    expect(root).toContain(`data-variant="${variant}"`);
    expect(root).toContain(expected);
    expect(root).not.toContain("bg-color-1");
  });

  it("disables the native button", () => {
    const root = attributesOf(renderToStaticMarkup(<Button disabled>Save</Button>));
    expect(root).toContain("disabled");
    expect(root).toContain("data-disabled");
  });

  it("keeps a pending button focusable, busy and inert, with the loading layer", () => {
    const markup = renderToStaticMarkup(<Button isPending>Save</Button>);
    const root = attributesOf(markup);
    expect(root).toContain("data-pending");
    expect(root).toContain('aria-busy="true"');
    expect(root).toContain('aria-disabled="true"');
    expect(root).toContain("data-disabled");
    expect(root).not.toMatch(/\sdisabled(=|\s|$)/);
    expect(markup).toContain('data-slot="button-loader"');
    expect(markup).toContain("animate-spin");
    expect(markup).toContain("Save");
  });

  it("merges className and keeps icons as children", () => {
    const markup = renderToStaticMarkup(
      <Button size="icon" variant="ghost" aria-label="Add" className="px-m">
        <PlusIcon />
      </Button>,
    );
    const root = attributesOf(markup);
    expect(root).toContain('data-size="icon"');
    expect(root).toContain('aria-label="Add"');
    expect(root).toContain("px-m");
    expect(markup).toContain("size-(--line-s)");
    expect(markup).toContain('data-slot="icon"');
  });

  it("gives a small icon button a tighter inset and a smaller corner", () => {
    const root = attributesOf(
      renderToStaticMarkup(
        <Button size="icon-s" variant="ghost" aria-label="Plus">
          <PlusIcon />
        </Button>,
      ),
    );
    expect(root).toContain('data-size="icon-s"');
    expect(root).toContain("p-xxs corner-xs");
    expect(root).not.toContain("corner-s");
  });

  it("supports a className function of the state", () => {
    const root = attributesOf(
      renderToStaticMarkup(
        <Button disabled className={(state) => (state.disabled ? "is-off" : "is-on")}>
          Go
        </Button>,
      ),
    );
    expect(root).toContain("is-off");
  });
});
