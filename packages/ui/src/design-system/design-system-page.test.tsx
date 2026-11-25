import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThemeProvider } from "../theme/theme-provider";
import { createMemoryThemeStorage } from "../theme/theme-storage";
import { DesignSystemPage } from "./design-system-page";

describe("DesignSystemPage", () => {
  it("collects every section, foundations first", () => {
    const markup = renderToStaticMarkup(
      <ThemeProvider storage={createMemoryThemeStorage("light")}>
        <DesignSystemPage />
      </ThemeProvider>,
    );
    const ids = [...markup.matchAll(/<section id="([^"]+)"/g)].map((match) => match[1]);
    expect(ids[0]).toBe("foundations");
    expect(ids).toEqual(expect.arrayContaining(["button", "separator"]));
    expect(markup).toContain('aria-pressed="true"');
  });
});
