import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuGroup,
  ContextMenuGroupLabel,
  ContextMenuItem,
  ContextMenuPopup,
  ContextMenuSeparator,
  ContextMenuSubmenu,
  ContextMenuSubmenuPopup,
  ContextMenuSubmenuTrigger,
  ContextMenuTrigger,
} from "../../components/context-menu";
import { BookmarkIcon, PlayIcon, ScissorsIcon, TrashIcon, UserIcon } from "../../icon";
import { ThemeScope } from "../../theme/portal-container";
import { Section, Specimen } from "../section";

// The spec's reference target: a centred surface 280px wide, at least 160px tall.
const regionClassName = "flex min-h-[160px] w-[280px] flex-col items-center justify-center gap-xxs";

function ConversationRegion({ disabled = false }: { disabled?: boolean }) {
  return (
    <ContextMenu disabled={disabled}>
      <ContextMenuTrigger className={regionClassName}>
        <span>Point hebdo avec Camille</span>
        <span className="font-regular text-body-xs text-cte-text-muted in-data-disabled:text-neutral-6">
          Zoom · 42 min
        </span>
      </ContextMenuTrigger>
      <ContextMenuPopup>
        <ContextMenuItem icon={<PlayIcon />} shortcut="↵">
          Ouvrir la conversation
        </ContextMenuItem>
        <ContextMenuItem icon={<BookmarkIcon />} shortcut="⌘B">
          Marquer le moment
        </ContextMenuItem>
        <ContextMenuSubmenu>
          <ContextMenuSubmenuTrigger icon={<UserIcon />}>Attribuer à</ContextMenuSubmenuTrigger>
          <ContextMenuSubmenuPopup>
            <ContextMenuItem>Camille</ContextMenuItem>
            <ContextMenuItem>Hugo</ContextMenuItem>
            <ContextMenuItem>Inès</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem>Nouvel intervenant…</ContextMenuItem>
          </ContextMenuSubmenuPopup>
        </ContextMenuSubmenu>
        <ContextMenuCheckboxItem defaultChecked>Épinglée</ContextMenuCheckboxItem>
        <ContextMenuItem icon={<ScissorsIcon />} disabled>
          Couper ici
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="danger" icon={<TrashIcon />} shortcut="⌘⌫">
          Supprimer
        </ContextMenuItem>
      </ContextMenuPopup>
    </ContextMenu>
  );
}

function SegmentRegion() {
  return (
    <ContextMenu>
      <ContextMenuTrigger className={regionClassName}>
        <span>« On valide la maquette jeudi. »</span>
        <span className="font-regular text-body-xs text-cte-text-muted">Hugo · 14:32</span>
      </ContextMenuTrigger>
      <ContextMenuPopup>
        <ContextMenuGroup>
          <ContextMenuGroupLabel>Segment</ContextMenuGroupLabel>
          <ContextMenuItem shortcut="⌘C">Copier le texte</ContextMenuItem>
          <ContextMenuItem>Lire depuis ici</ContextMenuItem>
          <ContextMenuItem>Corriger la transcription</ContextMenuItem>
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuItem variant="danger">Masquer le segment</ContextMenuItem>
      </ContextMenuPopup>
    </ContextMenu>
  );
}

export default function ContextMenuSection() {
  return (
    <Section id="context-menu" title="Context menu">
      <Specimen label="Regions" className="items-start">
        <ConversationRegion />
        <SegmentRegion />
      </Specimen>
      <Specimen label="Disabled">
        <ConversationRegion disabled />
      </Specimen>
      <Specimen label="Theme scope">
        <ThemeScope theme="light" className="corner-s p-m">
          <ConversationRegion />
        </ThemeScope>
        <ThemeScope theme="dark" className="corner-s p-m">
          <ConversationRegion />
        </ThemeScope>
      </Specimen>
    </Section>
  );
}
