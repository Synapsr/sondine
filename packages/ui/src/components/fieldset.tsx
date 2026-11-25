import { Fieldset as FieldsetPrimitive } from "@base-ui/react/fieldset";
import { mergeClassName } from "../lib/class-name";
import { cn } from "../lib/cn";

// Sondine Fieldset (gui/components/sondine/fieldset.md): a native fieldset
// stacking a legend and complete Fields with M spacing. Disabling the
// fieldset disables every nested Field (Base UI and the native element).

export type FieldsetProps = FieldsetPrimitive.Root.Props;

export function Fieldset({ className, ...props }: FieldsetProps) {
  return (
    <FieldsetPrimitive.Root
      data-slot="fieldset"
      className={mergeClassName("m-zero flex min-w-0 flex-col gap-m p-zero", className)}
      {...props}
    />
  );
}

export type FieldsetLegendProps = FieldsetPrimitive.Legend.Props;

export function FieldsetLegend({ className, ...props }: FieldsetLegendProps) {
  return (
    <FieldsetPrimitive.Legend
      data-slot="fieldset-legend"
      className={mergeClassName(
        cn(
          "font-body font-medium text-body-m text-neutral-10",
          "data-disabled:text-neutral-6",
          "transition-colors duration-motion ease-motion motion-reduce:transition-none",
        ),
        className,
      )}
      {...props}
    />
  );
}
