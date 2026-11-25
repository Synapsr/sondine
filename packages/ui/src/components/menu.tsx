import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { cva, type VariantProps } from "class-variance-authority";
import { type ReactNode, useCallback, useRef } from "react";
import { CheckIcon, ChevronRightIcon } from "../icon";
import { mergeClassName } from "../lib/class-name";
import { cn } from "../lib/cn";
import { usePortalContainer } from "../theme/portal-container";
import { Button, type ButtonProps } from "./button";

// Sondine Menu (gui/components/sondine/menu.md). The trigger reuses the
// outline Button, which the spec references. Context menus reuse every part
// below (gui/components/sondine/context-menu.md).

const menuPopupClassName = cn(
  "group/menu relative flex flex-col outline-none",
  "max-w-[min(var(--available-width),calc(100vw_-_var(--space-xl)),420px)]",
  "max-h-[var(--available-height,360px)] overflow-y-auto overscroll-contain",
  // Neutral 1 in light, Neutral 2 in dark, from the nearest theme scope.
  "corner-xs bg-[light-dark(var(--neutral-1),var(--neutral-2))] p-xxs text-neutral-10",
  "font-body font-regular text-body-s",
  "ring-s ring-neutral-4-transparent shadow-m",
  "origin-(--transform-origin) transition-[opacity,scale] duration-motion ease-motion",
  "data-starting-style:scale-(--motion-popup-scale) data-starting-style:opacity-0",
  "data-ending-style:scale-(--motion-popup-scale) data-ending-style:opacity-0",
  "motion-reduce:transition-opacity motion-reduce:data-starting-style:scale-100 motion-reduce:data-ending-style:scale-100",
  "data-instant:transition-none motion-reduce:data-instant:transition-none",
);

// Ordinary menus have a 220px reference minimum and submenus 8 × the S text
// size, both capped by the available width.
const menuPopupWidthClassName = {
  root: "min-w-[min(220px,var(--available-width))]",
  nested: "min-w-[min(calc(var(--size-s)_*_8),var(--available-width))]",
} as const;

