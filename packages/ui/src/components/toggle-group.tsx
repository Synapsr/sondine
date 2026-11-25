import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import { createContext, useContext } from "react";
import { mergeClassName } from "../lib/class-name";
import { Toggle, type ToggleProps, type ToggleSize } from "./toggle";

// Sondine Toggle group (gui/components/sondine/toggle-group.md). The group is
// a bare row (no fill, edge or padding) with an XXS gap; each item is the
// shared Toggle, sized from its own content and padding. Selection mode,
// roving focus, orientation and disabled handling stay with Base UI.
const toggleGroupClassName = [
  "flex w-fit items-center gap-xxs corner-zero bg-transparent p-zero ring-none ring-transparent",
  "font-body font-regular text-body-s text-neutral-10",
  "data-[orientation=vertical]:flex-col data-[orientation=vertical]:items-start",
].join(" ");

const ToggleGroupSizeContext = createContext<ToggleSize>("default");

export interface ToggleGroupProps<
  Value extends string = string,
> extends ToggleGroupPrimitive.Props<Value> {
  /** Size given to every ToggleGroupItem that does not set its own. */
  size?: ToggleSize | undefined;
}

export function ToggleGroup<Value extends string = string>({
  className,
  size = "default",
  ...props
}: ToggleGroupProps<Value>) {
  return (
    <ToggleGroupSizeContext value={size}>
      <ToggleGroupPrimitive
        data-slot="toggle-group"
        data-size={size}
        className={mergeClassName(toggleGroupClassName, className)}
        {...props}
      />
    </ToggleGroupSizeContext>
  );
}

export type ToggleGroupItemProps<Value extends string = string> = ToggleProps<Value>;

/** A Toggle inside a ToggleGroup; give it a `value` from the group's values. */
export function ToggleGroupItem<Value extends string = string>({
  size,
  ...props
}: ToggleGroupItemProps<Value>) {
  const groupSize = useContext(ToggleGroupSizeContext);
  return <Toggle data-slot="toggle-group-item" size={size ?? groupSize} {...props} />;
}
