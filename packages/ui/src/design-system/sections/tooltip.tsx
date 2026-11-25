import type { ReactNode } from "react";
import { Button } from "../../components/button";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../../components/tooltip";
import {
  DownloadIcon,
  MicrophoneOffIcon,
  PauseIcon,
  SearchIcon,
  SettingsIcon,
  TrashIcon,
} from "../../icon";
import { Section, Specimen } from "../section";

// Tooltips sharing a provider (or none) close each other, so each static
// open example gets its own.
function OpenTooltip({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider>
      <Tooltip defaultOpen>{children}</Tooltip>
    </TooltipProvider>
  );
}

export default function TooltipSection() {
  return (
    <Section id="tooltip" title="Tooltip">
      <Specimen label="Hover or focus">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger size="icon" aria-label="Mettre en pause l’écoute">
              <PauseIcon />
            </TooltipTrigger>
            <TooltipPopup>Mettre en pause l’écoute</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger size="icon" aria-label="Couper le micro">
              <MicrophoneOffIcon />
            </TooltipTrigger>
            <TooltipPopup>Couper le micro</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger size="icon" aria-label="Rechercher">
              <SearchIcon />
            </TooltipTrigger>
            <TooltipPopup>
              <span>Rechercher dans vos conversations</span>
              <span>⌘K</span>
            </TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger size="icon" aria-label="Réglages">
              <SettingsIcon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Réglages</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger>
              <DownloadIcon />
              Exporter
            </TooltipTrigger>
            <TooltipPopup>Exporter la transcription en Markdown</TooltipPopup>
          </Tooltip>
        </TooltipProvider>
      </Specimen>
      <Specimen label="Open" className="gap-xxl py-xl">
        <OpenTooltip>
          <TooltipTrigger size="icon" aria-label="Mettre en pause l’écoute">
            <PauseIcon />
          </TooltipTrigger>
          <TooltipPopup>Mettre en pause l’écoute</TooltipPopup>
        </OpenTooltip>
        <OpenTooltip>
          <TooltipTrigger size="icon" aria-label="Rechercher">
            <SearchIcon />
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            <span>Rechercher dans vos conversations</span>
            <span>⌘K</span>
          </TooltipPopup>
        </OpenTooltip>
        <OpenTooltip>
          <TooltipTrigger>Micro occupé</TooltipTrigger>
          <TooltipPopup side="right">
            La transcription reprendra dès que Zoom libérera le micro de Camille.
          </TooltipPopup>
        </OpenTooltip>
      </Specimen>
      <Specimen label="Disabled trigger" className="gap-xxl py-xl">
        <OpenTooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                disabled
                focusableWhenDisabled
                aria-label="Supprimer la conversation"
              />
            }
          >
            <TrashIcon />
          </TooltipTrigger>
          <TooltipPopup>Disponible après la transcription</TooltipPopup>
        </OpenTooltip>
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" disabled focusableWhenDisabled />}>
            <DownloadIcon />
            Exporter
          </TooltipTrigger>
          <TooltipPopup>Aucune transcription à exporter</TooltipPopup>
        </Tooltip>
      </Specimen>
    </Section>
  );
}
