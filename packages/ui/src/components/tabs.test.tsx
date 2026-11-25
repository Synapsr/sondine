import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SparkleIcon } from "../icon";
import { Tabs, TabsList, TabsPanel, TabsTab } from "./tabs";

function tagsOf(markup: string, slot: string): string[] {
  return [...markup.matchAll(new RegExp(`<[a-z]+[^>]*data-slot="${slot}"[^>]*>`, "g"))].map(
    (match) => match[0],
  );
}

/** Matches the attribute itself, not a class such as `data-active:text-…`. */
function hasAttribute(tag: string | undefined, name: string): boolean {
  return tag !== undefined && new RegExp(`\\s${name}(=|\\s|>|$)`).test(tag);
}

function renderTabs(props: { orientation?: "horizontal" | "vertical" } = {}) {
  return renderToStaticMarkup(
    <Tabs defaultValue="summary" {...props}>
      <TabsList>
        <TabsTab value="transcript">Transcription</TabsTab>
        <TabsTab value="summary">
          <SparkleIcon />
          Résumé
        </TabsTab>
        <TabsTab value="iphone" disabled>
          iPhone
        </TabsTab>
      </TabsList>
      <TabsPanel value="transcript">Réunion Zoom</TabsPanel>
      <TabsPanel value="summary">Trois décisions</TabsPanel>
      <TabsPanel value="iphone">Jumelez un iPhone</TabsPanel>
    </Tabs>,
  );
}

describe("Tabs", () => {
  it("stacks the list and panels with S spacing", () => {
    const [root] = tagsOf(renderTabs(), "tabs");
    expect(root).toContain('data-orientation="horizontal"');
    expect(root).toContain("flex-col gap-s");
  });

  it("renders the list as the spec's Neutral 3 track with one indicator", () => {
    const markup = renderTabs();
    const [list] = tagsOf(markup, "tabs-list");
    expect(list).toContain('role="tablist"');
    for (const token of [
      "relative isolate",
      "w-fit max-w-full",
      "gap-xxs p-xxs",
      "corner-m",
      "bg-neutral-3",
      "ring-none ring-neutral-4-transparent",
    ]) {
      expect(list).toContain(token);
    }
    const indicators = tagsOf(markup, "tabs-indicator");
    expect(indicators).toHaveLength(1);
    for (const token of [
      "-z-1",
      "w-(--active-tab-width)",
      "translate-x-(--active-tab-left)",
      "corner-s bg-neutral-1",
      "duration-motion ease-motion",
      "motion-reduce:transition-none",
    ]) {
      expect(indicators[0]).toContain(token);
    }
  });

  it("paints the active tab itself until the indicator is measured", () => {
    const markup = renderTabs();
    const [indicator] = tagsOf(markup, "tabs-indicator");
    // Without layout (server markup) Base UI keeps the indicator hidden.
    expect(indicator).toMatch(/\shidden(=|\s|>)/);
    const [list] = tagsOf(markup, "tabs-list");
    // Server markup escapes & and > inside the class attribute.
    expect(list).toContain(
      "[&amp;:not(:has(&gt;[data-slot=tabs-indicator]:not([hidden])))&gt;[data-active]]:bg-neutral-1",
    );
  });

  it("styles tabs with the spec's typography and states", () => {
    const tabs = tagsOf(renderTabs(), "tabs-tab");
    expect(tabs).toHaveLength(3);
    const [rest, active, disabled] = tabs as [string, string, string];
    expect(rest).toMatch(/^<button/);
    expect(rest).toContain('role="tab"');
    expect(rest).toContain('aria-selected="false"');
    for (const token of [
      "px-s py-xxs",
      "corner-s",
      "font-body font-medium text-body-s",
      "text-neutral-7",
      "control-hover:text-neutral-10",
      "data-active:text-neutral-10",
      "control-disabled:text-neutral-6",
      "control-focus:ring-color-1",
      "focus-ring",
    ]) {
      expect(rest).toContain(token);
    }
    expect(rest).not.toContain("translate-y-(--motion-press-distance)");
    expect(active).toContain('aria-selected="true"');
    expect(hasAttribute(active, "data-active")).toBe(true);
    expect(hasAttribute(disabled, "data-disabled")).toBe(true);
    expect(hasAttribute(rest, "data-disabled")).toBe(false);
  });

  it("renders only the active panel, with the content typography", () => {
    const panels = tagsOf(renderTabs(), "tabs-panel");
    expect(panels).toHaveLength(1);
    const [shown] = panels as [string];
    expect(shown).toContain('role="tabpanel"');
    expect(hasAttribute(shown, "hidden")).toBe(false);
    for (const token of ["pt-xs", "font-regular text-body-s", "text-neutral-8", "focus-ring"]) {
      expect(shown).toContain(token);
    }
  });

  it("keeps hidden panels hidden when they stay mounted", () => {
    const panels = tagsOf(
      renderToStaticMarkup(
        <Tabs defaultValue="summary">
          <TabsList>
            <TabsTab value="transcript">Transcription</TabsTab>
            <TabsTab value="summary">Résumé</TabsTab>
          </TabsList>
          <TabsPanel value="transcript" keepMounted>
            Réunion Zoom
          </TabsPanel>
          <TabsPanel value="summary" keepMounted>
            Trois décisions
          </TabsPanel>
        </Tabs>,
      ),
      "tabs-panel",
    );
    expect(panels).toHaveLength(2);
    expect(hasAttribute(panels[0], "hidden")).toBe(true);
    expect(hasAttribute(panels[1], "hidden")).toBe(false);
  });

  it("sets the orientation on every part", () => {
    const markup = renderTabs({ orientation: "vertical" });
    const [root] = tagsOf(markup, "tabs");
    const [list] = tagsOf(markup, "tabs-list");
    expect(root).toContain('data-orientation="vertical"');
    expect(list).toContain('data-orientation="vertical"');
    expect(list).toContain('aria-orientation="vertical"');
    expect(list).toContain("data-[orientation=vertical]:flex-col");
  });

  it("merges a caller className and keeps the stretch variable", () => {
    const [list] = tagsOf(
      renderToStaticMarkup(
        <Tabs defaultValue="a">
          <TabsList className="p-xs">
            <TabsTab value="a">A</TabsTab>
          </TabsList>
        </Tabs>,
      ),
      "tabs-list",
    );
    expect(list).toContain("p-xs");
    expect(list).not.toMatch(/\sp-xxs[\s"]/);
    expect(list).toContain("[--tabs-press-stretch:6px]");
  });
});
