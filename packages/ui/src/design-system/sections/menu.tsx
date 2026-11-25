import { useState } from "react";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSubmenu,
  MenuSubmenuPopup,
  MenuSubmenuTrigger,
  MenuTrigger,
} from "../../components/menu";
import {
  BookmarkIcon,
  ChevronDownIcon,
  DownloadIcon,
  EllipsisIcon,
  EyeOffIcon,
  MergeIcon,
  PenIcon,
  TrashIcon,
  UsersIcon,
} from "../../icon";
import { PortalContainer, ThemeScope } from "../../theme/portal-container";
import { Section, Specimen } from "../section";

function ConversationMenuContent() {
  return (
    <>
      <MenuGroup>
        <MenuGroupLabel>Conversation</MenuGroupLabel>
        <MenuItem icon={<PenIcon />} shortcut="⌘R">
          Renommer
        </MenuItem>
        <MenuItem icon={<BookmarkIcon />} shortcut="⌘B">
          Marquer le moment
        </MenuItem>
        <MenuSubmenu>
          <MenuSubmenuTrigger icon={<DownloadIcon />}>Exporter</MenuSubmenuTrigger>
          <MenuSubmenuPopup>
            <MenuItem>Texte brut</MenuItem>
            <MenuItem>Sous-titres (.srt)</MenuItem>
            <MenuItem>Markdown</MenuItem>
          </MenuSubmenuPopup>
        </MenuSubmenu>
        <MenuItem icon={<MergeIcon />} disabled>
          Fusionner les intervenants
        </MenuItem>
      </MenuGroup>
      <MenuSeparator />
      <MenuGroup>
        <MenuGroupLabel>Affichage</MenuGroupLabel>
        <MenuCheckboxItem defaultChecked>Afficher les résumés</MenuCheckboxItem>
        <MenuCheckboxItem shortcut="⌘T">Horodatage</MenuCheckboxItem>
        <MenuCheckboxItem defaultChecked disabled>
          Noms des intervenants
        </MenuCheckboxItem>
      </MenuGroup>
      <MenuSeparator />
      <MenuItem variant="danger" icon={<TrashIcon />} shortcut="⌘⌫">
        Supprimer la conversation
      </MenuItem>
      <MenuItem variant="danger" icon={<TrashIcon />} disabled>
        Supprimer l’enregistrement
      </MenuItem>
    </>
  );
}

function SortMenu() {
  const [sort, setSort] = useState("date");
  return (
    <Menu>
      <MenuTrigger>
        Trier par
        <ChevronDownIcon />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuRadioGroup value={sort} onValueChange={setSort}>
          <MenuGroupLabel>Trier par</MenuGroupLabel>
          <MenuRadioItem value="date">Date</MenuRadioItem>
          <MenuRadioItem value="duration">Durée</MenuRadioItem>
          <MenuRadioItem value="speaker">Intervenant</MenuRadioItem>
          <MenuRadioItem value="app" disabled>
            Application
          </MenuRadioItem>
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

function ListeningMenu() {
  return (
    <Menu>
      <MenuTrigger variant="ghost" size="icon" aria-label="Actions de l’écoute">
        <EllipsisIcon />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuItem shortcut="⌘⇧P">Mettre en pause l’écoute</MenuItem>
        <MenuItem>Ignorer cette application</MenuItem>
        <MenuItem>Rechercher dans vos conversations</MenuItem>
        <MenuSeparator />
        <MenuItem disabled>Reprendre l’écoute</MenuItem>
        <MenuItem variant="danger">Oublier la dernière heure</MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function ScopedMenu({ theme }: { theme: "light" | "dark" }) {
  return (
    <ThemeScope theme={theme} className="corner-s p-m">
      <Menu>
        <MenuTrigger variant="secondary">
          <UsersIcon />
          Intervenants
        </MenuTrigger>
        <MenuPopup align="start">
          <MenuItem icon={<EyeOffIcon />}>Masquer Camille</MenuItem>
          <MenuItem>Renommer Hugo</MenuItem>
          <MenuItem disabled>Fusionner avec Inès</MenuItem>
        </MenuPopup>
      </Menu>
    </ThemeScope>
  );
}

export default function MenuSection() {
  return (
    <Section id="menu" title="Menu">
      <Specimen label="Triggers">
        <SortMenu />
        <ListeningMenu />
        <Menu>
          <MenuTrigger disabled>
            Exporter
            <ChevronDownIcon />
          </MenuTrigger>
          <MenuPopup>
            <MenuItem>Texte brut</MenuItem>
          </MenuPopup>
        </Menu>
      </Specimen>
      <Specimen label="Open" className="items-start">
        {/*
          Static preview: the popup portals into an inert frame that contains it
          (layout containment), so it stays open in place and cannot take focus
          on load. Menu has no initialFocus prop.
        */}
        <div inert className="relative h-[30rem] w-full min-w-0 contain-layout">
          <PortalContainer>
            <Menu open modal={false}>
              <MenuTrigger>
                Conversation
                <ChevronDownIcon />
              </MenuTrigger>
              <MenuPopup align="start">
                <ConversationMenuContent />
              </MenuPopup>
            </Menu>
          </PortalContainer>
        </div>
      </Specimen>
      <Specimen label="Theme scope">
        <ScopedMenu theme="light" />
        <ScopedMenu theme="dark" />
      </Specimen>
    </Section>
  );
}
