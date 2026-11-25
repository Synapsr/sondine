import {
  createContext,
  type ReactNode,
  use,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import {
  createThemeController,
  type ResolvedTheme,
  type Theme,
  type ThemeStorage,
  type ThemeTarget,
} from "./theme-controller";

export interface ThemeContextValue {
  /** The user's choice. */
  theme: Theme;
  /** The mode in effect once "system" is resolved. */
  resolvedTheme: ResolvedTheme;
  setTheme(theme: Theme): void;
  /** Switches to the opposite of the mode in effect. The app binds it to `D`. */
  toggleTheme(): void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export interface ThemeProviderProps {
  children?: ReactNode;
  /** Defaults to memory only; pass createLocalStorageThemeStorage() or an app adapter to persist. */
  storage?: ThemeStorage | undefined;
  defaultTheme?: Theme | undefined;
  /** Element that receives the `light`/`dark` class and `data-theme`. Defaults to `<html>`. */
  target?: ThemeTarget | undefined;
}

export function ThemeProvider({ children, storage, defaultTheme, target }: ThemeProviderProps) {
  const [controller] = useState(() =>
    createThemeController({
      storage,
      defaultTheme,
      target: target ?? (typeof document === "undefined" ? null : document.documentElement),
      query:
        typeof window === "undefined" || typeof window.matchMedia !== "function"
          ? null
          : window.matchMedia("(prefers-color-scheme: dark)"),
    }),
  );

  // Layout effect so the class is on <html> before the first paint.
  useLayoutEffect(() => controller.connect(), [controller]);

  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme: snapshot.theme,
      resolvedTheme: snapshot.resolvedTheme,
      setTheme: controller.setTheme,
      toggleTheme: controller.toggleTheme,
    }),
    [snapshot, controller],
  );

  return <ThemeContext value={value}>{children}</ThemeContext>;
}

export function useTheme(): ThemeContextValue {
  const value = use(ThemeContext);
  if (value === null) throw new Error("useTheme must be used inside <ThemeProvider>");
  return value;
}
