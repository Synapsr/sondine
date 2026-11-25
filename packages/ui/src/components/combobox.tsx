import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { type ComponentProps, createContext, type ReactElement, use, useId, useMemo } from "react";
import { CheckIcon, ChevronDownIcon } from "../icon";
import { mergeClassName } from "../lib/class-name";
import { cn } from "../lib/cn";
import { usePortalContainer } from "../theme/portal-container";

// Sondine Combobox (gui/components/sondine/combobox.md): label, the input part
// painted on the outer field, popover and option rows, rest/hover/focus/
// disabled, both modes. Edges are box shadows sized by the theme's border scale.

interface ComboboxContextValue {
  /** The root id, which Base UI also gives the input. */
  id: string;
  disabled: boolean;
}

const ComboboxContext = createContext<ComboboxContextValue | null>(null);

export type ComboboxProps<
  Value,
  Multiple extends boolean | undefined = false,
  Item = Value,
> = ComboboxPrimitive.Root.Props<Value, Multiple, Item>;

export function Combobox<Value, Multiple extends boolean | undefined = false, Item = Value>(
  props: ComboboxProps<Value, Multiple, Item>,
): ReactElement {
  const generatedId = useId();
  const id = props.id ?? generatedId;
  const disabled = props.disabled === true;
  const context = useMemo(() => ({ id, disabled }), [id, disabled]);
  return (
    <ComboboxContext value={context}>
      <ComboboxPrimitive.Root {...props} id={id} />
    </ComboboxContext>
  );
}

const labelClassName = cn(
  "font-body font-medium text-body-s text-neutral-10",
  "data-disabled:text-neutral-6",
);

export type ComboboxLabelProps = ComponentProps<"label">;

/**
 * A native label for the input (Base UI's Combobox.Label only labels a
 * trigger). Inside `Combobox` it points at the input on its own.
 */
export function ComboboxLabel({ className, htmlFor, ...props }: ComboboxLabelProps) {
  const context = use(ComboboxContext);
  return (
    <label
      data-slot="combobox-label"
      data-disabled={context?.disabled === true ? "" : undefined}
      htmlFor={htmlFor ?? context?.id}
      className={cn(labelClassName, className)}
      {...props}
    />
  );
}

// The field carries the input part's surface. Its states follow the input:
// disabled, then focused, then hovered, then rest. An invalid edge stays
// through hover and focus, under the focus outline. Class names stay literal
// so Tailwind's scanner sees them.
const inputGroupClassName = cn(
  "flex w-full min-w-0 items-center gap-xs",
  "corner-s bg-neutral-3 px-m py-s text-neutral-10",
  "font-body font-regular text-body-s",
  "ring-s ring-neutral-4",
  "transition-[background-color,color,box-shadow] duration-motion ease-motion motion-reduce:transition-none",
  // The focus outline, drawn on the field while its input has focus.
  "has-[[data-slot=combobox-input]:focus-visible]:focus-ring-within",
  "not-data-invalid:not-has-[[data-slot=combobox-input]:focus-visible]:control-hover:ring-neutral-5",
  "not-data-invalid:has-[[data-slot=combobox-input]:focus-visible]:ring-color-1-transparent",
  "data-invalid:bg-error-transparent data-invalid:ring-error",
  "control-disabled:bg-neutral-3 control-disabled:text-neutral-6 control-disabled:ring-neutral-4-transparent",
);

export type ComboboxInputGroupProps = ComboboxPrimitive.InputGroup.Props;

/** The styled field the popup anchors to. Holds `ComboboxInput` and `ComboboxTrigger`. */
export function ComboboxInputGroup({ className, ...props }: ComboboxInputGroupProps) {
  return (
    <ComboboxPrimitive.InputGroup
      data-slot="combobox-input-group"
      className={mergeClassName(inputGroupClassName, className)}
      {...props}
    />
  );
}

// No padding, edge or fill of its own: the field draws them.
const inputClassName = cn(
  "min-w-0 flex-1 bg-transparent p-0 outline-none",
  "placeholder:text-current/45",
);

export type ComboboxInputProps = ComboboxPrimitive.Input.Props;

export function ComboboxInput({ className, ...props }: ComboboxInputProps) {
  return (
    <ComboboxPrimitive.Input
      data-slot="combobox-input"
      className={mergeClassName(inputClassName, className)}
      {...props}
    />
  );
}

// At least 1.5em square around the 1em chevron. The negative block margin keeps
// the field at its line height plus padding, like Select and Input.
const triggerClassName = cn(
  "-my-[0.25em] inline-flex min-h-[1.5em] min-w-[1.5em] shrink-0 items-center justify-center corner-xs",
  "focus-ring",
  "**:data-[slot=icon]:pointer-events-none **:data-[slot=icon]:shrink-0",
);

export type ComboboxTriggerProps = ComboboxPrimitive.Trigger.Props;

