import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MicrophoneIcon } from "../icon";
import { Toggle } from "./toggle";
import { ToggleGroup, ToggleGroupItem } from "./toggle-group";

function attributesOf(markup: string): string {
  return markup.slice(0, markup.indexOf(">"));
}

/** Matches the attribute itself, not a class such as `data-pressed:bg-…`. */
function hasAttribute(tag: string, name: string): boolean {
  return new RegExp(`\\s${name}(=|\\s|>|$)`).test(tag);
}

function items(markup: string): string[] {
  return [...markup.matchAll(/<button[^>]*>/g)].map((match) => match[0]);
}

describe("ToggleGroup", () => {
  it("renders a horizontal Base UI group with the spec's bare row", () => {
    const markup = renderToStaticMarkup(
      <ToggleGroup aria-label="Période">
        <ToggleGroupItem value="today">Aujourd’hui</ToggleGroupItem>
        <ToggleGroupItem value="week">Cette semaine</ToggleGroupItem>
      </ToggleGroup>,
    );
    const root = attributesOf(markup);
    expect(root).toMatch(/^<div/);
    expect(root).toContain('role="group"');
    expect(root).toContain('aria-label="Période"');
    expect(root).toContain('data-slot="toggle-group"');
    expect(root).toContain('data-orientation="horizontal"');
    expect(root).toContain('data-size="default"');
    expect(hasAttribute(root, "data-multiple")).toBe(false);
    for (const token of ["flex w-fit", "gap-xxs", "p-zero", "bg-transparent", "ring-none"]) {
      expect(root).toContain(token);
    }
  });

  it("renders items as shared Toggles with their own slot", () => {
    const [first] = items(
      renderToStaticMarkup(
        <ToggleGroup>
          <ToggleGroupItem value="today">Aujourd’hui</ToggleGroupItem>
        </ToggleGroup>,
      ),
    );
    expect(first).toContain('data-slot="toggle-group-item"');
    expect(first).toContain("px-s py-xs");
    expect(first).toContain("data-pressed:bg-neutral-3");
    expect(first).toContain('aria-pressed="false"');
  });

  it("marks the default values as pressed in multiple mode", () => {
    const markup = renderToStaticMarkup(
      <ToggleGroup multiple defaultValue={["camille", "ines"]}>
        <ToggleGroupItem value="camille">Camille</ToggleGroupItem>
        <ToggleGroupItem value="leo">Léo</ToggleGroupItem>
        <ToggleGroupItem value="ines">Inès</ToggleGroupItem>
      </ToggleGroup>,
    );
    expect(hasAttribute(attributesOf(markup), "data-multiple")).toBe(true);
    const pressed = items(markup).map((item) => item.includes('aria-pressed="true"'));
    expect(pressed).toEqual([true, false, true]);
  });

  it("disables every item when the group is disabled", () => {
    const markup = renderToStaticMarkup(
      <ToggleGroup disabled defaultValue={["week"]}>
        <ToggleGroupItem value="today">Aujourd’hui</ToggleGroupItem>
        <ToggleGroupItem value="week">Cette semaine</ToggleGroupItem>
      </ToggleGroup>,
    );
    expect(hasAttribute(attributesOf(markup), "data-disabled")).toBe(true);
    const [today, week] = items(markup);
    for (const item of [today, week]) {
      expect(hasAttribute(item ?? "", "disabled")).toBe(true);
      expect(hasAttribute(item ?? "", "data-disabled")).toBe(true);
    }
    expect(hasAttribute(today ?? "", "data-pressed")).toBe(false);
    expect(hasAttribute(week ?? "", "data-pressed")).toBe(true);
  });

  it("stacks vertically", () => {
    const root = attributesOf(
      renderToStaticMarkup(
        <ToggleGroup orientation="vertical">
          <ToggleGroupItem value="recent">Récentes</ToggleGroupItem>
        </ToggleGroup>,
      ),
    );
    expect(root).toContain('data-orientation="vertical"');
    expect(root).toContain("data-[orientation=vertical]:flex-col");
  });

  it("passes the group size to items unless an item sets its own", () => {
    const [inherited, own] = items(
      renderToStaticMarkup(
        <ToggleGroup size="icon">
          <ToggleGroupItem value="micro" aria-label="Micro">
            <MicrophoneIcon />
          </ToggleGroupItem>
          <ToggleGroupItem value="system" size="default">
            Audio système
          </ToggleGroupItem>
        </ToggleGroup>,
      ),
    );
    expect(inherited).toContain('data-size="icon"');
    expect(inherited).toContain("p-xs");
    expect(own).toContain('data-size="default"');
    expect(own).toContain("px-s py-xs");
  });

  it("accepts a plain Toggle as an item", () => {
    const [item] = items(
      renderToStaticMarkup(
        <ToggleGroup defaultValue={["micro"]}>
          <Toggle value="micro">Micro</Toggle>
        </ToggleGroup>,
      ),
    );
    expect(item).toContain('data-slot="toggle"');
    expect(item).toContain('aria-pressed="true"');
  });
});
