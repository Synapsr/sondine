import { Input as InputPrimitive } from "@base-ui/react/input";
import { cva } from "class-variance-authority";
import { mergeClassName } from "../lib/class-name";

// Sondine Text field control (gui/components/sondine/input.md), also the
// control of Field, Fieldset, Form and Number field. Precedence follows the
// spec: disabled, then focus, then hover, then rest. Validation (invalid,
// valid) supplies the fill and edge color over hover and focus, while the
// focus outline stays. Read-only changes the fill and text only. Base UI
// also marks an empty optional field valid after a submit; the valid look
// needs a value (data-filled) so an empty field never reads as confirmed.
const inputVariants = cva([
  "w-full min-w-0 corner-s px-m py-s",
  "font-body font-regular text-body-s",
  "bg-neutral-3 text-neutral-10 ring-s ring-neutral-4 shadow-none",
  "placeholder:text-cte-text-muted",
  "transition-[background-color,color,box-shadow] duration-motion ease-motion motion-reduce:transition-none",
  "focus-ring",
  "read-only:bg-neutral-2 read-only:text-neutral-8",
  "not-data-invalid:not-[[data-valid][data-filled]]:control-hover:ring-neutral-5",
  "not-data-invalid:not-[[data-valid][data-filled]]:control-focus:ring-color-1-transparent",
  "data-valid:data-filled:bg-success-transparent data-valid:data-filled:ring-success",
  "data-invalid:bg-error-transparent data-invalid:ring-error",
  // Disabled inputs also match :read-only, so the rest fill is restored here.
  "control-disabled:bg-neutral-3 control-disabled:text-neutral-6 control-disabled:ring-neutral-4-transparent",
  "control-disabled:placeholder:text-neutral-6",
]);

export type InputProps = InputPrimitive.Props;

/**
 * A native text input. Inside a `Field` it takes the field's label,
 * description, validation and disabled state.
 */
export function Input({ className, ...props }: InputProps) {
  return (
    <InputPrimitive
      data-slot="input"
      className={mergeClassName(inputVariants(), className)}
      {...props}
    />
  );
}

export { inputVariants };
