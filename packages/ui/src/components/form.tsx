import { Form as FormPrimitive } from "@base-ui/react/form";
import type { ComponentProps } from "react";
import { mergeClassName } from "../lib/class-name";
import { cn } from "../lib/cn";

// Sondine Form (gui/components/sondine/form.md): a native form stacking
// complete Fields and a submit Button (primary variant, type="submit") with
// M spacing. The form never restyles the buttons it contains.

// Base UI's own constraint (a string-keyed record), so interfaces work too.
type AnyFormValues = FormPrimitive.Values;

export type FormProps<FormValues extends AnyFormValues = AnyFormValues> =
  FormPrimitive.Props<FormValues>;

export function Form<FormValues extends AnyFormValues = AnyFormValues>({
  className,
  ...props
}: FormProps<FormValues>) {
  return (
    <FormPrimitive<FormValues>
      data-slot="form"
      className={mergeClassName("flex min-w-0 flex-col gap-m", className)}
      {...props}
    />
  );
}

export type FormStatusProps = ComponentProps<"p">;

/**
 * The outcome of a submission ("Préférences enregistrées"), announced
 * politely. Keep it mounted and change its children so screen readers hear
 * the update. Uses the Field description typography.
 */
export function FormStatus({ className, ...props }: FormStatusProps) {
  return (
    <p
      data-slot="form-status"
      role="status"
      className={cn(
        "m-zero max-w-[40ch]",
        "font-body font-regular text-body-s text-neutral-7",
        className,
      )}
      {...props}
    />
  );
}
