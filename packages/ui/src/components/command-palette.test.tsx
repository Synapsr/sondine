import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DownloadIcon, LoaderIcon, PauseIcon } from "../icon";
import { Badge } from "./badge";
import {
  CommandPalette,
  CommandPaletteCollection,
  CommandPaletteDialog,
  CommandPaletteDialogPopup,
  CommandPaletteDialogTrigger,
  CommandPaletteEmpty,
  CommandPaletteFooter,
  CommandPaletteGroup,
  CommandPaletteGroupLabel,
  CommandPaletteInput,
  CommandPaletteItem,
  CommandPaletteList,
  type CommandPaletteProps,
  CommandPaletteSeparator,
  CommandPaletteStatus,
} from "./command-palette";
import { Kbd } from "./kbd";

interface Command {
  value: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
}

interface Group {
  value: string;
  items: Command[];
}

const groups: Group[] = [
  {
    value: "Actions",
    items: [
      { value: "pause", label: "Mettre en pause l’écoute", shortcut: "⌥⌘P" },
      { value: "export", label: "Exporter la conversation", disabled: true },
    ],
  },
  {
    value: "Conversations",
    items: [{ value: "daily", label: "Point quotidien" }],
  },
];

function element(markup: string, slot: string): string {
  const match = markup.match(new RegExp(`<[a-z]+[^>]*data-slot="${slot}"[^>]*>`));
  if (!match) throw new Error(`no element with data-slot="${slot}" in ${markup}`);
  return match[0];
}

function elements(markup: string, slot: string): string[] {
  return markup.match(new RegExp(`<[a-z]+[^>]*data-slot="${slot}"[^>]*>`, "g")) ?? [];
}

/** Whether the tag has the attribute (class values such as "data-disabled:…" do not count). */
function hasAttribute(tag: string, name: string): boolean {
  return new RegExp(`\\s${name}(=|\\s|/?>)`).test(tag);
}

function attribute(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
}

type RenderProps = Omit<CommandPaletteProps<Command>, "items" | "children">;

function renderPalette(props: RenderProps = {}, withIcons = true) {
  return renderToStaticMarkup(
    <CommandPalette items={groups} {...props}>
      <CommandPaletteInput aria-label="Rechercher une commande" placeholder="Rechercher" />
      <CommandPaletteEmpty>Aucun résultat</CommandPaletteEmpty>
      <CommandPaletteList>
        {(group: Group, index: number) => (
          <div key={group.value}>
            {index > 0 ? <CommandPaletteSeparator /> : null}
            <CommandPaletteGroup items={group.items}>
              <CommandPaletteGroupLabel>{group.value}</CommandPaletteGroupLabel>
              <CommandPaletteCollection>
                {(command: Command) => (
                  <CommandPaletteItem
                    key={command.value}
                    value={command}
                    disabled={command.disabled}
                    shortcut={command.shortcut}
                    icon={
                      withIcons ? command.disabled ? <DownloadIcon /> : <PauseIcon /> : undefined
                    }
                    description={command.value === "daily" ? "Zoom · Camille, Hugo" : undefined}
                    trailing={
                      command.value === "daily" ? <Badge variant="success">Transcrite</Badge> : null
                    }
                  >
                    {command.label}
                  </CommandPaletteItem>
                )}
              </CommandPaletteCollection>
            </CommandPaletteGroup>
          </div>
        )}
      </CommandPaletteList>
      <CommandPaletteFooter>
        <span>
          <Kbd>↵</Kbd>
          Ouvrir
        </span>
      </CommandPaletteFooter>
    </CommandPalette>,
  );
}

