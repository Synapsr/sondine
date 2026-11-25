import { Autocomplete as AutocompletePrimitive } from "@base-ui/react/autocomplete";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { SearchIcon } from "../icon";
import { mergeClassName } from "../lib/class-name";
import { cn } from "../lib/cn";
import { usePortalContainer } from "../theme/portal-container";
import { AutocompleteEmpty, AutocompleteItem, AutocompleteList } from "./autocomplete";
import { Button, type ButtonProps } from "./button";
import { dialogClassNames } from "./dialog";

// Sondine Command palette. The theme has no Command palette specification, so
// it composes specified parts (a coverage gap for the composition itself):
// - the modal shell is the Dialog popover part (radius M, Neutral 1 / Neutral 2,
//   edge, M elevation, Large motion) over the Dialog backdrop, top-aligned in a
//   Dialog viewport instead of centered. Its padding is XS, not the Dialog's L:
//   it holds a field and a list of rows, like the Autocomplete and Menu
//   popovers, and XS keeps the rows' S corners concentric with its M corners;
// - the search field is the Autocomplete input part; the list, rows and empty
//   message are the Autocomplete components (option and content parts);
// - group labels, separators, the icon column and shortcuts repeat the Menu
//   spec's detailed option content.
// The list is an inline Autocomplete that is always open, highlights its first
// match and keeps the highlight when the pointer leaves, so Enter always runs
// a command.

/** Groups the parts of the modal palette. Renders no element. */
export const CommandPaletteDialog: typeof DialogPrimitive.Root = DialogPrimitive.Root;

export type CommandPaletteDialogProps = DialogPrimitive.Root.Props;

/** Connects the palette to triggers rendered outside of it (a global shortcut, a toolbar). */
export const createCommandPaletteDialogHandle: typeof DialogPrimitive.createHandle =
  DialogPrimitive.createHandle;

export interface CommandPaletteDialogTriggerProps
  extends DialogPrimitive.Trigger.Props, Pick<ButtonProps, "variant" | "size"> {}

/** Opens the palette. An outline Button unless `variant` or `render` says otherwise. */
export function CommandPaletteDialogTrigger({
  variant = "outline",
  size,
  render,
  ...props
}: CommandPaletteDialogTriggerProps) {
  return (
    <DialogPrimitive.Trigger
      data-slot="command-palette-dialog-trigger"
      render={render ?? <Button variant={variant} size={size} />}
      {...props}
    />
  );
}

// The inline padding (M on each side, the backdrop part's padding) caps the
// popup at the viewport width minus XL, as for Dialog. The top offset and the
// widths are structural.
const viewportClassName = "fixed inset-0 flex flex-col items-center px-m pt-[min(14dvh,8rem)] pb-m";

// The surface names a different token per mode; light-dark() follows the
// nearest theme scope, as in Dialog.
const popupClassName = cn(
  "flex max-h-[min(30rem,100%)] w-full max-w-[36rem] min-h-0 flex-col outline-none",
  "corner-m bg-[color:light-dark(var(--neutral-1),var(--neutral-2))] p-xs text-neutral-10",
  "font-body font-regular text-body-s",
  "ring-s ring-neutral-4-transparent shadow-m",
  "origin-top transition-[opacity,scale] duration-motion-large ease-motion-large",
  "data-starting-style:opacity-0 data-ending-style:opacity-0",
  "motion-safe:data-starting-style:scale-(--motion-popup-scale) motion-safe:data-ending-style:scale-(--motion-popup-scale)",
);

export interface CommandPaletteDialogPopupProps extends DialogPrimitive.Popup.Props {
  /** Portal options. The container defaults to the current theme scope's portal container. */
  portalProps?: DialogPrimitive.Portal.Props | undefined;
}

/**
 * The modal surface with its portal, backdrop and viewport. Name it with
 * `aria-label` (for example "Palette de commandes") and put a
 * `CommandPalette` inside. Escape and a press outside close it.
 */
export function CommandPaletteDialogPopup({
  className,
  portalProps,
  ...props
}: CommandPaletteDialogPopupProps) {
  const container = usePortalContainer();
  return (
    <DialogPrimitive.Portal
      data-slot="command-palette-dialog-portal"
      container={container}
      {...portalProps}
    >
      <DialogPrimitive.Backdrop
        data-slot="command-palette-dialog-backdrop"
        className={dialogClassNames.backdrop}
      />
      <DialogPrimitive.Viewport
        data-slot="command-palette-dialog-viewport"
        className={viewportClassName}
      >
        <DialogPrimitive.Popup
          data-slot="command-palette-dialog-popup"
          className={mergeClassName(popupClassName, className)}
          {...props}
        />
      </DialogPrimitive.Viewport>
    </DialogPrimitive.Portal>
  );
}

