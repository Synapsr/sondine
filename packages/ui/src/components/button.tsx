import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { LoaderIcon } from "../icon";
import { mergeClassName } from "../lib/class-name";
import { cn } from "../lib/cn";
import { popupScale, smallTransition } from "../lib/motion";

// Sondine Button (gui/components/sondine/button.md). Each variant maps the
// spec's control and label rows: rest, hover, focus, disabled, in both modes.
const buttonVariants = cva(
  [
    "relative inline-flex shrink-0 items-center justify-center whitespace-nowrap select-none",
    // The sidebar items' corner on every button (Téo, 2026-11-19: a round one beside a
    // square one looked apart); the chips stay round.
    "corner-s font-body font-medium text-body-s",
    "transition-[background-color,color,box-shadow,translate] duration-motion ease-motion motion-reduce:transition-none",
    "motion-safe:control-pressed:translate-y-(--motion-press-distance)",
    "focus-ring",
    "**:data-[slot=icon]:pointer-events-none **:data-[slot=icon]:shrink-0",
  ],
  {
    variants: {
      variant: {
        primary: [
          "bg-color-1 text-cte-accent-text ring-none ring-color-1-transparent",
          "control-hover:shadow-s",
          "control-focus:ring-color-1-transparent",
          "control-disabled:bg-neutral-3 control-disabled:text-neutral-6 control-disabled:ring-neutral-4-transparent",
        ],
        secondary: [
          "bg-neutral-3 text-neutral-10 ring-s ring-neutral-3-transparent",
          "control-hover:bg-neutral-4 control-hover:ring-neutral-4-transparent",
          "control-focus:ring-color-1-transparent",
          "control-disabled:bg-neutral-3 control-disabled:text-neutral-6 control-disabled:ring-neutral-4-transparent",
        ],
        outline: [
          "bg-transparent text-neutral-10 ring-s ring-neutral-4-transparent",
          "control-hover:bg-neutral-3",
          "control-focus:ring-color-1-transparent",
          "control-disabled:text-neutral-6",
        ],
        ghost: [
          "bg-transparent text-neutral-10 ring-s ring-transparent",
          "control-hover:bg-neutral-3",
          "control-focus:ring-color-1-transparent",
          "control-disabled:text-neutral-6",
        ],
        danger: [
          // The spec resolves the label on error to black in both modes.
          "bg-error text-neutral-10 dark:text-neutral-1 ring-s ring-error-transparent",
          "control-hover:shadow-s",
          "control-focus:ring-color-1-transparent",
          "control-disabled:bg-neutral-3 control-disabled:text-neutral-6 control-disabled:ring-neutral-4-transparent",
        ],
      },
      size: {
        default: "px-l py-s",
        // Square: the spec's vertical padding on every side around a line-height box.
        icon: "p-s",
        // A small icon button beside a line of text (a sentence's, a journal line's
        // actions): a tighter inset and a smaller corner, so it keeps the large
        // one's shape instead of turning round.
        "icon-s": "p-xxs corner-xs",
      },
    },
    compoundVariants: [
      // A ghost label lines up with the text around it (ADR 037): a smaller inset.
      { variant: "ghost", size: "default", class: "px-s" },
    ],
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  },
);

export interface ButtonProps extends ButtonPrimitive.Props, VariantProps<typeof buttonVariants> {
  /**
   * Shows the loading layer in place of the label. The button keeps its size
   * and focus but ignores presses until the work finishes.
   */
  isPending?: boolean | undefined;
}

export function Button({
  className,
  variant,
  size,
  isPending = false,
  disabled,
  focusableWhenDisabled,
  children,
  ...props
}: ButtonProps) {
  const reduceMotion = useReducedMotion() === true;
  const hidden = reduceMotion ? { opacity: 0 } : { opacity: 0, scale: popupScale };

  return (
    <ButtonPrimitive
      data-slot="button"
      data-variant={variant ?? "primary"}
      data-size={size ?? "default"}
      data-pending={isPending ? "" : undefined}
      aria-busy={isPending ? true : undefined}
      disabled={disabled === true || isPending}
      focusableWhenDisabled={focusableWhenDisabled === true || isPending}
      className={mergeClassName(buttonVariants({ variant, size }), className)}
      {...props}
    >
      <motion.span
        data-slot="button-label"
        className={cn(
          "inline-flex items-center gap-xs",
          size === "icon" && "size-(--line-s) justify-center",
        )}
        initial={false}
        animate={{ opacity: isPending ? 0 : 1 }}
        transition={smallTransition}
      >
        {children}
      </motion.span>
      <AnimatePresence initial={false}>
        {isPending ? (
          <motion.span
            key="loader"
            data-slot="button-loader"
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
            initial={hidden}
            animate={{ opacity: 1, scale: 1 }}
            exit={hidden}
            transition={smallTransition}
          >
            <LoaderIcon className="animate-spin motion-reduce:animate-none" />
          </motion.span>
        ) : null}
      </AnimatePresence>
    </ButtonPrimitive>
  );
}

export { buttonVariants };
