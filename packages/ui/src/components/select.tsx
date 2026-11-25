import { Select as SelectPrimitive } from "@base-ui/react/select";
import { createContext, type ReactElement, use } from "react";
import { CheckIcon, ChevronDownIcon } from "../icon";
import { mergeClassName } from "../lib/class-name";
import { cn } from "../lib/cn";
import { usePortalContainer } from "../theme/portal-container";

// Sondine Select (gui/components/sondine/select.md): label, trigger (control
// part), popover and option rows, rest/hover/focus/open/disabled, both modes.
// Every edge is a box shadow sized by the theme's border scale.

// Select.Label only reads a Field's disabled state, so the root shares its own.
const SelectDisabledContext = createContext(false);

export type SelectProps<
  Value,
  Multiple extends boolean | undefined = false,
> = SelectPrimitive.Root.Props<Value, Multiple>;

/**
 * Pass `items` so the trigger shows the selected label before the popup has
 * ever opened.
 */
export function Select<Value, Multiple extends boolean | undefined = false>(
  props: SelectProps<Value, Multiple>,
): ReactElement {
  return (
    <SelectDisabledContext value={props.disabled === true}>
      <SelectPrimitive.Root {...props} />
    </SelectDisabledContext>
  );
}

const labelClassName = cn(
  "font-body font-medium text-body-s text-neutral-10",
  "data-disabled:text-neutral-6",
);

export type SelectLabelProps = SelectPrimitive.Label.Props;

export function SelectLabel({ className, ...props }: SelectLabelProps) {
  const disabled = use(SelectDisabledContext);
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      // Spread only when set: an undefined value would drop a Field's own attribute.
      {...(disabled ? { "data-disabled": "" } : {})}
      className={mergeClassName(labelClassName, className)}
      {...props}
    />
  );
}

// Precedence: disabled, then focused or open, then hovered, then rest. An
// invalid edge stays through hover, focus and open; the focus outline is drawn
// on top of it.
const triggerClassName = cn(
  "flex w-full min-w-0 items-center justify-between gap-xs text-start whitespace-nowrap select-none",
  "corner-s bg-neutral-3 px-m py-s text-neutral-10",
  "font-body font-regular text-body-s",
  "ring-s ring-neutral-4",
  "transition-[background-color,color,box-shadow] duration-motion ease-motion motion-reduce:transition-none",
  "focus-ring",
  "not-data-invalid:not-data-popup-open:control-hover:ring-neutral-5",
  "not-data-invalid:control-focus:ring-color-1-transparent",
  "not-data-invalid:data-popup-open:ring-color-1-transparent",
  "data-invalid:bg-error-transparent data-invalid:ring-error",
  "control-disabled:bg-neutral-3 control-disabled:text-neutral-6 control-disabled:ring-neutral-4-transparent",
  "**:data-[slot=icon]:pointer-events-none **:data-[slot=icon]:shrink-0",
);

export type SelectTriggerProps = SelectPrimitive.Trigger.Props;

/** The field-like button. Put a `SelectValue` inside; the chevron is added. */
export function SelectTrigger({ className, children, ...props }: SelectTriggerProps) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={mergeClassName(triggerClassName, className)}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon data-slot="select-icon" className="flex shrink-0">
        <ChevronDownIcon />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

// The theme gives Select no placeholder treatment; this is the Combobox one
// (current text color at 45%).
const valueClassName = "min-w-0 flex-1 truncate data-placeholder:text-current/45";

export type SelectValueProps = SelectPrimitive.Value.Props;

export function SelectValue({ className, ...props }: SelectValueProps) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={mergeClassName(valueClassName, className)}
      {...props}
    />
  );
}

// The popover part's gap is the distance to the trigger. It is a margin on
// the side facing the trigger (the positioner is placed flush), so it stays a
// theme token instead of a number passed to sideOffset.
const popupClassName = cn(
  "flex flex-col outline-none",
  "w-(--anchor-width) max-w-(--available-width) max-h-[calc(var(--available-height)-var(--space-xxs))]",
  "data-[side=bottom]:mt-xxs data-[side=top]:mb-xxs data-[side=left]:mr-xxs data-[side=right]:ml-xxs",
  "data-[side=inline-start]:me-xxs data-[side=inline-end]:ms-xxs",
  "corner-s bg-neutral-1 p-xxs text-neutral-10 dark:bg-neutral-2",
  "ring-s ring-neutral-4-transparent shadow-m",
  "origin-(--transform-origin) transition-[opacity,scale] duration-motion ease-motion",
  "data-starting-style:opacity-0 data-ending-style:opacity-0",
  "motion-safe:data-starting-style:scale-(--motion-popup-scale) motion-safe:data-ending-style:scale-(--motion-popup-scale)",
);

const listClassName =
  "flex min-h-0 flex-col gap-xxs overflow-y-auto overscroll-contain outline-none";

export interface SelectPopupProps extends SelectPrimitive.Popup.Props {
  side?: SelectPrimitive.Positioner.Props["side"];
  align?: SelectPrimitive.Positioner.Props["align"];
  alignOffset?: SelectPrimitive.Positioner.Props["alignOffset"];
  anchor?: SelectPrimitive.Positioner.Props["anchor"];
  collisionAvoidance?: SelectPrimitive.Positioner.Props["collisionAvoidance"];
  portalProps?: SelectPrimitive.Portal.Props | undefined;
}

/**
 * Portal, positioner, popup and list in one part. The popup sits under the
 * trigger, start-aligned and as wide as it, instead of over the selected item.
 */
export function SelectPopup({
  className,
  children,
  side = "bottom",
  align = "start",
  alignOffset,
  anchor,
  collisionAvoidance,
  portalProps,
  ...props
}: SelectPopupProps) {
  const container = usePortalContainer();
  return (
    <SelectPrimitive.Portal container={container} {...portalProps}>
      <SelectPrimitive.Positioner
        data-slot="select-positioner"
        className="z-50 outline-none"
        side={side}
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        collisionAvoidance={collisionAvoidance}
        alignItemWithTrigger={false}
      >
        <SelectPrimitive.Popup
          data-slot="select-popup"
          className={mergeClassName(popupClassName, className)}
          {...props}
        >
          <SelectPrimitive.List data-slot="select-list" className={listClassName}>
            {children}
          </SelectPrimitive.List>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

// Option precedence: disabled, then highlighted, then selected, then rest, so
// the keyboard or pointer highlight stays distinct from the selected value.
const itemClassName = cn(
  "flex w-full cursor-default items-center justify-between gap-xs outline-none select-none",
  "corner-xs px-xs py-xxs text-neutral-10",
  "font-body font-regular text-body-s",
  "not-data-disabled:data-highlighted:bg-neutral-3",
  "not-data-disabled:not-data-highlighted:data-selected:bg-neutral-2",
  "data-disabled:text-neutral-6",
  "**:data-[slot=icon]:pointer-events-none **:data-[slot=icon]:shrink-0",
);

export type SelectItemProps = SelectPrimitive.Item.Props;

/** One option: its label, then the check shown while it is selected. */
export function SelectItem({ className, children, ...props }: SelectItemProps) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={mergeClassName(itemClassName, className)}
      {...props}
    >
      <SelectPrimitive.ItemText data-slot="select-item-text" className="min-w-0 flex-1">
        {children}
      </SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator data-slot="select-item-indicator" className="flex shrink-0">
        <CheckIcon />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}
