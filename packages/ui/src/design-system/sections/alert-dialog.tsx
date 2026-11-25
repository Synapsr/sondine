import type { ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../components/alert-dialog";
import { Dialog } from "../../components/dialog";
import { PortalContainer } from "../../theme/portal-container";
import { Section, Specimen } from "../section";

// A frame that hosts the popup's portal and contains its fixed backdrop and
// popup (layout containment), so an open alert previews in place.
function PreviewStage({ children }: { children: ReactNode }) {
  return (
    <div className="relative h-[20rem] min-w-0 overflow-hidden corner-m bg-cte-canvas p-m contain-layout">
      <PortalContainer>{children}</PortalContainer>
    </div>
  );
}

// An open alert dialog is always modal: it would lock the page and hide the
// other previews. Its parts are Base UI Dialog parts, so a non-modal Dialog
// root hosts them for the static previews; the triggers above open real ones.
function StaticPreview({ children }: { children: ReactNode }) {
  return (
    <PreviewStage>
      <Dialog defaultOpen modal={false} disablePointerDismissal>
        {children}
      </Dialog>
    </PreviewStage>
  );
}

// Static previews pass initialFocus={false} so they do not take focus on load.
function DeletePopup({ initialFocus }: { initialFocus?: false }) {
  return (
    <AlertDialogPopup initialFocus={initialFocus}>
      <AlertDialogTitle>Supprimer la conversation avec Camille&nbsp;?</AlertDialogTitle>
      <AlertDialogDescription>
        L’enregistrement et sa transcription seront effacés de ce Mac. Cette action est
        irréversible.
      </AlertDialogDescription>
      <AlertDialogFooter>
        <AlertDialogClose>Annuler</AlertDialogClose>
        <AlertDialogAction>Supprimer</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogPopup>
  );
}

export default function AlertDialogSection() {
  return (
    <Section id="alert-dialog" title="Alert dialog">
      <Specimen label="Trigger">
        <AlertDialog>
          <AlertDialogTrigger>Supprimer la conversation</AlertDialogTrigger>
          <DeletePopup />
        </AlertDialog>
        <AlertDialog>
          <AlertDialogTrigger disabled>Supprimer la conversation</AlertDialogTrigger>
        </AlertDialog>
      </Specimen>
      <Specimen label="Open, rest and disabled" className="grid grid-cols-2 items-stretch gap-m">
        <StaticPreview>
          <AlertDialogTrigger>Supprimer la conversation</AlertDialogTrigger>
          <DeletePopup initialFocus={false} />
        </StaticPreview>
        <StaticPreview>
          <AlertDialogTrigger>Oublier Camille</AlertDialogTrigger>
          <AlertDialogPopup initialFocus={false}>
            <AlertDialogTitle disabled>Oublier la voix de Camille&nbsp;?</AlertDialogTitle>
            <AlertDialogDescription disabled>
              Disponible quand l’analyse des locuteurs de la réunion Zoom sera terminée.
            </AlertDialogDescription>
            <AlertDialogFooter>
              <AlertDialogClose disabled>Annuler</AlertDialogClose>
              <AlertDialogAction disabled>Oublier</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </StaticPreview>
      </Specimen>
    </Section>
  );
}
