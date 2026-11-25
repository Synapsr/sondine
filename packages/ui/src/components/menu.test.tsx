import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EllipsisIcon, PenIcon } from "../icon";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./menu";

function attributesOf(markup: string): string {
  return markup.slice(0, markup.indexOf(">"));
}

// Popups are portalled and need a DOM, so these render parts under a bare
// Root; open, highlight, submenu and positioning behaviour is checked in the
// browser on the design-system page.
function inMenu(children: ReactNode): string {
  return renderToStaticMarkup(<Menu>{children}</Menu>);
}

describe("MenuTrigger", () => {
  it("renders the outline Sondine Button with menu semantics", () => {
    const root = attributesOf(
      renderToStaticMarkup(
        <Menu>
          <MenuTrigger>Trier par</MenuTrigger>
          <MenuPopup>
            <MenuItem>Date</MenuItem>
          </MenuPopup>
        </Menu>,
      ),
    );
    expect(root).toMatch(/^<button/);
    expect(root).toContain('data-slot="menu-trigger"');
    expect(root).toContain('data-variant="outline"');
    expect(root).toContain('aria-haspopup="menu"');
    expect(root).toContain('aria-expanded="false"');
    expect(root).toContain("ring-s ring-neutral-4-transparent");
    expect(root).toContain("control-hover:bg-neutral-3");
    expect(root).toContain("control-focus:ring-color-1-transparent");
    expect(root).toContain("control-disabled:text-neutral-6");
    expect(root).toContain("px-l py-s");
    expect(root).toContain("focus-ring");
  });

  it("forwards the button variant and size", () => {
    const root = attributesOf(
      inMenu(
        <MenuTrigger variant="ghost" size="icon" aria-label="Actions de l’écoute">
          <EllipsisIcon />
        </MenuTrigger>,
      ),
    );
    expect(root).toContain('data-variant="ghost"');
    expect(root).toContain('data-size="icon"');
    expect(root).toContain('aria-label="Actions de l’écoute"');
    expect(root).toContain("p-s");
  });

  it("disables the native button", () => {
    const root = attributesOf(inMenu(<MenuTrigger disabled>Exporter</MenuTrigger>));
    expect(root).toMatch(/\sdisabled(=|\s|$)/);
    expect(root).toContain("data-disabled");
  });

  it("keeps a caller's render element", () => {
    const root = attributesOf(inMenu(<MenuTrigger render={<span />}>Plus</MenuTrigger>));
    expect(root).toMatch(/^<span/);
    expect(root).toContain('data-slot="menu-trigger"');
    expect(root).not.toContain("data-variant");
  });
});

describe("MenuItem", () => {
  it("lays out icon, label and shortcut cells with the option tokens", () => {
    const markup = inMenu(
      <MenuItem icon={<PenIcon />} shortcut="⌘R">
        Renommer
      </MenuItem>,
    );
    const root = attributesOf(markup);
    expect(root).toContain('role="menuitem"');
    expect(root).toContain('data-slot="menu-item"');
    expect(root).toContain('data-variant="default"');
    for (const token of [
      "corner-xs",
      "p-xs",
      "gap-xs",
      "font-regular",
      "text-body-s",
      "text-neutral-10",
      "whitespace-nowrap",
      "not-data-disabled:data-highlighted:bg-neutral-3",
      "not-data-disabled:data-checked:bg-neutral-3",
      "not-data-disabled:data-popup-open:bg-neutral-3",
      "data-disabled:text-neutral-6",
      "group-has-[[data-slot=menu-item-icon]]/menu:grid-cols-[1em_minmax(0,1fr)_auto]",
    ]) {
      expect(root).toContain(token);
    }
    expect(markup).toMatch(
      /data-slot="menu-item-icon"[^>]*size-\[1em\][^>]*><svg[^>]*data-slot="icon"/,
    );
    expect(markup).toContain('data-slot="menu-item-label"');
    expect(markup).toMatch(
      /<kbd data-slot="menu-item-shortcut" class="[^"]*ms-s[^"]*text-body-xs text-neutral-6[^"]*">⌘R<\/kbd>/,
    );
  });

  it("renders only a label when there is no icon or shortcut", () => {
    const markup = inMenu(<MenuItem>Texte brut</MenuItem>);
    expect(markup).not.toContain('data-slot="menu-item-icon"');
    expect(markup).not.toContain("<kbd");
    expect(markup).toContain(">Texte brut</span>");
  });

  it("uses the error foreground for the danger variant and keeps disabled distinct", () => {
    const danger = attributesOf(inMenu(<MenuItem variant="danger">Supprimer</MenuItem>));
    expect(danger).toContain('data-variant="danger"');
    expect(danger).toContain("text-error");
    expect(danger).not.toContain("text-neutral-10");

    const disabled = attributesOf(
      inMenu(
        <MenuItem variant="danger" disabled>
          Supprimer
        </MenuItem>,
      ),
    );
    expect(disabled).toContain("data-disabled");
    expect(disabled).toContain('aria-disabled="true"');
    expect(disabled).toContain("data-disabled:text-neutral-6");
  });

  it("supports a className function of the state", () => {
    const root = attributesOf(
      inMenu(
        <MenuItem disabled className={(state) => (state.disabled ? "is-off" : "is-on")}>
          Fusionner
        </MenuItem>,
      ),
    );
    expect(root).toContain("is-off");
    expect(root).toContain("p-xs");
  });
});

