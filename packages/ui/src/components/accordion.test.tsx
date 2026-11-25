import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MicrophoneIcon } from "../icon";
import { Accordion, AccordionItem, AccordionPanel, AccordionTrigger } from "./accordion";

/** Opening tag of the first element carrying `data-slot="<slot>"`. */
function tagOf(markup: string, slot: string): string {
  const at = markup.indexOf(`data-slot="${slot}"`);
  if (at === -1) throw new Error(`no ${slot} in ${markup}`);
  const start = markup.lastIndexOf("<", at);
  return markup.slice(start, markup.indexOf(">", at) + 1);
}

/** Matches the attribute itself, not a class such as `data-disabled:…`. */
function hasAttribute(tag: string, name: string): boolean {
  return new RegExp(`\\s${name}(=|\\s|>|$)`).test(tag);
}

function renderFaq(props: { open?: string[]; disabled?: boolean } = {}) {
  return renderToStaticMarkup(
    <Accordion defaultValue={props.open ?? []}>
      <AccordionItem value="storage" disabled={props.disabled ?? false}>
        <AccordionTrigger>Où sont stockées mes conversations ?</AccordionTrigger>
        <AccordionPanel>Uniquement sur ce Mac.</AccordionPanel>
      </AccordionItem>
      <AccordionItem value="pause">
        <AccordionTrigger>Comment mettre en pause l’écoute ?</AccordionTrigger>
        <AccordionPanel>Depuis la barre des menus.</AccordionPanel>
      </AccordionItem>
    </Accordion>,
  );
}

describe("Accordion", () => {
  it("renders the anatomy with data slots and a zero-margin semantic header", () => {
    const markup = renderFaq();
    expect(tagOf(markup, "accordion")).toContain("flex w-full flex-col");
    const header = tagOf(markup, "accordion-header");
    expect(header).toMatch(/^<h3/);
    expect(header).toContain("m-0");
    const trigger = tagOf(markup, "accordion-trigger");
    expect(trigger).toMatch(/^<button/);
    expect(trigger).toContain('aria-expanded="false"');
    expect(markup).toContain('data-slot="accordion-label"');
    expect(tagOf(markup, "accordion-indicator")).toContain('aria-hidden="true"');
    expect(markup).toContain('data-slot="icon"');
  });

  it("divides items with the panel border token on every item but the last", () => {
    const item = tagOf(renderFaq(), "accordion-item");
    expect(item).toContain(
      "not-last:inset-shadow-[0_calc(var(--border-s)*-1)_0_0_var(--neutral-4-transparent)]",
    );
  });

  it("styles the trigger from the spec: M vertical padding, medium S label, focus and disabled", () => {
    const trigger = tagOf(renderFaq(), "accordion-trigger");
    for (const token of [
      "corner-s",
      "px-zero py-m",
      "gap-xs",
      "justify-between",
      "bg-transparent text-neutral-10",
      "font-body font-medium text-body-s",
      "ring-none ring-transparent control-focus:ring-color-1",
      "focus-ring",
      "control-disabled:text-neutral-6",
    ]) {
      expect(trigger).toContain(token);
    }
    // Accordion triggers do not take the button press translation or a hover fill.
    expect(trigger).not.toContain("translate-y");
    expect(trigger).not.toContain("control-hover");
  });

  it("turns the neutral-7 chevron 90 degrees with Large motion when open", () => {
    const indicator = tagOf(renderFaq(), "accordion-indicator");
    for (const token of [
      "text-body-m text-neutral-7",
      "group-data-panel-open/accordion-trigger:rotate-90",
      "duration-motion-large ease-motion-large motion-reduce:transition-none",
      "group-data-disabled/accordion-trigger:text-neutral-6",
    ]) {
      expect(indicator).toContain(token);
    }
  });

  it("does not render closed panels", () => {
    expect(renderFaq()).not.toContain('data-slot="accordion-panel"');
  });

  it("animates the open panel's grid row and keeps its padding inside the clip", () => {
    const markup = renderFaq({ open: ["storage"] });
    expect(tagOf(markup, "accordion-trigger")).toContain('aria-expanded="true"');
    expect(hasAttribute(tagOf(markup, "accordion-trigger"), "data-panel-open")).toBe(true);

    const panel = tagOf(markup, "accordion-panel");
    expect(panel).toContain('role="region"');
    expect(hasAttribute(panel, "data-open")).toBe(true);
    for (const token of [
      "grid grid-rows-[1fr]",
      "p-0",
      "transition-[grid-template-rows,opacity] duration-motion-large ease-motion-large",
      "data-starting-style:grid-rows-[0fr] data-starting-style:opacity-0",
      "data-ending-style:grid-rows-[0fr] data-ending-style:opacity-0",
    ]) {
      expect(panel).toContain(token);
    }
    expect(tagOf(markup, "accordion-clip")).toContain("min-h-0 overflow-hidden");
    const content = tagOf(markup, "accordion-content");
    for (const token of [
      "px-zero pt-zero pb-m",
      "font-body font-regular text-body-s text-neutral-8",
      "group-data-disabled/accordion-panel:text-neutral-6",
    ]) {
      expect(content).toContain(token);
    }
  });

  it("marks disabled items on the trigger and the panel", () => {
    const markup = renderFaq({ open: ["storage"], disabled: true });
    const trigger = tagOf(markup, "accordion-trigger");
    expect(hasAttribute(trigger, "data-disabled")).toBe(true);
    expect(hasAttribute(tagOf(markup, "accordion-panel"), "data-disabled")).toBe(true);
  });

  it("keeps icons in the label next to the text", () => {
    const markup = renderToStaticMarkup(
      <Accordion>
        <AccordionItem>
          <AccordionTrigger>
            <MicrophoneIcon />
            Micro intégré
          </AccordionTrigger>
        </AccordionItem>
      </Accordion>,
    );
    const label = markup.slice(markup.indexOf('data-slot="accordion-label"'));
    expect(label.indexOf('data-slot="icon"')).toBeLessThan(label.indexOf("Micro intégré"));
    expect(tagOf(markup, "accordion-label")).toContain("flex min-w-0 flex-1 items-center gap-xs");
  });

  it("passes className strings and state functions, and header props", () => {
    const markup = renderToStaticMarkup(
      <Accordion className="max-w-[20rem]">
        <AccordionItem className={(state) => (state.open ? "is-open" : "is-closed")}>
          <AccordionTrigger className="py-s" headerProps={{ className: "is-header" }}>
            Réunion produit
          </AccordionTrigger>
        </AccordionItem>
      </Accordion>,
    );
    expect(tagOf(markup, "accordion")).toContain("max-w-[20rem]");
    expect(tagOf(markup, "accordion-item")).toContain("is-closed");
    const trigger = tagOf(markup, "accordion-trigger");
    expect(trigger).toContain("py-s");
    expect(trigger).not.toContain("py-m");
    expect(tagOf(markup, "accordion-header")).toContain("m-0 flex is-header");
  });
});
