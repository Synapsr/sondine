import { Accordion as AccordionPrimitive } from "@base-ui/react/accordion";
import { ChevronRightIcon } from "../icon";
import { mergeClassName } from "../lib/class-name";

// Sondine Accordion (gui/components/sondine/accordion.md). Items are divided by
// a one-sided bottom edge drawn with the panel's border token (neutral-4 at
// 20%, the theme's S width), except the last one. The trigger is a bare text
// row with a right chevron that turns 90° when open; it never takes the
// button press translation. The panel opens its intrinsic grid row from 0fr
// to 1fr with Large motion, and all of its padding sits on the content
// wrapper inside the clip so the measured size includes it.

const accordionClassName = "flex w-full flex-col";

const itemClassName =
  "not-last:inset-shadow-[0_calc(var(--border-s)*-1)_0_0_var(--neutral-4-transparent)]";

const headerClassName = "m-0 flex";

const triggerClassName = [
  "group/accordion-trigger flex w-full items-center justify-between gap-xs text-left select-none",
  "corner-s px-zero py-m bg-transparent text-neutral-10",
  "font-body font-medium text-body-s",
  "ring-none ring-transparent control-focus:ring-color-1",
  "transition-[color,box-shadow] duration-motion ease-motion motion-reduce:transition-none",
  "focus-ring",
  "control-disabled:text-neutral-6",
  "**:data-[slot=icon]:pointer-events-none **:data-[slot=icon]:shrink-0",
].join(" ");

const labelClassName = "flex min-w-0 flex-1 items-center gap-xs";

// The chevron is sized by its own text step (M) and colored apart from the label.
const indicatorClassName = [
  "flex shrink-0 text-body-m text-neutral-7",
  "transition-[rotate,color] duration-motion-large ease-motion-large motion-reduce:transition-none",
  "group-data-panel-open/accordion-trigger:rotate-90",
  "group-data-disabled/accordion-trigger:text-neutral-6",
].join(" ");

const panelClassName = [
  "group/accordion-panel grid grid-rows-[1fr] bg-transparent p-0 opacity-100",
  "transition-[grid-template-rows,opacity] duration-motion-large ease-motion-large motion-reduce:transition-none",
  "data-starting-style:grid-rows-[0fr] data-starting-style:opacity-0",
  "data-ending-style:grid-rows-[0fr] data-ending-style:opacity-0",
].join(" ");

const clipClassName = "min-h-0 overflow-hidden";

const contentClassName = [
  "px-zero pt-zero pb-m",
  "font-body font-regular text-body-s text-neutral-8",
  "group-data-disabled/accordion-panel:text-neutral-6",
].join(" ");

export type AccordionProps<Value = string> = AccordionPrimitive.Root.Props<Value>;

export function Accordion<Value = string>({ className, ...props }: AccordionProps<Value>) {
  return (
    <AccordionPrimitive.Root<Value>
      data-slot="accordion"
      className={mergeClassName(accordionClassName, className)}
      {...props}
    />
  );
}

export type AccordionItemProps = AccordionPrimitive.Item.Props;

export function AccordionItem({ className, ...props }: AccordionItemProps) {
  return (
    <AccordionPrimitive.Item
      data-slot="accordion-item"
      className={mergeClassName(itemClassName, className)}
      {...props}
    />
  );
}

export interface AccordionTriggerProps extends AccordionPrimitive.Trigger.Props {
  /** Props for the semantic heading that wraps the trigger (an `<h3>` by default). */
  headerProps?: AccordionPrimitive.Header.Props | undefined;
}

/** The item's heading and its toggle button, with the right-chevron indicator. */
export function AccordionTrigger({
  className,
  children,
  headerProps,
  ...props
}: AccordionTriggerProps) {
  const { className: headerClass, ...header }: AccordionPrimitive.Header.Props = headerProps ?? {};
  return (
    <AccordionPrimitive.Header
      data-slot="accordion-header"
      className={mergeClassName(headerClassName, headerClass)}
      {...header}
    >
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={mergeClassName(triggerClassName, className)}
        {...props}
      >
        <span data-slot="accordion-label" className={labelClassName}>
          {children}
        </span>
        <span data-slot="accordion-indicator" aria-hidden className={indicatorClassName}>
          <ChevronRightIcon />
        </span>
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

export type AccordionPanelProps = AccordionPrimitive.Panel.Props;

/** The collapsible region of an item: an outer grid row, a clip, then the padded content. */
export function AccordionPanel({ className, children, ...props }: AccordionPanelProps) {
  return (
    <AccordionPrimitive.Panel
      data-slot="accordion-panel"
      className={mergeClassName(panelClassName, className)}
      {...props}
    >
      <div data-slot="accordion-clip" className={clipClassName}>
        <div data-slot="accordion-content" className={contentClassName}>
          {children}
        </div>
      </div>
    </AccordionPrimitive.Panel>
  );
}
