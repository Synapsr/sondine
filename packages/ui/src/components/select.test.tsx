import { Field } from "@base-ui/react/field";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Select,
  SelectItem,
  SelectLabel,
  SelectPopup,
  type SelectProps,
  SelectTrigger,
  SelectValue,
} from "./select";

const languages = [
  { value: "fr", label: "Français" },
  { value: "en", label: "Anglais" },
];

function element(markup: string, slot: string): string {
  const match = markup.match(new RegExp(`<[a-z]+[^>]*data-slot="${slot}"[^>]*>`));
  if (!match) throw new Error(`no element with data-slot="${slot}" in ${markup}`);
  return match[0];
}

/** Whether the tag has the attribute (class values such as "data-disabled:…" do not count). */
function hasAttribute(tag: string, name: string): boolean {
  return new RegExp(`\\s${name}(=|\\s|/?>)`).test(tag);
}

function renderSelect(props: Omit<SelectProps<string>, "children"> = {}, placeholder?: string) {
  return renderToStaticMarkup(
    <Select items={languages} {...props}>
      <SelectLabel>Langue de transcription</SelectLabel>
      <SelectTrigger>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectPopup>
        {languages.map((language) => (
          <SelectItem key={language.value} value={language.value}>
            {language.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>,
  );
}

describe("Select", () => {
  it("shows the selected label before the popup has opened", () => {
    const markup = renderSelect({ defaultValue: "fr" });
    expect(hasAttribute(element(markup, "select-value"), "data-placeholder")).toBe(false);
    expect(markup).toMatch(/data-slot="select-value"[^>]*>Français</);
    // Closed: the popup is not rendered.
    expect(markup).not.toContain("select-popup");
  });

  it("renders the trigger with the control part's tokens and a chevron", () => {
    const markup = renderSelect({ defaultValue: "fr" });
    const trigger = element(markup, "select-trigger");
    expect(trigger).toMatch(/^<button/);
    expect(trigger).toContain('role="combobox"');
    for (const token of [
      "w-full",
      "corner-s",
      "bg-neutral-3",
      "px-m",
      "py-s",
      "gap-xs",
      "font-regular",
      "text-body-s",
      "ring-s",
      "ring-neutral-4",
      "focus-ring",
      "not-data-invalid:not-data-popup-open:control-hover:ring-neutral-5",
      "not-data-invalid:data-popup-open:ring-color-1-transparent",
      "control-disabled:text-neutral-6",
    ]) {
      expect(trigger).toContain(token);
    }
    const icon = element(markup, "select-icon");
    expect(icon).toContain('aria-hidden="true"');
    expect(icon).toContain("shrink-0");
    expect(markup).toMatch(/data-slot="select-icon"[^>]*><svg[^>]*data-slot="icon"/);
  });

  it("styles the label with the label part's tokens", () => {
    const label = element(renderSelect(), "select-label");
    expect(label).toContain("font-medium");
    expect(label).toContain("text-neutral-10");
    expect(label).toContain("data-disabled:text-neutral-6");
    expect(hasAttribute(label, "data-disabled")).toBe(false);
  });

  it("marks the placeholder", () => {
    const markup = renderSelect({}, "Choisir une langue");
    const value = element(markup, "select-value");
    expect(hasAttribute(value, "data-placeholder")).toBe(true);
    expect(value).toContain("data-placeholder:text-current/45");
    expect(markup).toContain(">Choisir une langue<");
    expect(hasAttribute(element(markup, "select-trigger"), "data-placeholder")).toBe(true);
  });

  it("disables the trigger and dims the label", () => {
    const markup = renderSelect({ defaultValue: "fr", disabled: true });
    const trigger = element(markup, "select-trigger");
    expect(hasAttribute(trigger, "data-disabled")).toBe(true);
    expect(trigger).toMatch(/\sdisabled=""/);
    expect(hasAttribute(element(markup, "select-label"), "data-disabled")).toBe(true);
  });

  it("exposes a Field's invalid state on the trigger", () => {
    const markup = renderToStaticMarkup(
      <Field.Root invalid>
        <Select items={languages}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
        </Select>
      </Field.Root>,
    );
    const trigger = element(markup, "select-trigger");
    expect(hasAttribute(trigger, "data-invalid")).toBe(true);
    expect(trigger).toContain("data-invalid:bg-error-transparent");
    expect(trigger).toContain("data-invalid:ring-error");
  });

  it("merges className strings and state functions", () => {
    const markup = renderToStaticMarkup(
      <Select items={languages} disabled>
        <SelectTrigger className={(state) => (state.disabled ? "is-off" : "is-on")}>
          <SelectValue className="font-medium" />
        </SelectTrigger>
      </Select>,
    );
    expect(element(markup, "select-trigger")).toContain("is-off");
    const value = element(markup, "select-value");
    expect(value).toContain("font-medium");
    expect(value).toContain("truncate");
  });
});
