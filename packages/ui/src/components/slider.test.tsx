import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Field } from "./field";
import { Slider, SliderLabel, SliderValue } from "./slider";

function attributesOf(markup: string): string {
  return markup.slice(0, markup.indexOf(">"));
}

function partOf(markup: string, slot: string): string {
  const start = markup.indexOf(`data-slot="${slot}"`);
  expect(start).toBeGreaterThan(-1);
  const open = markup.lastIndexOf("<", start);
  return markup.slice(open, markup.indexOf(">", start));
}

function count(markup: string, text: string): number {
  return markup.split(text).length - 1;
}

const INSET_PADDING = "px-[calc(var(--slider-track)/2)]";
const TRACK_BLEED = "-mx-[calc(var(--slider-track)/2)]";

describe("Slider", () => {
  it("renders the heading, the XL track, the fill and an L thumb", () => {
    const markup = renderToStaticMarkup(
      <Slider defaultValue={60} name="volume" locale="fr-FR">
        <SliderLabel>Volume de lecture</SliderLabel>
        <SliderValue />
      </Slider>,
    );
    const root = attributesOf(markup);
    expect(root).toContain('data-slot="slider"');
    expect(root).toContain('role="group"');
    expect(root).toContain("flex min-w-0 flex-col gap-s");
    expect(root).toContain("w-full");
    expect(root).toContain("[--slider-track:var(--space-xl)]");

    expect(partOf(markup, "slider-label")).toContain(
      "font-body font-medium text-body-s text-neutral-10",
    );
    const value = partOf(markup, "slider-value");
    expect(value).toMatch(/^<output/);
    expect(value).toContain("font-body font-regular text-body-xs text-neutral-7");
    expect(markup).toContain(">60</output>");

    const track = partOf(markup, "slider-track");
    expect(track).toContain("h-(--slider-track)");
    expect(track).toContain("corner-full bg-neutral-3");
    expect(track).toContain("focus-ring-within");
    expect(partOf(markup, "slider-indicator")).toContain("bg-color-1");
    expect(partOf(markup, "slider-indicator")).toContain("data-disabled:bg-neutral-5");

    const thumb = partOf(markup, "slider-thumb");
    expect(thumb).toContain("size-l");
    expect(thumb).toContain("corner-full bg-neutral-2 ring-s ring-color-1");
    expect(thumb).toContain("data-disabled:ring-neutral-5-transparent");
    expect(thumb).toContain("transition-[inset-inline-start,bottom,box-shadow]");
    expect(markup).toMatch(/<input[^>]*type="range"/);
    expect(markup).toMatch(/<input[^>]*name="volume"/);
    expect(count(markup, 'data-slot="slider-thumb"')).toBe(1);
  });

  it("insets the thumb travel for a horizontal single value", () => {
    const markup = renderToStaticMarkup(<Slider defaultValue={0} getAriaLabel={() => "Volume"} />);
    expect(markup).not.toContain("slider-heading");
    expect(partOf(markup, "slider-control")).toContain(INSET_PADDING);
    expect(partOf(markup, "slider-control")).toContain("min-h-(--slider-track)");
    expect(partOf(markup, "slider-track")).toContain(TRACK_BLEED);
    expect(partOf(markup, "slider-travel")).toContain("inset-x-[calc(var(--slider-track)/2)]");
    const indicator = partOf(markup, "slider-indicator");
    expect(indicator).toContain("-ms-[calc(var(--slider-track)/2)] box-content");
    expect(indicator).toContain(INSET_PADDING);
    expect(markup).toMatch(/<input[^>]*aria-label="Volume"/);
  });

  it.each([
    ["a range", <Slider key="range" defaultValue={[8, 19]} max={24} />, 2],
    ["a vertical slider", <Slider key="vertical" defaultValue={70} orientation="vertical" />, 1],
    ["an explicit alignment", <Slider key="edge" defaultValue={40} thumbAlignment="edge" />, 1],
  ])("keeps Base UI geometry for %s", (_, element, thumbs) => {
    const markup = renderToStaticMarkup(element);
    expect(markup).not.toContain(INSET_PADDING);
    expect(markup).not.toContain(TRACK_BLEED);
    expect(count(markup, 'data-slot="slider-thumb"')).toBe(thumbs);
  });

  it("lets the caller's size replace the orientation's default", () => {
    const horizontal = attributesOf(
      renderToStaticMarkup(<Slider defaultValue={30} className="w-[20rem]" />),
    );
    expect(horizontal).toContain("w-[20rem]");
    expect(horizontal).not.toContain("w-full");

    const vertical = renderToStaticMarkup(
      <Slider defaultValue={70} orientation="vertical" className="h-[10rem]" />,
    );
    const root = attributesOf(vertical);
    expect(root).toContain('data-orientation="vertical"');
    expect(root).toContain("h-[10rem]");
    expect(root).not.toContain("h-full");
    expect(root).not.toContain("w-full");
    expect(partOf(vertical, "slider-track")).toContain(
      "data-[orientation=vertical]:w-(--slider-track)",
    );
    expect(partOf(vertical, "slider-control")).toContain("data-[orientation=vertical]:flex-col");
  });

  it("keeps the rest look when a Field marks it invalid", () => {
    const markup = renderToStaticMarkup(
      <Field invalid>
        <Slider defaultValue={95}>
          <SliderLabel>Gain du micro</SliderLabel>
          <SliderValue />
        </Slider>
      </Field>,
    );
    expect(partOf(markup, "slider")).toContain("data-invalid");
    expect(partOf(markup, "slider-label")).toContain("text-neutral-10");
    expect(partOf(markup, "slider-label")).not.toContain("invalid:");
    expect(partOf(markup, "slider-indicator")).toContain("bg-color-1");
    expect(markup).toMatch(/<input[^>]*aria-invalid="true"/);
  });

  it("labels each range thumb and formats both values", () => {
    const markup = renderToStaticMarkup(
      <Slider
        defaultValue={[8, 19]}
        max={24}
        getAriaLabel={(index) => (index === 0 ? "Début" : "Fin")}
      >
        <SliderValue>
          {(formatted) => `${formatted[0] ?? ""} h – ${formatted[1] ?? ""} h`}
        </SliderValue>
      </Slider>,
    );
    expect(markup).toMatch(/<input[^>]*aria-label="Début"/);
    expect(markup).toMatch(/<input[^>]*aria-label="Fin"/);
    expect(markup).toContain("8 h – 19 h");
  });

  it("disables every part", () => {
    const markup = renderToStaticMarkup(
      <Slider defaultValue={60} disabled>
        <SliderLabel>Volume de lecture</SliderLabel>
        <SliderValue />
      </Slider>,
    );
    expect(attributesOf(markup)).toContain("data-disabled");
    for (const slot of ["slider-label", "slider-value", "slider-indicator", "slider-thumb"]) {
      expect(partOf(markup, slot)).toContain("data-disabled");
    }
    expect(partOf(markup, "slider-label")).toContain("data-disabled:text-neutral-6");
    expect(markup).toMatch(/<input[^>]*disabled/);
  });
});
