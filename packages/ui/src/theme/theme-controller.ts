export const THEMES = ["light", "dark", "system"] as const;

export type Theme = (typeof THEMES)[number];
export type ResolvedTheme = Exclude<Theme, "system">;

export function isTheme(value: unknown): value is Theme {
  return THEMES.some((theme) => theme === value);
}

/** Where the chosen theme is persisted. The app decides (localStorage, settings, ...). */
export interface ThemeStorage {
  load(): Theme | null;
  save(theme: Theme): void;
  /** Reports changes made elsewhere, such as another window. */
  subscribe?(onChange: (theme: Theme) => void): () => void;
}

/** The element that carries the mode: `<html>` in the app. */
export interface ThemeTarget {
  classList: { toggle(token: string, force?: boolean): boolean };
  setAttribute(name: string, value: string): void;
  style: { colorScheme: string };
}

/** `matchMedia("(prefers-color-scheme: dark)")`. */
export interface ColorSchemeQuery {
  readonly matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

export interface ThemeSnapshot {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
}

export interface ThemeControllerOptions {
  storage?: ThemeStorage | undefined;
  defaultTheme?: Theme | undefined;
  target?: ThemeTarget | null | undefined;
  query?: ColorSchemeQuery | null | undefined;
}

export interface ThemeController {
  getSnapshot(): ThemeSnapshot;
  subscribe(listener: () => void): () => void;
  setTheme(theme: Theme): void;
  toggleTheme(): void;
  /** Applies the theme to the target and starts following the system and storage. */
  connect(): () => void;
}

export function applyResolvedTheme(target: ThemeTarget, resolvedTheme: ResolvedTheme): void {
  target.classList.toggle("dark", resolvedTheme === "dark");
  target.classList.toggle("light", resolvedTheme === "light");
  target.setAttribute("data-theme", resolvedTheme);
  target.style.colorScheme = resolvedTheme;
}

export function createThemeController({
  storage,
  defaultTheme = "system",
  target = null,
  query = null,
}: ThemeControllerOptions = {}): ThemeController {
  const listeners = new Set<() => void>();

  const resolve = (theme: Theme): ResolvedTheme =>
    theme === "system" ? (query?.matches === true ? "dark" : "light") : theme;

  const initialTheme = storage?.load() ?? defaultTheme;
  let snapshot: ThemeSnapshot = { theme: initialTheme, resolvedTheme: resolve(initialTheme) };

  const update = (theme: Theme): void => {
    const resolvedTheme = resolve(theme);
    if (theme === snapshot.theme && resolvedTheme === snapshot.resolvedTheme) return;
    snapshot = { theme, resolvedTheme };
    if (target) applyResolvedTheme(target, resolvedTheme);
    for (const listener of listeners) listener();
  };

  const setTheme = (theme: Theme): void => {
    storage?.save(theme);
    update(theme);
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setTheme,
    toggleTheme() {
      setTheme(snapshot.resolvedTheme === "dark" ? "light" : "dark");
    },
    connect() {
      if (target) applyResolvedTheme(target, snapshot.resolvedTheme);
      const onSystemChange = (): void => update(snapshot.theme);
      query?.addEventListener("change", onSystemChange);
      const unsubscribeStorage = storage?.subscribe?.(update);
      return () => {
        query?.removeEventListener("change", onSystemChange);
        unsubscribeStorage?.();
      };
    },
  };
}
