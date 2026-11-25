import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Field } from "./field";
import { Switch, SwitchLabel } from "./switch";

function tagOf(markup: string, slot: string): string {
  const match = markup.match(new RegExp(`<[a-z]+[^>]*data-slot="${slot}"[^>]*>`));
  if (!match) throw new Error(`no ${slot} in ${markup}`);
  return match[0];
}

/** Matches the attribute itself, not a class such as `data-checked:bg-…`. */
function hasAttribute(tag: string, name: string): boolean {
  return new RegExp(`\\s${name}(=|\\s|>|$)`).test(tag);
}

describe("Switch", () => {
  it("renders the Base UI switch as an XL track with derived geometry", () => {
    const markup = renderToStaticMarkup(<Switch aria-label="Micro" name="micro" />);
    const track = tagOf(markup, "switch");
    expect(track).toMatch(/^<span/);
    expect(track).toContain('role="switch"');
    expect(track).toContain('aria-checked="false"');
    expect(track).toContain('aria-label="Micro"');
    expect(hasAttribute(track, "data-unchecked")).toBe(true);
    for (const token of [
      "[--switch-size:var(--space-xl)]",
      "[--switch-inset:calc(var(--switch-size)/8)]",
      "[--switch-thumb:calc(var(--switch-size)*0.75)]",
      "[--switch-travel:calc(var(--switch-size)*0.75)]",
      "[--switch-stretch:min(6px,calc(var(--switch-thumb)/4))]",
      "h-(--switch-size) w-[calc(var(--switch-size)*1.75)]",
      "corner-full",
      "bg-neutral-4 ring-none ring-neutral-4",
      "control-focus:ring-color-1-transparent",
      "data-checked:bg-color-1",
      "control-disabled:bg-neutral-3",
      "focus-ring",
    ]) {
      expect(track).toContain(token);
    }
    expect(markup).toMatch(/<input[^>]*name="micro"/);
  });

  it("renders the thumb at the inset with checked travel and press stretch", () => {
    const thumb = tagOf(renderToStaticMarkup(<Switch aria-label="Micro" />), "switch-thumb");
    for (const token of [
      "absolute top-(--switch-inset) start-(--switch-inset)",
      "size-(--switch-thumb) corner-full bg-neutral-1 ring-s ring-neutral-4-transparent",
      "data-checked:translate-x-[calc(var(--switch-travel)*var(--switch-direction))]",
      "data-disabled:bg-neutral-6",
      "motion-safe:group-active/switch:not-data-disabled:not-data-readonly:w-[calc(var(--switch-thumb)+var(--switch-stretch))]",
      "motion-safe:group-active/switch:not-data-disabled:not-data-readonly:duration-[calc(var(--motion-duration)/2)]",
      "motion-safe:in-[label:active]:not-data-disabled:not-data-readonly:data-checked:translate-x-[calc((var(--switch-travel)-var(--switch-stretch))*var(--switch-direction))]",
      "motion-reduce:transition-none",
    ]) {
      expect(thumb).toContain(token);
    }
  });

  it("reverses the travel in right-to-left layouts", () => {
    const track = tagOf(renderToStaticMarkup(<Switch aria-label="Micro" />), "switch");
    expect(track).toContain("[--switch-direction:1] rtl:[--switch-direction:-1]");
  });

  it("marks checked, disabled and read-only states on track and thumb", () => {
    const markup = renderToStaticMarkup(
      <Switch aria-label="Micro" defaultChecked disabled readOnly />,
    );
    const track = tagOf(markup, "switch");
    const thumb = tagOf(markup, "switch-thumb");
    expect(track).toContain('aria-checked="true"');
    expect(track).toContain('aria-disabled="true"');
    expect(track).toContain('aria-readonly="true"');
    for (const tag of [track, thumb]) {
      expect(hasAttribute(tag, "data-checked")).toBe(true);
      expect(hasAttribute(tag, "data-disabled")).toBe(true);
      expect(hasAttribute(tag, "data-readonly")).toBe(true);
    }
  });
});

describe("SwitchLabel", () => {
  it("wraps the switch in a label row with the medium label typography", () => {
    const markup = renderToStaticMarkup(
      <SwitchLabel>
        <Switch />
        Écoute en continu
      </SwitchLabel>,
    );
    const label = tagOf(markup, "switch-label");
    expect(label).toMatch(/^<label/);
    for (const token of [
      "inline-flex items-center gap-xs",
      "font-body font-medium text-body-s text-neutral-10",
      "has-data-disabled:text-neutral-6",
    ]) {
      expect(label).toContain(token);
    }
    expect(markup).toContain("Écoute en continu");
  });

  it("accepts another element through render and merges className", () => {
    const markup = renderToStaticMarkup(
      <SwitchLabel render={<div />} className="gap-s">
        <Switch aria-label="Micro" />
      </SwitchLabel>,
    );
    const label = tagOf(markup, "switch-label");
    expect(label).toMatch(/^<div/);
    expect(label).toContain("gap-s");
    expect(label).not.toContain("gap-xs");
  });
});

describe("Switch in an invalid Field", () => {
  it("exposes the invalid state on track and thumb without disabling", () => {
    const markup = renderToStaticMarkup(
      <Field invalid>
        <SwitchLabel>
          <Switch required />
          Prévenir les participants
        </SwitchLabel>
      </Field>,
    );
    const track = tagOf(markup, "switch");
    expect(track).toContain('aria-invalid="true"');
    expect(hasAttribute(track, "data-invalid")).toBe(true);
    expect(hasAttribute(tagOf(markup, "switch-thumb"), "data-invalid")).toBe(true);
    expect(hasAttribute(track, "data-disabled")).toBe(false);
  });
});
