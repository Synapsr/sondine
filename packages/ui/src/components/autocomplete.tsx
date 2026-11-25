import { Autocomplete as AutocompletePrimitive } from "@base-ui/react/autocomplete";
import { type ComponentProps, createContext, type ReactElement, use, useId, useMemo } from "react";
import { mergeClassName } from "../lib/class-name";
import { cn } from "../lib/cn";
import { usePortalContainer } from "../theme/portal-container";

// Sondine Autocomplete (gui/components/sondine/autocomplete.md): label, input,
// popover, option and content (empty message) parts, rest/hover/focus/
// disabled, both modes. Free text: no selection check on options.

interface AutocompleteContextValue {
  /** The root id, which Base UI also gives the input. */
  id: string;
  disabled: boolean;
}

const AutocompleteContext = createContext<AutocompleteContextValue | null>(null);

type GroupedItems = readonly { items: readonly unknown[] }[];

export type AutocompleteProps<ItemValue> = Omit<
  AutocompletePrimitive.Root.Props<ItemValue>,
  "items"
> & {
  items?: readonly ItemValue[] | undefined;
};

export type AutocompleteGroupedProps<Items extends GroupedItems> = Omit<
  AutocompletePrimitive.Root.Props<Items[number]["items"][number]>,
  "items"
> & { items: Items };

// The same two signatures as Autocomplete.Root: grouped items, or a flat list.
export function Autocomplete<Items extends GroupedItems>(
  props: AutocompleteGroupedProps<Items>,
): ReactElement;
export function Autocomplete<ItemValue>(props: AutocompleteProps<ItemValue>): ReactElement;
export function Autocomplete(props: AutocompleteProps<unknown>): ReactElement {
  const generatedId = useId();
  const id = props.id ?? generatedId;
  const disabled = props.disabled === true;
  const context = useMemo(() => ({ id, disabled }), [id, disabled]);
  return (
    <AutocompleteContext value={context}>
      <AutocompletePrimitive.Root {...props} id={id} />
    </AutocompleteContext>
  );
}

const labelClassName = cn(
  "font-body font-medium text-body-s text-neutral-10",
  "data-disabled:text-neutral-6",
);

export type AutocompleteLabelProps = ComponentProps<"label">;

/** A native label; inside `Autocomplete` it points at the input on its own. */
export function AutocompleteLabel({ className, htmlFor, ...props }: AutocompleteLabelProps) {
  const context = use(AutocompleteContext);
  return (
    <label
      data-slot="autocomplete-label"
      data-disabled={context?.disabled === true ? "" : undefined}
      htmlFor={htmlFor ?? context?.id}
      className={cn(labelClassName, className)}
      {...props}
    />
  );
}

// Precedence: disabled, then focused, then hovered, then rest. An invalid
// edge stays through hover and focus, under the focus outline. The theme's
// Input rule sets the placeholder: muted text at full opacity, or the disabled
// foreground while disabled.
const inputClassName = cn(
  "w-full min-w-0 corner-s bg-neutral-3 p-s text-neutral-10",
  "font-body font-regular text-body-s",
  "ring-s ring-neutral-4",
  "placeholder:text-cte-text-muted",
  "transition-[background-color,color,box-shadow] duration-motion ease-motion motion-reduce:transition-none",
  "focus-ring",
  "not-data-invalid:control-hover:ring-neutral-5",
  "not-data-invalid:control-focus:ring-color-1",
  "data-invalid:bg-error-transparent data-invalid:ring-error",
  "control-disabled:bg-neutral-2 control-disabled:text-neutral-6 control-disabled:ring-neutral-4",
  "control-disabled:placeholder:text-neutral-6",
);

export type AutocompleteInputProps = AutocompletePrimitive.Input.Props;

export function AutocompleteInput({ className, ...props }: AutocompleteInputProps) {
  return (
    <AutocompletePrimitive.Input
      data-slot="autocomplete-input"
      className={mergeClassName(inputClassName, className)}
      {...props}
    />
  );
}

