import type { ReactNode } from "react";
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
} from "../../components/dialog";
import { PortalContainer } from "../../theme/portal-container";
import { Section, Specimen } from "../section";

const conversations = [
  { time: "08:42", title: "Point quotidien", source: "Zoom", people: "Camille, Hugo" },
  { time: "09:15", title: "Appel fournisseur", source: "Téléphone", people: "Inès" },
  { time: "10:03", title: "Revue de design", source: "Google Meet", people: "Camille, Léa" },
  { time: "11:30", title: "Déjeuner d’équipe", source: "Micro", people: "Hugo, Léa, Malo" },
  { time: "13:10", title: "Entretien candidat", source: "Zoom", people: "Nora" },
  { time: "14:00", title: "Planification T1", source: "Slack Huddle", people: "Camille" },
  { time: "14:45", title: "Support client", source: "Téléphone", people: "Yanis" },
  { time: "15:20", title: "Démo produit", source: "Zoom", people: "Inès, Malo" },
  { time: "16:05", title: "Rétrospective", source: "Google Meet", people: "Équipe produit" },
  { time: "17:30", title: "Appel avec Camille", source: "FaceTime", people: "Camille" },
  { time: "18:10", title: "Bilan de la journée", source: "Micro", people: "Hugo" },
];

// A frame that hosts the popup's portal and contains its fixed backdrop and
// popup (layout containment), so an open dialog previews in place.
function PreviewStage({ children }: { children: ReactNode }) {
  return (
    <div className="relative h-[20rem] min-w-0 overflow-hidden corner-m bg-cte-canvas p-m contain-layout">
      <PortalContainer>{children}</PortalContainer>
    </div>
  );
}

// Static previews pass initialFocus={false} so they do not take focus on load.
function PausePopup({ initialFocus }: { initialFocus?: false }) {
  return (
    <DialogPopup initialFocus={initialFocus}>
      <DialogTitle>Mettre en pause l’écoute&nbsp;?</DialogTitle>
      <DialogDescription>
        Sondine cesse d’enregistrer le micro et l’audio système. Les conversations déjà captées
        restent sur ce Mac.
      </DialogDescription>
      <DialogFooter>
        <DialogClose>Annuler</DialogClose>
        <DialogAction>Mettre en pause</DialogAction>
      </DialogFooter>
      <DialogCornerClose aria-label="Fermer" />
    </DialogPopup>
  );
}

export default function DialogSection() {
  return (
    <Section id="dialog" title="Dialog">
      <Specimen label="Trigger">
        <Dialog>
          <DialogTrigger>Mettre en pause l’écoute</DialogTrigger>
          <PausePopup />
        </Dialog>
        <Dialog>
          <DialogTrigger>Conversations du jour</DialogTrigger>
          <DialogPopup>
            <DialogTitle>Conversations du jour</DialogTitle>
            <DialogDescription>
              {conversations.length} conversations captées aujourd’hui.
            </DialogDescription>
            <ul className="flex flex-col gap-xs">
              {conversations.map(({ time, title, source, people }) => (
                <li key={time} className="flex flex-col">
                  <span className="font-medium">
                    {time} · {title}
                  </span>
                  <span className="text-cte-text-muted">
                    {source} · {people}
                  </span>
                </li>
              ))}
            </ul>
            <DialogFooter>
              <DialogClose>Fermer</DialogClose>
            </DialogFooter>
            <DialogCornerClose aria-label="Fermer" />
          </DialogPopup>
        </Dialog>
        <Dialog>
          <DialogTrigger>Ce qui a compté (tiroir)</DialogTrigger>
          <DialogPopup side="end">
            <DialogTitle>Lundi 7 septembre</DialogTitle>
            <ul className="flex flex-col gap-xs">
              {conversations.map(({ time, title }) => (
                <li key={time} className="flex gap-s">
                  <span className="w-[3.5rem] shrink-0 text-cte-text-muted">{time}</span>
                  <span>{title}</span>
                </li>
              ))}
            </ul>
            <DialogCornerClose aria-label="Fermer" />
          </DialogPopup>
        </Dialog>
        <Dialog>
          <DialogTrigger disabled>Mettre en pause l’écoute</DialogTrigger>
        </Dialog>
      </Specimen>
      <Specimen label="Open, rest and disabled" className="grid grid-cols-2 items-stretch gap-m">
        <PreviewStage>
          <Dialog defaultOpen modal={false} disablePointerDismissal>
            <DialogTrigger>Mettre en pause l’écoute</DialogTrigger>
            <PausePopup initialFocus={false} />
          </Dialog>
        </PreviewStage>
        <PreviewStage>
          <Dialog defaultOpen modal={false} disablePointerDismissal>
            <DialogTrigger>Exporter</DialogTrigger>
            <DialogPopup initialFocus={false}>
              <DialogTitle disabled>Exporter la conversation</DialogTitle>
              <DialogDescription disabled>
                L’export sera possible quand la transcription de l’appel Zoom avec Camille sera
                terminée.
              </DialogDescription>
              <DialogFooter>
                <DialogClose disabled>Annuler</DialogClose>
                <DialogAction disabled>Exporter</DialogAction>
              </DialogFooter>
              <DialogCornerClose aria-label="Fermer" />
            </DialogPopup>
          </Dialog>
        </PreviewStage>
      </Specimen>
    </Section>
  );
}
