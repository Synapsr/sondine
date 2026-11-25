import { useTheme } from "@sondine/ui";
import {
  CommandPalette,
  CommandPaletteDialog,
  CommandPaletteDialogPopup,
  CommandPaletteEmpty,
  CommandPaletteFooter,
  CommandPaletteInput,
  CommandPaletteItem,
  CommandPaletteList,
} from "@sondine/ui/components/command-palette";
import { Kbd, KbdGroup } from "@sondine/ui/components/kbd";
import {
  CalendarIcon,
  ChipIcon,
  CircleCheckIcon,
  FolderIcon,
  MoonIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  StopIcon,
  WaveformIcon,
  SlidersIcon,
} from "@sondine/ui/icon";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { orpc } from "../../core/orpc";
import { m } from "../../paraglide/messages.js";
import { SHORTCUT_ACTIONS } from "../../shortcuts/registry";
import { useShortcutLabel } from "../../shortcuts/shortcuts-provider";
import { endLabel, useEndEpisode } from "../episode/end-episode";
import { useImport } from "../imports/import-actions";
import { TIMED_PAUSES_MS } from "../../../shared/timed-pause";
import { focusSearchField } from "../search/search-field";
import { listeningView } from "../status/listening-view";

// ⇧⌘P: the screens and the app's actions over the shortcut registry.

interface Command {
  readonly value: string;
  readonly label: string;
  readonly keywords: readonly string[];
  readonly icon: ReactNode;
  readonly shortcut?: string | null;
  readonly disabled?: boolean;
  readonly run: () => void;
}

