import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import { mergeClassName } from "../lib/class-name";
import { cn } from "../lib/cn";

// Sondine Scroll area (gui/components/sondine/scroll-area.md). The root is the
// framed, clipped surface (neutral-1, S corners, outer edge); the viewport
// fills it and inherits its corners; the content carries the M padding and S
// gap so the padding scrolls with it. Scrollbars are XS thick with an XXS
// margin; the thumb is neutral-4, neutral-5 on hover or while the viewport has
// keyboard focus, neutral-3 when disabled.

// The viewport is clipped by the root, so the root draws its focus outline.
const viewportFocus = "has-[[data-slot=scroll-area-viewport]:focus-visible]:focus-ring-within";

export type ScrollAreaOrientation = "vertical" | "horizontal" | "both";

export interface ScrollAreaProps extends ScrollAreaPrimitive.Root.Props {
  /**
   * The axes that scroll. With "vertical" (the default) the content is no
   * wider than the viewport, so text wraps instead of overflowing sideways.
   */
  orientation?: ScrollAreaOrientation | undefined;
  /** Dims the content and the thumb. Scrolling still works. */
  disabled?: boolean | undefined;
  /** Classes for the content box, for a layout other than the padded column. */
  contentClassName?: string | undefined;
}

export function ScrollArea({
  className,
  children,
  orientation = "vertical",
  disabled = false,
  contentClassName,
  ...props
}: ScrollAreaProps) {
  const disabledAttribute = disabled ? "" : undefined;
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      data-disabled={disabledAttribute}
      className={mergeClassName(
        cn(
          "group/scroll-area relative min-h-0 overflow-hidden p-0",
          "corner-s bg-neutral-1 ring-s ring-neutral-4-transparent shadow-none",
          viewportFocus,
        ),
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className="size-full rounded-[inherit] overscroll-contain outline-none"
      >
        <ScrollAreaPrimitive.Content
          data-slot="scroll-area-content"
          data-disabled={disabledAttribute}
          className={cn(
            "flex flex-col gap-s px-m py-m",
            "font-body font-regular text-body-s text-neutral-8",
            "data-disabled:text-neutral-6",
            "transition-colors duration-motion ease-motion motion-reduce:transition-none",
            // Base UI sizes the content to fit for horizontal scrolling.
            orientation === "vertical" && "min-w-0!",
            contentClassName,
          )}
        >
          {children}
        </ScrollAreaPrimitive.Content>
      </ScrollAreaPrimitive.Viewport>
      {orientation === "horizontal" ? null : (
        <ScrollAreaScrollbar orientation="vertical" disabled={disabled} />
      )}
      {orientation === "vertical" ? null : (
        <ScrollAreaScrollbar orientation="horizontal" disabled={disabled} />
      )}
      {orientation === "both" ? (
        <ScrollAreaPrimitive.Corner data-slot="scroll-area-corner" className="bg-transparent" />
      ) : null}
    </ScrollAreaPrimitive.Root>
  );
}

export interface ScrollAreaScrollbarProps extends ScrollAreaPrimitive.Scrollbar.Props {
  /** Uses the disabled thumb color. */
  disabled?: boolean | undefined;
}

/** One scrollbar and its thumb. `ScrollArea` renders these itself. */
export function ScrollAreaScrollbar({
  className,
  orientation = "vertical",
  disabled = false,
  ...props
}: ScrollAreaScrollbarProps) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={mergeClassName(
        cn(
          "m-xxs flex p-0 select-none",
          "corner-full bg-transparent ring-none ring-neutral-4-transparent",
          "data-[orientation=vertical]:w-xs data-[orientation=horizontal]:h-xs",
        ),
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        data-slot="scroll-area-thumb"
        data-disabled={disabled ? "" : undefined}
        className={cn(
          "corner-full bg-neutral-4 ring-none ring-transparent",
          "data-[orientation=vertical]:w-full data-[orientation=horizontal]:h-full",
          "not-data-disabled:group-has-[[data-slot=scroll-area-viewport]:focus-visible]/scroll-area:bg-neutral-5",
          "control-hover:bg-neutral-5 control-disabled:bg-neutral-3",
          "transition-colors duration-motion ease-motion motion-reduce:transition-none",
        )}
      />
    </ScrollAreaPrimitive.Scrollbar>
  );
}
