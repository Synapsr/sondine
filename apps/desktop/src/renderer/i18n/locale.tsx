import { createContext, use, useMemo, useState, type ReactNode } from "react";
import {
  defineCustomClientStrategy,
  getLocale,
  locales,
  setLocale,
  type Locale,
} from "../paraglide/runtime.js";

// Paraglide's strategy is: the user's choice (localStorage), then the OS
// locale main passed through the preload ("custom-os"), then English.

export function localeFromTag(tag: string): Locale {
  return tag.toLowerCase().startsWith("fr") ? "fr" : "en";
}

export function installOsLocale(osLocale: string): void {
  defineCustomClientStrategy("custom-os", {
    getLocale: () => localeFromTag(osLocale),
    setLocale: () => undefined,
  });
  document.documentElement.lang = getLocale();
}

interface LocaleContextValue {
  readonly locale: Locale;
  readonly locales: readonly Locale[];
  setLocale(locale: Locale): void;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

/** Re-renders its subtree (keyed on the locale) when the user switches language. */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setCurrent] = useState<Locale>(() => getLocale());
  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      locales,
      setLocale(next) {
        void setLocale(next, { reload: false });
        document.documentElement.lang = next;
        setCurrent(next);
      },
    }),
    [locale],
  );
  return (
    <LocaleContext value={value}>
      <LocaleScope key={locale}>{children}</LocaleScope>
    </LocaleContext>
  );
}

function LocaleScope({ children }: { children: ReactNode }) {
  return children;
}

export function useLocale(): LocaleContextValue {
  const value = use(LocaleContext);
  if (value === null) throw new Error("useLocale needs a LocaleProvider");
  return value;
}
