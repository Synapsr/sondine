import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PortalContainer, ThemeScope, usePortalContainer } from "./portal-container";
import { ThemeProvider, useTheme } from "./theme-provider";
import { createMemoryThemeStorage } from "./theme-storage";

function ThemeName() {
  const { theme, resolvedTheme } = useTheme();
  return (
    <span>
      {theme}:{resolvedTheme}
    </span>
  );
}

function ContainerState() {
  const container = usePortalContainer();
  return <span>{container === undefined ? "body" : "scoped"}</span>;
}

describe("ThemeProvider", () => {
  it("exposes the stored theme", () => {
    const markup = renderToStaticMarkup(
      <ThemeProvider storage={createMemoryThemeStorage("dark")}>
        <ThemeName />
      </ThemeProvider>,
    );
    expect(markup).toBe("<span>dark:dark</span>");
  });

  it("resolves system to light when no color scheme query is available", () => {
    const markup = renderToStaticMarkup(
      <ThemeProvider>
        <ThemeName />
      </ThemeProvider>,
    );
    expect(markup).toContain("<span>system:light</span>");
  });

  it("requires a provider", () => {
    expect(() => renderToStaticMarkup(<ThemeName />)).toThrow(/ThemeProvider/);
  });
});

describe("portal containers", () => {
  it("leave portals on <body> outside a container", () => {
    expect(renderToStaticMarkup(<ContainerState />)).toBe("<span>body</span>");
  });

  it("hold portals inside a container until it mounts", () => {
    const markup = renderToStaticMarkup(
      <PortalContainer>
        <ContainerState />
      </PortalContainer>,
    );
    expect(markup).toBe('<span>scoped</span><div data-slot="portal-container"></div>');
  });

  it("scope a mode with its class, data-theme and a portal container", () => {
    const markup = renderToStaticMarkup(
      <ThemeScope theme="dark" className="p-m">
        <ContainerState />
      </ThemeScope>,
    );
    expect(markup).toContain('data-theme="dark"');
    expect(markup).toContain('class="dark isolate p-m"');
    expect(markup).toContain('data-slot="portal-container"');
  });
});