/** Opens the list. Shows a chevron unless given children; needs an `aria-label`. */
export function ComboboxTrigger({ className, children, ...props }: ComboboxTriggerProps) {
  return (
    <ComboboxPrimitive.Trigger
      data-slot="combobox-trigger"
      className={mergeClassName(triggerClassName, className)}
      {...props}
    >
      {children ?? <ChevronDownIcon />}
    </ComboboxPrimitive.Trigger>
  );
}

// The popover part's gap is the distance to the field. It is a margin on the
// side facing the field (the positioner is placed flush), so it stays a theme
// token instead of a number passed to sideOffset.
const popupClassName = cn(
  "flex flex-col outline-none",
  "w-(--anchor-width) max-w-(--available-width)",
  "max-h-[min(22.5rem,calc(var(--available-height)-var(--space-xxs)))]",
  "data-[side=bottom]:mt-xxs data-[side=top]:mb-xxs data-[side=left]:mr-xxs data-[side=right]:ml-xxs",
  "data-[side=inline-start]:me-xxs data-[side=inline-end]:ms-xxs",
  "corner-s bg-neutral-1 p-xxs text-neutral-10 dark:bg-neutral-2",
  "ring-s ring-neutral-4-transparent shadow-m",
  "origin-(--transform-origin) transition-[opacity,scale] duration-motion ease-motion",
  "data-starting-style:opacity-0 data-ending-style:opacity-0",
  "motion-safe:data-starting-style:scale-(--motion-popup-scale) motion-safe:data-ending-style:scale-(--motion-popup-scale)",
);

export interface ComboboxPopupProps extends ComboboxPrimitive.Popup.Props {
  side?: ComboboxPrimitive.Positioner.Props["side"];
  align?: ComboboxPrimitive.Positioner.Props["align"];
  alignOffset?: ComboboxPrimitive.Positioner.Props["alignOffset"];
  anchor?: ComboboxPrimitive.Positioner.Props["anchor"];
  collisionAvoidance?: ComboboxPrimitive.Positioner.Props["collisionAvoidance"];
  portalProps?: ComboboxPrimitive.Portal.Props | undefined;
}

/**
 * Portal, positioner and popup, anchored to the whole field, start-aligned and
 * as wide as it. Put `ComboboxEmpty` and `ComboboxList` inside.
 */
export function ComboboxPopup({
  className,
  side = "bottom",
  align = "start",
  alignOffset,
  anchor,
  collisionAvoidance,
  portalProps,
  ...props
}: ComboboxPopupProps) {
  const container = usePortalContainer();
  return (
    <ComboboxPrimitive.Portal container={container} {...portalProps}>
      <ComboboxPrimitive.Positioner
        data-slot="combobox-positioner"
        className="z-50 outline-none"
        side={side}
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        collisionAvoidance={collisionAvoidance}
      >
        <ComboboxPrimitive.Popup
          data-slot="combobox-popup"
          className={mergeClassName(popupClassName, className)}
          {...props}
        />
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  );
}

const listClassName =
  "flex min-h-0 flex-col gap-xxs overflow-y-auto overscroll-contain outline-none";

export type ComboboxListProps = ComboboxPrimitive.List.Props;

export function ComboboxList({ className, ...props }: ComboboxListProps) {
  return (
    <ComboboxPrimitive.List
      data-slot="combobox-list"
      className={mergeClassName(listClassName, className)}
      {...props}
    />
  );
}

// The theme gives the empty text no colour of its own; this is Autocomplete's
// content part (neutral-7).
const emptyClassName = cn("font-body font-regular text-body-s text-neutral-7", "not-empty:p-s");

export type ComboboxEmptyProps = ComboboxPrimitive.Empty.Props;

/** Stays mounted as a live region; its children show only when nothing matches. */
export function ComboboxEmpty({ className, ...props }: ComboboxEmptyProps) {
  return (
    <ComboboxPrimitive.Empty
      data-slot="combobox-empty"
      className={mergeClassName(emptyClassName, className)}
      {...props}
    />
  );
}

// Option precedence: disabled, then highlighted, then selected, then rest.
const itemClassName = cn(
  "flex w-full cursor-default items-center outline-none select-none",
  "corner-xs p-xs text-neutral-10",
  "font-body font-regular text-body-s",
  "not-data-disabled:data-highlighted:bg-neutral-3",
  "not-data-disabled:not-data-highlighted:data-selected:bg-neutral-2",
  "data-disabled:text-neutral-6",
  "**:data-[slot=icon]:pointer-events-none **:data-[slot=icon]:shrink-0",
);

export type ComboboxItemProps = ComboboxPrimitive.Item.Props;

/** One option: its label, then the check shown while it is selected. */
export function ComboboxItem({ className, children, ...props }: ComboboxItemProps) {
  return (
    <ComboboxPrimitive.Item
      data-slot="combobox-item"
      className={mergeClassName(itemClassName, className)}
      {...props}
    >
      <span data-slot="combobox-item-label" className="min-w-0 flex-1">
        {children}
      </span>
      <ComboboxPrimitive.ItemIndicator
        data-slot="combobox-item-indicator"
        className="ms-xs flex shrink-0"
      >
        <CheckIcon />
      </ComboboxPrimitive.ItemIndicator>
    </ComboboxPrimitive.Item>
  );
}
