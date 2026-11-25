import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Meter, MeterLabel, MeterValue, meterLevel } from "./meter";

function attributesOf(markup: string): string {
  return markup.slice(0, markup.indexOf(">"));
}

function partOf(markup: string, slot: string): string {
  const start = markup.indexOf(`data-slot="${slot}"`);
  expect(start).toBeGreaterThan(-1);
  const open = markup.lastIndexOf("<", start);
  return markup.slice(open, markup.indexOf(">", start));
}

describe("meterLevel", () => {
  it.each([
    [42, 20, 85, "normal"],
    [12, 20, 85, "low"],
    [92, 20, 85, "high"],
    [20, 20, 85, "normal"],
    [85, 20, 85, "normal"],
    [5, undefined, undefined, "normal"],
    [95, undefined, 85, "high"],
  ] as const)("value %s with low %s and high %s is %s", (value, low, high, expected) => {
    expect(meterLevel(value, low, high)).toBe(expected);
  });
});

describe("Meter", () => {
  it("renders a meter with the heading, track and color-1 fill", () => {
    const markup = renderToStaticMarkup(
      <Meter value={42} low={20} high={85} locale="fr-FR">
        <MeterLabel>Espace disque utilisé</MeterLabel>
        <MeterValue />
      </Meter>,
    );
    const root = attributesOf(markup);
    expect(root).toContain('data-slot="meter"');
    expect(root).toContain('role="meter"');
    expect(root).toContain('aria-valuenow="42"');
    expect(root).toContain('data-level="normal"');
    expect(root).toContain("flex w-full min-w-0 flex-col gap-s");
    expect(partOf(markup, "meter-label")).toContain(
      "font-body font-medium text-body-s text-neutral-10",
    );
    expect(partOf(markup, "meter-value")).toContain(
      "font-body font-regular text-body-xs text-neutral-7",
    );
    expect(markup).toMatch(/42\s%/);
    expect(partOf(markup, "meter-track")).toContain("h-xxs");
    const indicator = partOf(markup, "meter-indicator");
    expect(indicator).toContain('data-level="normal"');
    expect(indicator).toContain("bg-color-1");
    expect(indicator).toContain("data-[level=low]:bg-warning data-[level=high]:bg-error");
    expect(indicator).toContain("width:42%");
  });

  it.each([
    [12, "low"],
    [92, "high"],
  ] as const)("marks %s as %s", (value, level) => {
    const markup = renderToStaticMarkup(
      <Meter value={value} low={20} high={85} aria-label="Niveau du micro" />,
    );
    expect(partOf(markup, "meter-indicator")).toContain(`data-level="${level}"`);
    expect(markup).not.toContain("meter-heading");
  });

  it("formats the value with the root's format", () => {
    const markup = renderToStaticMarkup(
      <Meter
        value={18.4}
        max={64}
        locale="fr-FR"
        format={{ style: "unit", unit: "gigabyte", maximumFractionDigits: 1 }}
      >
        <MeterLabel>Modèles téléchargés</MeterLabel>
        <MeterValue />
      </Meter>,
    );
    expect(markup).toMatch(/18,4\sGo/);
    expect(attributesOf(markup)).toContain('aria-valuemax="64"');
  });

  it("dims the label and value when disabled", () => {
    const markup = renderToStaticMarkup(
      <Meter value={36} disabled>
        <MeterLabel>Niveau du micro</MeterLabel>
        <MeterValue />
      </Meter>,
    );
    expect(attributesOf(markup)).toContain('data-disabled=""');
    expect(partOf(markup, "meter-label")).toContain("group-data-disabled/meter:text-neutral-6");
    expect(partOf(markup, "meter-value")).toContain("group-data-disabled/meter:text-neutral-6");
  });
});
