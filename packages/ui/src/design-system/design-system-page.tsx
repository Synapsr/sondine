import type { ComponentType } from "react";
import { Button } from "../components/button";
import { LaptopIcon, MoonIcon, SunIcon } from "../icon";
import type { Theme } from "../theme/theme-controller";
import { useTheme } from "../theme/theme-provider";

interface SectionModule {
  default: ComponentType;
  /** Lower comes first; sections without one follow in file-name order. */
  order?: number;
}

const DEFAULT_ORDER = 100;

// Every file in ./sections is a section; adding one adds it to the page.
const sections = Object.entries(
  import.meta.glob<SectionModule>("./sections/*.tsx", { eager: true }),
)
  .map(([path, module]) => ({
    key: path,
    order: module.order ?? DEFAULT_ORDER,
    Component: module.default,
  }))
  .toSorted((a, b) => a.order - b.order || a.key.localeCompare(b.key));

const themeOptions = [
  { theme: "light", label: "Light", Icon: SunIcon },
  { theme: "dark", label: "Dark", Icon: MoonIcon },
  { theme: "system", label: "System", Icon: LaptopIcon },
] as const satisfies readonly { theme: Theme; label: string; Icon: ComponentType }[];

function ThemeSwitch() {
  const { theme, setTheme } = useTheme();
  return (
    <div role="group" aria-label="Theme" className="flex items-center gap-xxs">
      {themeOptions.map(({ theme: option, label, Icon }) => (
        <Button
          key={option}
          variant={theme === option ? "secondary" : "ghost"}
          aria-pressed={theme === option}
          onClick={() => setTheme(option)}
        >
          <Icon />
          {label}
        </Button>
      ))}
    </div>
  );
}

/** Dev-only page showing every component and foundation. Render inside ThemeProvider. */
export function DesignSystemPage() {
  return (
    <div className="min-h-dvh bg-cte-canvas text-cte-text">
      <header className="sticky top-0 z-10 flex items-center justify-between gap-m bg-cte-canvas px-xl py-m">
        <h1 className="font-display font-heavy text-display-xxs">Design system</h1>
        <ThemeSwitch />
      </header>
      <main className="mx-auto flex max-w-[72rem] flex-col gap-xxl px-xl pt-l pb-xxl">
        {sections.map(({ key, Component }) => (
          <Component key={key} />
        ))}
      </main>
    </div>
  );
}
