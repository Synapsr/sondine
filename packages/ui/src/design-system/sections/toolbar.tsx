import { ToggleGroup } from "../../components/toggle-group";
import {
  Toolbar,
  ToolbarButton,
  ToolbarGroup,
  ToolbarLink,
  ToolbarSeparator,
  ToolbarToggle,
} from "../../components/toolbar";
import {
  BookmarkIcon,
  DownloadIcon,
  ExternalLinkIcon,
  MicrophoneIcon,
  PauseIcon,
  ScissorsIcon,
  StarIcon,
  TrashIcon,
  VolumeIcon,
} from "../../icon";
import { Section, Specimen } from "../section";

export default function ToolbarSection() {
  return (
    <Section id="toolbar" title="Toolbar">
      <Specimen label="Icons, text, toggles and a link">
        <Toolbar aria-label="Écoute">
          <ToolbarGroup aria-label="Sources">
            <ToolbarToggle size="icon" aria-label="Micro" defaultPressed>
              <MicrophoneIcon />
            </ToolbarToggle>
            <ToolbarToggle size="icon" aria-label="Audio système">
              <VolumeIcon />
            </ToolbarToggle>
          </ToolbarGroup>
          <ToolbarSeparator />
          <ToolbarButton>
            <PauseIcon />
            Mettre en pause l’écoute
          </ToolbarButton>
          <ToolbarSeparator />
          <ToolbarButton size="icon" aria-label="Marquer ce moment">
            <BookmarkIcon />
          </ToolbarButton>
          <ToolbarButton size="icon" aria-label="Exporter">
            <DownloadIcon />
          </ToolbarButton>
          <ToolbarSeparator />
          <ToolbarLink href="#toolbar">
            <ExternalLinkIcon />
            Ouvrir dans Zoom
          </ToolbarLink>
        </Toolbar>
      </Specimen>

      <Specimen label="Text toggle group">
        <Toolbar aria-label="Conversation">
          <ToggleGroup defaultValue={["transcript"]} aria-label="Affichage">
            <ToolbarToggle value="summary">Résumé</ToolbarToggle>
            <ToolbarToggle value="transcript">Transcription</ToolbarToggle>
            <ToolbarToggle value="people">Personnes</ToolbarToggle>
          </ToggleGroup>
          <ToolbarSeparator />
          <ToolbarButton>Exporter</ToolbarButton>
        </Toolbar>
      </Specimen>

      <Specimen label="Disabled items">
        <Toolbar aria-label="Extrait">
          <ToolbarButton>
            <ScissorsIcon />
            Découper
          </ToolbarButton>
          <ToolbarButton disabled>
            <StarIcon />
            Favori
          </ToolbarButton>
          <ToolbarToggle size="icon" aria-label="Épingler" disabled defaultPressed>
            <BookmarkIcon />
          </ToolbarToggle>
          <ToolbarSeparator />
          <ToolbarButton size="icon" aria-label="Supprimer" disabled>
            <TrashIcon />
          </ToolbarButton>
        </Toolbar>
      </Specimen>

      <Specimen label="Disabled toolbar">
        <Toolbar aria-label="Écoute" disabled>
          <ToolbarButton>
            <PauseIcon />
            Mettre en pause l’écoute
          </ToolbarButton>
          <ToolbarSeparator />
          <ToolbarButton size="icon" aria-label="Marquer ce moment">
            <BookmarkIcon />
          </ToolbarButton>
          <ToolbarButton size="icon" aria-label="Exporter">
            <DownloadIcon />
          </ToolbarButton>
        </Toolbar>
      </Specimen>

      <Specimen label="Vertical">
        <Toolbar aria-label="Actions" orientation="vertical">
          <ToolbarButton size="icon" aria-label="Marquer ce moment">
            <BookmarkIcon />
          </ToolbarButton>
          <ToolbarButton size="icon" aria-label="Découper">
            <ScissorsIcon />
          </ToolbarButton>
          <ToolbarSeparator />
          <ToolbarButton size="icon" aria-label="Supprimer">
            <TrashIcon />
          </ToolbarButton>
        </Toolbar>
      </Specimen>
    </Section>
  );
}
