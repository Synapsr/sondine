import { type ComponentProps, createContext, type ReactNode, use, useState } from "react";
import { cn } from "../lib/cn";
import type { ResolvedTheme } from "./theme-controller";

// undefined: no container in scope, portals go to <body>, which inherits the
// theme from <html>. null: a container is mounting; Base UI waits for it.
const PortalContainerContext = createContext<HTMLElement | null | undefined>(undefined);

/**
 * The element Base UI portals should render into. Pass it to every
 * `<X.Portal container={usePortalContainer()}>` so popups opened inside a
 * themed subtree keep that subtree's tokens.
 */
export function usePortalContainer(): HTMLElement | null | undefined {
  return use(PortalContainerContext);
}

export interface PortalContainerProps {
  children?: ReactNode;
}

/** Hosts the portals opened by its descendants inside the current theme scope. */
export function PortalContainer({ children }: PortalContainerProps) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  return (
    <PortalContainerContext value={container}>
      {children}
      <div data-slot="portal-container" ref={setContainer} />
    </PortalContainerContext>
  );
}

export interface PortalDestinationProps {
  children?: ReactNode;
  /** Where its descendants' portals render; null or undefined leaves them on <body>. */
  container: HTMLElement | null | undefined;
}

/**
 * Sends the portals opened by its descendants to an element outside the
 * theme tree, such as a development tool's app viewport. Without a
 * container, portals keep their usual destination.
 */
export function PortalDestination({ children, container }: PortalDestinationProps) {
  return <PortalContainerContext value={container ?? undefined}>{children}</PortalContainerContext>;
}

export interface ThemeScopeProps extends ComponentProps<"div"> {
  theme: ResolvedTheme;
}

/**
 * Forces a mode on a subtree (for example a preview), including its portals.
 * The document-wide mode belongs to ThemeProvider.
 */
export function ThemeScope({ theme, className, children, ...props }: ThemeScopeProps) {
  return (
    <div
      {...props}
      data-slot="theme-scope"
      data-theme={theme}
      className={cn(theme, "isolate", className)}
    >
      <PortalContainer>{children}</PortalContainer>
    </div>
  );
}
