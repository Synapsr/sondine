import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";
import { ChevronRightIcon } from "../icon";
import { mergeClassName } from "../lib/class-name";

// Sondine Collapsible (gui/components/sondine/collapsible.md). The root is a
// vertical stack whose S gap closes to zero together with the panel, so no
// space is left once the panel unmounts. The panel animates the primitive's
// measured height and its opacity with Large motion; its padding sits on the
// inner flow-root content so the measurement includes it. The trigger is a
// full-width text row with a right chevron that turns 90° when open.

const collapsibleClassName = [
  "flex flex-col gap-s corner-zero bg-transparent p-zero",
  "font-body font-regular text-body-s text-neutral-10",
  "transition-[gap] duration-motion-large ease-motion-large motion-reduce:transition-none",
  "data-closed:gap-0",
].join(" ");

const triggerClassName = [
  "group/collapsible-trigger flex w-full items-center justify-between gap-xs text-left select-none",
  "corner-s px-zero py-xs bg-transparent text-neutral-10",
  "font-body font-medium text-body-s",
  "ring-none ring-transparent control-focus:ring-color-1",
  "transition-[color,box-shadow] duration-motion ease-motion motion-reduce:transition-none",
  "focus-ring",
  "control-disabled:text-neutral-6",
  "**:data-[slot=icon]:pointer-events-none **:data-[slot=icon]:shrink-0",
].join(" ");

const labelClassName = "flex min-w-0 flex-1 items-center gap-xs";

const indicatorClassName = [
  "flex shrink-0 text-body-m text-neutral-7",
  "transition-[rotate,color] duration-motion-large ease-motion-large motion-reduce:transition-none",
  "group-data-panel-open/collapsible-trigger:rotate-90",
  "group-data-disabled/collapsible-trigger:text-neutral-6",
].join(" ");

const panelClassName = [
  "group/collapsible-panel h-(--collapsible-panel-height) overflow-hidden p-0 opacity-100",
  "corner-s bg-neutral-2 ring-s ring-neutral-4-transparent",
  "transition-[height,opacity] duration-motion-large ease-motion-large motion-reduce:transition-none",
  "data-starting-style:h-0 data-starting-style:opacity-0",
  "data-ending-style:h-0 data-ending-style:opacity-0",
].join(" ");

const contentClassName = [
  "flow-root p-s",
  "font-body font-regular text-body-s text-neutral-8",
  "group-data-disabled/collapsible-panel:text-neutral-6",
].join(" ");

export type CollapsibleProps = CollapsiblePrimitive.Root.Props;

export function Collapsible({ className, ...props }: CollapsibleProps) {
  return (
    <CollapsiblePrimitive.Root
      data-slot="collapsible"
      className={mergeClassName(collapsibleClassName, className)}
      {...props}
    />
  );
}

export type CollapsibleTriggerProps = CollapsiblePrimitive.Trigger.Props;

/** Full-width toggle row: the label, then the right-chevron indicator. */
export function CollapsibleTrigger({ className, children, ...props }: CollapsibleTriggerProps) {
  return (
    <CollapsiblePrimitive.Trigger
      data-slot="collapsible-trigger"
      className={mergeClassName(triggerClassName, className)}
      {...props}
    >
      <span data-slot="collapsible-label" className={labelClassName}>
        {children}
      </span>
      <span data-slot="collapsible-indicator" aria-hidden className={indicatorClassName}>
        <ChevronRightIcon />
      </span>
    </CollapsiblePrimitive.Trigger>
  );
}

export type CollapsiblePanelProps = CollapsiblePrimitive.Panel.Props;

/** The panel surface and its padded content. */
export function CollapsiblePanel({ className, children, ...props }: CollapsiblePanelProps) {
  return (
    <CollapsiblePrimitive.Panel
      data-slot="collapsible-panel"
      className={mergeClassName(panelClassName, className)}
      {...props}
    >
      <div data-slot="collapsible-content" className={contentClassName}>
        {children}
      </div>
    </CollapsiblePrimitive.Panel>
  );
}
