import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Separator } from "./separator";

describe("Separator", () => {
  it("renders a horizontal separator by default", () => {
    const markup = renderToStaticMarkup(<Separator />);
    expect(markup).toContain('role="separator"');
    expect(markup).toContain('aria-orientation="horizontal"');
    expect(markup).toContain('data-orientation="horizontal"');
    expect(markup).toContain('data-slot="separator"');
    expect(markup).toContain("data-[orientation=horizontal]:h-xxs");
  });

  it("renders a vertical separator", () => {
    const markup = renderToStaticMarkup(<Separator orientation="vertical" className="mx-xs" />);
    expect(markup).toContain('aria-orientation="vertical"');
    expect(markup).toContain('data-orientation="vertical"');
    expect(markup).toContain("mx-xs");
  });

  it("can be decorative", () => {
    const markup = renderToStaticMarkup(<Separator decorative />);
    expect(markup).toContain('role="none"');
    expect(markup).not.toContain("aria-orientation");
  });
});
