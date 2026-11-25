import { Field } from "@base-ui/react/field";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxInputGroup,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  type ComboboxProps,
  ComboboxTrigger,
} from "./combobox";

interface Person {
  value: string;
  label: string;
  disabled?: boolean;
}

const camille: Person = { value: "camille", label: "Camille Martin" };
const people: Person[] = [
  camille,
  { value: "lea", label: "Léa Bernard" },
  { value: "thomas", label: "Thomas Dubois", disabled: true },
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

function attribute(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
}

function renderField(props: Omit<ComboboxProps<Person>, "children"> = {}) {
  return renderToStaticMarkup(
    <Combobox items={people} {...props}>
      <ComboboxLabel>Attribuer à</ComboboxLabel>
      <ComboboxInputGroup>
        <ComboboxInput placeholder="Rechercher une personne" />
        <ComboboxTrigger aria-label="Afficher les personnes" />
      </ComboboxInputGroup>
    </Combobox>,
  );
}

// `inline` renders the list without a portal, so options render on the server.
function renderList(props: Omit<ComboboxProps<Person>, "children"> = {}) {
  return renderToStaticMarkup(
    <Combobox items={people} inline open {...props}>
      <ComboboxEmpty>Aucune personne trouvée</ComboboxEmpty>
      <ComboboxList>
        {(person: Person) => (
          <ComboboxItem key={person.value} value={person} disabled={person.disabled}>
            {person.label}
          </ComboboxItem>
        )}
      </ComboboxList>
    </Combobox>,
  );
}

describe("Combobox", () => {
  it("links the native label to the input", () => {
    const markup = renderField();
    const label = element(markup, "combobox-label");
    const input = element(markup, "combobox-input");
    expect(label).toMatch(/^<label/);
    expect(attribute(label, "for")).toBeTruthy();
    expect(attribute(label, "for")).toBe(attribute(input, "id"));
  });

  it("keeps an explicit id and htmlFor", () => {
    const markup = renderField({ id: "assignee" });
    expect(attribute(element(markup, "combobox-input"), "id")).toBe("assignee");
    expect(attribute(element(markup, "combobox-label"), "for")).toBe("assignee");
    const own = renderToStaticMarkup(
      <Combobox items={people}>
        <ComboboxLabel htmlFor="elsewhere">Attribuer à</ComboboxLabel>
      </Combobox>,
    );
    expect(attribute(element(own, "combobox-label"), "for")).toBe("elsewhere");
  });

  it("paints the input part on the field and leaves the input bare", () => {
    const markup = renderField({ defaultValue: camille });
    const group = element(markup, "combobox-input-group");
    for (const token of [
      "corner-s",
      "bg-neutral-3",
      "px-m",
      "py-s",
      "ring-s",
      "ring-neutral-4",
      "text-body-s",
      "has-[[data-slot=combobox-input]:focus-visible]:focus-ring-within",
      "not-data-invalid:has-[[data-slot=combobox-input]:focus-visible]:ring-color-1-transparent",
      "control-disabled:ring-neutral-4-transparent",
    ]) {
      expect(group).toContain(token);
    }
    const input = element(markup, "combobox-input");
    expect(input).toContain('value="Camille Martin"');
    expect(input).toContain("bg-transparent");
    expect(input).toContain("p-0");
    expect(input).toContain("placeholder:text-current/45");
    expect(input).not.toContain("corner-s");
  });

  it("renders a named trigger with a chevron", () => {
    const markup = renderField();
    const trigger = element(markup, "combobox-trigger");
    expect(trigger).toMatch(/^<button/);
    expect(trigger).toContain('aria-label="Afficher les personnes"');
    expect(trigger).toContain("min-h-[1.5em]");
    expect(trigger).toContain("focus-ring");
    expect(markup).toMatch(/data-slot="combobox-trigger"[^>]*><svg[^>]*data-slot="icon"/);
  });

  it("disables the field and dims the label", () => {
    const markup = renderField({ disabled: true });
    expect(hasAttribute(element(markup, "combobox-input-group"), "data-disabled")).toBe(true);
    expect(element(markup, "combobox-input")).toMatch(/\sdisabled=""/);
    expect(hasAttribute(element(markup, "combobox-label"), "data-disabled")).toBe(true);
    expect(hasAttribute(element(renderField(), "combobox-label"), "data-disabled")).toBe(false);
  });

  it("exposes a Field's invalid state on the field", () => {
    const markup = renderToStaticMarkup(
      <Field.Root invalid>
        <Combobox items={people}>
          <ComboboxInputGroup>
            <ComboboxInput />
          </ComboboxInputGroup>
        </Combobox>
      </Field.Root>,
    );
    const group = element(markup, "combobox-input-group");
    expect(hasAttribute(group, "data-invalid")).toBe(true);
    expect(group).toContain("data-invalid:bg-error-transparent");
  });

  it("renders options with the option part's tokens and a check on the selected one", () => {
    const markup = renderList({ defaultValue: camille });
    const items = markup.match(/<div[^>]*data-slot="combobox-item"[^>]*>/g) ?? [];
    expect(items).toHaveLength(3);
    const [selected = "", rest = "", disabled = ""] = items;
    expect(hasAttribute(selected, "data-selected")).toBe(true);
    expect(selected).toContain('aria-selected="true"');
    expect(hasAttribute(rest, "data-selected")).toBe(false);
    expect(hasAttribute(disabled, "data-disabled")).toBe(true);
    for (const token of [
      "p-xs",
      "corner-xs",
      "not-data-disabled:data-highlighted:bg-neutral-3",
      "not-data-disabled:not-data-highlighted:data-selected:bg-neutral-2",
      "data-disabled:text-neutral-6",
    ]) {
      expect(rest).toContain(token);
    }
    expect(markup.match(/data-slot="combobox-item-indicator"/g)).toHaveLength(1);
    expect(element(markup, "combobox-item-indicator")).toContain("ms-xs");
    expect(element(markup, "combobox-list")).toContain("gap-xxs");
  });

  it("shows the empty message only when nothing matches", () => {
    const empty = renderList({ defaultInputValue: "Zoé" });
    expect(empty).toMatch(/data-slot="combobox-empty"[^>]*>Aucune personne trouvée</);
    expect(element(empty, "combobox-empty")).toContain('role="status"');
    expect(element(empty, "combobox-empty")).toContain("not-empty:p-s");
    expect(empty).not.toContain('data-slot="combobox-item"');
    const matches = renderList({ defaultInputValue: "Léa" });
    expect(matches).toMatch(/data-slot="combobox-empty"[^>]*><\/div>/);
    expect(matches.match(/data-slot="combobox-item"/g)).toHaveLength(1);
  });
});
