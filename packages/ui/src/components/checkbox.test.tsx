import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Checkbox, CheckboxLabel } from "./checkbox";
import { Field } from "./field";

function tagOf(markup: string, slot: string): string | undefined {
  return markup.match(new RegExp(`<[a-z]+[^>]*data-slot="${slot}"[^>]*>`))?.[0];
}

/** Matches the attribute itself, not a class such as `data-checked:ring-…`. */
function hasAttribute(tag: string | undefined, name: string): boolean {
  return tag !== undefined && new RegExp(`\\s${name}(=|\\s|>|$)`).test(tag);
}

describe("Checkbox", () => {
  it("renders an L square with the unchecked surface and a separate fill", () => {
    const markup = renderToStaticMarkup(<Checkbox aria-label="Zoom" name="zoom" />);
    const root = tagOf(markup, "checkbox");
    expect(root).toMatch(/^<span/);
    expect(root).toContain('role="checkbox"');
    expect(root).toContain('aria-checked="false"');
    for (const token of [
      "[--checkbox-size:var(--space-l)]",
      "size-(--checkbox-size)",
      "corner-xs bg-neutral-3 ring-s ring-neutral-4",
      "not-data-checked:not-data-indeterminate:control-hover:bg-neutral-4",
      "not-data-checked:not-data-indeterminate:control-hover:ring-neutral-5",
      "control-focus:ring-color-1-transparent",
      "data-checked:ring-color-1-transparent",
      "control-disabled:bg-neutral-3 control-disabled:ring-neutral-4",
      "focus-ring",
    ]) {
      expect(root).toContain(token);
    }
    const fill = tagOf(markup, "checkbox-fill");
    expect(fill).toContain('aria-hidden="true"');
    for (const token of [
      "absolute inset-0 rounded-[inherit] bg-color-1",
      "scale-0",
      "group-data-checked/checkbox:group-not-data-disabled/checkbox:scale-100",
      "duration-motion ease-motion",
    ]) {
      expect(fill).toContain(token);
    }
    // The mark is mounted only while checked or indeterminate.
    expect(tagOf(markup, "checkbox-indicator")).toBeUndefined();
    expect(markup).toMatch(/<input[^>]*name="zoom"/);
  });

  it("does not draw a check that is there from the first paint", () => {
    const markup = renderToStaticMarkup(<Checkbox aria-label="Zoom" defaultChecked />);
    expect(markup).toContain("sondine-check-draw");
    expect(markup).not.toContain('data-draw=""');
  });

  it("shows the check mark at 70% of the control in the primary foreground", () => {
    const markup = renderToStaticMarkup(<Checkbox aria-label="Zoom" defaultChecked />);
    expect(tagOf(markup, "checkbox")).toContain('aria-checked="true"');
    const indicator = tagOf(markup, "checkbox-indicator");
    expect(hasAttribute(indicator, "data-checked")).toBe(true);
    for (const token of [
      "text-cte-accent-text",
      "data-disabled:text-neutral-6",
      "duration-[calc(var(--motion-duration)*0.9)]",
      "delay-[calc(var(--motion-duration)*0.35)]",
      "data-starting-style:scale-0",
      "data-ending-style:duration-[calc(var(--motion-duration)*0.7)]",
      "motion-reduce:transition-none",
    ]) {
      expect(indicator).toContain(token);
    }
    expect(indicator).toContain('data-mark="check"');
    const marks = [...markup.matchAll(/<svg[^>]*>/g)].map((match) => match[0]);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toContain("size-[calc(var(--checkbox-size)*0.7)]");
    expect(marks[0]).toContain('aria-hidden="true"');
  });

  it("marks the indeterminate state as mixed and shows the minus", () => {
    const markup = renderToStaticMarkup(<Checkbox aria-label="Toutes" indeterminate />);
    expect(tagOf(markup, "checkbox")).toContain('aria-checked="mixed"');
    expect(hasAttribute(tagOf(markup, "checkbox"), "data-indeterminate")).toBe(true);
    const indicator = tagOf(markup, "checkbox-indicator");
    expect(hasAttribute(indicator, "data-indeterminate")).toBe(true);
    expect(indicator).toContain('data-mark="minus"');
    expect(markup.match(/<svg/g)).toHaveLength(1);
  });

  it("prefers the minus when checked and indeterminate together", () => {
    const markup = renderToStaticMarkup(
      <Checkbox aria-label="Toutes" defaultChecked indeterminate />,
    );
    expect(tagOf(markup, "checkbox-indicator")).toContain('data-mark="minus"');
  });

  it("forwards form and validation props to the primitive", () => {
    const markup = renderToStaticMarkup(
      <Checkbox aria-label="Zoom" name="zoom" value="zoom" required readOnly />,
    );
    const root = tagOf(markup, "checkbox");
    expect(root).toContain('aria-required="true"');
    expect(root).toContain('aria-readonly="true"');
    expect(hasAttribute(root, "data-required")).toBe(true);
    expect(hasAttribute(root, "data-readonly")).toBe(true);
    expect(markup).toMatch(/<input[^>]*name="zoom"/);
  });

  it("merges a caller className, including a state function", () => {
    const markup = renderToStaticMarkup(
      <Checkbox aria-label="Zoom" className={(state) => (state.checked ? "m-xs" : "m-xxs")} />,
    );
    expect(tagOf(markup, "checkbox")).toContain("m-xxs");
  });

  it("marks disabled on the root and the mark", () => {
    const markup = renderToStaticMarkup(<Checkbox aria-label="Zoom" defaultChecked disabled />);
    expect(tagOf(markup, "checkbox")).toContain('aria-disabled="true"');
    expect(hasAttribute(tagOf(markup, "checkbox"), "data-disabled")).toBe(true);
    expect(hasAttribute(tagOf(markup, "checkbox-indicator"), "data-disabled")).toBe(true);
  });
});

describe("CheckboxLabel", () => {
  it("wraps the checkbox in a label row with the regular label typography", () => {
    const markup = renderToStaticMarkup(
      <CheckboxLabel>
        <Checkbox />
        Réunions Zoom
      </CheckboxLabel>,
    );
    const label = tagOf(markup, "checkbox-label");
    expect(label).toMatch(/^<label/);
    for (const token of [
      "inline-flex items-center gap-xs",
      "font-body font-regular text-body-s text-neutral-10",
      "has-data-disabled:text-neutral-6",
    ]) {
      expect(label).toContain(token);
    }
  });
});

describe("Checkbox in an invalid Field", () => {
  it("keeps the rest surface and exposes the invalid state", () => {
    const markup = renderToStaticMarkup(
      <Field invalid>
        <CheckboxLabel>
          <Checkbox required />
          Supprimer l’audio après transcription
        </CheckboxLabel>
      </Field>,
    );
    const root = tagOf(markup, "checkbox");
    expect(root).toContain('aria-invalid="true"');
    expect(hasAttribute(root, "data-invalid")).toBe(true);
    expect(hasAttribute(root, "data-disabled")).toBe(false);
    expect(root).toContain("bg-neutral-3 ring-s ring-neutral-4");
  });
});
