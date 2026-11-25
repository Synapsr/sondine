import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  PreviewCard,
  PreviewCardDescription,
  PreviewCardPopup,
  PreviewCardTitle,
  PreviewCardTrigger,
} from "./preview-card";

function attributesOf(markup: string): string {
  return markup.slice(0, markup.indexOf(">"));
}

describe("PreviewCardTrigger", () => {
  it("renders a real link in the spec's link treatment", () => {
    const markup = renderToStaticMarkup(
      <PreviewCard>
        <PreviewCardTrigger href="#camille">Camille</PreviewCardTrigger>
        <PreviewCardPopup>
          <PreviewCardTitle>Camille Laurent</PreviewCardTitle>
        </PreviewCardPopup>
      </PreviewCard>,
    );
    const root = attributesOf(markup);
    expect(root).toMatch(/^<a/);
    expect(root).toContain('href="#camille"');
    expect(root).toContain('data-slot="preview-card-trigger"');
    expect(root).toContain("text-color-1");
    expect(root).toContain("font-body font-medium text-body-s");
    expect(root).toContain("corner-s");
    expect(root).toContain("focus-ring control-focus:ring-color-1");
    expect(root).not.toContain("aria-disabled");
    // Closed popups are not rendered.
    expect(markup).not.toContain("preview-card-popup");
  });

  it("drops navigation and preview when disabled", () => {
    const root = attributesOf(
      renderToStaticMarkup(
        <PreviewCardTrigger disabled href="#camille" delay={100}>
          Camille
        </PreviewCardTrigger>,
      ),
    );
    expect(root).toMatch(/^<a/);
    expect(root).not.toContain("href");
    expect(root).not.toContain("delay");
    expect(root).toContain('aria-disabled="true"');
    expect(root).toContain("data-disabled");
    expect(root).toContain("control-disabled:text-neutral-6");
    expect(root).toContain('data-slot="preview-card-trigger"');
  });

  it("keeps render and a className function when disabled", () => {
    const root = attributesOf(
      renderToStaticMarkup(
        <PreviewCardTrigger
          disabled
          render={<span />}
          className={(state) => (state.open ? "is-open" : "is-closed")}
        >
          Camille
        </PreviewCardTrigger>,
      ),
    );
    expect(root).toMatch(/^<span/);
    expect(root).toContain("is-closed");
  });
});

describe("PreviewCardTitle and PreviewCardDescription", () => {
  it("apply the title and description typography", () => {
    const title = attributesOf(renderToStaticMarkup(<PreviewCardTitle>Camille</PreviewCardTitle>));
    expect(title).toMatch(/^<p/);
    expect(title).toContain('data-slot="preview-card-title"');
    expect(title).toContain("text-neutral-10 font-body font-medium text-body-m");
    expect(title).not.toContain("data-disabled=");

    const description = attributesOf(
      renderToStaticMarkup(<PreviewCardDescription>14 conversations</PreviewCardDescription>),
    );
    expect(description).toContain('data-slot="preview-card-description"');
    expect(description).toContain("text-neutral-7 font-body font-regular text-body-s");
    expect(description).toContain("max-w-[40ch]");
  });

  it("mark the disabled state and accept render and className", () => {
    const title = attributesOf(
      renderToStaticMarkup(
        <PreviewCardTitle disabled render={<h3 />} className="truncate">
          Personne inconnue
        </PreviewCardTitle>,
      ),
    );
    expect(title).toMatch(/^<h3/);
    expect(title).toContain("data-disabled");
    expect(title).toContain("data-disabled:text-neutral-6");
    expect(title).toContain("truncate");

    const description = attributesOf(
      renderToStaticMarkup(
        <PreviewCardDescription disabled>Profil supprimé</PreviewCardDescription>,
      ),
    );
    expect(description).toContain("data-disabled");
  });
});
