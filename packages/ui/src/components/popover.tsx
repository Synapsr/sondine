import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { useCallback, useRef } from "react";
import { mergeClassName } from "../lib/class-name";
import { cn } from "../lib/cn";
import { usePortalContainer } from "../theme/portal-container";
import { Button, type ButtonProps } from "./button";

// Sondine Popover (gui/components/sondine/popover.md). The trigger, action and
// close parts reference Button (outline, primary, ghost), so they render it.
// The surface edge is a ring at the theme's border width (0 in this theme),
// composed with the m elevation; it has no bevel overlay. The surface names
// neutral-1 in light and neutral-2 in dark; light-dark() resolves it from the
// nearest theme scope's color-scheme (see dialog.tsx).

const popupClassName = cn(
  "flex flex-col gap-xs overflow-y-auto",
  "w-[300px] max-w-[min(var(--available-width),calc(100vw-var(--space-xl)),420px)]",
  "max-h-[var(--available-height,calc(100dvh-var(--space-xl)))]",
  "corner-m bg-[color:light-dark(var(--neutral-1),var(--neutral-2))] p-m text-neutral-10",
  "font-body font-regular text-body-s",
  "ring-s ring-neutral-4-transparent shadow-m outline-none",
  "origin-(--transform-origin) transition-[opacity,scale] duration-motion ease-motion",
  "data-starting-style:opacity-0 data-ending-style:opacity-0",
  "motion-safe:data-starting-style:scale-(--motion-popup-scale) motion-safe:data-ending-style:scale-(--motion-popup-scale)",
  "data-instant:transition-none",
);

const titleClassName = cn(
  "font-body font-medium text-body-m text-neutral-10",
  "data-disabled:text-neutral-6",
);

const descriptionClassName = cn(
  "max-w-[40ch] font-body font-regular text-body-s text-neutral-7",
  "data-disabled:text-neutral-6",
);

// Reads a length token (for example --space-xs) where the popup renders, so the
// anchor offset follows the theme instead of copying its value.
function readLength(element: Element | null, property: string): number {
  if (element === null) return 0;
  const value = Number.parseFloat(getComputedStyle(element).getPropertyValue(property));
  return Number.isFinite(value) ? value : 0;
}

export type PopoverProps = PopoverPrimitive.Root.Props;

/** Groups the parts of a popover. Renders no element. */
export const Popover: typeof PopoverPrimitive.Root = PopoverPrimitive.Root;

/** Connects a popover to triggers rendered outside of it. */
export const createPopoverHandle: typeof PopoverPrimitive.createHandle =
  PopoverPrimitive.createHandle;

export interface PopoverTriggerProps
  extends PopoverPrimitive.Trigger.Props, Pick<ButtonProps, "variant" | "size"> {}

/** Opens the popover. An outline Button unless `variant` or `render` says otherwise. */
export function PopoverTrigger({
  variant = "outline",
  size,
  render,
  ...props
}: PopoverTriggerProps) {
  return (
    <PopoverPrimitive.Trigger
      data-slot="popover-trigger"
      render={render ?? <Button variant={variant} size={size} />}
      {...props}
    />
  );
}

type PositionerOptions = Pick<
  PopoverPrimitive.Positioner.Props,
  | "side"
  | "align"
  | "sideOffset"
  | "alignOffset"
  | "anchor"
  | "collisionPadding"
  | "collisionAvoidance"
  | "sticky"
  | "positionMethod"
>;

export interface PopoverPopupProps extends PopoverPrimitive.Popup.Props, PositionerOptions {
  /** Portal options. The container defaults to the current theme scope's portal container. */
  portalProps?: PopoverPrimitive.Portal.Props | undefined;
}

/**
 * The anchored surface, with its portal and positioner. The anchor gap
 * defaults to the popover's XS gap token.
 */
export function PopoverPopup({
  className,
  side,
  align,
  sideOffset,
  alignOffset,
  anchor,
  collisionPadding,
  collisionAvoidance,
  sticky,
  positionMethod,
  portalProps,
  ...props
}: PopoverPopupProps) {
  const container = usePortalContainer();
  const positionerRef = useRef<HTMLDivElement>(null);
  const gapOffset = useCallback(() => readLength(positionerRef.current, "--space-xs"), []);
  return (
    <PopoverPrimitive.Portal data-slot="popover-portal" container={container} {...portalProps}>
      <PopoverPrimitive.Positioner
        ref={positionerRef}
        data-slot="popover-positioner"
        side={side}
        align={align}
        sideOffset={sideOffset ?? gapOffset}
        alignOffset={alignOffset}
        anchor={anchor}
        collisionPadding={collisionPadding}
        collisionAvoidance={collisionAvoidance}
        sticky={sticky}
        positionMethod={positionMethod}
      >
        <PopoverPrimitive.Popup
          data-slot="popover-popup"
          className={mergeClassName(popupClassName, className)}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export interface PopoverTitleProps extends PopoverPrimitive.Title.Props {
  /** Dims the title when the popover's content is unavailable. */
  disabled?: boolean | undefined;
}

/** Labels the popover. */
export function PopoverTitle({ className, disabled = false, ...props }: PopoverTitleProps) {
  return (
    <PopoverPrimitive.Title
      data-slot="popover-title"
      data-disabled={disabled ? "" : undefined}
      className={mergeClassName(titleClassName, className)}
      {...props}
    />
  );
}

export interface PopoverDescriptionProps extends PopoverPrimitive.Description.Props {
  /** Dims the description when the popover's content is unavailable. */
  disabled?: boolean | undefined;
}

/** Describes the popover; wraps within 40ch. */
export function PopoverDescription({
  className,
  disabled = false,
  ...props
}: PopoverDescriptionProps) {
  return (
    <PopoverPrimitive.Description
      data-slot="popover-description"
      data-disabled={disabled ? "" : undefined}
      className={mergeClassName(descriptionClassName, className)}
      {...props}
    />
  );
}

export interface PopoverCloseProps
  extends PopoverPrimitive.Close.Props, Pick<ButtonProps, "variant" | "size"> {}

/** Closes the popover. A ghost Button unless `variant` or `render` says otherwise. */
export function PopoverClose({ variant = "ghost", size, render, ...props }: PopoverCloseProps) {
  return (
    <PopoverPrimitive.Close
      data-slot="popover-close"
      render={render ?? <Button variant={variant} size={size} />}
      {...props}
    />
  );
}

export type PopoverActionProps = ButtonProps;

/** The popover's configured action: a primary Button that does not close the popover by itself. */
export function PopoverAction(props: PopoverActionProps) {
  return <Button data-slot="popover-action" {...props} />;
}
