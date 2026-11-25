import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Dialog,
  DialogAction,
  DialogClose,
  DialogCornerClose,
  DialogDescription,
  DialogFooter,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
  dialogClassNames,
} from "./dialog";

function attributesOf(markup: string): string {
  return markup.slice(0, markup.indexOf(">"));
}

describe("Dialog", () => {
  it("renders the trigger as an outline Button that opens a dialog", () => {
    const root = attributesOf(
      renderToStaticMarkup(
        <Dialog>
          <DialogTrigger>Mettre en pause</DialogTrigger>
        </Dialog>,
      ),
    );
    expect(root).toMatch(/^<button/);
    expect(root).toContain('data-slot="dialog-trigger"');
    expect(root).toContain('data-variant="outline"');
    expect(root).toContain('aria-haspopup="dialog"');
    expect(root).toContain('aria-expanded="false"');
    expect(root).toContain("ring-neutral-4-transparent");
  });

  it("lets the trigger take another Button variant and the disabled state", () => {
    const root = attributesOf(
      renderToStaticMarkup(
        <Dialog>
          <DialogTrigger variant="secondary" disabled>
            Mettre en pause
          </DialogTrigger>
        </Dialog>,
      ),
    );
    expect(root).toContain('data-variant="secondary"');
    expect(root).toContain("data-disabled");
    expect(root).toMatch(/\sdisabled(=|\s|$)/);
  });

  it("renders nothing for a closed popup", () => {
    const markup = renderToStaticMarkup(
      <Dialog>
        <DialogPopup>
          <DialogTitle>Titre</DialogTitle>
        </DialogPopup>
      </Dialog>,
    );
    expect(markup).toBe("");
  });

  it("styles the title and description with the spec's typography and colors", () => {
    const markup = renderToStaticMarkup(
      <Dialog>
        <DialogTitle>Mettre en pause l'écoute ?</DialogTitle>
        <DialogDescription>Les conversations restent sur ce Mac.</DialogDescription>
      </Dialog>,
    );
    const [title = "", description = ""] = markup.split("</h2>");
    expect(title).toMatch(/^<h2/);
    expect(title).toContain('data-slot="dialog-title"');
    for (const token of ["font-medium", "text-body-m", "text-neutral-10"]) {
      expect(title).toContain(token);
    }
    expect(title).not.toContain("data-disabled=");
    expect(description).toMatch(/^<p/);
    expect(description).toContain('data-slot="dialog-description"');
    for (const token of ["font-regular", "text-body-s", "text-neutral-7"]) {
      expect(description).toContain(token);
    }
  });

  it("dims a disabled title and description", () => {
    const markup = renderToStaticMarkup(
      <Dialog>
        <DialogTitle disabled>Exporter</DialogTitle>
        <DialogDescription disabled>Bientôt disponible.</DialogDescription>
      </Dialog>,
    );
    expect(markup.match(/data-disabled=""/g)).toHaveLength(2);
    expect(markup.match(/data-disabled:text-neutral-6/g)).toHaveLength(2);
  });

  it("renders the close part as a ghost Button and the action as a primary Button", () => {
    const close = attributesOf(
      renderToStaticMarkup(
        <Dialog>
          <DialogClose>Annuler</DialogClose>
        </Dialog>,
      ),
    );
    expect(close).toContain('data-slot="dialog-close"');
    expect(close).toContain('data-variant="ghost"');
    expect(close).toContain("ring-transparent");

    const action = attributesOf(
      renderToStaticMarkup(<DialogAction isPending>Exporter</DialogAction>),
    );
    expect(action).toContain('data-slot="dialog-action"');
    expect(action).toContain('data-variant="primary"');
    expect(action).toContain("bg-color-1");
    expect(action).toContain('aria-busy="true"');
  });

  it("renders the corner close as a named icon-only ghost Button at the top inline-end corner", () => {
    const markup = renderToStaticMarkup(
      <Dialog>
        <DialogCornerClose aria-label="Fermer" />
      </Dialog>,
    );
    const root = attributesOf(markup);
    expect(root).toContain('data-slot="dialog-corner-close"');
    expect(root).toContain('aria-label="Fermer"');
    expect(root).toContain('data-variant="ghost"');
    expect(root).toContain('data-size="icon"');
    expect(root).toContain("absolute top-s end-s");
    expect(root).not.toMatch(/\brelative\b/);
    expect(markup).toContain('data-slot="icon"');
    expect(markup).toContain('aria-hidden="true"');
  });

  it("lays out the footer at the end with XS gaps and top margin", () => {
    const root = attributesOf(renderToStaticMarkup(<DialogFooter className="pt-xs" />));
    expect(root).toContain('data-slot="dialog-footer"');
    for (const token of ["flex-wrap", "justify-end", "gap-xs", "mt-xs", "pt-xs"]) {
      expect(root).toContain(token);
    }
  });

  it("lays a drawer along the inline-end edge, sliding in from it", () => {
    const { drawer } = dialogClassNames;
    for (const token of [
      "fixed",
      "inset-y-xs",
      "end-xs",
      "w-[min(26rem,calc(100vw-var(--space-xl)))]",
      "overflow-y-auto",
      "corner-l",
      "shadow-m",
      "motion-safe:data-starting-style:translate-x-[2rem]",
    ]) {
      expect(drawer.split(" ")).toContain(token);
    }
    expect(drawer).not.toContain("top-1/2");
  });

  it("keeps the surface, backdrop and motion on the spec's tokens", () => {
    const { popup, backdrop, title } = dialogClassNames;
    for (const token of [
      "fixed",
      "top-1/2",
      "left-1/2",
      "-translate-x-1/2",
      "-translate-y-1/2",
      "w-[min(400px,calc(100vw-var(--space-xl)))]",
      "max-h-[calc(100dvh-var(--space-xl))]",
      "overflow-y-auto",
      "gap-s",
      "p-l",
      "corner-m",
      "bg-[color:light-dark(var(--neutral-1),var(--neutral-2))]",
      "ring-s",
      "ring-neutral-4-transparent",
      "shadow-m",
      "duration-motion-large",
      "ease-motion-large",
      "data-starting-style:opacity-0",
      "data-ending-style:opacity-0",
      "motion-safe:data-starting-style:scale-(--motion-popup-scale)",
    ]) {
      expect(popup.split(" ")).toContain(token);
    }
    for (const token of [
      "fixed",
      "inset-0",
      "bg-[color:light-dark(var(--neutral-10-transparent),var(--neutral-1-transparent))]",
      "transition-opacity",
      "duration-motion-large",
      "data-starting-style:opacity-0",
    ]) {
      expect(backdrop.split(" ")).toContain(token);
    }
    expect(title).toContain("group-has-[[data-slot=dialog-corner-close]]/dialog-popup:pe-xl");
  });
});
