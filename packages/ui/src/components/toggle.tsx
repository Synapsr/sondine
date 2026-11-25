import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { cva, type VariantProps } from "class-variance-authority";
import { mergeClassName } from "../lib/class-name";
import { cn } from "../lib/cn";

// Sondine Toggle (gui/components/sondine/toggle.md). The control row carries
// the surface (rest, hover, focus, disabled, and "pressed" = toggled on); the
// label row's typography and foreground sit on the control and are inherited,
// so the label follows the control's state instead of hovering on its own.
// Toggled on (data-pressed) keeps its fill under focus and disabled; the
// pointer-down press is the separate translate.
const toggleVariants = cva(
  [
    "relative inline-flex shrink-0 items-center justify-center whitespace-nowrap select-none",
    "corner-s font-body font-medium text-body-s",
    "bg-transparent text-neutral-10 ring-none ring-transparent",
    "transition-[background-color,color,box-shadow,translate] duration-motion ease-motion motion-reduce:transition-none",
    "motion-safe:control-pressed:translate-y-(--motion-press-distance)",
    "focus-ring",
    "control-hover:bg-neutral-3",
    "data-pressed:bg-neutral-3",
    "control-focus:ring-color-1",
    "control-disabled:text-neutral-6",
    "**:data-[slot=icon]:pointer-events-none **:data-[slot=icon]:shrink-0",
  ],
  {
    variants: {
      size: {
        default: "px-s py-xs",
        // Square: the spec's vertical padding on every side around a line-height box.
        icon: "p-xs",
      },
    },
    defaultVariants: {
      size: "default",
    },
  },
);

const labelClassName = "inline-flex min-h-(--line-s) items-center gap-xs";

export type ToggleSize = NonNullable<VariantProps<typeof toggleVariants>["size"]>;

export interface ToggleProps<Value extends string = string>
  extends TogglePrimitive.Props<Value>, VariantProps<typeof toggleVariants> {}

export function Toggle<Value extends string = string>({
  className,
  size,
  children,
  ...props
}: ToggleProps<Value>) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      data-size={size ?? "default"}
      className={mergeClassName(toggleVariants({ size }), className)}
      {...props}
    >
      <span
        data-slot="toggle-label"
        className={cn(labelClassName, size === "icon" && "size-(--line-s) justify-center")}
      >
        {children}
      </span>
    </TogglePrimitive>
  );
}

export { toggleVariants };
