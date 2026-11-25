import { Avatar as AvatarPrimitive } from "@base-ui/react/avatar";
import { mergeClassName } from "../lib/class-name";
import { cn } from "../lib/cn";

// Sondine Avatar (gui/components/sondine/avatar.md): an XL square with full
// corners on neutral-3. The image and the text fallback share the root's single
// grid cell; Base UI decides which one is shown. The edge is an outer ring at
// the theme's "none" width, composed with the root's (empty) elevation.

export interface AvatarProps extends AvatarPrimitive.Root.Props {
  /** Dims the fallback, for a person shown in a disabled row. */
  disabled?: boolean | undefined;
}

export function Avatar({ className, disabled = false, ...props }: AvatarProps) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      data-disabled={disabled ? "" : undefined}
      className={mergeClassName(
        cn(
          "group/avatar relative inline-grid size-xl shrink-0 place-items-center overflow-hidden p-0 align-middle select-none",
          "corner-full bg-neutral-3 ring-none ring-neutral-4-transparent",
        ),
        className,
      )}
      {...props}
    />
  );
}

export type AvatarImageProps = AvatarPrimitive.Image.Props;

export function AvatarImage({ className, ...props }: AvatarImageProps) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={mergeClassName("col-start-1 row-start-1 size-full object-cover", className)}
      {...props}
    />
  );
}

export type AvatarFallbackProps = AvatarPrimitive.Fallback.Props;

/** Initials or an icon shown until the image loads, or when there is none. */
export function AvatarFallback({ className, ...props }: AvatarFallbackProps) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={mergeClassName(
        cn(
          "col-start-1 row-start-1 grid size-full place-items-center p-0 whitespace-nowrap",
          "font-body font-medium text-body-s text-neutral-8",
          "group-data-disabled/avatar:text-neutral-6",
          "transition-colors duration-motion ease-motion motion-reduce:transition-none",
          "**:data-[slot=icon]:shrink-0",
        ),
        className,
      )}
      {...props}
    />
  );
}
