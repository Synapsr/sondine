import type { ReactNode } from "react";
import {
  Popover,
  PopoverAction,
  PopoverClose,
  PopoverDescription,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "../../components/popover";
import { PauseIcon } from "../../icon";
import { Section, Specimen } from "../section";

function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-end gap-xs">{children}</div>;
}

function PausedPopup({ initialFocus }: { initialFocus?: false }) {
  return (
    <PopoverPopup align="start" initialFocus={initialFocus}>
      <PopoverTitle>Écoute en pause</PopoverTitle>
      <PopoverDescription>
        Reprise automatique à 14:30. La réunion Zoom en cours avec Camille n’est pas enregistrée.
      </PopoverDescription>
      <Actions>
        <PopoverClose>Plus tard</PopoverClose>
        <PopoverAction>Reprendre</PopoverAction>
      </Actions>
    </PopoverPopup>
  );
}

export default function PopoverSection() {
  return (
    <Section id="popover" title="Popover">
      <Specimen label="Trigger">
        <Popover>
          <PopoverTrigger>
            <PauseIcon />
            En pause
          </PopoverTrigger>
          <PausedPopup />
        </Popover>
        <Popover>
          <PopoverTrigger disabled>
            <PauseIcon />
            En pause
          </PopoverTrigger>
        </Popover>
      </Specimen>
      {/* The popups are portalled, so the specimen reserves their height. */}
      <Specimen label="Open, rest and disabled" className="min-h-[17rem] items-start gap-xxl">
        <div className="w-[22rem]">
          <Popover defaultOpen>
            <PopoverTrigger>
              <PauseIcon />
              En pause
            </PopoverTrigger>
            <PausedPopup initialFocus={false} />
          </Popover>
        </div>
        <div className="w-[22rem]">
          <Popover defaultOpen>
            <PopoverTrigger>Exporter le résumé</PopoverTrigger>
            <PopoverPopup align="start" initialFocus={false}>
              <PopoverTitle disabled>Exporter le résumé</PopoverTitle>
              <PopoverDescription disabled>
                Disponible quand la transcription de l’appel avec Inès sera terminée.
              </PopoverDescription>
              <Actions>
                <PopoverClose disabled>Plus tard</PopoverClose>
                <PopoverAction disabled>Exporter</PopoverAction>
              </Actions>
            </PopoverPopup>
          </Popover>
        </div>
      </Specimen>
    </Section>
  );
}
