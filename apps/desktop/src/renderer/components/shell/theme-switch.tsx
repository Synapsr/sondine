import { THEMES, useTheme, type Theme } from "@sondine/ui";
import { ToggleGroup, ToggleGroupItem } from "@sondine/ui/components/toggle-group";
import { m } from "../../paraglide/messages.js";

export const themeNames: Record<Theme, () => string> = {
  light: () => m.theme_light(),
  dark: () => m.theme_dark(),
  system: () => m.theme_system(),
};

/** Light, dark, or the Mac's appearance; `D` still switches from anywhere. */
export function ThemeSwitch() {
  const { theme, setTheme } = useTheme();
  return (
    <ToggleGroup<Theme>
      aria-label={m.theme_label()}
      value={[theme]}
      onValueChange={(values) => {
        const [next] = values;
        if (next !== undefined && next !== theme) setTheme(next);
      }}
    >
      {THEMES.map((option) => (
        <ToggleGroupItem<Theme> key={option} value={option}>
          {themeNames[option]()}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