export function CommandMenu({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const { toggleTheme } = useTheme();
  const navigate = useNavigate();
  const themeShortcut = useShortcutLabel("theme.toggle");
  const searchShortcut = useShortcutLabel("search.open");
  const imports = useImport();
  const status = useQuery(
    orpc.status.watch.experimental_liveOptions({ retry: true, enabled: open }),
  );
  const pause = useMutation(orpc.listening.pause.mutationOptions());
  const resume = useMutation(orpc.listening.resume.mutationOptions());
  const day = useQuery(orpc.episodes.day.queryOptions({ input: {}, enabled: open }));
  const end = useEndEpisode();
  const view = status.data === undefined ? null : listeningView(status.data.listening);
  const pauseFor = (durationMs: number | null) =>
    pause.mutate(durationMs === null ? {} : { untilMs: Date.now() + durationMs });

  const listening: Command[] =
    view?.actions.includes("resume") === true
      ? [
          {
            value: "listening.resume",
            label: m.tray_resume(),
            keywords: ["resume", "reprendre", "listen", "écouter"],
            icon: <PlayIcon />,
            run: () => resume.mutate({}),
          },
        ]
      : [
          {
            value: "listening.pause-15-min",
            label: m.tray_pause_15_min(),
            keywords: ["pause", "stop", "15"],
            icon: <PauseIcon />,
            disabled: view === null,
            run: () => pauseFor(TIMED_PAUSES_MS["15-min"]),
          },
          {
            value: "listening.pause-1-hour",
            label: m.tray_pause_1_hour(),
            keywords: ["pause", "stop", "hour", "heure"],
            icon: <PauseIcon />,
            disabled: view === null,
            run: () => pauseFor(TIMED_PAUSES_MS["1-hour"]),
          },
          {
            value: "listening.pause",
            label: m.tray_pause_until_resumed(),
            keywords: ["pause", "stop"],
            icon: <PauseIcon />,
            disabled: view === null,
            run: () => pauseFor(null),
          },
        ];

  // « Terminer » for each recording going on (ADR 044).
  const ongoing = (day.data?.ongoing ?? []).map((episode): Command => ({
    value: `episode.end-${episode.id}`,
    label: endLabel(episode),
    keywords: ["end", "finish", "stop", "terminer", "finir", "next", "suivant"],
    icon: <StopIcon />,
    run: () => end.mutate({ episodeId: episode.id }),
  }));

  const commands: Command[] = [
    {
      value: "nav.today",
      label: m.nav_today(),
      keywords: [
        "today",
        "aujourd'hui",
        "timeline",
        "journal",
        "engagements",
        "commitments",
        "promesses",
        "promises",
      ],
      icon: <CalendarIcon />,
      run: () => void navigate({ to: "/" }),
    },
    {
      value: "nav.calendar",
      label: m.nav_calendar(),
      keywords: ["calendar", "calendrier", "week", "semaine", "month", "mois", "agenda"],
      icon: <CalendarIcon />,
      run: () => void navigate({ to: "/calendar" }),
    },
    {
      value: "nav.commitments",
      label: m.nav_commitments(),
      keywords: ["commitments", "engagements", "promesses", "à faire", "todo", "tâches"],
      icon: <CircleCheckIcon />,
      run: () => void navigate({ to: "/commitments" }),
    },
    {
      value: "nav.search",
      label: SHORTCUT_ACTIONS["search.open"].label(),
      keywords: SHORTCUT_ACTIONS["search.open"].keywords,
      icon: <SearchIcon />,
      shortcut: searchShortcut,
      run: () => void navigate({ to: "/search" }).then(focusSearchField),
    },
    ...ongoing,
    ...listening,
    {
      value: "theme.toggle",
      label: SHORTCUT_ACTIONS["theme.toggle"].label(),
      keywords: SHORTCUT_ACTIONS["theme.toggle"].keywords,
      icon: <MoonIcon />,
      shortcut: themeShortcut,
      run: toggleTheme,
    },
    {
      value: "imports.pick",
      label: m.imports_add(),
      keywords: ["import", "importer", "audio", "fichier", "file", "enregistrement", "recording"],
      icon: <PlusIcon />,
      run: imports.pick,
    },
    {
      value: "nav.imports",
      label: m.nav_imports(),
      keywords: ["import", "importer", "audio", "fichier", "file"],
      icon: <FolderIcon />,
      run: () => void navigate({ to: "/search", search: { contexts: ["imported"] } }),
    },
    {
      value: "nav.settings",
      label: m.nav_settings(),
      keywords: ["settings", "réglages", "preferences", "model", "modèle"],
      icon: <SettingsIcon />,
      run: () => void navigate({ to: "/settings" }),
    },
    {
      value: "nav.status",
      label: m.settings_tab_advanced(),
      keywords: ["status", "état", "advanced", "avancé", "helper", "permissions"],
      icon: <WaveformIcon />,
      run: () => void navigate({ to: "/settings/$page", params: { page: "advanced" } }),
    },
    ...(import.meta.env.DEV
      ? [
          {
            value: "nav.design-system",
            label: m.nav_design_system(),
            keywords: ["design", "components", "composants"],
            icon: <ChipIcon />,
            run: () => void navigate({ to: "/design-system" }),
          },
          {
            value: "nav.notch-lab",
            label: m.nav_notch_lab(),
            keywords: ["notch", "encoche", "island"],
            icon: <SlidersIcon />,
            run: () => void navigate({ to: "/notch-lab" }),
          },
        ]
      : []),
  ];

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) setQuery("");
  };

  return (
    <CommandPaletteDialog open={open} onOpenChange={close}>
      <CommandPaletteDialogPopup aria-label={m.command_palette_title()}>
        <CommandPalette
          items={commands}
          value={query}
          onValueChange={setQuery}
          itemToStringValue={(command) => [command.label, ...command.keywords].join(" ")}
        >
          <CommandPaletteInput
            aria-label={m.command_palette_search()}
            placeholder={m.command_palette_placeholder()}
          />
          <CommandPaletteEmpty>{m.command_palette_empty()}</CommandPaletteEmpty>
          <CommandPaletteList>
            {(command: Command) => (
              <CommandPaletteItem
                key={command.value}
                value={command}
                icon={command.icon}
                shortcut={command.shortcut ?? undefined}
                disabled={command.disabled}
                onClick={() => {
                  command.run();
                  close(false);
                }}
              >
                {command.label}
              </CommandPaletteItem>
            )}
          </CommandPaletteList>
          <CommandPaletteFooter>
            <span>
              <KbdGroup>
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd>
              </KbdGroup>
              {m.command_palette_hint_navigate()}
            </span>
            <span>
              <Kbd>↵</Kbd>
              {m.command_palette_hint_run()}
            </span>
            <span>
              <Kbd>esc</Kbd>
              {m.command_palette_close()}
            </span>
          </CommandPaletteFooter>
        </CommandPalette>
      </CommandPaletteDialogPopup>
    </CommandPaletteDialog>
  );
}