// The popover part's gap is the distance to the input. It is a margin on the
// side facing the input (the positioner is placed flush), so it stays a theme
// token instead of a number passed to sideOffset. Width: the input's, capped
// by the available width and by the viewport minus XL.
const popupClassName = cn(
  "flex flex-col outline-none",
  "w-(--anchor-width) max-w-[min(var(--available-width),calc(100vw-var(--space-xl)))]",
  "max-h-[calc(var(--available-height)-var(--space-xxs))]",
  "data-[side=bottom]:mt-xxs data-[side=top]:mb-xxs data-[side=left]:mr-xxs data-[side=right]:ml-xxs",
  "data-[side=inline-start]:me-xxs data-[side=inline-end]:ms-xxs",
  "corner-s bg-neutral-1 p-xxs text-neutral-10 dark:bg-neutral-2",
  "ring-s ring-neutral-4-transparent shadow-m",
  "origin-(--transform-origin) transition-[opacity,scale] duration-motion ease-motion",
  "data-starting-style:opacity-0 data-ending-style:opacity-0",
  "motion-safe:data-starting-style:scale-(--motion-popup-scale) motion-safe:data-ending-style:scale-(--motion-popup-scale)",
);

export interface AutocompletePopupProps extends AutocompletePrimitive.Popup.Props {
  side?: AutocompletePrimitive.Positioner.Props["side"];
  align?: AutocompletePrimitive.Positioner.Props["align"];
  alignOffset?: AutocompletePrimitive.Positioner.Props["alignOffset"];
  anchor?: AutocompletePrimitive.Positioner.Props["anchor"];
  collisionAvoidance?: AutocompletePrimitive.Positioner.Props["collisionAvoidance"];
  portalProps?: AutocompletePrimitive.Portal.Props | undefined;
}

/**
 * Portal, positioner and popup, start-aligned under the input and as wide as
 * it. Put `AutocompleteEmpty` and `AutocompleteList` inside.
 */
export function AutocompletePopup({
  className,
  side = "bottom",
  align = "start",
  alignOffset,
  anchor,
  collisionAvoidance,
  portalProps,
  ...props
}: AutocompletePopupProps) {
  const container = usePortalContainer();
  return (
    <AutocompletePrimitive.Portal container={container} {...portalProps}>
      <AutocompletePrimitive.Positioner
        data-slot="autocomplete-positioner"
        className="z-50 outline-none"
        side={side}
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        collisionAvoidance={collisionAvoidance}
      >
        <AutocompletePrimitive.Popup
          data-slot="autocomplete-popup"
          className={mergeClassName(popupClassName, className)}
          {...props}
        />
      </AutocompletePrimitive.Positioner>
    </AutocompletePrimitive.Portal>
  );
}

const listClassName =
  "flex min-h-0 flex-col gap-xxs overflow-y-auto overscroll-contain outline-none";

export type AutocompleteListProps = AutocompletePrimitive.List.Props;

export function AutocompleteList({ className, ...props }: AutocompleteListProps) {
  return (
    <AutocompletePrimitive.List
      data-slot="autocomplete-list"
      className={mergeClassName(listClassName, className)}
      {...props}
    />
  );
}

// The content part: S block and XS inline padding on the message only.
const emptyMessageClassName = cn("px-xs py-s text-neutral-7", "font-body font-regular text-body-s");

export type AutocompleteEmptyProps = AutocompletePrimitive.Empty.Props;

/**
 * Stays mounted as a live region; its message, with the content part's
 * padding, shows only when nothing matches.
 */
export function AutocompleteEmpty({ children, ...props }: AutocompleteEmptyProps) {
  return (
    <AutocompletePrimitive.Empty data-slot="autocomplete-empty" {...props}>
      <div data-slot="autocomplete-empty-message" className={emptyMessageClassName}>
        {children}
      </div>
    </AutocompletePrimitive.Empty>
  );
}

const itemClassName = cn(
  "flex w-full cursor-default items-center outline-none select-none",
  "corner-s p-xs text-neutral-10",
  "font-body font-regular text-body-s",
  "not-data-disabled:data-highlighted:bg-neutral-3",
  "data-disabled:text-neutral-6",
  "**:data-[slot=icon]:pointer-events-none **:data-[slot=icon]:shrink-0",
);

export type AutocompleteItemProps = AutocompletePrimitive.Item.Props;

export function AutocompleteItem({ className, ...props }: AutocompleteItemProps) {
  return (
    <AutocompletePrimitive.Item
      data-slot="autocomplete-item"
      className={mergeClassName(itemClassName, className)}
      {...props}
    />
  );
}