type GroupedItems = readonly { items: readonly unknown[] }[];

// The palette's list is always shown, so the open state is not configurable.
type FixedRootProps = "items" | "inline" | "open" | "defaultOpen";

export type CommandPaletteProps<ItemValue> = Omit<
  AutocompletePrimitive.Root.Props<ItemValue>,
  FixedRootProps
> & {
  items?: readonly ItemValue[] | undefined;
};

export type CommandPaletteGroupedProps<Items extends GroupedItems> = Omit<
  AutocompletePrimitive.Root.Props<Items[number]["items"][number]>,
  FixedRootProps
> & { items: Items };

/**
 * The search field and its command list: an inline Autocomplete that is
 * always open. It highlights the first match and keeps the highlight, so
 * Enter runs the highlighted item's `onClick`. Renders no element.
 */
export function CommandPalette<Items extends GroupedItems>(
  props: CommandPaletteGroupedProps<Items>,
): ReactElement;
export function CommandPalette<ItemValue>(props: CommandPaletteProps<ItemValue>): ReactElement;
export function CommandPalette({
  autoHighlight = "always",
  keepHighlight = true,
  ...props
}: CommandPaletteProps<unknown>): ReactElement {
  return (
    <AutocompletePrimitive.Root
      autoHighlight={autoHighlight}
      keepHighlight={keepHighlight}
      {...props}
      inline
      open
    />
  );
}

// The Autocomplete input part, painted on the field around the input:
// disabled, then focused, then hovered, then rest. The focus outline is drawn
// on the field while its input has focus.
const inputGroupClassName = cn(
  "flex w-full min-w-0 shrink-0 cursor-text items-center gap-xs",
  "corner-s bg-neutral-3 p-s text-neutral-10",
  "font-body font-regular text-body-s",
  "ring-s ring-neutral-4",
  "transition-[background-color,color,box-shadow] duration-motion ease-motion motion-reduce:transition-none",
  "has-[[data-slot=command-palette-input]:focus-visible]:focus-ring-within",
  "has-[[data-slot=command-palette-input]:focus-visible]:ring-color-1",
  "not-has-[[data-slot=command-palette-input]:focus-visible]:control-hover:ring-neutral-5",
  "control-disabled:cursor-default control-disabled:bg-neutral-2 control-disabled:text-neutral-6",
  "**:data-[slot=icon]:pointer-events-none **:data-[slot=icon]:shrink-0",
);

// The field draws the padding, edge and fill.
const inputClassName = cn(
  "min-w-0 flex-1 bg-transparent p-0 outline-none",
  "placeholder:text-cte-text-muted data-disabled:placeholder:text-neutral-6",
);

const inputIconClassName = cn(
  "flex shrink-0 items-center justify-center text-cte-text-muted",
  "in-data-disabled:text-neutral-6",
);

export interface CommandPaletteInputProps extends AutocompletePrimitive.Input.Props {
  /** Leading 1em icon. The search icon by default; `null` removes it. */
  icon?: ReactNode;
  /** Content at the end of the field, for example a `Kbd` or a loader. */
  trailing?: ReactNode;
}

/**
 * The search field. Name it with `aria-label` or a placeholder that says
 * what is searched, for example "Rechercher dans vos conversations". Props
 * other than `icon` and `trailing` go to the input.
 */
export function CommandPaletteInput({
  className,
  icon = <SearchIcon />,
  trailing,
  ...props
}: CommandPaletteInputProps) {
  return (
    <AutocompletePrimitive.InputGroup
      data-slot="command-palette-input-group"
      className={inputGroupClassName}
    >
      {icon === null ? null : (
        <span data-slot="command-palette-input-icon" className={inputIconClassName}>
          {icon}
        </span>
      )}
      <AutocompletePrimitive.Input
        data-slot="command-palette-input"
        className={mergeClassName(inputClassName, className)}
        {...props}
      />
      {trailing === undefined || trailing === null ? null : (
        <span data-slot="command-palette-input-trailing" className="flex shrink-0 items-center">
          {trailing}
        </span>
      )}
    </AutocompletePrimitive.InputGroup>
  );
}

