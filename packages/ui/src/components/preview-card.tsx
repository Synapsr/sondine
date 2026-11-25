import { PreviewCard as PreviewCardPrimitive } from "@base-ui/react/preview-card";
import { useRender } from "@base-ui/react/use-render";
import { mergeClassName } from "../lib/class-name";
import { cn } from "../lib/cn";
import { usePortalContainer } from "../theme/portal-container";

// Sondine Preview card (gui/components/sondine/preview-card.md). The trigger
// stays a real link in color-1; the popup reuses Popover's 300px column with
// its own surface (neutral-1 light, neutral-2 dark), title (M step) and
// description (S step, neutral-7).

/** Groups a link and its preview. Renders no element. */
export const PreviewCard = PreviewCardPrimitive.Root;
export type PreviewCardProps<Payload = unknown> = PreviewCardPrimitive.Root.Props<Payload>;

/** Connects detached triggers to one preview card. */
export const createPreviewCardHandle = PreviewCardPrimitive.createHandle;

// Base UI wants the anchor offset in pixels; reading the token keeps it linked
// to the theme's popover gap (--space-xs).
function popoverGap(): number {
  if (typeof document === "undefined") return 0;
  const value = getComputedStyle(document.documentElement).getPropertyValue("--space-xs");
  return Number.parseFloat(value) || 0;
}

const triggerClassName = cn(
  "corner-s p-zero text-color-1 ring-none ring-transparent",
  "font-body font-medium text-body-s",
  "transition-[color,box-shadow] duration-motion ease-motion motion-reduce:transition-none",
  "focus-ring control-focus:ring-color-1",
  "control-disabled:text-neutral-6",
);

export interface PreviewCardTriggerProps<
  Payload = unknown,
> extends PreviewCardPrimitive.Trigger.Props<Payload> {
  /**
   * Renders the link without navigation or preview (no `href`,
   * `aria-disabled`), in the spec's disabled color.
   */
  disabled?: boolean | undefined;
}

/** The link that opens the preview on hover or focus and still navigates on click. */
export function PreviewCardTrigger<Payload = unknown>({
  className,
  disabled = false,
  ...props
}: PreviewCardTriggerProps<Payload>) {
  if (disabled) return <DisabledLink className={className} {...props} />;
  return (
    <PreviewCardPrimitive.Trigger
      data-slot="preview-card-trigger"
      className={mergeClassName(triggerClassName, className)}
      {...props}
    />
  );
}

function DisabledLink<Payload>({
  className,
  render,
  ref,
  href: _href,
  delay: _delay,
  closeDelay: _closeDelay,
  handle: _handle,
  payload: _payload,
  ...props
}: Omit<PreviewCardTriggerProps<Payload>, "disabled">) {
  const state = { open: false };
  return useRender({
    defaultTagName: "a",
    render,
    ref,
    state,
    props: {
      "data-slot": "preview-card-trigger",
      "aria-disabled": true,
      ...props,
      "data-disabled": "",
      className: cn(
        triggerClassName,
        typeof className === "function" ? className(state) : className,
      ),
    },
  });
}

const popupClassName = cn(
  "flex w-[300px] flex-col gap-xs overflow-y-auto",
  "max-h-[var(--available-height,calc(100dvh-var(--space-xl)))] max-w-[min(var(--available-width,100vw),calc(100vw-var(--space-xl)),420px)]",
  "corner-m bg-neutral-1 p-m text-neutral-10 shadow-m ring-s ring-neutral-4-transparent dark:bg-neutral-2",
  "font-body font-regular text-body-s",
  "origin-(--transform-origin) transition-[opacity,scale] duration-motion ease-motion",
  "data-starting-style:opacity-0 data-ending-style:opacity-0",
  "motion-safe:data-starting-style:scale-(--motion-popup-scale) motion-safe:data-ending-style:scale-(--motion-popup-scale)",
  "data-instant:transition-none",
);

export interface PreviewCardPopupProps extends PreviewCardPrimitive.Popup.Props {
  /** Preferred side of the link; flips to avoid collisions. Default `bottom`. */
  side?: PreviewCardPrimitive.Positioner.Props["side"];
  align?: PreviewCardPrimitive.Positioner.Props["align"];
  /** Distance from the link. Defaults to the popover gap token. */
  sideOffset?: PreviewCardPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: PreviewCardPrimitive.Positioner.Props["alignOffset"];
  anchor?: PreviewCardPrimitive.Positioner.Props["anchor"];
  portalProps?: PreviewCardPrimitive.Portal.Props | undefined;
}

/** The portalled preview surface: a vertical stack of title, description and content. */
export function PreviewCardPopup({
  className,
  side = "bottom",
  align = "center",
  sideOffset = popoverGap,
  alignOffset,
  anchor,
  portalProps,
  ...props
}: PreviewCardPopupProps) {
  const portalContainer = usePortalContainer();
  return (
    <PreviewCardPrimitive.Portal
      {...portalProps}
      container={portalProps?.container ?? portalContainer}
    >
      <PreviewCardPrimitive.Positioner
        data-slot="preview-card-positioner"
        className="z-50"
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        anchor={anchor}
      >
        <PreviewCardPrimitive.Popup
          data-slot="preview-card-popup"
          className={mergeClassName(popupClassName, className)}
          {...props}
        />
      </PreviewCardPrimitive.Positioner>
    </PreviewCardPrimitive.Portal>
  );
}

interface PreviewCardTextProps extends useRender.ComponentProps<"p"> {
  /** Shows the text in the spec's disabled color (neutral-6). */
  disabled?: boolean | undefined;
}

export type PreviewCardTitleProps = PreviewCardTextProps;

/** The preview's heading line (M step, medium). Renders a `<p>`; use `render` for a heading. */
export function PreviewCardTitle({
  className,
  render,
  ref,
  disabled = false,
  ...props
}: PreviewCardTitleProps) {
  return useRender({
    defaultTagName: "p",
    render,
    ref,
    props: {
      "data-slot": "preview-card-title",
      "data-disabled": disabled ? "" : undefined,
      ...props,
      className: cn(
        "m-zero text-neutral-10 font-body font-medium text-body-m",
        "data-disabled:text-neutral-6",
        className,
      ),
    },
  });
}

export type PreviewCardDescriptionProps = PreviewCardTextProps;

/** Supporting text (S step, neutral-7), wrapped within 40ch. */
export function PreviewCardDescription({
  className,
  render,
  ref,
  disabled = false,
  ...props
}: PreviewCardDescriptionProps) {
  return useRender({
    defaultTagName: "p",
    render,
    ref,
    props: {
      "data-slot": "preview-card-description",
      "data-disabled": disabled ? "" : undefined,
      ...props,
      className: cn(
        "m-zero max-w-[40ch] text-neutral-7 font-body font-regular text-body-s",
        "data-disabled:text-neutral-6",
        className,
      ),
    },
  });
}
