import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";

// Sondine Badge. The theme has no Badge specification, so it is built from
// the foundations (a coverage gap):
// - neutral uses the theme's option badge role (Neutral 4 fill, Neutral 10 label);
// - status variants fill with the status color and take the label the
//   resolver gives status fills (Button danger): black in both modes, which is
//   Neutral 10 in light and Neutral 1 in dark. Black clears 4.5:1 on all three
//   colors; white and the status colors as text on light surfaces do not.
//   light-dark() follows the nearest theme scope, as Dialog's surface does.
// The label uses the detail typography (XS) at the medium label weight, in a
// box one S line high so a badge never grows a row of S text. The edge is a
// ring at the theme's border width (0 in this theme).
const badgeVariants = cva(
  [
    "inline-flex min-h-(--line-s) shrink-0 items-center justify-center gap-xxs whitespace-nowrap",
    "corner-xs px-xs ring-s",
    "font-body font-medium text-body-xs tabular-nums",
    "focus-ring",
    "**:data-[slot=icon]:pointer-events-none **:data-[slot=icon]:shrink-0",
  ],
  {
    variants: {
      variant: {
        neutral: "bg-option-badge-background text-option-badge-foreground ring-border-default",
        success:
          "bg-success text-[color:light-dark(var(--neutral-10),var(--neutral-1))] ring-success-transparent",
        warning:
          "bg-warning text-[color:light-dark(var(--neutral-10),var(--neutral-1))] ring-warning-transparent",
        error:
          "bg-error text-[color:light-dark(var(--neutral-10),var(--neutral-1))] ring-error-transparent",
      },
    },
    defaultVariants: {
      variant: "neutral",
    },
  },
);

export interface BadgeProps
  extends useRender.ComponentProps<"span">, VariantProps<typeof badgeVariants> {}

/**
 * A short status or count label, for example "Transcrite" or "3". A span by
 * default; `render` swaps the element (a link, a list item). A badge is not a
 * control: use Button or Toggle for actions.
 */
export function Badge({ className, variant, render, ref, ...props }: BadgeProps) {
  const defaultProps = {
    "data-slot": "badge",
    "data-variant": variant ?? "neutral",
    className: cn(badgeVariants({ variant }), className),
  };
  return useRender({
    defaultTagName: "span",
    render,
    ref,
    props: mergeProps<"span">(defaultProps, props),
  });
}

export { badgeVariants };
