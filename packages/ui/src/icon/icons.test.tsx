import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { checkIcons, MAX_GLYPHS } from "../../scripts/check-icons";
import * as icons from "./index";
import { BrandMark, CheckIcon, MicrophoneIcon } from "./index";

describe("Nucleo subset (ADR 009)", () => {
  it("stays within budget, carries the notice, and is never imported from nucleo-*", async () => {
    const { glyphCount, problems } = await checkIcons();
    expect(problems).toEqual([]);
    expect(glyphCount).toBeLessThanOrEqual(MAX_GLYPHS);
  });

  it("exports one semantic component per icons.json entry", async () => {
    const list: unknown = JSON.parse(
      await readFile(new URL("./icons.json", import.meta.url), "utf8"),
    );
    const names = Object.keys(typeof list === "object" && list !== null ? list : {});
    const exported = Object.keys(icons).filter((name) => name.endsWith("Icon"));
    expect(exported).toHaveLength(names.length);
    expect(exported).toContain("MicrophoneIcon");
    expect(exported).toContain("XIcon");
  });
});

describe("icon components", () => {
  it("render decorative 1em glyphs in currentColor", () => {
    const markup = renderToStaticMarkup(<MicrophoneIcon className="text-body-xxl" />);
    expect(markup).toContain('width="1em"');
    expect(markup).toContain('height="1em"');
    expect(markup).toContain('data-slot="icon"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('fill="currentColor"');
    expect(markup).toContain('class="text-body-xxl"');
    expect(markup).not.toContain("<title>");
  });

  it("become an image with an accessible name when given a title", () => {
    const markup = renderToStaticMarkup(<MicrophoneIcon title="Microphone" />);
    expect(markup).toContain('role="img"');
    expect(markup).toContain("<title>Microphone</title>");
    expect(markup).not.toContain("aria-hidden");
  });

  it("accept a size and a stroke width for micro-bold glyphs", () => {
    const markup = renderToStaticMarkup(<CheckIcon size={20} strokeWidth={1.5} />);
    expect(markup).toContain('width="20"');
    expect(markup).toContain('stroke-width="1.5"');
  });
});

describe("brand marks (ADR 009)", () => {
  it("keep their owner's color from the brand tokens, and stay decorative", () => {
    for (const brand of ["youtube", "vimeo", "twitch"] as const) {
      const markup = renderToStaticMarkup(<BrandMark brand={brand} className="size-s" />);
      expect(markup).toContain(`text-brand-${brand}`);
      expect(markup).toContain('aria-hidden="true"');
      expect(markup).toContain('fill="currentColor"');
    }
  });

  it("fill YouTube's triangle and Twitch's bubble, so they read the same in both modes", () => {
    expect(renderToStaticMarkup(<BrandMark brand="youtube" />)).toContain("fill-brand-inside");
    expect(renderToStaticMarkup(<BrandMark brand="twitch" />)).toContain("fill-brand-inside");
    expect(renderToStaticMarkup(<BrandMark brand="vimeo" />)).not.toContain("fill-brand-inside");
  });
});