const menuItemVariants = cva(
  [
    // The icon column exists for a whole popup as soon as one row has an icon;
    // rows without one keep their label in the second column. Unlike the spec,
    // a check sits at the row's end, not in that column (Téo, 2026-11-19).
    "relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-xs",
    "group-has-[[data-slot=menu-item-icon]]/menu:grid-cols-[1em_minmax(0,1fr)_auto]",
    "cursor-default corner-xs p-xs whitespace-nowrap outline-none select-none",
    "font-body font-regular text-body-s",
    // Highlighted, checked (the spec's selected state) and a submenu trigger
    // with an open child share one fill; disabled wins over all of them.
    "not-data-disabled:data-highlighted:bg-neutral-3",
    "not-data-disabled:data-checked:bg-neutral-3",
    "not-data-disabled:data-popup-open:bg-neutral-3",
    "data-disabled:text-neutral-6",
    "**:data-[slot=icon]:pointer-events-none **:data-[slot=icon]:shrink-0",
  ],
  {
    variants: {
      variant: {
        default: "text-neutral-10",
        danger: "text-error",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

const menuItemIconClassName = "col-start-1 row-start-1 flex size-[1em] items-center justify-center";
const menuItemLabelClassName =
  "col-start-1 row-start-1 min-w-0 truncate group-has-[[data-slot=menu-item-icon]]/menu:col-start-2";
const menuItemTrailingClassName =
  "col-start-2 row-start-1 flex items-center gap-s justify-self-end group-has-[[data-slot=menu-item-icon]]/menu:col-start-3";
// Shortcuts use the detail typography in Neutral 6 with an S inline-start margin.
const menuItemShortcutClassName = "ms-s font-body font-regular text-body-xs text-neutral-6";
// A count or a value beside the label, apart from it, in muted figures.
const menuItemDetailClassName = "ms-s tabular-nums text-neutral-6";
// The check of a toggle or a choice sits at the row's end, in a box that is
// there checked or not, so nothing moves when it appears (Téo, 2026-11-19).
const menuItemCheckClassName = "flex size-[1em] items-center justify-center";
const menuItemIndicatorClassName = cn(
  "flex items-center justify-center text-body-s text-neutral-10 data-disabled:text-neutral-6",
  "transition-opacity duration-motion ease-motion motion-reduce:transition-none",
  "data-starting-style:opacity-0 data-ending-style:opacity-0",
);

const menuGroupLabelClassName =
  "px-xs pt-xs pb-xxs font-body font-medium text-body-xs text-neutral-6 select-none";

// A local 1px line (the spec's numeric borderWidth) drawn as a one-sided inset edge.
const menuSeparatorClassName = "my-xxs h-px shrink-0 inset-shadow-[0_1px_0_0_var(--neutral-4)]";

function readSpace(element: Element | null, token: `--space-${string}`): number {
  if (element === null) return 0;
  const value = Number.parseFloat(getComputedStyle(element).getPropertyValue(token));
  return Number.isFinite(value) ? value : 0;
}

type PositionerProps = MenuPrimitive.Positioner.Props;

interface MenuPopupFrameProps
  extends
    MenuPrimitive.Popup.Props,
    Pick<
      PositionerProps,
      "side" | "align" | "sideOffset" | "alignOffset" | "anchor" | "collisionPadding"
    > {
  nested: boolean;
}

// Portal, positioner and popup in one part. The anchor-to-popup offset is the
// popover gap (XXS); a submenu also shifts by the popup padding (XXS) so its
// first option lines up with its trigger.
function MenuPopupFrame({
  nested,
  side,
  align,
  sideOffset,
  alignOffset,
  anchor,
  collisionPadding,
  className,
  ...props
}: MenuPopupFrameProps) {
  const container = usePortalContainer();
  const positionerRef = useRef<HTMLDivElement>(null);
  const gap = useCallback(() => readSpace(positionerRef.current, "--space-xxs"), []);
  const nestedAlignOffset = useCallback(() => -readSpace(positionerRef.current, "--space-xxs"), []);
  const widthClassName = nested ? menuPopupWidthClassName.nested : menuPopupWidthClassName.root;

  return (
    <MenuPrimitive.Portal container={container}>
      <MenuPrimitive.Positioner
        ref={positionerRef}
        data-slot="menu-positioner"
        className="z-50 outline-none"
        side={side}
        align={align}
        sideOffset={sideOffset ?? gap}
        alignOffset={alignOffset ?? (nested ? nestedAlignOffset : undefined)}
        anchor={anchor}
        collisionPadding={collisionPadding}
      >
        <MenuPrimitive.Popup
          data-slot="menu-popup"
          className={mergeClassName(cn(menuPopupClassName, widthClassName), className)}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function ItemContent({
  icon,
  shortcut,
  trailing,
  children,
}: {
  icon?: ReactNode;
  shortcut?: ReactNode;
  trailing?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <>
      {icon ? (
        <span data-slot="menu-item-icon" className={menuItemIconClassName}>
          {icon}
        </span>
      ) : null}
      <span data-slot="menu-item-label" className={menuItemLabelClassName}>
        {children}
      </span>
      {shortcut || trailing ? (
        <span data-slot="menu-item-trailing" className={menuItemTrailingClassName}>
          {shortcut ? (
            <kbd data-slot="menu-item-shortcut" className={menuItemShortcutClassName}>
              {shortcut}
            </kbd>
          ) : null}
          {trailing}
        </span>
      ) : null}
    </>
  );
}

// Typeahead and filtering read the label, not the shortcut beside it.
function textLabel(label: string | undefined, children: ReactNode): string | undefined {
  return label ?? (typeof children === "string" ? children : undefined);
}

/** Groups all parts of a menu. */
export const Menu = MenuPrimitive.Root;

/** Opens a submenu from a `MenuSubmenuTrigger`. */
export const MenuSubmenu = MenuPrimitive.SubmenuRoot;

export type MenuProps = MenuPrimitive.Root.Props;
export type MenuSubmenuProps = MenuPrimitive.SubmenuRoot.Props;

export interface MenuTriggerProps
  extends MenuPrimitive.Trigger.Props, Pick<ButtonProps, "variant" | "size"> {}

/** A Sondine Button that opens the menu, outline by default. */
export function MenuTrigger({ variant = "outline", size, render, ...props }: MenuTriggerProps) {
  return (
    <MenuPrimitive.Trigger
      data-slot="menu-trigger"
      render={render ?? <Button variant={variant} size={size} />}
      {...props}
    />
  );
}

export interface MenuPopupProps
  extends
    MenuPrimitive.Popup.Props,
    Pick<
      PositionerProps,
      "side" | "align" | "sideOffset" | "alignOffset" | "anchor" | "collisionPadding"
    > {}

/** The menu surface, portalled and positioned against the trigger. */
export function MenuPopup(props: MenuPopupProps) {
  return <MenuPopupFrame nested={false} {...props} />;
}

/** The surface of a submenu, placed at the inline end of its trigger. */
export function MenuSubmenuPopup(props: MenuPopupProps) {
  return <MenuPopupFrame nested {...props} />;
}

export interface MenuItemProps
  extends MenuPrimitive.Item.Props, VariantProps<typeof menuItemVariants> {
  /** Leading 1em icon; one icon in a popup adds the icon column to every row. */
  icon?: ReactNode;
  /** Trailing keyboard shortcut, for example "⌘⇧P". */
  shortcut?: ReactNode;
}

export function MenuItem({
  className,
  variant,
  icon,
  shortcut,
  label,
  children,
  ...props
}: MenuItemProps) {
  return (
    <MenuPrimitive.Item
      data-slot="menu-item"
      data-variant={variant ?? "default"}
      label={textLabel(label, children)}
      className={mergeClassName(menuItemVariants({ variant }), className)}
      {...props}
    >
      <ItemContent icon={icon} shortcut={shortcut}>
        {children}
      </ItemContent>
    </MenuPrimitive.Item>
  );
}

export interface MenuLinkItemProps
  extends MenuPrimitive.LinkItem.Props, VariantProps<typeof menuItemVariants> {
  icon?: ReactNode;
  shortcut?: ReactNode;
}

/** A menu item that navigates; renders an `<a>`. */
export function MenuLinkItem({
  className,
  variant,
  icon,
  shortcut,
  label,
  children,
  ...props
}: MenuLinkItemProps) {
  return (
    <MenuPrimitive.LinkItem
      data-slot="menu-link-item"
      data-variant={variant ?? "default"}
      label={textLabel(label, children)}
      className={mergeClassName(menuItemVariants({ variant }), className)}
      {...props}
    >
      <ItemContent icon={icon} shortcut={shortcut}>
        {children}
      </ItemContent>
    </MenuPrimitive.LinkItem>
  );
}

export interface MenuCheckboxItemProps extends MenuPrimitive.CheckboxItem.Props {
  shortcut?: ReactNode;
  /** A count or a value shown apart from the label, before the check. */
  detail?: ReactNode;
}

/** A toggle row; its check sits at the row's end. */
export function MenuCheckboxItem({
  className,
  shortcut,
  detail,
  label,
  children,
  ...props
}: MenuCheckboxItemProps) {
  return (
    <MenuPrimitive.CheckboxItem
      data-slot="menu-checkbox-item"
      label={textLabel(label, children)}
      className={mergeClassName(menuItemVariants(), className)}
      {...props}
    >
      <ItemContent
        shortcut={shortcut}
        trailing={
          <>
            {detail === undefined ? null : (
              <span data-slot="menu-item-detail" className={menuItemDetailClassName}>
                {detail}
              </span>
            )}
            <span className={menuItemCheckClassName}>
              <MenuPrimitive.CheckboxItemIndicator
                data-slot="menu-checkbox-item-indicator"
                className={menuItemIndicatorClassName}
              >
                <CheckIcon />
              </MenuPrimitive.CheckboxItemIndicator>
            </span>
          </>
        }
      >
        {children}
      </ItemContent>
    </MenuPrimitive.CheckboxItem>
  );
}

export type MenuRadioGroupProps = MenuPrimitive.RadioGroup.Props;

export function MenuRadioGroup(props: MenuRadioGroupProps) {
  return <MenuPrimitive.RadioGroup data-slot="menu-radio-group" {...props} />;
}

export interface MenuRadioItemProps extends MenuPrimitive.RadioItem.Props {
  shortcut?: ReactNode;
  /** A count or a value shown apart from the label, before the check. */
  detail?: ReactNode;
}

/** One choice of a `MenuRadioGroup`; its check sits at the row's end. */
export function MenuRadioItem({
  className,
  shortcut,
  detail,
  label,
  children,
  ...props
}: MenuRadioItemProps) {
  return (
    <MenuPrimitive.RadioItem
      data-slot="menu-radio-item"
      label={textLabel(label, children)}
      className={mergeClassName(menuItemVariants(), className)}
      {...props}
    >
      <ItemContent
        shortcut={shortcut}
        trailing={
          <>
            {detail === undefined ? null : (
              <span data-slot="menu-item-detail" className={menuItemDetailClassName}>
                {detail}
              </span>
            )}
            <span className={menuItemCheckClassName}>
              <MenuPrimitive.RadioItemIndicator
                data-slot="menu-radio-item-indicator"
                className={menuItemIndicatorClassName}
              >
                <CheckIcon />
              </MenuPrimitive.RadioItemIndicator>
            </span>
          </>
        }
      >
        {children}
      </ItemContent>
    </MenuPrimitive.RadioItem>
  );
}

export interface MenuSubmenuTriggerProps extends MenuPrimitive.SubmenuTrigger.Props {
  icon?: ReactNode;
}

/** The row that opens a submenu; it keeps the highlighted fill while the submenu is open. */
export function MenuSubmenuTrigger({
  className,
  icon,
  label,
  children,
  ...props
}: MenuSubmenuTriggerProps) {
  return (
    <MenuPrimitive.SubmenuTrigger
      data-slot="menu-submenu-trigger"
      label={textLabel(label, children)}
      className={mergeClassName(menuItemVariants(), className)}
      {...props}
    >
      <ItemContent icon={icon} trailing={<ChevronRightIcon className="rtl:rotate-180" />}>
        {children}
      </ItemContent>
    </MenuPrimitive.SubmenuTrigger>
  );
}

export type MenuGroupProps = MenuPrimitive.Group.Props;

export function MenuGroup(props: MenuGroupProps) {
  return <MenuPrimitive.Group data-slot="menu-group" {...props} />;
}

export type MenuGroupLabelProps = MenuPrimitive.GroupLabel.Props;

/** Names the enclosing `MenuGroup` or `MenuRadioGroup`. */
export function MenuGroupLabel({ className, ...props }: MenuGroupLabelProps) {
  return (
    <MenuPrimitive.GroupLabel
      data-slot="menu-group-label"
      className={mergeClassName(menuGroupLabelClassName, className)}
      {...props}
    />
  );
}

export type MenuSeparatorProps = MenuPrimitive.Separator.Props;

export function MenuSeparator({ className, ...props }: MenuSeparatorProps) {
  return (
    <MenuPrimitive.Separator
      data-slot="menu-separator"
      className={mergeClassName(menuSeparatorClassName, className)}
      {...props}
    />
  );
}
