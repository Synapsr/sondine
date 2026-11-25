import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { mergeClassName } from "../lib/class-name";
import { cn } from "../lib/cn";

// Sondine Radio group (gui/components/sondine/radio-group.md) and Radio
// (radio.md). The group owns the value, arrow-key navigation and the form
// value; each Radio is a controlSize M circle whose dot is inset 30%. Visual
// precedence: disabled, checked, focused, hovered, rest; disabled keeps the
// rest fill and greys the dot.

const groupClassName = "flex w-[20rem] max-w-full flex-col gap-xxs";

export type RadioGroupProps<Value = unknown> = RadioGroupPrimitive.Props<Value>;

/** Name the group with `aria-labelledby`, or render it as a Fieldset. */
export function RadioGroup<Value = unknown>({ className, ...props }: RadioGroupProps<Value>) {
  return (
    <RadioGroupPrimitive<Value>
      data-slot="radio-group"
      className={mergeClassName(groupClassName, className)}
      {...props}
    />
  );
}

const radioClassName = cn(
  "relative inline-flex size-m shrink-0 items-center justify-center align-middle",
  "corner-full bg-neutral-3 ring-s ring-neutral-5",
  "transition-[background-color,box-shadow] duration-motion ease-motion motion-reduce:transition-none",
  "focus-ring",
  "not-data-checked:control-hover:ring-neutral-7",
  "control-focus:ring-color-1",
  "data-checked:bg-color-1 data-checked:ring-color-1",
  "control-disabled:bg-neutral-3 control-disabled:ring-neutral-4",
);

const dotClassName = cn(
  "pointer-events-none absolute inset-[30%] corner-full",
  "bg-neutral-1 dark:bg-neutral-10 ring-none ring-neutral-4-transparent",
  "data-disabled:bg-neutral-6",
  "transition-[opacity,background-color] duration-motion ease-motion motion-reduce:transition-none",
  "data-starting-style:opacity-0 data-ending-style:opacity-0",
);

export type RadioProps<Value = unknown> = RadioPrimitive.Root.Props<Value>;

/**
 * One choice of a `RadioGroup`. Name it with an enclosing `RadioLabel` or with
 * `aria-label`.
 */
export function Radio<Value = unknown>({ className, ...props }: RadioProps<Value>) {
  return (
    <RadioPrimitive.Root<Value>
      data-slot="radio"
      className={mergeClassName(radioClassName, className)}
      {...props}
    >
      <RadioPrimitive.Indicator data-slot="radio-indicator" className={dotClassName} />
    </RadioPrimitive.Root>
  );
}

const radioLabelVariants = cva(
  [
    "flex items-center gap-xs",
    "font-body font-regular text-body-s text-neutral-10",
    "has-data-disabled:text-neutral-6",
    "transition-[background-color,color] duration-motion ease-motion motion-reduce:transition-none",
  ],
  {
    variants: {
      variant: {
        // radio-group.md: a padded row whose fill follows its radio.
        row: [
          "corner-s bg-transparent p-s",
          "not-has-data-disabled:not-has-data-checked:hover:bg-neutral-3-transparent",
          "not-has-data-disabled:has-data-checked:bg-neutral-3",
        ],
        // radio.md: the label text placed after the control, without a surface.
        plain: "w-fit",
      },
    },
    defaultVariants: {
      variant: "row",
    },
  },
);

export interface RadioLabelProps
  extends useRender.ComponentProps<"label">, VariantProps<typeof radioLabelVariants> {}

/**
 * A `<label>` holding one `Radio` and its text, so a click anywhere on it
 * selects the radio. `row` (default) is the group's padded row; `plain` is
 * the bare label. Pass `render` to render another element.
 */
export function RadioLabel({ className, variant, render, ...props }: RadioLabelProps) {
  return useRender({
    defaultTagName: "label",
    render,
    props: {
      "data-slot": "radio-label",
      "data-variant": variant ?? "row",
      ...props,
      className: cn(radioLabelVariants({ variant }), className),
    },
  });
}

export { radioLabelVariants };
