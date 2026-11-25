import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { useRender } from "@base-ui/react/use-render";
import { mergeClassName } from "../lib/class-name";
import { cn } from "../lib/cn";

// Sondine Switch (gui/components/sondine/switch.md). The track's controlSize H
// is XL (a component edit); every other dimension derives from it: width
// 1.75H, thumb inset H/8, thumb diameter and checked travel 0.75H. A press
// stretches the thumb by min(6px, diameter/4) over half the Small duration,
// shortening the checked travel by the same amount so the far edge stays put.
// Visual precedence: disabled, checked, focused, hovered, rest.

const trackClassName = cn(
  "[--switch-size:var(--space-xl)]",
  "[--switch-inset:calc(var(--switch-size)/8)]",
  "[--switch-thumb:calc(var(--switch-size)*0.75)]",
  "[--switch-travel:calc(var(--switch-size)*0.75)]",
  "[--switch-stretch:min(6px,calc(var(--switch-thumb)/4))]",
  "[--switch-direction:1] rtl:[--switch-direction:-1]",
  "group/switch relative inline-block shrink-0 align-middle",
  "h-(--switch-size) w-[calc(var(--switch-size)*1.75)] corner-full",
  "bg-neutral-4 ring-none ring-neutral-4",
  "transition-[background-color,box-shadow] duration-motion ease-motion motion-reduce:transition-none",
  "focus-ring",
  "control-focus:ring-color-1-transparent",
  "data-checked:bg-color-1 data-checked:ring-color-1-transparent",
  "control-disabled:bg-neutral-3 control-disabled:ring-neutral-4",
);

const thumbClassName = cn(
  "pointer-events-none absolute top-(--switch-inset) start-(--switch-inset)",
  "size-(--switch-thumb) corner-full bg-neutral-1 ring-s ring-neutral-4-transparent",
  "transition-[translate,width,background-color] duration-motion ease-motion motion-reduce:transition-none",
  "data-checked:translate-x-[calc(var(--switch-travel)*var(--switch-direction))]",
  "data-disabled:bg-neutral-6",
  // Pressed on the switch or anywhere on its label; never when disabled or
  // read-only, and not with reduced motion.
  "motion-safe:group-active/switch:not-data-disabled:not-data-readonly:w-[calc(var(--switch-thumb)+var(--switch-stretch))]",
  "motion-safe:group-active/switch:not-data-disabled:not-data-readonly:duration-[calc(var(--motion-duration)/2)]",
  "motion-safe:group-active/switch:not-data-disabled:not-data-readonly:data-checked:translate-x-[calc((var(--switch-travel)-var(--switch-stretch))*var(--switch-direction))]",
  "motion-safe:in-[label:active]:not-data-disabled:not-data-readonly:w-[calc(var(--switch-thumb)+var(--switch-stretch))]",
  "motion-safe:in-[label:active]:not-data-disabled:not-data-readonly:duration-[calc(var(--motion-duration)/2)]",
  "motion-safe:in-[label:active]:not-data-disabled:not-data-readonly:data-checked:translate-x-[calc((var(--switch-travel)-var(--switch-stretch))*var(--switch-direction))]",
);

export type SwitchProps = SwitchPrimitive.Root.Props;

/**
 * The switch track and thumb. Name it with an enclosing `SwitchLabel` or with
 * `aria-label`.
 */
export function Switch({ className, ...props }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={mergeClassName(trackClassName, className)}
      {...props}
    >
      <SwitchPrimitive.Thumb data-slot="switch-thumb" className={thumbClassName} />
    </SwitchPrimitive.Root>
  );
}

const labelClassName = cn(
  "inline-flex items-center gap-xs",
  "font-body font-medium text-body-s text-neutral-10",
  "has-data-disabled:text-neutral-6",
  "transition-colors duration-motion ease-motion motion-reduce:transition-none",
);

export type SwitchLabelProps = useRender.ComponentProps<"label">;

/**
 * The switch row: a `<label>` holding the `Switch` and its text, so a click on
 * the text toggles the switch. Pass `render` to render another element.
 */
export function SwitchLabel({ className, render, ...props }: SwitchLabelProps) {
  return useRender({
    defaultTagName: "label",
    render,
    props: { "data-slot": "switch-label", ...props, className: cn(labelClassName, className) },
  });
}
