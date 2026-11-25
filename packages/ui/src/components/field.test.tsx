import type { ComponentProps, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Field, FieldDescription, FieldError, FieldItem, FieldLabel, FieldValidity } from "./field";
import { Input } from "./input";

function render(node: ReactNode): string {
  return renderToStaticMarkup(node);
}

function tagWithSlot(markup: string, slot: string): string {
  const match = markup.match(new RegExp(`<[a-z]+[^>]*data-slot="${slot}"[^>]*>`));
  expect(match, slot).not.toBeNull();
  return match?.[0] ?? "";
}

function attribute(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
}

const complete = (props: ComponentProps<typeof Field> = {}) => (
  <Field name="person" {...props}>
    <FieldLabel>Nom de la personne</FieldLabel>
    <Input placeholder="Camille Martin" />
    <FieldDescription>Visible dans vos transcriptions.</FieldDescription>
    <FieldError match>Indiquez un nom.</FieldError>
  </Field>
);

describe("Field", () => {
  it("stacks its parts with the XS gap", () => {
    const root = tagWithSlot(render(complete()), "field");
    expect(root).toMatch(/^<div/);
    expect(root).toContain("flex-col");
    expect(root).toContain("gap-xs");
  });

  // aria-describedby is registered in a layout effect, so it is checked in
  // the browser, not in server markup.
  it("links the label to the input and names it", () => {
    const markup = render(complete());
    const label = tagWithSlot(markup, "field-label");
    const input = tagWithSlot(markup, "input");

    expect(label).toMatch(/^<label/);
    expect(attribute(input, "id")).toBeTruthy();
    expect(attribute(label, "for")).toBe(attribute(input, "id"));
    expect(attribute(input, "name")).toBe("person");
    expect(attribute(tagWithSlot(markup, "field-description"), "id")).toBeTruthy();
    expect(attribute(tagWithSlot(markup, "field-error"), "id")).toBeTruthy();
  });

  it("applies each part's typography and color", () => {
    const markup = render(complete());
    const label = tagWithSlot(markup, "field-label");
    for (const token of ["font-medium", "text-body-s", "text-neutral-10"]) {
      expect(label).toContain(token);
    }
    const description = tagWithSlot(markup, "field-description");
    for (const token of [
      "font-regular",
      "text-body-s",
      "text-neutral-7",
      "max-w-[40ch]",
      "m-zero",
    ]) {
      expect(description).toContain(token);
    }
    const error = tagWithSlot(markup, "field-error");
    for (const token of ["font-regular", "text-body-xs", "text-error"]) {
      expect(error).toContain(token);
    }
    for (const part of [label, description, error]) {
      expect(part).toContain("data-disabled:text-neutral-6");
    }
  });

  it("marks every part disabled and disables the input", () => {
    const markup = render(complete({ disabled: true }));
    for (const slot of ["field", "field-label", "field-description", "input"]) {
      expect(tagWithSlot(markup, slot)).toContain('data-disabled=""');
    }
    expect(tagWithSlot(markup, "input")).toMatch(/\sdisabled=""/);
  });

  it("marks the field invalid when the app says so", () => {
    const markup = render(complete({ invalid: true }));
    expect(tagWithSlot(markup, "field")).toContain('data-invalid=""');
    expect(tagWithSlot(markup, "field-label")).toContain('data-invalid=""');
    expect(tagWithSlot(markup, "input")).toContain('aria-invalid="true"');
    expect(markup).toContain("Indiquez un nom.");
  });

  it("hides the error until validation fails", () => {
    const markup = render(
      <Field>
        <FieldLabel>Nom</FieldLabel>
        <Input required />
        <FieldError>Indiquez un nom.</FieldError>
      </Field>,
    );
    expect(markup).not.toContain('data-slot="field-error"');
    expect(markup).not.toContain("Indiquez un nom.");
  });

  it("renders items and validity for grouped controls", () => {
    const markup = render(
      <Field>
        <FieldItem>
          <FieldLabel>Zoom</FieldLabel>
        </FieldItem>
        <FieldValidity>
          {(validity) => <span data-valid-state={String(validity.validity.valid)} />}
        </FieldValidity>
      </Field>,
    );
    expect(tagWithSlot(markup, "field-item")).toContain("items-center");
    expect(markup).toContain('data-valid-state="null"');
  });

  it("merges className on every part", () => {
    const markup = render(
      <Field className="gap-s">
        <FieldLabel className="text-body-m">Nom</FieldLabel>
        <FieldDescription className="text-body-xs">Aide</FieldDescription>
      </Field>,
    );
    expect(tagWithSlot(markup, "field")).toContain("gap-s");
    expect(tagWithSlot(markup, "field")).not.toContain("gap-xs");
    expect(tagWithSlot(markup, "field-label")).toContain("text-body-m");
    expect(tagWithSlot(markup, "field-label")).not.toMatch(/\stext-s\s/);
    expect(tagWithSlot(markup, "field-description")).toContain("text-body-xs");
  });
});
