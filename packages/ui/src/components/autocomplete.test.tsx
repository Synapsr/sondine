import { Field } from "@base-ui/react/field";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteLabel,
  AutocompleteList,
  type AutocompleteProps,
} from "./autocomplete";

interface Suggestion {
  id: string;
  value: string;
  disabled?: boolean;
}

const suggestions: Suggestion[] = [
  { id: "zoom", value: "Appel Zoom de lundi" },
  { id: "budget", value: "Budget 2027" },
  { id: "train", value: "Notes du trajet en train", disabled: true },
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

function renderInput(props: Omit<AutocompleteProps<Suggestion>, "children"> = {}) {
  return renderToStaticMarkup(
    <Autocomplete items={suggestions} {...props}>
      <AutocompleteLabel>Recherche</AutocompleteLabel>
      <AutocompleteInput placeholder="Rechercher dans vos conversations" />
    </Autocomplete>,
  );
}

// `inline` renders the list without a portal, so options render on the server.
function renderList(props: Omit<AutocompleteProps<Suggestion>, "children"> = {}) {
  return renderToStaticMarkup(
    <Autocomplete items={suggestions} inline open {...props}>
      <AutocompleteEmpty>Aucune conversation ne correspond</AutocompleteEmpty>
      <AutocompleteList>
        {(suggestion: Suggestion) => (
          <AutocompleteItem key={suggestion.id} value={suggestion} disabled={suggestion.disabled}>
            {suggestion.value}
          </AutocompleteItem>
        )}
      </AutocompleteList>
    </Autocomplete>,
  );
}

describe("Autocomplete", () => {
  it("links the native label to the input", () => {
    const markup = renderInput();
    const label = element(markup, "autocomplete-label");
    expect(label).toMatch(/^<label/);
    expect(attribute(label, "for")).toBeTruthy();
    expect(attribute(label, "for")).toBe(attribute(element(markup, "autocomplete-input"), "id"));
    const named = renderInput({ id: "search" });
    expect(attribute(element(named, "autocomplete-input"), "id")).toBe("search");
    expect(attribute(element(named, "autocomplete-label"), "for")).toBe("search");
  });

  it("styles the input with the input part's tokens", () => {
    const markup = renderInput({ defaultValue: "Budget 2027" });
    const input = element(markup, "autocomplete-input");
    expect(input).toMatch(/^<input/);
    expect(input).toContain('role="combobox"');
    expect(input).toContain('value="Budget 2027"');
    for (const token of [
      "w-full",
      "corner-s",
      "bg-neutral-3",
      "p-s",
      "ring-s",
      "ring-neutral-4",
      "font-regular",
      "placeholder:text-cte-text-muted",
      "focus-ring",
      "not-data-invalid:control-focus:ring-color-1",
      "control-disabled:bg-neutral-2",
    ]) {
      expect(input).toContain(token);
    }
    expect(element(markup, "autocomplete-label")).toContain("font-medium");
  });

  it("disables the input and dims the label", () => {
    const markup = renderInput({ disabled: true });
    const input = element(markup, "autocomplete-input");
    expect(hasAttribute(input, "data-disabled")).toBe(true);
    expect(input).toMatch(/\sdisabled=""/);
    expect(hasAttribute(element(markup, "autocomplete-label"), "data-disabled")).toBe(true);
  });

  it("exposes a Field's invalid state on the input", () => {
    const markup = renderToStaticMarkup(
      <Field.Root invalid>
        <Autocomplete items={suggestions}>
          <AutocompleteInput />
        </Autocomplete>
      </Field.Root>,
    );
    const input = element(markup, "autocomplete-input");
    expect(hasAttribute(input, "data-invalid")).toBe(true);
    expect(input).toContain("data-invalid:ring-error");
  });

  it("renders options without a selection check", () => {
    const markup = renderList();
    const items = markup.match(/<div[^>]*data-slot="autocomplete-item"[^>]*>/g) ?? [];
    expect(items).toHaveLength(3);
    expect(hasAttribute(items[2] ?? "", "data-disabled")).toBe(true);
    for (const token of [
      "corner-s",
      "p-xs",
      "not-data-disabled:data-highlighted:bg-neutral-3",
      "data-disabled:text-neutral-6",
    ]) {
      expect(items[0]).toContain(token);
    }
    expect(markup).not.toContain("indicator");
    expect(hasAttribute(markup, "data-selected")).toBe(false);
  });

  it("keeps the empty live region mounted and pads only its message", () => {
    const empty = renderList({ defaultValue: "Webex" });
    const region = element(empty, "autocomplete-empty");
    expect(region).toContain('role="status"');
    expect(region).not.toContain("class=");
    const message = element(empty, "autocomplete-empty-message");
    expect(message).toContain("py-s");
    expect(message).toContain("px-xs");
    expect(message).toContain("text-neutral-7");
    expect(empty).toContain(">Aucune conversation ne correspond<");
    const matches = renderList({ defaultValue: "zoom" });
    expect(matches).toContain('data-slot="autocomplete-empty"');
    expect(matches).not.toContain("autocomplete-empty-message");
    expect(matches.match(/data-slot="autocomplete-item"/g)).toHaveLength(1);
  });
});
