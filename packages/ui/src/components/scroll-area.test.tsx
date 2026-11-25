import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ScrollArea } from "./scroll-area";

function attributesOf(markup: string): string {
  return markup.slice(markup.indexOf("<div"), markup.indexOf(">", markup.indexOf("<div")));
}

function partOf(markup: string, slot: string): string {
  const start = markup.indexOf(`data-slot="${slot}"`);
  expect(start).toBeGreaterThan(-1);
  const open = markup.lastIndexOf("<", start);
  return markup.slice(open, markup.indexOf(">", start));
}

describe("ScrollArea", () => {
  it("renders the framed root, the viewport and the padded content", () => {
    const markup = renderToStaticMarkup(
      <ScrollArea className="h-[15rem]">
        <p>Point hebdo avec Camille</p>
      </ScrollArea>,
    );
    const root = attributesOf(markup);
    expect(root).toContain('data-slot="scroll-area"');
    expect(root).toContain("relative min-h-0 overflow-hidden");
    expect(root).toContain("corner-s bg-neutral-1 ring-s ring-neutral-4-transparent");
    expect(root).toContain("h-[15rem]");
    expect(root).toContain("has-[[data-slot=scroll-area-viewport]:focus-visible]");
    expect(root).not.toContain("data-disabled");

    const viewport = partOf(markup, "scroll-area-viewport");
    expect(viewport).toContain("size-full rounded-[inherit] overscroll-contain");

    const content = partOf(markup, "scroll-area-content");
    expect(content).toContain("flex flex-col gap-s px-m py-m");
    expect(content).toContain("font-body font-regular text-body-s text-neutral-8");
    expect(content).toContain("min-w-0!");
    expect(markup).toContain("Point hebdo avec Camille");
  });

  it("lets horizontal content keep its width and takes content classes", () => {
    const markup = renderToStaticMarkup(
      <ScrollArea orientation="horizontal" contentClassName="flex-row">
        <span>Zoom</span>
      </ScrollArea>,
    );
    const content = partOf(markup, "scroll-area-content");
    expect(content).not.toContain("min-w-0!");
    expect(content).toContain("flex-row");
    expect(content).not.toContain("flex-col");
  });

  it("marks the root and content disabled", () => {
    const markup = renderToStaticMarkup(
      <ScrollArea disabled>
        <p>Café avec Jules</p>
      </ScrollArea>,
    );
    expect(attributesOf(markup)).toContain('data-disabled=""');
    const content = partOf(markup, "scroll-area-content");
    expect(content).toContain('data-disabled=""');
    expect(content).toContain("data-disabled:text-neutral-6");
  });
});
