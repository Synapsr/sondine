import { Meter as MeterPrimitive } from "@base-ui/react/meter";
import { mergeClassName } from "../lib/class-name";
import { cn } from "../lib/cn";

// Sondine Meter (gui/components/sondine/meter.md): a vertical stack with S
// spacing, an optional heading row (label at the start, tabular value at the
// end), then an XXS-high neutral-3 track with a color-1 fill. The fill turns
// warning below `low` and error above `high`; only the label and value change
// when disabled. Fill, color and text changes use the Small curve.

export type MeterLevel = "low" | "normal" | "high";

/** Where a value falls between the `low` and `high` thresholds. */
export function meterLevel(value: number, low?: number, high?: number): MeterLevel {
  if (low !== undefined && value < low) return "low";
  if (high !== undefined && value > high) return "high";
  return "normal";
}

const textTransition =
  "transition-colors duration-motion ease-motion motion-reduce:transition-none";

export interface MeterProps extends MeterPrimitive.Root.Props {
  /** Values under this threshold use the warning fill (an input that is too quiet). */
  low?: number | undefined;
  /** Values over this threshold use the error fill (storage almost full). */
  high?: number | undefined;
  /**
   * Shows the label and value as unavailable, for a measurement that is paused.
   * Base UI has no disabled meter, so this only sets `data-disabled`.
   */
  disabled?: boolean | undefined;
}

/**
 * Children form the heading row, usually `<MeterLabel>` and `<MeterValue>`.
 * Without a visible label, give the root an `aria-label`.
 */
export function Meter({
  className,
  children,
  value,
  low,
  high,
  disabled = false,
  ...props
}: MeterProps) {
  const level = meterLevel(value, low, high);

  return (
    <MeterPrimitive.Root
      data-slot="meter"
      data-level={level}
      data-disabled={disabled ? "" : undefined}
      value={value}
      className={mergeClassName("group/meter flex w-full min-w-0 flex-col gap-s", className)}
      {...props}
    >
      {children == null ? null : (
        <div data-slot="meter-heading" className="flex min-w-0 items-baseline gap-s">
          {children}
        </div>
      )}
      <MeterPrimitive.Track
        data-slot="meter-track"
        className={cn(
          "relative block h-xxs w-full overflow-hidden p-0",
          "corner-full bg-neutral-3 ring-none ring-neutral-4-transparent",
        )}
      >
        <MeterPrimitive.Indicator
          data-slot="meter-indicator"
          data-level={level}
          className={cn(
            "block h-full p-0",
            "corner-full bg-color-1 ring-none ring-neutral-4-transparent",
            "data-[level=low]:bg-warning data-[level=high]:bg-error",
            "transition-[width,background-color] duration-motion ease-motion motion-reduce:transition-none",
          )}
        />
      </MeterPrimitive.Track>
    </MeterPrimitive.Root>
  );
}

export type MeterLabelProps = MeterPrimitive.Label.Props;

export function MeterLabel({ className, ...props }: MeterLabelProps) {
  return (
    <MeterPrimitive.Label
      data-slot="meter-label"
      className={mergeClassName(
        cn(
          "m-zero min-w-0",
          "font-body font-medium text-body-s text-neutral-10",
          "group-data-disabled/meter:text-neutral-6",
          textTransition,
        ),
        className,
      )}
      {...props}
    />
  );
}

export type MeterValueProps = MeterPrimitive.Value.Props;

/** The formatted value: a percentage of the range unless the root sets `format`. */
export function MeterValue({ className, ...props }: MeterValueProps) {
  return (
    <MeterPrimitive.Value
      data-slot="meter-value"
      className={mergeClassName(
        cn(
          "ms-auto shrink-0 whitespace-nowrap tabular-nums",
          "font-body font-regular text-body-xs text-neutral-7",
          "group-data-disabled/meter:text-neutral-6",
          textTransition,
        ),
        className,
      )}
      {...props}
    />
  );
}
