import { Fragment, type ReactNode, useState } from "react";
import { Badge, type BadgeProps } from "../../components/badge";
import {
  CommandPalette,
  CommandPaletteCollection,
  CommandPaletteDialog,
  CommandPaletteDialogPopup,
  CommandPaletteDialogTrigger,
  CommandPaletteEmpty,
  CommandPaletteFooter,
  CommandPaletteGroup,
  CommandPaletteGroupLabel,
  CommandPaletteInput,
  CommandPaletteItem,
  CommandPaletteList,
  type CommandPaletteProps,
  CommandPaletteSeparator,
  CommandPaletteStatus,
} from "../../components/command-palette";
import { Kbd, KbdGroup } from "../../components/kbd";
import {
  BookmarkIcon,
  CalendarIcon,
  ChipIcon,
  DownloadIcon,
  LoaderIcon,
  MoonIcon,
  PauseIcon,
  PhoneIcon,
  SearchIcon,
  SettingsIcon,
  UserIcon,
  UsersIcon,
  VideoIcon,
} from "../../icon";
import { PortalContainer } from "../../theme/portal-container";
import { Section, Specimen } from "../section";

interface Command {
  value: string;
  label: string;
  icon: ReactNode;
  description?: string;
  shortcut?: string;
  badge?: { variant: NonNullable<BadgeProps["variant"]>; label: string };
  disabled?: boolean;
}

interface CommandGroup {
  value: string;
  items: Command[];
}

const commandGroups: CommandGroup[] = [
  {
    value: "Actions",
    items: [
      {
        value: "pause",
        label: "Mettre en pause l’écoute",
        icon: <PauseIcon />,
        shortcut: "⌥⌘P",
      },
      {
        value: "keep",
        label: "Garder cette conversation",
        icon: <BookmarkIcon />,
        shortcut: "⌘S",
      },
      {
        value: "export",
        label: "Exporter la conversation",
        icon: <DownloadIcon />,
        description: "Disponible après la transcription",
        shortcut: "⇧⌘E",
        disabled: true,
      },
      { value: "theme", label: "Basculer le thème", icon: <MoonIcon />, shortcut: "D" },
    ],
  },
  {
    value: "Conversations",
    items: [
      {
        value: "daily",
        label: "Point quotidien",
        icon: <VideoIcon />,
        description: "Zoom · Camille, Hugo · 08:42",
        badge: { variant: "success", label: "Transcrite" },
      },
      {
        value: "supplier",
        label: "Appel fournisseur",
        icon: <PhoneIcon />,
        description: "Téléphone · Inès · 09:15",
        badge: { variant: "neutral", label: "En cours" },
      },
      {
        value: "design",
        label: "Revue de design",
        icon: <VideoIcon />,
        description: "Google Meet · Camille, Léa · 10:03",
        badge: { variant: "warning", label: "Audio partiel" },
      },
      {
        value: "interview",
        label: "Entretien candidat",
        icon: <VideoIcon />,
        description: "Zoom · Nora · 13:10",
        badge: { variant: "error", label: "Échec" },
      },
    ],
  },
  {
    value: "Personnes",
    items: [
      {
        value: "camille",
        label: "Camille",
        icon: <UserIcon />,
        description: "12 conversations",
      },
      {
        value: "unknown",
        label: "Qui est-ce ?",
        icon: <UsersIcon />,
        description: "Voix à identifier",
        badge: { variant: "neutral", label: "3" },
      },
    ],
  },
  {
    value: "Aller à",
    items: [
      { value: "today", label: "Aujourd’hui", icon: <CalendarIcon />, shortcut: "⌘1" },
      { value: "people", label: "Personnes", icon: <UsersIcon />, shortcut: "⌘2" },
      { value: "settings", label: "Réglages", icon: <SettingsIcon />, shortcut: "⌘," },
      { value: "diagnostics", label: "Diagnostics", icon: <ChipIcon /> },
    ],
  },
];

function CommandRows({ onRun }: { onRun?: (() => void) | undefined }) {
  return (
    <CommandPaletteList>
      {(group: CommandGroup, index: number) => (
        <Fragment key={group.value}>
          {index > 0 ? <CommandPaletteSeparator /> : null}
          <CommandPaletteGroup items={group.items}>
            <CommandPaletteGroupLabel>{group.value}</CommandPaletteGroupLabel>
            <CommandPaletteCollection>
              {(command: Command) => (
                <CommandPaletteItem
                  key={command.value}
                  value={command}
                  icon={command.icon}
                  description={command.description}
                  shortcut={command.shortcut}
                  trailing={
                    command.badge ? (
                      <Badge variant={command.badge.variant}>{command.badge.label}</Badge>
                    ) : undefined
                  }
                  disabled={command.disabled}
                  onClick={onRun}
                >
                  {command.label}
                </CommandPaletteItem>
              )}
            </CommandPaletteCollection>
          </CommandPaletteGroup>
        </Fragment>
      )}
    </CommandPaletteList>
  );
}

