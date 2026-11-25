import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Progress, ProgressLabel, ProgressValue } from "./progress";

function attributesOf(markup: string): string {
  return markup.slice(0, markup.indexOf(">"));
}

function partOf(markup: string, slot: string): string {
  const start = markup.indexOf(`data-slot="${slot}"`);
  expect(start).toBeGreaterThan(-1);
  const open = markup.lastIndexOf("<", start);
  return markup.slice(open, markup.indexOf(">", start));
}

describe("Progress", () => {
  it("renders the heading, an XXS neutral-3 track and a color-1 fill", () => {
    const markup = renderToStaticMarkup(
      <Progress value={42} locale="fr-FR">
        <ProgressLabel>Transcription de la réunion</ProgressLabel>
        <ProgressValue />
      </Progress>,
    );
    const root = attributesOf(markup);
    expect(root).toContain('data-slot="progress"');
    expect(root).toContain('role="progressbar"');
    expect(root).toContain('aria-valuenow="42"');
    expect(root).toContain("data-progressing");
    expect(root).toContain("flex w-full min-w-0 flex-col gap-s");

    expect(partOf(markup, "progress-heading")).toContain("items-baseline");
    expect(partOf(markup, "progress-label")).toContain(
      "font-body font-medium text-body-s text-neutral-10",
    );
    const value = partOf(markup, "progress-value");
    expect(value).toContain("font-body font-regular text-body-xs text-neutral-7");
    expect(value).toContain("tabular-nums");
    // The space before % is U+00A0 or U+202F depending on ICU; \s matches both.
    expect(markup).toMatch(/42\s%/);

    const track = partOf(markup, "progress-track");
    expect(track).toContain("h-xxs");
    expect(track).toContain("corner-full bg-neutral-3");
    const indicator = partOf(markup, "progress-indicator");
    expect(indicator).toContain("bg-color-1");
    expect(indicator).toContain("width:42%");
    expect(indicator).toContain("transition-[width]");
  });

  it("omits the heading without children", () => {
    const markup = renderToStaticMarkup(<Progress value={10} aria-label="Import" />);
    expect(markup).not.toContain("progress-heading");
    expect(attributesOf(markup)).toContain('aria-label="Import"');
  });

  it("marks complete work and keeps the rest fill", () => {
    const markup = renderToStaticMarkup(<Progress value={100} aria-label="Analyse" />);
    expect(attributesOf(markup)).toContain("data-complete");
    expect(partOf(markup, "progress-indicator")).toContain("bg-color-1");
  });

  it("loops a 35% fill without a value while indeterminate", () => {
    const markup = renderToStaticMarkup(
      <Progress value={null}>
        <ProgressLabel>Préparation du modèle</ProgressLabel>
        <ProgressValue>
          {(formatted, value) => (value === null ? "En cours" : formatted)}
        </ProgressValue>
      </Progress>,
    );
    const root = attributesOf(markup);
    expect(root).toContain("data-indeterminate");
    expect(root).not.toContain("aria-valuenow");
    const indicator = partOf(markup, "progress-indicator");
    expect(indicator).toContain("data-indeterminate");
    expect(indicator).toContain("data-indeterminate:w-[35%]");
    expect(indicator).not.toMatch(/width:\d/);
    expect(markup).toContain("En cours");
  });

  it("dims the label and value when disabled", () => {
    const markup = renderToStaticMarkup(
      <Progress value={64} disabled>
        <ProgressLabel>Transcription en pause</ProgressLabel>
        <ProgressValue />
      </Progress>,
    );
    const root = attributesOf(markup);
    expect(root).toContain('data-disabled=""');
    expect(root).toContain("group/progress");
    expect(partOf(markup, "progress-label")).toContain(
      "group-data-disabled/progress:text-neutral-6",
    );
    expect(partOf(markup, "progress-value")).toContain(
      "group-data-disabled/progress:text-neutral-6",
    );
  });
});
