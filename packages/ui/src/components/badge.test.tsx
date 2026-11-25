import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CircleCheckIcon } from "../icon";
import { Badge } from "./badge";

function attributesOf(markup: string): string {
  return markup.slice(0, markup.indexOf(">"));
}

const statusLabel = "text-[color:light-dark(var(--neutral-10),var(--neutral-1))]";

describe("Badge", () => {
  it("renders a neutral span with the option badge role and detail typography", () => {
    const markup = renderToStaticMarkup(<Badge>En cours</Badge>);
    const root = attributesOf(markup);
    expect(root).toMatch(/^<span/);
    expect(root).toContain('data-slot="badge"');
    expect(root).toContain('data-variant="neutral"');
    for (const token of [
      "bg-option-badge-background",
      "text-option-badge-foreground",
      "ring-s",
      "ring-border-default",
      "corner-xs",
      "px-xs",
      "min-h-(--line-s)",
      "font-body",
      "font-medium",
      "text-body-xs",
      "whitespace-nowrap",
    ]) {
      expect(root).toContain(token);
    }
    expect(markup).toContain("En cours</span>");
  });

  it.each([
    ["success", "bg-success", "ring-success-transparent"],
    ["warning", "bg-warning", "ring-warning-transparent"],
    ["error", "bg-error", "ring-error-transparent"],
  ] as const)("fills the %s variant with black text in both modes", (variant, fill, edge) => {
    const root = attributesOf(renderToStaticMarkup(<Badge variant={variant}>Échec</Badge>));
    expect(root).toContain(`data-variant="${variant}"`);
    expect(root).toContain(fill);
    expect(root).toContain(edge);
    expect(root).toContain(statusLabel);
    expect(root).not.toContain("bg-option-badge-background");
    expect(root).not.toContain("text-option-badge-foreground");
  });

  it("keeps icons as children and merges className", () => {
    const markup = renderToStaticMarkup(
      <Badge variant="success" className="ms-xs px-s">
        <CircleCheckIcon />
        Transcrite
      </Badge>,
    );
    const root = attributesOf(markup);
    expect(root).toContain("ms-xs");
    expect(root).toContain("px-s");
    expect(root).not.toMatch(/\spx-xs(\s|")/);
    expect(markup).toContain('data-slot="icon"');
    expect(markup).toContain("Transcrite");
  });

  it("renders another element through render and forwards props", () => {
    const markup = renderToStaticMarkup(
      <Badge render={<a href="#people" />} aria-label="3 voix à identifier" id="unknown-voices">
        3
      </Badge>,
    );
    const root = attributesOf(markup);
    expect(root).toMatch(/^<a/);
    expect(root).toContain('href="#people"');
    expect(root).toContain('aria-label="3 voix à identifier"');
    expect(root).toContain('id="unknown-voices"');
    expect(root).toContain('data-slot="badge"');
    expect(root).toContain("focus-ring");
  });
});
