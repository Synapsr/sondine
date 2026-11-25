import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CommandIcon } from "../icon";
import { Kbd, KbdGroup } from "./kbd";

function attributesOf(markup: string): string {
  return markup.slice(0, markup.indexOf(">"));
}

describe("Kbd", () => {
  it("renders a kbd keycap with detail typography on Neutral 4", () => {
    const markup = renderToStaticMarkup(<Kbd>esc</Kbd>);
    const root = attributesOf(markup);
    expect(root).toMatch(/^<kbd/);
    expect(root).toContain('data-slot="kbd"');
    for (const token of [
      "min-h-(--line-s)",
      "min-w-(--line-s)",
      "corner-xs",
      "bg-neutral-4",
      "px-xxs",
      "text-neutral-8",
      "ring-s",
      "ring-border-default",
      "font-body",
      "font-regular",
      "text-body-xs",
      "whitespace-nowrap",
      "select-none",
      "in-data-disabled:text-neutral-6",
    ]) {
      expect(root).toContain(token);
    }
    expect(markup).toBe(`${root}>esc</kbd>`);
  });

  it("merges className and forwards attributes", () => {
    const root = attributesOf(
      renderToStaticMarkup(
        <Kbd className="bg-neutral-3" title="Commande">
          ⌘
        </Kbd>,
      ),
    );
    expect(root).toContain("bg-neutral-3");
    expect(root).not.toContain("bg-neutral-4");
    expect(root).toContain('title="Commande"');
  });

  it("keeps an icon key as a 1em glyph", () => {
    const markup = renderToStaticMarkup(
      <Kbd aria-label="Commande">
        <CommandIcon />
      </Kbd>,
    );
    expect(markup).toContain('data-slot="icon"');
    expect(markup).toContain('aria-label="Commande"');
  });
});

describe("KbdGroup", () => {
  it("groups keys in one kbd element, XXS apart", () => {
    const markup = renderToStaticMarkup(
      <KbdGroup>
        <Kbd>⌘</Kbd>
        <Kbd>K</Kbd>
      </KbdGroup>,
    );
    const root = attributesOf(markup);
    expect(root).toMatch(/^<kbd/);
    expect(root).toContain('data-slot="kbd-group"');
    expect(root).toContain("inline-flex");
    expect(root).toContain("gap-xxs");
    expect(markup.match(/data-slot="kbd"/g)).toHaveLength(2);
  });
});
