import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "./button";
import { Field, FieldError, FieldLabel } from "./field";
import { Form, FormStatus } from "./form";
import { Input } from "./input";

function tagWithSlot(markup: string, slot: string): string {
  const match = markup.match(new RegExp(`<[a-z]+[^>]*data-slot="${slot}"[^>]*>`));
  expect(match, slot).not.toBeNull();
  return match?.[0] ?? "";
}

describe("Form", () => {
  it("renders a native form stacking its fields with the M gap", () => {
    const markup = renderToStaticMarkup(
      <Form aria-label="Ajouter une personne">
        <Field name="name">
          <FieldLabel>Nom</FieldLabel>
          <Input required />
        </Field>
        <Button type="submit">Enregistrer</Button>
      </Form>,
    );
    const form = tagWithSlot(markup, "form");
    expect(form).toMatch(/^<form/);
    expect(form).toContain("flex-col");
    expect(form).toContain("gap-m");
    // Base UI validates fields itself and reports them through Field.Error.
    expect(form).toContain("noValidate");
    expect(form).toContain('aria-label="Ajouter une personne"');
  });

  it("keeps the submit button's type and primary styling", () => {
    const markup = renderToStaticMarkup(
      <Form>
        <Button type="submit">Enregistrer</Button>
      </Form>,
    );
    const button = tagWithSlot(markup, "button");
    expect(button).toContain('type="submit"');
    expect(button).toContain('data-variant="primary"');
    expect(button).toContain("bg-color-1");
  });

  it("shows errors passed by the app for a named field", () => {
    const markup = renderToStaticMarkup(
      <Form errors={{ email: "Cette adresse est déjà utilisée." }}>
        <Field name="email">
          <FieldLabel>Adresse e-mail</FieldLabel>
          <Input type="email" defaultValue="camille@exemple.fr" />
          <FieldError />
        </Field>
      </Form>,
    );
    expect(tagWithSlot(markup, "field")).toContain('data-invalid=""');
    expect(tagWithSlot(markup, "input")).toContain('aria-invalid="true"');
    expect(markup).toContain("Cette adresse est déjà utilisée.");
  });

  it("supports typed form values", () => {
    const markup = renderToStaticMarkup(
      <Form<{ name: string }> onFormSubmit={(values) => values.name.trim()} className="gap-l">
        <Field name="name">
          <Input />
        </Field>
      </Form>,
    );
    expect(tagWithSlot(markup, "form")).toContain("gap-l");
    expect(tagWithSlot(markup, "form")).not.toContain("gap-m");
  });
});

describe("FormStatus", () => {
  it("is a polite status with the description typography", () => {
    const status = tagWithSlot(
      renderToStaticMarkup(<FormStatus>Camille Martin a été ajoutée.</FormStatus>),
      "form-status",
    );
    expect(status).toMatch(/^<p/);
    expect(status).toContain('role="status"');
    for (const token of ["font-regular", "text-body-s", "text-neutral-7"]) {
      expect(status).toContain(token);
    }
  });
});
