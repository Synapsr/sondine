import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { createContext, use } from "react";
import { mergeClassName } from "../lib/class-name";
import {
  MenuCheckboxItem,
  type MenuCheckboxItemProps,
  MenuGroup,
  MenuGroupLabel,
  type MenuGroupLabelProps,
  type MenuGroupProps,
  MenuItem,
  type MenuItemProps,
  MenuLinkItem,
  type MenuLinkItemProps,
  MenuPopup,
  type MenuPopupProps,
  MenuRadioGroup,
  type MenuRadioGroupProps,
  MenuRadioItem,
  type MenuRadioItemProps,
  MenuSeparator,
  type MenuSeparatorProps,
  MenuSubmenu,
  MenuSubmenuPopup,
  MenuSubmenuTrigger,
  type MenuSubmenuTriggerProps,
} from "./menu";

// Sondine Context menu (gui/components/sondine/context-menu.md). Only the
// trigger region has its own assignments; the popup, options, labels,
// separators and indicators resolve to the Menu parts, so they are reused here
// with context-menu slots. Base UI's context-menu parts are the menu parts
// too, apart from Root, Trigger and Positioner.

// The primitive keeps `disabled` on the root and does not expose it on the
// trigger, which needs it for the disabled look.
const ContextMenuDisabledContext = createContext(false);

// Edges are outer rings at the theme's S border width. Disabled wins, then
// focus or open, then hover.
const contextMenuTriggerClassName = [
  "relative corner-s bg-neutral-1 px-s py-xs text-neutral-10 outline-none",
  "font-body font-medium text-body-s",
  "ring-s ring-neutral-4",
  "transition-[background-color,color,box-shadow] duration-motion ease-motion motion-reduce:transition-none",
  "not-data-popup-open:control-hover:bg-neutral-2 not-data-popup-open:control-hover:ring-neutral-5",
  "control-focus:ring-color-1",
  "data-popup-open:bg-neutral-3",
  "control-disabled:bg-neutral-2 control-disabled:text-neutral-6",
  "focus-ring",
].join(" ");

export type ContextMenuProps = ContextMenuPrimitive.Root.Props;

/** Groups all parts of a context menu. */
export function ContextMenu({ disabled = false, ...props }: ContextMenuProps) {
  return (
    <ContextMenuDisabledContext value={disabled}>
      <ContextMenuPrimitive.Root disabled={disabled} {...props} />
    </ContextMenuDisabledContext>
  );
}

export type ContextMenuTriggerProps = ContextMenuPrimitive.Trigger.Props;

/**
 * The region that opens the menu on secondary click, long press or the
 * keyboard context-menu key. It is focusable by default so the keyboard can
 * reach it; pass `tabIndex={-1}` or render an interactive element instead.
 */
export function ContextMenuTrigger({ className, ...props }: ContextMenuTriggerProps) {
  const disabled = use(ContextMenuDisabledContext);
  return (
    <ContextMenuPrimitive.Trigger
      data-slot="context-menu-trigger"
      data-disabled={disabled ? "" : undefined}
      tabIndex={disabled ? undefined : 0}
      className={mergeClassName(contextMenuTriggerClassName, className)}
      {...props}
    />
  );
}

export type ContextMenuPopupProps = MenuPopupProps;

/**
 * The menu surface, opened at the pointer (or against `anchor`). The Menu
 * popup, with Base UI's context-menu placement defaults.
 */
export function ContextMenuPopup(props: ContextMenuPopupProps) {
  return <MenuPopup data-slot="context-menu-popup" {...props} />;
}

export function ContextMenuItem(props: MenuItemProps) {
  return <MenuItem data-slot="context-menu-item" {...props} />;
}

export function ContextMenuLinkItem(props: MenuLinkItemProps) {
  return <MenuLinkItem data-slot="context-menu-link-item" {...props} />;
}

export function ContextMenuCheckboxItem(props: MenuCheckboxItemProps) {
  return <MenuCheckboxItem data-slot="context-menu-checkbox-item" {...props} />;
}

export function ContextMenuRadioGroup(props: MenuRadioGroupProps) {
  return <MenuRadioGroup data-slot="context-menu-radio-group" {...props} />;
}

export function ContextMenuRadioItem(props: MenuRadioItemProps) {
  return <MenuRadioItem data-slot="context-menu-radio-item" {...props} />;
}

export function ContextMenuGroup(props: MenuGroupProps) {
  return <MenuGroup data-slot="context-menu-group" {...props} />;
}

export function ContextMenuGroupLabel(props: MenuGroupLabelProps) {
  return <MenuGroupLabel data-slot="context-menu-group-label" {...props} />;
}

export function ContextMenuSeparator(props: MenuSeparatorProps) {
  return <MenuSeparator data-slot="context-menu-separator" {...props} />;
}

/** Opens a submenu from a `ContextMenuSubmenuTrigger`. */
export const ContextMenuSubmenu = MenuSubmenu;

export function ContextMenuSubmenuTrigger(props: MenuSubmenuTriggerProps) {
  return <MenuSubmenuTrigger data-slot="context-menu-submenu-trigger" {...props} />;
}

export function ContextMenuSubmenuPopup(props: MenuPopupProps) {
  return <MenuSubmenuPopup data-slot="context-menu-submenu-popup" {...props} />;
}

export type {
  MenuCheckboxItemProps as ContextMenuCheckboxItemProps,
  MenuGroupLabelProps as ContextMenuGroupLabelProps,
  MenuGroupProps as ContextMenuGroupProps,
  MenuItemProps as ContextMenuItemProps,
  MenuLinkItemProps as ContextMenuLinkItemProps,
  MenuRadioGroupProps as ContextMenuRadioGroupProps,
  MenuRadioItemProps as ContextMenuRadioItemProps,
  MenuSeparatorProps as ContextMenuSeparatorProps,
  MenuSubmenuTriggerProps as ContextMenuSubmenuTriggerProps,
  MenuPopupProps as ContextMenuSubmenuPopupProps,
};
