import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import { motion, type Transition, useReducedMotion } from "motion/react";
import { mergeClassName } from "../lib/class-name";
import { cn } from "../lib/cn";
import { largeTransition } from "../lib/motion";

// Sondine Progress (gui/components/sondine/progress.md): a vertical stack with
// S spacing, an optional heading row (label at the start, tabular value at the
// end), then an XXS-high neutral-3 track with a color-1 fill. Loading and
// complete keep the rest look; only the label and value change when disabled.

// The indeterminate fill is 35% of the track and travels to 185% of its own
// width (the track's far edge), back and forth over four Large durations.
const indeterminateTransition = {
  duration: largeTransition.duration * 4,
  ease: largeTransition.ease,
  repeat: Infinity,
  repeatType: "reverse",
} as const satisfies Transition;

const textTransition =
  "transition-colors duration-motion ease-motion motion-reduce:transition-none";

export interface ProgressProps extends ProgressPrimitive.Root.Props {
  /**
   * Shows the label and value as unavailable, for work that is paused. Base UI
   * has no disabled progress, so this only sets `data-disabled`.
   */
  disabled?: boolean | undefined;
}

/**
 * Children form the heading row, usually `<ProgressLabel>` and `<ProgressValue>`.
 * Pass `value={null}` for work of unknown length, with a translated
 * `aria-valuetext` (Base UI's default is "indeterminate progress"). Without a
 * visible label, give the root an `aria-label`.
 */
export function Progress({
  className,
  children,
  value,
  disabled = false,
  ...props
}: ProgressProps) {
  const reduceMotion = useReducedMotion() === true;
  const looping = value === null && !reduceMotion;

  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      data-disabled={disabled ? "" : undefined}
      value={value}
      className={mergeClassName("group/progress flex w-full min-w-0 flex-col gap-s", className)}
      {...props}
    >
      {children == null ? null : (
        <div data-slot="progress-heading" className="flex min-w-0 items-baseline gap-s">
          {children}
        </div>
      )}
      <ProgressPrimitive.Track
        data-slot="progress-track"
        className={cn(
          "relative block h-xxs w-full overflow-hidden p-0",
          "corner-full bg-neutral-3 ring-none ring-neutral-4-transparent",
        )}
      >
        <ProgressPrimitive.Indicator
          data-slot="progress-indicator"
          className={cn(
            "block h-full p-0",
            "corner-full bg-color-1 ring-none ring-neutral-4-transparent",
            "transition-[width] duration-motion ease-motion motion-reduce:transition-none",
            "data-indeterminate:w-[35%]",
          )}
          render={
            looping ? (
              <motion.div animate={{ x: ["0%", "185%"] }} transition={indeterminateTransition} />
            ) : undefined
          }
        />
      </ProgressPrimitive.Track>
    </ProgressPrimitive.Root>
  );
}

export type ProgressLabelProps = ProgressPrimitive.Label.Props;

export function ProgressLabel({ className, ...props }: ProgressLabelProps) {
  return (
    <ProgressPrimitive.Label
      data-slot="progress-label"
      className={mergeClassName(
        cn(
          "m-zero min-w-0",
          "font-body font-medium text-body-s text-neutral-10",
          "group-data-disabled/progress:text-neutral-6",
          textTransition,
        ),
        className,
      )}
      {...props}
    />
  );
}

export type ProgressValueProps = ProgressPrimitive.Value.Props;

/**
 * The formatted value (a percentage by default). While indeterminate it is
 * empty: a children function `(formatted, value) => …` receives `value === null`
 * and can show a status such as "En cours".
 */
export function ProgressValue({ className, ...props }: ProgressValueProps) {
  return (
    <ProgressPrimitive.Value
      data-slot="progress-value"
      className={mergeClassName(
        cn(
          "ms-auto shrink-0 whitespace-nowrap tabular-nums",
          "font-body font-regular text-body-xs text-neutral-7",
          "group-data-disabled/progress:text-neutral-6",
          textTransition,
        ),
        className,
      )}
      {...props}
    />
  );
}
