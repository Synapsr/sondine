import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PauseIcon } from "../icon";
import { Button } from "./button";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./tooltip";

function attributesOf(markup: string): string {
  return markup.slice(0, markup.indexOf(">"));
}

function renderTooltip(trigger: ReactElement): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <Tooltip>
        {trigger}
        <TooltipPopup>Mettre en pause l’écoute</TooltipPopup>
      </Tooltip>
    </TooltipProvider>,
  );
}

describe("TooltipTrigger", () => {
  it("renders the spec's ghost Button trigger", () => {
    const root = attributesOf(
      renderTooltip(
        <TooltipTrigger size="icon" aria-label="Mettre en pause l’écoute">
          <PauseIcon />
        </TooltipTrigger>,
      ),
    );
    expect(root).toMatch(/^<button/);
    expect(root).toContain('data-slot="tooltip-trigger"');
    expect(root).toContain('data-variant="ghost"');
    expect(root).toContain('data-size="icon"');
    expect(root).toContain('aria-label="Mettre en pause l’écoute"');
    expect(root).toContain("data-base-ui-tooltip-trigger");
    expect(root).toContain("ring-transparent");
    expect(root).toContain("control-hover:bg-neutral-3");
    expect(root).toContain("control-disabled:text-neutral-6");
    expect(root).toContain("focus-ring");
  });

  it("keeps the ghost text inset by default and accepts another variant", () => {
    const ghost = attributesOf(renderTooltip(<TooltipTrigger>Exporter</TooltipTrigger>));
    expect(ghost).toContain('data-size="default"');
    // A ghost label lines up with the text around it (ADR 037).
    expect(ghost).toContain("py-s px-s");

    const outline = attributesOf(
      renderTooltip(<TooltipTrigger variant="outline">Exporter</TooltipTrigger>),
    );
    expect(outline).toContain('data-variant="outline"');
  });

  it("uses the caller's control from render, including a focusable disabled Button", () => {
    const root = attributesOf(
      renderTooltip(
        <TooltipTrigger
          render={
            <Button
              variant="secondary"
              size="icon"
              disabled
              focusableWhenDisabled
              aria-label="Supprimer"
            />
          }
        >
          <PauseIcon />
        </TooltipTrigger>,
      ),
    );
    expect(root).toContain('data-slot="tooltip-trigger"');
    expect(root).toContain('data-variant="secondary"');
    expect(root).toContain("data-disabled");
    expect(root).toContain('aria-disabled="true"');
    expect(root).not.toMatch(/\sdisabled(=|\s|$)/);
  });

  it("merges className into the trigger", () => {
    const root = attributesOf(
      renderTooltip(<TooltipTrigger className="px-m">Exporter</TooltipTrigger>),
    );
    expect(root).toContain("px-m");
    expect(root).not.toContain("px-l");
  });
});

describe("TooltipPopup", () => {
  it("renders nothing while closed", () => {
    const markup = renderTooltip(<TooltipTrigger>Exporter</TooltipTrigger>);
    expect(markup).not.toContain("tooltip-popup");
  });
});