describe("MenuCheckboxItem and MenuRadioItem", () => {
  it("shows a checked check at the row's end, after its detail", () => {
    const markup = inMenu(
      <MenuCheckboxItem defaultChecked detail={4}>
        Afficher les résumés
      </MenuCheckboxItem>,
    );
    const root = attributesOf(markup);
    expect(root).toContain('role="menuitemcheckbox"');
    expect(root).toContain('aria-checked="true"');
    expect(root).toContain("data-checked");
    expect(root).toContain('data-slot="menu-checkbox-item"');
    expect(markup).not.toContain('data-slot="menu-item-icon"');
    expect(markup).toMatch(
      /data-slot="menu-item-trailing"[^>]*><span data-slot="menu-item-detail"[^>]*ms-s tabular-nums[^>]*>4<\/span><span class="flex size-\[1em\][^>]*><span[^>]*data-slot="menu-checkbox-item-indicator"[^>]*text-neutral-10 data-disabled:text-neutral-6/,
    );
    expect(markup).toContain('points="4 11 8 15 16 5"');
  });

  it("keeps the check's room when unchecked, and no icon column", () => {
    const markup = inMenu(<MenuCheckboxItem shortcut="⌘T">Horodatage</MenuCheckboxItem>);
    expect(attributesOf(markup)).toContain('aria-checked="false"');
    expect(markup).not.toContain('data-slot="menu-item-icon"');
    expect(markup).toContain('class="flex size-[1em] items-center justify-center"');
    expect(markup).not.toContain('data-slot="menu-checkbox-item-indicator"');
    expect(markup).toContain(">⌘T</kbd>");
  });

  it("checks the selected radio item only", () => {
    const markup = inMenu(
      <MenuRadioGroup defaultValue="date">
        <MenuRadioItem value="date">Date</MenuRadioItem>
        <MenuRadioItem value="app" disabled>
          Application
        </MenuRadioItem>
      </MenuRadioGroup>,
    );
    expect(markup).toContain('data-slot="menu-radio-group"');
    const items = markup.split('role="menuitemradio"');
    expect(items).toHaveLength(3);
    expect(items[1]).toContain('aria-checked="true"');
    expect(items[1]).toContain("menu-radio-item-indicator");
    expect(items[2]).toContain('aria-checked="false"');
    expect(items[2]).not.toContain("menu-radio-item-indicator");
    expect(markup).toMatch(/data-disabled=""[^>]*role="menuitemradio"[^>]*aria-disabled="true"/);
  });
});

describe("MenuGroupLabel and MenuSeparator", () => {
  it("styles the group label with the label tokens and layout padding", () => {
    const markup = inMenu(
      <MenuGroup>
        <MenuGroupLabel>Conversation</MenuGroupLabel>
      </MenuGroup>,
    );
    expect(markup).toContain('data-slot="menu-group"');
    expect(markup).toMatch(
      /data-slot="menu-group-label" class="px-xs pt-xs pb-xxs font-body font-medium text-body-xs text-neutral-6/,
    );
  });

  it("draws the separator as a 1px inset edge with XXS margins", () => {
    const root = attributesOf(inMenu(<MenuSeparator />));
    expect(root).toContain('role="separator"');
    expect(root).toContain('data-slot="menu-separator"');
    expect(root).toContain("my-xxs h-px");
    expect(root).toContain("inset-shadow-[0_1px_0_0_var(--neutral-4)]");
  });
});
