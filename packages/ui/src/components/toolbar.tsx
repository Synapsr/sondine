import { Toolbar as ToolbarPrimitive } from "@base-ui/react/toolbar";
import { cva, type VariantProps } from "class-variance-authority";
import { mergeClassName } from "../lib/class-name";
import { cn } from "../lib/cn";
import { Separator } from "./separator";
import { Toggle, type ToggleProps, toggleVariants } from "./toggle";

// Sondine Toolbar (gui/components/sondine/toolbar.md). The root is the
// toolbar surface (neutral-1, S radius, the S edge in neutral-4 at 20%, XXS
// padding and gap). Its controls take the shared Toggle source: the same
// fill, label, focus and disabled treatment, Small motion and press
// translation. Icon-only controls are squares of
// max(1em + left/right padding, 1lh + top/bottom padding); text controls
// stretch to the row height. Separators reuse the shared Separator.

const toolbarClassName = [
  "flex w-fit items-stretch gap-xxs corner-s bg-neutral-1 p-xxs ring-s ring-neutral-4-transparent",
  "font-body font-regular text-body-s text-neutral-10",
  "data-[orientation=vertical]:flex-col",
].join(" ");

const groupClassName = "flex items-stretch gap-xxs data-[orientation=vertical]:flex-col";

const toolbarControlVariants = cva("gap-xs", {
  variants: {
    size: {
      default: "",
      icon: "p-zero size-[max(calc(1em+var(--space-s)*2),calc(1lh+var(--space-xs)*2))]",
    },
  },
  defaultVariants: {
    size: "default",
  },
});

export type ToolbarControlSize = NonNullable<VariantProps<typeof toolbarControlVariants>["size"]>;

function controlClassName(size: ToolbarControlSize | null | undefined): string {
  return cn(toggleVariants(), toolbarControlVariants({ size }));
}

export type ToolbarProps = ToolbarPrimitive.Root.Props;

export function Toolbar({ className, ...props }: ToolbarProps) {
  return (
    <ToolbarPrimitive.Root
      data-slot="toolbar"
      className={mergeClassName(toolbarClassName, className)}
      {...props}
    />
  );
}

export type ToolbarGroupProps = ToolbarPrimitive.Group.Props;

/** Groups related controls; `disabled` disables every control inside. */
export function ToolbarGroup({ className, ...props }: ToolbarGroupProps) {
  return (
    <ToolbarPrimitive.Group
      data-slot="toolbar-group"
      className={mergeClassName(groupClassName, className)}
      {...props}
    />
  );
}

export interface ToolbarButtonProps
  extends ToolbarPrimitive.Button.Props, VariantProps<typeof toolbarControlVariants> {}

/**
 * A toolbar action. Compose popup triggers through `render`, for example
 * `<ToolbarButton render={<MenuTrigger />}>`. Disabled buttons stay focusable
 * by default so keyboard users can still reach them.
 */
export function ToolbarButton({ className, size, ...props }: ToolbarButtonProps) {
  return (
    <ToolbarPrimitive.Button
      data-slot="toolbar-button"
      data-size={size ?? "default"}
      className={mergeClassName(controlClassName(size), className)}
      {...props}
    />
  );
}

export interface ToolbarToggleProps<Value extends string = string>
  extends
    Omit<ToolbarPrimitive.Button.Props, "render" | "value">,
    Pick<ToggleProps<Value>, "pressed" | "defaultPressed" | "onPressedChange" | "value">,
    VariantProps<typeof toolbarControlVariants> {}

/**
 * A two-state toolbar control: one element that is both the toolbar item
 * and the shared Toggle (aria-pressed, data-pressed). Inside a ToggleGroup,
 * give it a `value`. Like other toolbar items, a disabled toggle stays
 * focusable: it gets aria-disabled and keeps its place in the roving focus
 * order (Base UI drops the inner Toggle's native `disabled` on mount).
 */
export function ToolbarToggle<Value extends string = string>({
  className,
  size,
  pressed,
  defaultPressed,
  onPressedChange,
  value,
  ...props
}: ToolbarToggleProps<Value>) {
  return (
    <ToolbarPrimitive.Button
      data-slot="toolbar-toggle"
      data-size={size ?? "default"}
      className={mergeClassName(toolbarControlVariants({ size }), className)}
      render={
        <Toggle<Value>
          pressed={pressed}
          defaultPressed={defaultPressed}
          onPressedChange={onPressedChange}
          value={value}
        />
      }
      {...props}
    />
  );
}

export interface ToolbarLinkProps
  extends ToolbarPrimitive.Link.Props, VariantProps<typeof toolbarControlVariants> {}

/** A real link inside the toolbar's focus order, styled as a toolbar control. */
export function ToolbarLink({ className, size, ...props }: ToolbarLinkProps) {
  return (
    <ToolbarPrimitive.Link
      data-slot="toolbar-link"
      data-size={size ?? "default"}
      className={mergeClassName(controlClassName(size), className)}
      {...props}
    />
  );
}

// The theme's --toolbar-divider-bleed (0 here) pulls a divider through the
// toolbar's block padding when enabled.
const separatorClassName =
  "data-[orientation=vertical]:my-[calc(var(--space-xxs)*var(--toolbar-divider-bleed)*-1)]";

export type ToolbarSeparatorProps = ToolbarPrimitive.Separator.Props;

/** The shared Separator, perpendicular to the toolbar. */
export function ToolbarSeparator({ className, ...props }: ToolbarSeparatorProps) {
  return (
    <ToolbarPrimitive.Separator
      data-slot="toolbar-separator"
      className={mergeClassName(separatorClassName, className)}
      render={(separatorProps, state) => (
        <Separator {...separatorProps} orientation={state.orientation} />
      )}
      {...props}
    />
  );
}
