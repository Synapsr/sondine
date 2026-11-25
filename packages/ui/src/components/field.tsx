import { Field as FieldPrimitive } from "@base-ui/react/field";
import { mergeClassName } from "../lib/class-name";
import { cn } from "../lib/cn";

// Sondine Field (gui/components/sondine/field.md): a vertical stack of label,
// control (the shared Input), description and error. Base UI sets
// data-disabled and data-invalid on every part; the label, description and
// error only change color when disabled.

const textTransition =
  "transition-colors duration-motion ease-motion motion-reduce:transition-none";

export type FieldProps = FieldPrimitive.Root.Props;

/** Imperative actions for `actionsRef` (`validate()`). */
export type FieldActions = FieldPrimitive.Root.Actions;

export function Field({ className, ...props }: FieldProps) {
  return (
    <FieldPrimitive.Root
      data-slot="field"
      className={mergeClassName("flex min-w-0 flex-col items-start gap-xs", className)}
      {...props}
    />
  );
}

export type FieldLabelProps = FieldPrimitive.Label.Props;

export function FieldLabel({ className, ...props }: FieldLabelProps) {
  return (
    <FieldPrimitive.Label
      data-slot="field-label"
      className={mergeClassName(
        cn(
          "m-zero inline-flex items-center gap-xs",
          "font-body font-medium text-body-s text-neutral-10",
          "data-disabled:text-neutral-6",
          "**:data-[slot=icon]:shrink-0",
          textTransition,
        ),
        className,
      )}
      {...props}
    />
  );
}

export type FieldDescriptionProps = FieldPrimitive.Description.Props;

export function FieldDescription({ className, ...props }: FieldDescriptionProps) {
  return (
    <FieldPrimitive.Description
      data-slot="field-description"
      className={mergeClassName(
        cn(
          "m-zero max-w-[40ch]",
          "font-body font-regular text-body-s text-neutral-7",
          "data-disabled:text-neutral-6",
          textTransition,
        ),
        className,
      )}
      {...props}
    />
  );
}

export type FieldErrorProps = FieldPrimitive.Error.Props;

/**
 * Shows the field's validation message when the control is invalid, or the
 * children when given. `match` picks one validity key (e.g. "valueMissing");
 * `match` set to true always shows it, for validity owned by the app.
 */
export function FieldError({ className, ...props }: FieldErrorProps) {
  return (
    <FieldPrimitive.Error
      data-slot="field-error"
      className={mergeClassName(
        cn(
          "m-zero max-w-[40ch]",
          "font-body font-regular text-body-xs text-error",
          "data-disabled:text-neutral-6",
          "transition-[color,opacity] duration-motion ease-motion motion-reduce:transition-none",
          "data-starting-style:opacity-0 data-ending-style:opacity-0",
        ),
        className,
      )}
      {...props}
    />
  );
}

export type FieldItemProps = FieldPrimitive.Item.Props;

/** One labelled option of a checkbox or radio group inside a Field. */
export function FieldItem({ className, ...props }: FieldItemProps) {
  return (
    <FieldPrimitive.Item
      data-slot="field-item"
      className={mergeClassName("flex items-center gap-xs", className)}
      {...props}
    />
  );
}

/** Render-prop access to the field's validity (no element of its own). */
export const FieldValidity = FieldPrimitive.Validity;
