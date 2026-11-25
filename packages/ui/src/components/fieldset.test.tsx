import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Field, FieldLabel } from "./field";
import { Fieldset, FieldsetLegend } from "./fieldset";
import { Input } from "./input";

function tagWithSlot(markup: string, slot: string): string {
  const match = markup.match(new RegExp(`<[a-z]+[^>]*data-slot="${slot}"[^>]*>`));
  expect(match, slot).not.toBeNull();
  return match?.[0] ?? "";
}

const speaker = (disabled = false) => (
  <Fieldset disabled={disabled}>
    <FieldsetLegend>Intervenant</FieldsetLegend>
    <Field name="firstName">
      <FieldLabel>Prénom</FieldLabel>
      <Input defaultValue="Camille" />
    </Field>
    <Field name="lastName">
      <FieldLabel>Nom</FieldLabel>
      <Input defaultValue="Martin" />
    </Field>
  </Fieldset>
);

describe("Fieldset", () => {
  it("renders a native fieldset stacking its fields with the M gap", () => {
    const root = tagWithSlot(renderToStaticMarkup(speaker()), "fieldset");
    expect(root).toMatch(/^<fieldset/);
    for (const token of ["flex-col", "gap-m", "min-w-0", "m-zero", "p-zero"]) {
      expect(root).toContain(token);
    }
    expect(root).not.toMatch(/\sdisabled=""/);
  });

  it("styles the legend with the M text step", () => {
    const legend = tagWithSlot(renderToStaticMarkup(speaker()), "fieldset-legend");
    for (const token of ["font-medium", "text-body-m", "text-neutral-10"]) {
      expect(legend).toContain(token);
    }
    expect(legend).toContain("data-disabled:text-neutral-6");
  });

  it("disables the legend and every nested field", () => {
    const markup = renderToStaticMarkup(speaker(true));
    expect(tagWithSlot(markup, "fieldset")).toMatch(/\sdisabled=""/);
    expect(tagWithSlot(markup, "fieldset")).toContain('data-disabled=""');
    expect(tagWithSlot(markup, "fieldset-legend")).toContain('data-disabled=""');
    const inputs = markup.match(/<input[^>]*>/g) ?? [];
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      expect(input).toMatch(/\sdisabled=""/);
      expect(input).toContain('data-disabled=""');
    }
    const labels = markup.match(/<label[^>]*>/g) ?? [];
    for (const label of labels) expect(label).toContain('data-disabled=""');
  });

  it("keeps each field independently labelled", () => {
    const markup = renderToStaticMarkup(speaker());
    const ids = [...markup.matchAll(/<input[^>]*\sid="([^"]+)"/g)].map((match) => match[1]);
    const targets = [...markup.matchAll(/<label[^>]*\sfor="([^"]+)"/g)].map((match) => match[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(targets).toEqual(ids);
  });
});