// Added to AutocompleteList. The rows' 1em icon column exists for the whole
// list as soon as one row has an icon; rows without one keep their label in
// the second column. XS separates the list from the field once it has rows.
const listClassName = cn(
  "group/command-palette-list flex-[0_1_auto] scroll-py-xxs",
  "not-data-empty:mt-xs",
);

export type CommandPaletteListProps = AutocompletePrimitive.List.Props;

/**
 * The scrolling list. Give it a function child that renders
 * `CommandPaletteGroup`s (grouped items) or `CommandPaletteItem`s (flat items).
 */
export function CommandPaletteList({ className, ...props }: CommandPaletteListProps) {
  return (
    <AutocompleteList
      data-slot="command-palette-list"
      className={mergeClassName(listClassName, className)}
      {...props}
    />
  );
}

export type CommandPaletteGroupProps = AutocompletePrimitive.Group.Props;

/** One group of rows; pass the group's `items` and render them in a `CommandPaletteCollection`. */
export function CommandPaletteGroup({ className, ...props }: CommandPaletteGroupProps) {
  return (
    <AutocompletePrimitive.Group
      data-slot="command-palette-group"
      className={mergeClassName("flex flex-col gap-xxs", className)}
      {...props}
    />
  );
}

// The Menu group label. The group's XXS gap supplies its bottom padding.
const groupLabelClassName = cn(
  "px-xs pt-xs select-none",
  "font-body font-medium text-body-xs text-neutral-6",
);

export type CommandPaletteGroupLabelProps = AutocompletePrimitive.GroupLabel.Props;

/** Names the enclosing group. */
export function CommandPaletteGroupLabel({ className, ...props }: CommandPaletteGroupLabelProps) {
  return (
    <AutocompletePrimitive.GroupLabel
      data-slot="command-palette-group-label"
      className={mergeClassName(groupLabelClassName, className)}
      {...props}
    />
  );
}

/** Renders a group's filtered items with its function child. Renders no element. */
export const CommandPaletteCollection: typeof AutocompletePrimitive.Collection =
  AutocompletePrimitive.Collection;

export type CommandPaletteCollectionProps = AutocompletePrimitive.Collection.Props;

// The Menu separator: a local 1px line drawn as a one-sided inset edge.
const separatorClassName = "my-xxs h-px shrink-0 inset-shadow-[0_1px_0_0_var(--neutral-4)]";

export type CommandPaletteSeparatorProps = AutocompletePrimitive.Separator.Props;

export function CommandPaletteSeparator({ className, ...props }: CommandPaletteSeparatorProps) {
  return (
    <AutocompletePrimitive.Separator
      data-slot="command-palette-separator"
      className={mergeClassName(separatorClassName, className)}
      {...props}
    />
  );
}

// Added to AutocompleteItem, which owns the option part (padding, radius,
// highlighted fill, disabled foreground): the Menu's detailed content grid.
const itemClassName = cn(
  "grid grid-cols-[minmax(0,1fr)_auto] gap-xs scroll-my-xxs",
  "group-has-[[data-slot=command-palette-item-icon]]/command-palette-list:grid-cols-[1em_minmax(0,1fr)_auto]",
);

const itemIconClassName = "col-start-1 row-start-1 flex size-[1em] items-center justify-center";

const itemLabelClassName = cn(
  "col-start-1 row-start-1 flex min-w-0 flex-col",
  "group-has-[[data-slot=command-palette-item-icon]]/command-palette-list:col-start-2",
);

const itemDescriptionClassName = cn(
  "truncate font-body font-regular text-body-xs text-cte-text-muted",
  "in-data-disabled:text-neutral-6",
);

// The Menu's S inline-start margin between the label and its shortcut.
const itemTrailingClassName = cn(
  "col-start-2 row-start-1 ms-s flex items-center gap-xs justify-self-end",
  "group-has-[[data-slot=command-palette-item-icon]]/command-palette-list:col-start-3",
);

// Menu shortcuts: the detail typography in Neutral 6.
const itemShortcutClassName =
  "font-body font-regular text-body-xs whitespace-nowrap text-neutral-6";

