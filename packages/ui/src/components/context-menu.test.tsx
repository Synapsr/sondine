import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TrashIcon } from "../icon";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuGroup,
  ContextMenuGroupLabel,
  ContextMenuItem,
  ContextMenuPopup,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./context-menu";

function attributesOf(markup: string): string {
  return markup.slice(0, markup.indexOf(">"));
}

describe("ContextMenuTrigger", () => {
  it("renders a focusable region with the trigger tokens", () => {
    const root = attributesOf(
      renderToStaticMarkup(
        <ContextMenu>
          <ContextMenuTrigger>Point hebdo avec Camille</ContextMenuTrigger>
          <ContextMenuPopup>
            <ContextMenuItem>Ouvrir</ContextMenuItem>
          </ContextMenuPopup>
        </ContextMenu>,
      ),
    );
    expect(root).toMatch(/^<div/);
    expect(root).toContain('data-slot="context-menu-trigger"');
    expect(root).toContain('tabindex="0"');
    expect(root).not.toContain("data-disabled");
    for (const token of [
      "corner-s",
      "bg-neutral-1",
      "px-s py-xs",
      "font-medium",
      "text-body-s",
      "ring-s ring-neutral-4",
      "not-data-popup-open:control-hover:bg-neutral-2",
      "not-data-popup-open:control-hover:ring-neutral-5",
      "control-focus:ring-color-1",
      "data-popup-open:bg-neutral-3",
      "control-disabled:bg-neutral-2 control-disabled:text-neutral-6",
      "focus-ring",
    ]) {
      expect(root).toContain(token);
    }
  });

  it("takes the disabled state from the root and leaves the tab order", () => {
    const root = attributesOf(
      renderToStaticMarkup(
        <ContextMenu disabled>
          <ContextMenuTrigger>Point hebdo avec Camille</ContextMenuTrigger>
        </ContextMenu>,
      ),
    );
    expect(root).toContain('data-disabled=""');
    expect(root).not.toContain("tabindex");
  });

  it("lets the caller override focusability and classes", () => {
    const root = attributesOf(
      renderToStaticMarkup(
        <ContextMenu>
          <ContextMenuTrigger tabIndex={-1} className="w-[280px]">
            Segment
          </ContextMenuTrigger>
        </ContextMenu>,
      ),
    );
    expect(root).toContain('tabindex="-1"');
    expect(root).toContain("w-[280px]");
    expect(root).toContain("bg-neutral-1");
  });
});

describe("context menu parts", () => {
  it("reuse the Menu option styling with context-menu slots", () => {
    const markup = renderToStaticMarkup(
      <ContextMenu>
        <ContextMenuGroup>
          <ContextMenuGroupLabel>Conversation</ContextMenuGroupLabel>
          <ContextMenuItem variant="danger" icon={<TrashIcon />} shortcut="⌘⌫">
            Supprimer
          </ContextMenuItem>
          <ContextMenuCheckboxItem defaultChecked>Épinglée</ContextMenuCheckboxItem>
        </ContextMenuGroup>
        <ContextMenuSeparator />
      </ContextMenu>,
    );
    expect(markup).toContain('data-slot="context-menu-group"');
    expect(markup).toMatch(/data-slot="context-menu-group-label" class="px-xs pt-xs pb-xxs/);
    expect(markup).toMatch(
      /role="menuitem"[^>]*data-slot="context-menu-item"[^>]*data-variant="danger"/,
    );
    expect(markup).toContain("text-error");
    expect(markup).toContain('data-slot="menu-item-icon"');
    expect(markup).toContain(">⌘⌫</kbd>");
    expect(markup).toMatch(/aria-checked="true"[^>]*data-slot="context-menu-checkbox-item"/);
    expect(markup).toMatch(/data-slot="context-menu-separator" class="my-xxs h-px/);
  });
});
