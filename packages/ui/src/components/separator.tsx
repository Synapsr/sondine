import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";
import { mergeClassName } from "../lib/class-name";
import { cn } from "../lib/cn";

// Sondine Separator (gui/components/sondine/separator.md). The element reserves
// XXS spacing across the line; the line itself is a local 1px edge (the spec's
// numeric borderWidth, not the theme border scale) drawn as an inset shadow.
const separatorClassName = cn(
  "shrink-0 bg-transparent p-0",
  "data-[orientation=horizontal]:h-xxs data-[orientation=horizontal]:w-full data-[orientation=horizontal]:min-w-m",
  "data-[orientation=horizontal]:inset-shadow-[0_1px_0_0_var(--neutral-4)]",
  "data-[orientation=vertical]:w-xxs data-[orientation=vertical]:min-h-l data-[orientation=vertical]:self-stretch",
  "data-[orientation=vertical]:inset-shadow-[1px_0_0_0_var(--neutral-4)]",
  "rtl:data-[orientation=vertical]:inset-shadow-[-1px_0_0_0_var(--neutral-4)]",
);

export interface SeparatorProps extends SeparatorPrimitive.Props {
  /** Hides the separator from assistive technology when it only decorates. */
  decorative?: boolean | undefined;
}

export function Separator({
  className,
  orientation = "horizontal",
  decorative = false,
  ...props
}: SeparatorProps) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={mergeClassName(separatorClassName, className)}
      {...(decorative ? { role: "none", "aria-orientation": undefined } : {})}
      {...props}
    />
  );
}
