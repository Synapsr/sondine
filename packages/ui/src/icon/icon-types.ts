import type { ComponentProps } from "react";

export type IconProps = Omit<ComponentProps<"svg">, "children"> & {
  /** Width and height. Defaults to 1em so the icon follows the text size. */
  size?: number | string | undefined;
  /** Accessible name. Without it the icon is decorative (aria-hidden). */
  title?: string | undefined;
};
