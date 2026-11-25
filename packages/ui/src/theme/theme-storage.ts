import { isTheme, type Theme, type ThemeStorage } from "./theme-controller";

/** Keeps the theme for the lifetime of the page only (tests, previews). */
export function createMemoryThemeStorage(initial: Theme | null = null): ThemeStorage {
  let stored = initial;
  return {
    load: () => stored,
    save(theme) {
      stored = theme;
    },
  };
}

/** Persists the theme in localStorage and follows changes from other windows. */
export function createLocalStorageThemeStorage(key = "sondine.theme"): ThemeStorage {
  return {
    load() {
      try {
        const value = globalThis.localStorage?.getItem(key);
        return isTheme(value) ? value : null;
      } catch {
        return null;
      }
    },
    save(theme) {
      try {
        globalThis.localStorage?.setItem(key, theme);
      } catch {
        // Storage can be unavailable (private mode, quota); the choice then lasts for the session.
      }
    },
    subscribe(onChange) {
      if (typeof window === "undefined") return () => {};
      const onStorage = (event: StorageEvent): void => {
        if (event.key === key && isTheme(event.newValue)) onChange(event.newValue);
      };
      window.addEventListener("storage", onStorage);
      return () => window.removeEventListener("storage", onStorage);
    },
  };
}