export interface CommandPaletteItemProps extends AutocompletePrimitive.Item.Props {
  /** Leading 1em icon; one icon in the list adds the icon column to every row. */
  icon?: ReactNode;
  /** A second, muted line under the label, for example "Zoom · Camille, Hugo". */
  description?: ReactNode;
  /** Content before the shortcut, for example a `Badge`. */
  trailing?: ReactNode;
  /** The command's keyboard shortcut, for example "⌘⇧P". */
  shortcut?: ReactNode;
}

function hasContent(node: ReactNode): boolean {
  return node !== undefined && node !== null && typeof node !== "boolean" && node !== "";
}

/**
 * One command. `onClick` runs on a press and on Enter while it is highlighted;
 * close the dialog there. Pass the item as `value` so filtering can read it.
 */
export function CommandPaletteItem({
  className,
  icon,
  description,
  trailing,
  shortcut,
  children,
  ...props
}: CommandPaletteItemProps) {
  const hasShortcut = hasContent(shortcut);
  const hasTrailing = hasContent(trailing) || hasShortcut;
  return (
    <AutocompleteItem
      data-slot="command-palette-item"
      className={mergeClassName(itemClassName, className)}
      {...props}
    >
      {hasContent(icon) ? (
        <span data-slot="command-palette-item-icon" className={itemIconClassName}>
          {icon}
        </span>
      ) : null}
      <span data-slot="command-palette-item-label" className={itemLabelClassName}>
        <span className="truncate">{children}</span>
        {hasContent(description) ? (
          <span data-slot="command-palette-item-description" className={itemDescriptionClassName}>
            {description}
          </span>
        ) : null}
      </span>
      {hasTrailing ? (
        <span data-slot="command-palette-item-trailing" className={itemTrailingClassName}>
          {trailing}
          {hasShortcut ? (
            <kbd data-slot="command-palette-item-shortcut" className={itemShortcutClassName}>
              {shortcut}
            </kbd>
          ) : null}
        </span>
      ) : null}
    </AutocompleteItem>
  );
}

export type CommandPaletteEmptyProps = AutocompletePrimitive.Empty.Props;

/**
 * Stays mounted as a live region; its message (the Autocomplete content part)
 * shows only when nothing matches. Keep it short and, when useful, say what
 * to try instead.
 */
export function CommandPaletteEmpty({ className, ...props }: CommandPaletteEmptyProps) {
  return (
    <AutocompleteEmpty
      data-slot="command-palette-empty"
      className={mergeClassName("not-empty:mt-xs", className)}
      {...props}
    />
  );
}

// The Autocomplete content part, on the inner message only, with room for a
// leading loader icon.
const statusMessageClassName = cn(
  "mt-xs flex items-center gap-xs px-xs py-s text-neutral-7",
  "font-body font-regular text-body-s",
  "**:data-[slot=icon]:shrink-0",
);

export type CommandPaletteStatusProps = AutocompletePrimitive.Status.Props;

/**
 * Stays mounted as a polite live region for asynchronous results. Pass a
 * message (and a loader icon) while searching, nothing otherwise.
 */
export function CommandPaletteStatus({ children, ...props }: CommandPaletteStatusProps) {
  return (
    <AutocompletePrimitive.Status data-slot="command-palette-status" {...props}>
      {hasContent(children) ? (
        <div data-slot="command-palette-status-message" className={statusMessageClassName}>
          {children}
        </div>
      ) : null}
    </AutocompletePrimitive.Status>
  );
}

// Detail typography in muted text under a full-width 1px line (the Menu
// separator's), bleeding into the popup's XS padding. Direct children are key
// hints: a Kbd and its label.
const footerClassName = cn(
  "relative mt-xs flex shrink-0 flex-wrap items-center gap-x-m gap-y-xxs px-xs pt-xs",
  "font-body font-regular text-body-xs text-cte-text-muted",
  "before:pointer-events-none before:absolute before:-inset-x-xs before:top-0 before:h-px",
  "before:inset-shadow-[0_1px_0_0_var(--neutral-4)]",
  "*:inline-flex *:items-center *:gap-xxs",
);

export type CommandPaletteFooterProps = ComponentProps<"div">;

/** Key hints under the list, for example "↵ Ouvrir" and "esc Fermer". */
export function CommandPaletteFooter({ className, ...props }: CommandPaletteFooterProps) {
  return (
    <div data-slot="command-palette-footer" className={cn(footerClassName, className)} {...props} />
  );
}
