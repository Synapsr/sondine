import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Popover,
  PopoverAction,
  PopoverClose,
  PopoverDescription,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "./popover";

function attributesOf(markup: string): string {
  return markup.slice(0, markup.indexOf(">"));
}

describe("Popover", () => {
  it("renders the trigger as an outline Button with popup ARIA", () => {
    const root = attributesOf(
      renderToStaticMarkup(
        <Popover>
          <PopoverTrigger>En pause</PopoverTrigger>
        </Popover>,
      ),
    );
    expect(root).toMatch(/^<button/);
    expect(root).toContain('data-slot="popover-trigger"');
    expect(root).toContain('data-variant="outline"');
    expect(root).toContain('aria-haspopup="dialog"');
    expect(root).toContain('aria-expanded="false"');
  });

  it("passes the disabled state to the trigger", () => {
    const root = attributesOf(
      renderToStaticMarkup(
        <Popover>
          <PopoverTrigger disabled>En pause</PopoverTrigger>
        </Popover>,
      ),
    );
    expect(root).toContain("data-disabled");
    expect(root).toContain("control-disabled:text-neutral-6");
  });

  it("renders nothing for a closed popup", () => {
    const markup = renderToStaticMarkup(
      <Popover>
        <PopoverPopup>
          <PopoverTitle>Écoute en pause</PopoverTitle>
        </PopoverPopup>
      </Popover>,
    );
    expect(markup).toBe("");
  });

  it("styles the title, and wraps the description within 40ch", () => {
    const markup = renderToStaticMarkup(
      <Popover>
        <PopoverTitle>Écoute en pause</PopoverTitle>
        <PopoverDescription>Reprise automatique à 14:30.</PopoverDescription>
      </Popover>,
    );
    const [title = "", description = ""] = markup.split("</h2>");
    expect(title).toContain('data-slot="popover-title"');
    for (const token of ["font-medium", "text-body-m", "text-neutral-10"]) {
      expect(title).toContain(token);
    }
    expect(description).toMatch(/^<p/);
    expect(description).toContain('data-slot="popover-description"');
    for (const token of ["max-w-[40ch]", "text-body-s", "text-neutral-7"]) {
      expect(description).toContain(token);
    }
  });

  it("dims a disabled title and description", () => {
    const markup = renderToStaticMarkup(
      <Popover>
        <PopoverTitle disabled>Exporter</PopoverTitle>
        <PopoverDescription disabled>Bientôt disponible.</PopoverDescription>
      </Popover>,
    );
    expect(markup.match(/data-disabled=""/g)).toHaveLength(2);
  });

  it("renders the close part as a ghost Button and the action as a primary Button", () => {
    const close = attributesOf(
      renderToStaticMarkup(
        <Popover>
          <PopoverClose>Plus tard</PopoverClose>
        </Popover>,
      ),
    );
    expect(close).toContain('data-slot="popover-close"');
    expect(close).toContain('data-variant="ghost"');

    const action = attributesOf(renderToStaticMarkup(<PopoverAction>Reprendre</PopoverAction>));
    expect(action).toContain('data-slot="popover-action"');
    expect(action).toContain('data-variant="primary"');
  });
});
