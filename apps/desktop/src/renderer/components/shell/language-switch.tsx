import { ToggleGroup, ToggleGroupItem } from "@sondine/ui/components/toggle-group";
import { useLocale } from "../../i18n/locale";
import { m } from "../../paraglide/messages.js";
import type { Locale } from "../../paraglide/runtime.js";

export const languageNames: Record<Locale, () => string> = {
  en: () => m.language_en(),
  fr: () => m.language_fr(),
};

export function LanguageSwitch() {
  const { locale, locales, setLocale } = useLocale();
  return (
    <ToggleGroup<Locale>
      aria-label={m.language_label()}
      value={[locale]}
      onValueChange={(values) => {
        const [next] = values;
        if (next !== undefined && next !== locale) setLocale(next);
      }}
    >
      {locales.map((option) => (
        <ToggleGroupItem<Locale> key={option} value={option} aria-label={languageNames[option]()}>
          {option.toUpperCase()}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
