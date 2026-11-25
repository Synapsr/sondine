import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { mergeClassName } from "../lib/class-name";
import { cn } from "../lib/cn";

// Sondine Tabs (gui/components/sondine/tabs.md), surface treatment: the list is
// a Neutral 3 track and one shared indicator carries the selected tab's
// Neutral 1 fill under the tab labels. Base UI measures the active tab and
// exposes its box as --active-tab-*; the indicator follows it with Small motion.

/** How far the indicator reaches toward a tab while it is pressed (tabs spec). */
const PRESS_STRETCH = "[--tabs-press-stretch:6px]";

const tabsClassName = cn(
  "flex min-w-0 flex-col gap-s",
  "data-[orientation=vertical]:flex-row data-[orientation=vertical]:items-start",
);

export type TabsProps = TabsPrimitive.Root.Props;

export function Tabs({ className, ...props }: TabsProps) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={mergeClassName(tabsClassName, className)}
      {...props}
    />
  );
}

const listClassName = cn(
  "relative isolate inline-flex w-fit max-w-full items-center gap-xxs p-xxs",
  "corner-m bg-neutral-3 ring-none ring-neutral-4-transparent",
  PRESS_STRETCH,
  "data-[orientation=vertical]:flex-col data-[orientation=vertical]:items-stretch",
  // Before the indicator is measured (or when it cannot be), the active tab
  // paints the selected fill itself; afterwards only the indicator does.
  "[&:not(:has(>[data-slot=tabs-indicator]:not([hidden])))>[data-active]]:bg-neutral-1",
);

const indicatorClassName = cn(
  "absolute top-0 left-0 -z-1",
  "h-(--active-tab-height) w-(--active-tab-width)",
  "translate-x-(--active-tab-left) translate-y-(--active-tab-top)",
  "corner-s bg-neutral-1 shadow-none ring-none ring-transparent",
  "transition-[translate,width,height] duration-motion ease-motion motion-reduce:transition-none",
  // Press anticipation: reach toward the pressed tab until it is selected.
  "motion-safe:in-data-[press-direction=right]:w-[calc(var(--active-tab-width)+var(--tabs-press-stretch))]",
  "motion-safe:in-data-[press-direction=left]:w-[calc(var(--active-tab-width)+var(--tabs-press-stretch))]",
  "motion-safe:in-data-[press-direction=left]:translate-x-[calc(var(--active-tab-left)-var(--tabs-press-stretch))]",
  "motion-safe:in-data-[press-direction=down]:h-[calc(var(--active-tab-height)+var(--tabs-press-stretch))]",
  "motion-safe:in-data-[press-direction=up]:h-[calc(var(--active-tab-height)+var(--tabs-press-stretch))]",
  "motion-safe:in-data-[press-direction=up]:translate-y-[calc(var(--active-tab-top)-var(--tabs-press-stretch))]",
);

export type TabsListProps = TabsPrimitive.List.Props;

/** The row of tabs. Renders the shared selection indicator after its children. */
export function TabsList({ className, children, ...props }: TabsListProps) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={mergeClassName(listClassName, className)}
      {...props}
    >
      {children}
      <TabsPrimitive.Indicator data-slot="tabs-indicator" className={indicatorClassName} />
    </TabsPrimitive.List>
  );
}

const tabClassName = cn(
  "relative inline-flex shrink-0 items-center justify-center gap-xs whitespace-nowrap select-none",
  "corner-s px-s py-xxs",
  "font-body font-medium text-body-s",
  "bg-transparent text-neutral-7 ring-none ring-transparent",
  "transition-[background-color,color,box-shadow] duration-motion ease-motion motion-reduce:transition-none",
  "focus-ring",
  "control-hover:text-neutral-10",
  "control-focus:ring-color-1",
  "data-active:text-neutral-10",
  "control-disabled:text-neutral-6",
  "data-[orientation=vertical]:justify-start",
  "**:data-[slot=icon]:pointer-events-none **:data-[slot=icon]:shrink-0",
);

type PressDirection = "left" | "right" | "up" | "down";

function pressDirection(tab: HTMLElement, list: HTMLElement): PressDirection | null {
  const active = list.querySelector<HTMLElement>(":scope > [data-slot=tabs-tab][data-active]");
  if (active === null || active === tab) return null;
  const from = active.getBoundingClientRect();
  const to = tab.getBoundingClientRect();
  if (list.getAttribute("data-orientation") === "vertical") {
    return to.top > from.top ? "down" : "up";
  }
  return to.left > from.left ? "right" : "left";
}

// The anticipation lives on the list as a data attribute, so the indicator
// can read it in CSS without re-rendering the tabs.
function stretchIndicatorToward(tab: HTMLElement) {
  const list = tab.closest<HTMLElement>("[data-slot=tabs-list]");
  if (list === null) return;
  const direction = pressDirection(tab, list);
  if (direction === null) return;
  list.setAttribute("data-press-direction", direction);
  const release = () => {
    list.removeAttribute("data-press-direction");
    tab.ownerDocument.removeEventListener("pointerup", release);
    tab.ownerDocument.removeEventListener("pointercancel", release);
  };
  tab.ownerDocument.addEventListener("pointerup", release);
  tab.ownerDocument.addEventListener("pointercancel", release);
}

export type TabsTabProps = TabsPrimitive.Tab.Props;

export function TabsTab({ className, onPointerDown, ...props }: TabsTabProps) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-tab"
      className={mergeClassName(tabClassName, className)}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        const tab = event.currentTarget;
        if (
          event.button !== 0 ||
          event.baseUIHandlerPrevented === true ||
          tab.hasAttribute("data-active") ||
          tab.hasAttribute("data-disabled")
        ) {
          return;
        }
        stretchIndicatorToward(tab);
      }}
      {...props}
    />
  );
}

const panelClassName = cn(
  "min-w-0 pt-xs",
  "font-body font-regular text-body-s text-neutral-8",
  "focus-ring",
);

export type TabsPanelProps = TabsPrimitive.Panel.Props;

export function TabsPanel({ className, ...props }: TabsPanelProps) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-panel"
      className={mergeClassName(panelClassName, className)}
      {...props}
    />
  );
}
