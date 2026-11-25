import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { mergeClassName } from "../lib/class-name";
import { cn } from "../lib/cn";
import { usePortalContainer } from "../theme/portal-container";
import { Button, type ButtonProps } from "./button";

// Sondine Tooltip (gui/components/sondine/tooltip.md). The trigger part is the
// ghost Button; the popup is the inverted surface (neutral-10 on neutral-1)
// with the XS text step, small motion and the popover gap as anchor offset.

/** Shares the hover delay between tooltips, so neighbours open instantly. */
export const TooltipProvider = TooltipPrimitive.Provider;
export type TooltipProviderProps = TooltipPrimitive.Provider.Props;

/** Groups a trigger and its popup. Renders no element. */
export const Tooltip = TooltipPrimitive.Root;
export type TooltipProps<Payload = unknown> = TooltipPrimitive.Root.Props<Payload>;

/** Connects detached triggers to one tooltip. */
export const createTooltipHandle = TooltipPrimitive.createHandle;

// Base UI wants the anchor offset in pixels; reading the token keeps it linked
// to the theme's popover gap (--space-xs).
function popoverGap(): number {
  if (typeof document === "undefined") return 0;
  const value = getComputedStyle(document.documentElement).getPropertyValue("--space-xs");
  return Number.parseFloat(value) || 0;
}

export interface TooltipTriggerProps<
  Payload = unknown,
> extends TooltipPrimitive.Trigger.Props<Payload> {
  /** Variant of the default Button trigger. Ignored when `render` is given. */
  variant?: ButtonProps["variant"];
  /** Size of the default Button trigger. Ignored when `render` is given. */
  size?: ButtonProps["size"];
}

/**
 * The control the tooltip describes: a ghost Button unless `render` supplies
 * another control. The tooltip supplements its accessible name, so icon-only
 * triggers still need `aria-label`. To disable the control itself, render a
 * disabled Button with `focusableWhenDisabled` so the tooltip can still explain why.
 */
export function TooltipTrigger<Payload = unknown>({
  variant = "ghost",
  size,
  render,
  ...props
}: TooltipTriggerProps<Payload>) {
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      render={render ?? <Button variant={variant} size={size} />}
      {...props}
    />
  );
}

const popupClassName = cn(
  "flex items-center gap-xs",
  "max-h-[var(--available-height,calc(100dvh-var(--space-xl)))] max-w-[min(100%,32ch,var(--available-width,calc(100vw-var(--space-xl))))]",
  "overflow-y-auto wrap-break-word",
  "corner-s bg-neutral-10 px-xs py-xxs text-neutral-1 shadow-m ring-none ring-transparent",
  "font-body font-medium text-body-xs",
  "origin-(--transform-origin) transition-[opacity,scale] duration-motion ease-motion",
  "data-starting-style:opacity-0 data-ending-style:opacity-0",
  "motion-safe:data-starting-style:scale-(--motion-popup-scale) motion-safe:data-ending-style:scale-(--motion-popup-scale)",
  "data-instant:transition-none",
  "**:data-[slot=icon]:shrink-0",
);

export interface TooltipPopupProps extends TooltipPrimitive.Popup.Props {
  /** Preferred side of the trigger; flips to avoid collisions. Default `top`. */
  side?: TooltipPrimitive.Positioner.Props["side"];
  align?: TooltipPrimitive.Positioner.Props["align"];
  /** Distance from the trigger. Defaults to the popover gap token. */
  sideOffset?: TooltipPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: TooltipPrimitive.Positioner.Props["alignOffset"];
  anchor?: TooltipPrimitive.Positioner.Props["anchor"];
  portalProps?: TooltipPrimitive.Portal.Props | undefined;
}

/** The portalled, positioned tooltip surface. Keep its content short and non-interactive. */
export function TooltipPopup({
  className,
  side = "top",
  align = "center",
  sideOffset = popoverGap,
  alignOffset,
  anchor,
  portalProps,
  ...props
}: TooltipPopupProps) {
  const portalContainer = usePortalContainer();
  return (
    <TooltipPrimitive.Portal {...portalProps} container={portalProps?.container ?? portalContainer}>
      <TooltipPrimitive.Positioner
        data-slot="tooltip-positioner"
        className="z-50"
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        anchor={anchor}
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-popup"
          className={mergeClassName(popupClassName, className)}
          {...props}
        />
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}
