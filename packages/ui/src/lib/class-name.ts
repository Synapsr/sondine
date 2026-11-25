import { cn } from "./cn";

type StateClassName<State> = string | ((state: State) => string | undefined) | undefined;

/**
 * Merges a component's own classes with a Base UI `className` prop, which may
 * be a string or a function of the component state.
 */
export function mergeClassName<State>(
  base: string,
  className: StateClassName<State>,
): string | ((state: State) => string) {
  if (typeof className === "function") {
    return (state) => cn(base, className(state));
  }
  return cn(base, className);
}
