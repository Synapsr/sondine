import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./collapsible";

/** Opening tag of the first element carrying `data-slot="<slot>"`. */
function tagOf(markup: string, slot: string): string {
  const at = markup.indexOf(`data-slot="${slot}"`);
  if (at === -1) throw new Error(`no ${slot} in ${markup}`);
  const start = markup.lastIndexOf("<", at);
  return markup.slice(start, markup.indexOf(">", at) + 1);
}

/** Matches the attribute itself, not a class such as `data-closed:…`. */
function hasAttribute(tag: string, name: string): boolean {
  return new RegExp(`\\s${name}(=|\\s|>|$)`).test(tag);
}

function renderDetails(props: { defaultOpen?: boolean; disabled?: boolean } = {}) {
  return renderToStaticMarkup(
    <Collapsible defaultOpen={props.defaultOpen} disabled={props.disabled}>
      <CollapsibleTrigger>Détails de l’enregistrement</CollapsibleTrigger>
      <CollapsiblePanel>Micro intégré · 48 kHz</CollapsiblePanel>
    </Collapsible>,
  );
}

describe("Collapsible", () => {
  it("renders a closed root whose S gap closes to zero with Large motion", () => {
    const markup = renderDetails();
    const root = tagOf(markup, "collapsible");
    expect(hasAttribute(root, "data-closed")).toBe(true);
    for (const token of [
      "flex flex-col gap-s",
      "p-0",
      "transition-[gap] duration-motion-large ease-motion-large motion-reduce:transition-none",
      "data-closed:gap-0",
    ]) {
      expect(root).toContain(token);
    }
    expect(markup).not.toContain('data-slot="collapsible-panel"');
  });

  it("styles the full-width trigger from the spec", () => {
    const trigger = tagOf(renderDetails(), "collapsible-trigger");
    expect(trigger).toMatch(/^<button/);
    expect(trigger).toContain('aria-expanded="false"');
    for (const token of [
      "flex w-full items-center justify-between gap-xs",
      "corner-s px-zero py-xs bg-transparent text-neutral-10",
      "font-body font-medium text-body-s",
      "ring-none ring-transparent control-focus:ring-color-1",
      "focus-ring",
      "control-disabled:text-neutral-6",
    ]) {
      expect(trigger).toContain(token);
    }
    expect(trigger).not.toContain("translate-y");
    const indicator = tagOf(renderDetails(), "collapsible-indicator");
    for (const token of [
      "text-body-m text-neutral-7",
      "group-data-panel-open/collapsible-trigger:rotate-90",
      "duration-motion-large ease-motion-large",
      "group-data-disabled/collapsible-trigger:text-neutral-6",
    ]) {
      expect(indicator).toContain(token);
    }
  });

  it("renders the open panel surface with measured height, opacity and inner padding", () => {
    const markup = renderDetails({ defaultOpen: true });
    expect(hasAttribute(tagOf(markup, "collapsible"), "data-open")).toBe(true);
    expect(tagOf(markup, "collapsible-trigger")).toContain('aria-expanded="true"');

    const panel = tagOf(markup, "collapsible-panel");
    expect(hasAttribute(panel, "data-open")).toBe(true);
    for (const token of [
      "h-(--collapsible-panel-height) overflow-hidden p-0",
      "corner-s bg-neutral-2 ring-s ring-neutral-4-transparent",
      "transition-[height,opacity] duration-motion-large ease-motion-large motion-reduce:transition-none",
      "data-starting-style:h-0 data-starting-style:opacity-0",
      "data-ending-style:h-0 data-ending-style:opacity-0",
    ]) {
      expect(panel).toContain(token);
    }
    const content = tagOf(markup, "collapsible-content");
    for (const token of [
      "flow-root p-s",
      "font-body font-regular text-body-s text-neutral-8",
      "group-data-disabled/collapsible-panel:text-neutral-6",
    ]) {
      expect(content).toContain(token);
    }
  });

  it("marks the trigger and panel disabled", () => {
    const markup = renderDetails({ defaultOpen: true, disabled: true });
    expect(hasAttribute(tagOf(markup, "collapsible-trigger"), "data-disabled")).toBe(true);
    expect(hasAttribute(tagOf(markup, "collapsible-panel"), "data-disabled")).toBe(true);
  });

  it("merges className strings and state functions", () => {
    const markup = renderToStaticMarkup(
      <Collapsible className={(state) => (state.open ? "is-open" : "is-closed")}>
        <CollapsibleTrigger className="py-s">Détails</CollapsibleTrigger>
      </Collapsible>,
    );
    expect(tagOf(markup, "collapsible")).toContain("is-closed");
    const trigger = tagOf(markup, "collapsible-trigger");
    expect(trigger).toContain("py-s");
    expect(trigger).not.toContain("py-xs");
  });
});
