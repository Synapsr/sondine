import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

// Sondine Kbd. The theme has no Kbd specification, so the keycap is built
// from the foundations (a coverage gap): the detail typography that menus use
// for shortcuts, a box at least one S line square so it never grows a line of
// S text, and a Neutral 4 fill, which stays visible on the canvas, on popups
// and on Neutral 3 rows (highlighted options, inputs). The label is Neutral 8:
// Neutral 7 (muted text) on Neutral 4 falls below 4.5:1 in light mode.
const kbdClassName = cn(
  "inline-flex min-h-(--line-s) min-w-(--line-s) shrink-0 items-center justify-center gap-xxs",
  "corner-xs bg-neutral-4 px-xxs text-neutral-8 ring-s ring-border-default",
  "font-body font-regular text-body-xs whitespace-nowrap tabular-nums",
  "pointer-events-none select-none",
  // Dims with the disabled control or option it labels.
  "in-data-disabled:text-neutral-6",
  "**:data-[slot=icon]:shrink-0",
);

export type KbdProps = ComponentProps<"kbd">;

/** One key: a letter, a symbol such as ⌘ or ↵, or a short name such as "esc". */
export function Kbd({ className, ...props }: KbdProps) {
  return <kbd data-slot="kbd" className={cn(kbdClassName, className)} {...props} />;
}

export type KbdGroupProps = ComponentProps<"kbd">;

/** A key combination: `Kbd` keys side by side, XXS apart, read as one input. */
export function KbdGroup({ className, ...props }: KbdGroupProps) {
  return (
    <kbd
      data-slot="kbd-group"
      className={cn("inline-flex items-center gap-xxs", className)}
      {...props}
    />
  );
}
