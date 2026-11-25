import { Toast as ToastPrimitive } from "@base-ui/react/toast";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Toast,
  ToastAction,
  ToastActions,
  ToastClose,
  ToastContent,
  ToastDescription,
  type ToastObject,
  ToastProvider,
  ToastRoot,
  ToastTitle,
  ToastViewport,
} from "./toast";

function inViewport(children: ReactNode): string {
  return renderToStaticMarkup(
    <ToastPrimitive.Provider>
      <ToastViewport aria-label="Notifications">{children}</ToastViewport>
    </ToastPrimitive.Provider>,
  );
}

function element(markup: string, slot: string): string {
  const start = markup.indexOf(`data-slot="${slot}"`);
  if (start === -1) throw new Error(`no ${slot} in markup`);
  const open = markup.lastIndexOf("<", start);
  return markup.slice(open, markup.indexOf(">", start) + 1);
}

const deleted: ToastObject = {
  id: "deleted",
  title: "Conversation supprimée",
  description: "Point hebdo produit · Zoom",
  actionProps: { children: "Annuler" },
};

describe("Toast", () => {
  it("renders the standard layout inside the notification region", () => {
    const markup = inViewport(<Toast toast={deleted} closeLabel="Fermer" />);

    const viewport = element(markup, "toast-viewport");
    expect(viewport).toContain('role="region"');
    expect(viewport).toContain('aria-label="Notifications"');
    expect(viewport).toContain("fixed right-l bottom-l");
    expect(viewport).toContain("w-[min(360px,calc(100vw-var(--space-xl)))]");

    const root = element(markup, "toast");
    expect(root).toContain('role="dialog"');
    expect(root).toContain("corner-m bg-neutral-1");
    expect(root).toContain("dark:bg-neutral-2");
    expect(root).toContain("ring-s ring-neutral-4-transparent");
    expect(root).toContain("shadow-m");
    expect(root).toContain("duration-motion-large ease-motion-large");
    expect(root).toContain("--toast-offset-y");
    expect(root).toContain("data-limited:opacity-0");
    expect(root).toContain("focus-ring");

    expect(element(markup, "toast-content")).toContain("flex flex-col gap-xs p-m");

    const title = element(markup, "toast-title");
    expect(title).toMatch(/^<h2/);
    expect(title).toContain("text-neutral-10 font-body font-medium text-body-s");
    expect(title).toContain("group-has-[[data-slot=toast-close]]/toast:pe-xl");
    expect(markup).toContain("Conversation supprimée</h2>");

    const description = element(markup, "toast-description");
    expect(description).toContain("text-neutral-7 font-body font-regular text-body-s");
    expect(markup).toContain("Point hebdo produit · Zoom</p>");

    expect(element(markup, "toast-actions")).toContain("flex items-center justify-end gap-xs");
    const action = element(markup, "toast-action");
    expect(action).toContain('data-variant="secondary"');
    expect(markup).toContain(">Annuler</span>");

    const close = element(markup, "toast-close");
    expect(close).toContain('data-variant="ghost"');
    expect(close).toContain('data-size="icon"');
    expect(close).toContain('aria-label="Fermer"');
    expect(close).toContain("absolute end-s top-s");
    expect(markup.slice(markup.indexOf('data-slot="toast-close"'))).toContain('data-slot="icon"');
  });

  it("omits the actions row without actionProps", () => {
    const markup = inViewport(
      <Toast toast={{ id: "saved", title: "Conversation enregistrée" }} closeLabel="Fermer" />,
    );
    expect(markup).not.toContain("toast-actions");
    expect(markup).not.toContain("toast-action");
    expect(markup).toContain('data-slot="toast-close"');
  });

  it("disables the action from actionProps", () => {
    const markup = inViewport(
      <Toast
        toast={{ ...deleted, actionProps: { children: "Annuler", disabled: true } }}
        closeLabel="Fermer"
      />,
    );
    const action = element(markup, "toast-action");
    expect(action).toContain("data-disabled");
    expect(action).toMatch(/\sdisabled(=|\s|>)/);
  });
});

describe("Toast parts", () => {
  it("compose with disabled text, a custom close label and merged classes", () => {
    const markup = inViewport(
      <ToastRoot toast={deleted} className="w-[20rem]">
        <ToastContent>
          <ToastTitle data-disabled="" />
          <ToastDescription data-disabled="">Annulation impossible</ToastDescription>
          <ToastActions>
            <ToastAction disabled>Annuler</ToastAction>
          </ToastActions>
          <ToastClose aria-label="Fermer" disabled />
        </ToastContent>
      </ToastRoot>,
    );
    const root = element(markup, "toast");
    expect(root).toContain("w-[20rem]");
    expect(root).not.toContain("w-full");
    expect(element(markup, "toast-title")).toContain("data-disabled");
    expect(element(markup, "toast-description")).toContain("data-disabled:text-neutral-6");
    expect(markup).toContain("Annulation impossible</p>");
    expect(element(markup, "toast-close")).toContain("data-disabled");
    expect(element(markup, "toast-action")).toContain("data-disabled");
  });

  it("lets the provider render its children (the viewport is portalled)", () => {
    const markup = renderToStaticMarkup(
      <ToastProvider closeLabel="Fermer" regionLabel="Notifications">
        <p>Contenu</p>
      </ToastProvider>,
    );
    expect(markup).toContain("<p>Contenu</p>");
  });
});