function Hints() {
  return (
    <CommandPaletteFooter>
      <span>
        <KbdGroup>
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
        </KbdGroup>
        Naviguer
      </span>
      <span>
        <Kbd>↵</Kbd>
        Ouvrir
      </span>
      <span>
        <Kbd>esc</Kbd>
        Fermer
      </span>
    </CommandPaletteFooter>
  );
}

const searchLabel = "Rechercher une commande ou une conversation";

interface PaletteProps extends Omit<
  CommandPaletteProps<Command>,
  "items" | "children" | "value" | "defaultValue" | "onValueChange"
> {
  initialQuery?: string;
  onRun?: (() => void) | undefined;
}

function Palette({ initialQuery = "", onRun, ...props }: PaletteProps) {
  const [query, setQuery] = useState(initialQuery);
  return (
    <CommandPalette items={commandGroups} value={query} onValueChange={setQuery} {...props}>
      <CommandPaletteInput
        aria-label={searchLabel}
        placeholder="Rechercher dans vos conversations"
      />
      <CommandPaletteEmpty>Aucun résultat pour «&nbsp;{query}&nbsp;»</CommandPaletteEmpty>
      <CommandRows onRun={onRun} />
      <Hints />
    </CommandPalette>
  );
}

function ModalDemo({ disabled = false }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <CommandPaletteDialog open={open} onOpenChange={setOpen}>
      <CommandPaletteDialogTrigger disabled={disabled}>
        <SearchIcon />
        Rechercher
        <KbdGroup>
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </KbdGroup>
      </CommandPaletteDialogTrigger>
      <CommandPaletteDialogPopup aria-label="Palette de commandes">
        <Palette onRun={() => setOpen(false)} />
      </CommandPaletteDialogPopup>
    </CommandPaletteDialog>
  );
}

// A frame that hosts the popup's portal and contains its fixed backdrop and
// viewport (layout containment), so an open palette previews in place.
function PreviewStage({ className, children }: { className: string; children: ReactNode }) {
  return (
    <div
      className={`relative min-w-0 overflow-hidden corner-m bg-cte-canvas contain-layout ${className}`}
    >
      <PortalContainer>
        {/* Static previews: non-modal, kept open, and they do not take focus on load. */}
        <CommandPaletteDialog defaultOpen modal={false} disablePointerDismissal>
          <CommandPaletteDialogPopup aria-label="Palette de commandes" initialFocus={false}>
            {children}
          </CommandPaletteDialogPopup>
        </CommandPaletteDialog>
      </PortalContainer>
    </div>
  );
}

export default function CommandPaletteSection() {
  return (
    <Section id="command-palette" title="Command palette">
      <p className="text-body-xs text-cte-text-muted">
        Coverage gap: no Graphical specification. Composes the Dialog, Autocomplete and Menu parts.
      </p>
      <Specimen label="Trigger: opens the modal palette; disabled">
        <ModalDemo />
        <ModalDemo disabled />
      </Specimen>
      <Specimen
        label="Open: groups, icons, descriptions, badges, shortcuts; first row highlighted, disabled row"
        className="grid grid-cols-1 items-stretch"
      >
        <PreviewStage className="h-[38rem]">
          <Palette />
        </PreviewStage>
      </Specimen>
      <Specimen label="No results, searching, disabled" className="grid grid-cols-3 items-stretch">
        <PreviewStage className="h-[20rem]">
          <Palette initialQuery="Webex" />
        </PreviewStage>
        <PreviewStage className="h-[20rem]">
          <CommandPalette items={[]} defaultValue="budget 2027">
            <CommandPaletteInput
              aria-label={searchLabel}
              placeholder="Rechercher dans vos conversations"
            />
            <CommandPaletteStatus>
              <LoaderIcon className="animate-spin motion-reduce:animate-none" />
              Recherche dans les transcriptions…
            </CommandPaletteStatus>
            <CommandPaletteList />
            <Hints />
          </CommandPalette>
        </PreviewStage>
        <PreviewStage className="h-[20rem]">
          <CommandPalette items={commandGroups.slice(3)} disabled>
            <CommandPaletteInput
              aria-label={searchLabel}
              placeholder="Rechercher dans vos conversations"
            />
            <CommandRows />
          </CommandPalette>
        </PreviewStage>
      </Specimen>
    </Section>
  );
}
