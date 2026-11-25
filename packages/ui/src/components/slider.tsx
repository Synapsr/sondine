import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { useState } from "react";
import { mergeClassName } from "../lib/class-name";
import { cn } from "../lib/cn";

// Sondine Slider (gui/components/sondine/slider.md): a vertical stack with S
// spacing, an optional heading row (label at the start, tabular value at the
// end), then the control. The track is an XL-high neutral-3 pill with a color-1
// fill; each thumb is an L-sized neutral-2 circle with a color-1 edge.
//
// Because the track (T) is taller than the thumb, a horizontal single-value
// slider insets the thumb travel: the control has T/2 inline padding, the
// track bleeds back over it with -T/2 margins, and the indicator and thumb are
// positioned in a "travel" box inset by T/2 inside the track. The thumb centre
// sits at T/2 + (W - T)f and the fill is T + (W - T)f wide. Ranges, vertical
// sliders and an explicit `thumbAlignment` keep Base UI's own geometry.

const focusOutline = "focus-ring-within";

const textTransition =
  "transition-colors duration-motion ease-motion motion-reduce:transition-none";

type SliderValue = number | readonly number[];

function thumbCount(value: SliderValue | undefined): number {
  return value === undefined || typeof value === "number" ? 1 : value.length;
}

export interface SliderProps<
  Value extends SliderValue = SliderValue,
> extends SliderPrimitive.Root.Props<Value> {
  /** Accessible name of each thumb's input, when there is no `SliderLabel` (or for ranges). */
  getAriaLabel?: ((index: number) => string) | null | undefined;
  /** Spoken value of each thumb's input, for values the formatted number does not explain. */
  getAriaValueText?:
    | ((formattedValue: string, value: number, index: number) => string)
    | null
    | undefined;
}

/**
 * Children form the heading row, usually `<SliderLabel>` and `<SliderValue>`.
 * Pass an array value for a range; one thumb is rendered per value.
 */
export function Slider<Value extends SliderValue>({
  className,
  children,
  value,
  defaultValue,
  orientation = "horizontal",
  thumbAlignment,
  onValueChange,
  onValueCommitted,
  getAriaLabel,
  getAriaValueText,
  ...props
}: SliderProps<Value>) {
  const count = thumbCount(value ?? defaultValue);
  const insetTravel = orientation === "horizontal" && count === 1 && thumbAlignment === undefined;
  // Dragging follows the pointer; track presses, keys and other changes ease.
  const [followingPointer, setFollowingPointer] = useState(false);

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      value={value}
      defaultValue={defaultValue}
      orientation={orientation}
      thumbAlignment={thumbAlignment}
      onValueChange={(next, details) => {
        setFollowingPointer(details.reason === "drag");
        onValueChange?.(next, details);
      }}
      onValueCommitted={(next, details) => {
        setFollowingPointer(false);
        onValueCommitted?.(next, details);
      }}
      className={mergeClassName(
        cn(
          "group/slider flex min-w-0 flex-col gap-s [--slider-track:var(--space-xl)]",
          // Chosen from the prop, not a data variant, so a caller's size wins.
          orientation === "vertical" ? "h-full" : "w-full",
        ),
        className,
      )}
      {...props}
    >
      {children == null ? null : (
        <div data-slot="slider-heading" className="flex min-w-0 items-baseline gap-s">
          {children}
        </div>
      )}
      <SliderPrimitive.Control
        data-slot="slider-control"
        className={cn(
          "relative flex min-h-l w-full touch-none items-center p-0 select-none",
          "data-[orientation=vertical]:min-w-l data-[orientation=vertical]:flex-1 data-[orientation=vertical]:flex-col",
          insetTravel && "min-h-(--slider-track) px-[calc(var(--slider-track)/2)]",
        )}
      >
        <SliderPrimitive.Track
          data-slot="slider-track"
          className={cn(
            "relative p-0 select-none",
            "corner-full bg-neutral-3 ring-none ring-neutral-4-transparent",
            "data-[orientation=horizontal]:h-(--slider-track) data-[orientation=horizontal]:flex-1",
            "data-[orientation=vertical]:w-(--slider-track) data-[orientation=vertical]:flex-1",
            insetTravel && "-mx-[calc(var(--slider-track)/2)]",
            focusOutline,
          )}
        >
          <div
            data-slot="slider-travel"
            className={cn(
              "absolute inset-0 h-full data-[orientation=vertical]:w-full",
              insetTravel && "inset-x-[calc(var(--slider-track)/2)]",
            )}
            data-orientation={orientation}
          >
            <SliderPrimitive.Indicator
              data-slot="slider-indicator"
              className={cn(
                "p-0 select-none",
                "corner-full bg-color-1 ring-none ring-neutral-4-transparent",
                "data-disabled:bg-neutral-5",
                insetTravel &&
                  "-ms-[calc(var(--slider-track)/2)] box-content px-[calc(var(--slider-track)/2)]",
                followingPointer
                  ? "transition-[background-color]"
                  : "transition-[width,height,inset-inline-start,bottom,background-color]",
                "duration-motion ease-motion motion-reduce:transition-none",
              )}
            />
            {Array.from({ length: count }, (_, index) => (
              <SliderPrimitive.Thumb
                key={index}
                index={index}
                getAriaLabel={getAriaLabel}
                getAriaValueText={getAriaValueText}
                data-slot="slider-thumb"
                className={cn(
                  "size-l p-0 select-none",
                  "corner-full bg-neutral-2 ring-s ring-color-1 shadow-none",
                  "data-disabled:ring-neutral-5-transparent",
                  focusOutline,
                  followingPointer
                    ? "transition-[box-shadow]"
                    : "transition-[inset-inline-start,bottom,box-shadow]",
                  "duration-motion ease-motion motion-reduce:transition-none",
                )}
              />
            ))}
          </div>
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export type SliderLabelProps = SliderPrimitive.Label.Props;

/** Visible name, associated with every thumb by Base UI. */
export function SliderLabel({ className, ...props }: SliderLabelProps) {
  return (
    <SliderPrimitive.Label
      data-slot="slider-label"
      className={mergeClassName(
        cn(
          "m-zero min-w-0",
          "font-body font-medium text-body-s text-neutral-10",
          "data-disabled:text-neutral-6",
          textTransition,
        ),
        className,
      )}
      {...props}
    />
  );
}

export type SliderValueProps = SliderPrimitive.Value.Props;

/** The formatted value, or each value of a range; a children function customises it. */
export function SliderValue({ className, ...props }: SliderValueProps) {
  return (
    <SliderPrimitive.Value
      data-slot="slider-value"
      className={mergeClassName(
        cn(
          "ms-auto shrink-0 whitespace-nowrap tabular-nums",
          "font-body font-regular text-body-xs text-neutral-7",
          "data-disabled:text-neutral-6",
          textTransition,
        ),
        className,
      )}
      {...props}
    />
  );
}
