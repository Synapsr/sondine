import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./alert-dialog";
import { dialogClassNames } from "./dialog";

function attributesOf(markup: string): string {
  return markup.slice(0, markup.indexOf(">"));
}

describe("AlertDialog", () => {
  it("renders the trigger as an outline Button that opens a dialog", () => {
    const root = attributesOf(
      renderToStaticMarkup(
        <AlertDialog>
          <AlertDialogTrigger>Supprimer</AlertDialogTrigger>
        </AlertDialog>,
      ),
    );
    expect(root).toMatch(/^<button/);
    expect(root).toContain('data-slot="alert-dialog-trigger"');
    expect(root).toContain('data-variant="outline"');
    expect(root).toContain('aria-haspopup="dialog"');
  });

  it("renders nothing for a closed popup", () => {
    const markup = renderToStaticMarkup(
      <AlertDialog>
        <AlertDialogPopup>
          <AlertDialogTitle>Supprimer ?</AlertDialogTitle>
        </AlertDialogPopup>
      </AlertDialog>,
    );
    expect(markup).toBe("");
  });

  it("shares the Dialog title and description styles, with the disabled state", () => {
    const markup = renderToStaticMarkup(
      <AlertDialog>
        <AlertDialogTitle>Supprimer la conversation ?</AlertDialogTitle>
        <AlertDialogDescription disabled>Cette action est irréversible.</AlertDialogDescription>
      </AlertDialog>,
    );
    const [title = "", description = ""] = markup.split("</h2>");
    expect(title).toContain('data-slot="alert-dialog-title"');
    expect(title).toContain(`class="${dialogClassNames.title}"`);
    expect(title).not.toContain("data-disabled=");
    expect(description).toMatch(/^<p/);
    expect(description).toContain('data-slot="alert-dialog-description"');
    expect(description).toContain(`class="${dialogClassNames.description}"`);
    expect(description).toContain('data-disabled=""');
  });

  it("keeps cancel (outline Button) and confirm (primary Button) distinct", () => {
    const markup = renderToStaticMarkup(
      <AlertDialog>
        <AlertDialogFooter>
          <AlertDialogClose>Annuler</AlertDialogClose>
          <AlertDialogAction>Supprimer</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialog>,
    );
    const footer = attributesOf(markup);
    expect(footer).toContain('data-slot="alert-dialog-footer"');
    expect(footer).toContain(`class="${dialogClassNames.footer}"`);

    const [, cancel = "", confirm = ""] = markup.split("<button");
    expect(cancel).toContain('data-slot="alert-dialog-close"');
    expect(cancel).toContain('data-variant="outline"');
    expect(confirm).toContain('data-slot="alert-dialog-action"');
    expect(confirm).toContain('data-variant="primary"');
  });

  it("lets the confirm action use another Button variant and stay pending", () => {
    const root = attributesOf(
      renderToStaticMarkup(
        <AlertDialogAction variant="danger" isPending>
          Supprimer
        </AlertDialogAction>,
      ),
    );
    expect(root).toContain('data-variant="danger"');
    expect(root).toContain("data-pending");
    expect(root).toContain('aria-busy="true"');
  });
});
