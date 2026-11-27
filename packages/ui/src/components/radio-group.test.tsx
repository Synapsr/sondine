import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Field } from "./field";
import { Radio, RadioGroup, RadioLabel } from "./radio-group";

function tagsOf(markup: string, slot: string): string[] {
  return [...markup.matchAll(new RegExp(`<[a-z]+[^>]*data-slot="${slot}"[^>]*>`, "g"))].map(
    (match) => match[0],
  );
}

/** Matches the attribute itself, not a class such as `data-checked:bg-…`. */
function hasAttribute(tag: string | undefined, name: string): boolean {
  return tag !== undefined && new RegExp(`\\s${name}(=|\\s|>|$)`).test(tag);
}

function renderGroup(variant?: "row" | "plain") {
  return renderToStaticMarkup(
    <RadioGroup aria-label="Qualité" defaultValue="balanced" name="quality">
      <RadioLabel variant={variant}>
        <Radio value="fast" />
        Rapide
      </RadioLabel>
      <RadioLabel variant={variant}>
        <Radio value="balanced" />
        Équilibrée
      </RadioLabel>
      <RadioLabel variant={variant}>
        <Radio value="precise" disabled />
        Précise
      </RadioLabel>
    </RadioGroup>,
  );
}

describe("RadioGroup", () => {
  it("renders a vertical 320px group with XXS spacing", () => {
    const [group] = tagsOf(renderGroup(), "radio-group");
    expect(group).toContain('role="radiogroup"');
    expect(group).toContain('aria-label="Qualité"');
    expect(group).toContain("flex w-[20rem] max-w-full flex-col gap-xxs");
  });

  it("renders M radios with the spec's states and an inset dot when checked", () => {
    const markup = renderGroup();
    const radios = tagsOf(markup, "radio");
    expect(radios).toHaveLength(3);
    const [rest, checked, disabled] = radios as [string, string, string];
    expect(rest).toContain('role="radio"');
    expect(rest).toContain('aria-checked="false"');
    for (const token of [
      "size-m",
      "corner-full bg-neutral-3 ring-s ring-neutral-5",
      "not-data-checked:control-hover:ring-neutral-7",
      "control-focus:ring-color-1",
      "data-checked:bg-color-1 data-checked:ring-color-1",
      "control-disabled:bg-neutral-3 control-disabled:ring-neutral-4",
      "focus-ring",
    ]) {
      expect(rest).toContain(token);
    }
    expect(checked).toContain('aria-checked="true"');
    expect(hasAttribute(disabled, "data-disabled")).toBe(true);
    const dots = tagsOf(markup, "radio-indicator");
    expect(dots).toHaveLength(1);
    for (const token of [
      "absolute inset-[30%] corner-full",
      "bg-neutral-1",
      "data-disabled:bg-neutral-6",
    ]) {
      expect(dots[0]).toContain(token);
    }
    // The dot takes the canvas color on the ink fill in both modes; white on
    // white hid it in dark mode.
    expect(dots[0]).not.toContain("dark:bg-neutral-10");
  });

  it("renders padded rows whose fill follows the radio", () => {
    const [row] = tagsOf(renderGroup(), "radio-label");
    expect(row).toMatch(/^<label/);
    expect(row).toContain('data-variant="row"');
    for (const token of [
      "flex items-center gap-xs",
      "corner-s bg-transparent p-s",
      "font-body font-regular text-body-s text-neutral-10",
      "has-data-disabled:text-neutral-6",
      "not-has-data-disabled:not-has-data-checked:hover:bg-neutral-3-transparent",
      "not-has-data-disabled:has-data-checked:bg-neutral-3",
    ]) {
      expect(row).toContain(token);
    }
  });

  it("renders plain labels without a row surface", () => {
    const [label] = tagsOf(renderGroup("plain"), "radio-label");
    expect(label).toContain('data-variant="plain"');
    expect(label).toContain("gap-xs");
    expect(label).not.toContain("p-s");
    expect(label).not.toContain("bg-neutral-3");
  });

  it("disables every radio of a disabled group", () => {
    const markup = renderToStaticMarkup(
      <RadioGroup aria-label="Conservation" defaultValue="30" disabled>
        <Radio value="7" />
        <Radio value="30" />
      </RadioGroup>,
    );
    const [group] = tagsOf(markup, "radio-group");
    expect(hasAttribute(group, "data-disabled")).toBe(true);
    for (const radio of tagsOf(markup, "radio")) {
      expect(hasAttribute(radio, "data-disabled")).toBe(true);
    }
  });
});

describe("RadioGroup in an invalid Field", () => {
  it("marks the group and its radios invalid, not disabled", () => {
    const markup = renderToStaticMarkup(
      <Field invalid>
        <RadioGroup aria-label="Intervenant" required>
          <RadioLabel>
            <Radio value="camille" />
            Camille
          </RadioLabel>
        </RadioGroup>
      </Field>,
    );
    const [group] = tagsOf(markup, "radio-group");
    expect(group).toContain('aria-invalid="true"');
    const [radio] = tagsOf(markup, "radio");
    expect(hasAttribute(radio, "data-invalid")).toBe(true);
    expect(hasAttribute(radio, "data-disabled")).toBe(false);
  });
});