describe("CommandPalette", () => {
  it("renders the search field with the Autocomplete input part on its group", () => {
    const markup = renderPalette();
    const group = element(markup, "command-palette-input-group");
    for (const token of [
      "corner-s",
      "bg-neutral-3",
      "p-s",
      "ring-s",
      "ring-neutral-4",
      "text-body-s",
      "has-[[data-slot=command-palette-input]:focus-visible]:ring-color-1",
      "not-has-[[data-slot=command-palette-input]:focus-visible]:control-hover:ring-neutral-5",
      "control-disabled:bg-neutral-2",
      "control-disabled:text-neutral-6",
    ]) {
      expect(group).toContain(token);
    }
    expect(group).toContain(
      "has-[[data-slot=command-palette-input]:focus-visible]:focus-ring-within",
    );
    const input = element(markup, "command-palette-input");
    expect(input).toMatch(/^<input/);
    expect(input).toContain('role="combobox"');
    expect(input).toContain('aria-label="Rechercher une commande"');
    expect(input).toContain("bg-transparent");
    expect(input).toContain("outline-none");
    expect(input).toContain("placeholder:text-cte-text-muted");
    expect(element(markup, "command-palette-input-icon")).toContain("text-cte-text-muted");
    expect(markup).toContain('data-slot="icon"');
  });

  // aria-controls needs the mounted list element, so it is not in server markup.
  it("keeps the list open inline", () => {
    const markup = renderPalette();
    const input = element(markup, "command-palette-input");
    const list = element(markup, "command-palette-list");
    expect(list).toContain('role="listbox"');
    expect(attribute(input, "aria-expanded")).toBe("true");
    expect(list).toContain("group/command-palette-list");
    expect(list).toContain("overflow-y-auto");
    expect(list).toContain("not-data-empty:mt-xs");
  });

  it("renders groups with Menu labels and separators", () => {
    const markup = renderPalette();
    expect(elements(markup, "command-palette-group")).toHaveLength(2);
    const label = element(markup, "command-palette-group-label");
    for (const token of ["px-xs", "pt-xs", "font-medium", "text-body-xs", "text-neutral-6"]) {
      expect(label).toContain(token);
    }
    expect(markup).toContain(">Actions</div>");
    const separators = elements(markup, "command-palette-separator");
    expect(separators).toHaveLength(1);
    // Inside the listbox the line is presentational.
    expect(separators[0]).toContain('role="presentation"');
    expect(separators[0]).toContain("inset-shadow-[0_1px_0_0_var(--neutral-4)]");
  });

  it("renders rows with the option part, the icon column, descriptions, badges and shortcuts", () => {
    const markup = renderPalette();
    const items = elements(markup, "command-palette-item");
    expect(items).toHaveLength(3);
    const [first, disabled] = items;
    for (const token of [
      "grid",
      "corner-s",
      "p-xs",
      "gap-xs",
      "not-data-disabled:data-highlighted:bg-neutral-3",
      "data-disabled:text-neutral-6",
      "group-has-[[data-slot=command-palette-item-icon]]/command-palette-list:grid-cols-[1em_minmax(0,1fr)_auto]",
    ]) {
      expect(first).toContain(token);
    }
    expect(first).not.toMatch(/\sflex\s/);
    expect(first).toContain('role="option"');
    expect(hasAttribute(disabled ?? "", "data-disabled")).toBe(true);
    expect(attribute(disabled ?? "", "aria-disabled")).toBe("true");
    expect(elements(markup, "command-palette-item-icon")).toHaveLength(3);
    const shortcut = element(markup, "command-palette-item-shortcut");
    expect(shortcut).toMatch(/^<kbd/);
    expect(shortcut).toContain("text-neutral-6");
    expect(shortcut).toContain("text-body-xs");
    expect(markup).toContain("⌥⌘P</kbd>");
    expect(element(markup, "command-palette-item-trailing")).toContain("ms-s");
    expect(element(markup, "command-palette-item-description")).toContain("text-cte-text-muted");
    expect(markup).toContain("Zoom · Camille, Hugo");
    expect(markup).toContain('data-slot="badge"');
  });

  it("omits the trailing cell and the icon column when a row has neither", () => {
    const markup = renderPalette({}, false);
    expect(markup).not.toContain('data-slot="command-palette-item-icon"');
    const items = elements(markup, "command-palette-item");
    const exportRow = markup.slice(
      markup.indexOf(items[1] ?? ""),
      markup.indexOf(items[2] ?? "") - 1,
    );
    expect(exportRow).not.toContain("command-palette-item-trailing");
  });

  it("shows the empty message only when nothing matches", () => {
    const withResults = renderPalette();
    expect(withResults).not.toContain("Aucun résultat");
    expect(element(withResults, "command-palette-empty")).toContain("not-empty:mt-xs");
    const empty = renderPalette({ defaultValue: "Webex" });
    expect(empty).toContain("Aucun résultat");
    expect(empty).not.toContain('data-slot="command-palette-item"');
    expect(hasAttribute(element(empty, "command-palette-list"), "data-empty")).toBe(true);
    expect(element(empty, "autocomplete-empty-message")).toContain("text-neutral-7");
  });

  it("disables the field and every row", () => {
    const markup = renderPalette({ disabled: true });
    expect(hasAttribute(element(markup, "command-palette-input-group"), "data-disabled")).toBe(
      true,
    );
    const input = element(markup, "command-palette-input");
    expect(input).toMatch(/\sdisabled=""/);
    for (const item of elements(markup, "command-palette-item")) {
      expect(hasAttribute(item, "data-disabled")).toBe(true);
    }
  });

  it("renders the status message only while it has content", () => {
    const idle = renderToStaticMarkup(
      <CommandPalette items={[]}>
        <CommandPaletteStatus />
      </CommandPalette>,
    );
    expect(element(idle, "command-palette-status")).toBeTruthy();
    expect(idle).not.toContain("command-palette-status-message");
    const searching = renderToStaticMarkup(
      <CommandPalette items={[]}>
        <CommandPaletteStatus>
          <LoaderIcon />
          Recherche…
        </CommandPaletteStatus>
      </CommandPalette>,
    );
    const message = element(searching, "command-palette-status-message");
    expect(message).toContain("text-neutral-7");
    expect(message).toContain("py-s");
    expect(searching).toContain("Recherche…");
  });

  it("renders the footer with detail typography and a full-width line", () => {
    const footer = element(renderPalette(), "command-palette-footer");
    for (const token of [
      "text-body-xs",
      "text-cte-text-muted",
      "pt-xs",
      "before:-inset-x-xs",
      "before:inset-shadow-[0_1px_0_0_var(--neutral-4)]",
    ]) {
      expect(footer).toContain(token);
    }
  });
});

describe("CommandPaletteDialog", () => {
  it("opens from an outline Button trigger", () => {
    const markup = renderToStaticMarkup(
      <CommandPaletteDialog>
        <CommandPaletteDialogTrigger>Rechercher</CommandPaletteDialogTrigger>
        <CommandPaletteDialogPopup aria-label="Palette de commandes" />
      </CommandPaletteDialog>,
    );
    const trigger = element(markup, "command-palette-dialog-trigger");
    expect(trigger).toMatch(/^<button/);
    expect(trigger).toContain('data-variant="outline"');
    expect(trigger).toContain('aria-haspopup="dialog"');
    expect(attribute(trigger, "aria-expanded")).toBe("false");
  });

  it("accepts another Button variant and disables the trigger", () => {
    const trigger = element(
      renderToStaticMarkup(
        <CommandPaletteDialog>
          <CommandPaletteDialogTrigger variant="ghost" disabled>
            Rechercher
          </CommandPaletteDialogTrigger>
        </CommandPaletteDialog>,
      ),
      "command-palette-dialog-trigger",
    );
    expect(trigger).toContain('data-variant="ghost"');
    expect(hasAttribute(trigger, "data-disabled")).toBe(true);
  });
});
