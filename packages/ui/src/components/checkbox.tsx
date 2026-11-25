import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { useRender } from "@base-ui/react/use-render";
import { type ComponentPropsWithRef, useEffect, useState } from "react";
import { CheckIcon, MinusIcon } from "../icon";
import { mergeClassName } from "../lib/class-name";
import { cn } from "../lib/cn";

// Sondine Checkbox (gui/components/sondine/checkbox.md). The square is
// controlSize L (a component edit). The unchecked surface stays on the root;
// a separate Color 1 fill scales from the centre over it when checked or
// indeterminate, and the mark (70% of the control) scales in after it, a
// check drawing its stroke as it does.
// Visual precedence: disabled, indeterminate, checked, focused, hovered, rest;
// disabled keeps the rest surface and greys the mark.

const rootClassName = cn(
  "[--checkbox-size:var(--space-l)]",
  "group/checkbox relative inline-flex shrink-0 items-center justify-center align-middle",
  "size-(--checkbox-size) corner-xs bg-neutral-3 ring-s ring-neutral-4",
  "transition-[background-color,box-shadow] duration-motion ease-motion motion-reduce:transition-none",
  "focus-ring",
  "not-data-checked:not-data-indeterminate:control-hover:bg-neutral-4",
  "not-data-checked:not-data-indeterminate:control-hover:ring-neutral-5",
  "control-focus:ring-color-1-transparent",
  "data-checked:ring-color-1-transparent data-indeterminate:ring-color-1-transparent",
  "control-disabled:bg-neutral-3 control-disabled:ring-neutral-4",
);

const fillClassName = cn(
  "pointer-events-none absolute inset-0 rounded-[inherit] bg-color-1",
  "scale-0 transition-[scale] duration-motion ease-motion motion-reduce:transition-none",
  "group-data-checked/checkbox:group-not-data-disabled/checkbox:scale-100",
  "group-data-indeterminate/checkbox:group-not-data-disabled/checkbox:scale-100",
);

const indicatorClassName = cn(
  "relative flex items-center justify-center text-cte-accent-text",
  "data-disabled:text-neutral-6",
  "transition-[scale,color] ease-motion motion-reduce:transition-none",
  "duration-[calc(var(--motion-duration)*0.9)] delay-[calc(var(--motion-duration)*0.35)]",
  "data-starting-style:scale-0",
  "data-ending-style:scale-0 data-ending-style:delay-0 data-ending-style:duration-[calc(var(--motion-duration)*0.7)]",
);

const markClassName = cn(
  "size-[calc(var(--checkbox-size)*0.7)] shrink-0",
  // The check draws itself as it appears (Téo, 2026-11-19); a minus only scales.
  "data-draw:[&_polyline]:[stroke-dasharray:24]",
  "motion-safe:data-draw:[&_polyline]:animate-[sondine-check-draw_calc(var(--motion-duration)*1.5)_ease-out_calc(var(--motion-duration)*0.35)_both]",
);

type Mark = "check" | "minus";

interface CheckboxMarkProps extends ComponentPropsWithRef<"span"> {
  checked: boolean;
  indeterminate: boolean;
  /** Whether the box was already on screen: a check shown on first paint does not draw. */
  settled: boolean;
}

// While the indicator exits it is neither checked nor indeterminate, so the
// mark it showed last is kept until Base UI unmounts it (a minus must not
// turn into a check as it shrinks away).
function CheckboxMark({ checked, indeterminate, settled, ...props }: CheckboxMarkProps) {
  const [shown, setShown] = useState<Mark>(indeterminate ? "minus" : "check");
  // Read once: a mark that appears when the user checks the box draws itself.
  const [draw] = useState(settled);
  const mark: Mark = indeterminate ? "minus" : checked ? "check" : shown;
  if (mark !== shown) setShown(mark);
  const Glyph = mark === "minus" ? MinusIcon : CheckIcon;
  return (
    <span data-mark={mark} {...props}>
      <Glyph data-draw={draw && mark === "check" ? "" : undefined} className={markClassName} />
    </span>
  );
}

export type CheckboxProps = CheckboxPrimitive.Root.Props;

/**
 * A checkbox with a check mark, or a minus when `indeterminate`. Name it with
 * an enclosing `CheckboxLabel` or with `aria-label`.
 */
export function Checkbox({ className, ...props }: CheckboxProps) {
  const [settled, setSettled] = useState(false);
  useEffect(() => setSettled(true), []);
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={mergeClassName(rootClassName, className)}
      {...props}
    >
      <span data-slot="checkbox-fill" aria-hidden className={fillClassName} />
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className={indicatorClassName}
        render={(indicatorProps, state) => (
          <CheckboxMark
            {...indicatorProps}
            checked={state.checked}
            indeterminate={state.indeterminate}
            settled={settled}
          />
        )}
      />
    </CheckboxPrimitive.Root>
  );
}

const labelClassName = cn(
  "inline-flex items-center gap-xs",
  "font-body font-regular text-body-s text-neutral-10",
  "has-data-disabled:text-neutral-6",
  "transition-colors duration-motion ease-motion motion-reduce:transition-none",
);

export type CheckboxLabelProps = useRender.ComponentProps<"label">;

/**
 * The checkbox row: a `<label>` holding the `Checkbox` and its text, so a
 * click on the text toggles it. Pass `render` to render another element.
 */
export function CheckboxLabel({ className, render, ...props }: CheckboxLabelProps) {
  return useRender({
    defaultTagName: "label",
    render,
    props: { "data-slot": "checkbox-label", ...props, className: cn(labelClassName, className) },
  });
}
