import { useTheme } from "@sondine/ui";
import { Outlet, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useShortcut } from "../../shortcuts/shortcuts-provider";
import { PlayerBar } from "../player/player-bar";
import { focusSearchField } from "../search/search-field";
import { AgentPanelProvider, useAgentPanel } from "../chat/agent-panel-state";
import { ChatPanel } from "../chat/chat-panel";
import { RestoredNote } from "../backup/restored-note";
import { useMediaQuery } from "../../lib/media-query";
import { useImportDrop } from "../imports/import-actions";
import { m } from "../../paraglide/messages.js";
import { AppSidebar, NARROW_WINDOW } from "./app-sidebar";
import { CommandMenu } from "./command-menu";
import { WindowBar } from "./window-bar";
import { useEditCommands } from "./edit-commands";
import { useFollowDeletions, useFollowEpisodeChanges } from "./follow-deletions";
import { ListeningBanner } from "./listening-banner";
import { SCREEN_OVERLAY_ID } from "./screen";

// The window once the first run is done: the sidebar (with search and
// « Demander »), a banner when audio is not stored, the screen, and the
// player at the screen's foot while an episode is loaded. ⌘K opens Search
// with its field focused from anywhere; ⌘J the agent panel, beside the
// screen; ⇧⌘P the command palette; ⌘Z and ⇧⌘Z undo and redo the user's
// edits.

export function AppShell() {
  return (
    <AgentPanelProvider>
      <ShellLayout />
    </AgentPanelProvider>
  );
}

function ShellLayout() {
  const agent = useAgentPanel();
  const narrow = useMediaQuery(NARROW_WINDOW);
  const drop = useImportDrop();
  const { toggleTheme } = useTheme();
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);
  useFollowDeletions();
  useFollowEpisodeChanges();
  useEditCommands();
  useMainNavigation();
  useShortcut("theme.toggle", toggleTheme);
  useShortcut("palette.open", () => setPaletteOpen((open) => !open));
  useShortcut("search.open", () => {
    void navigate({ to: "/search", search: (previous) => previous }).then(focusSearchField);
  });
  useShortcut("agent.open", agent.toggle);

  return (
    // The window's ground is the sidebar's; the screen sits on it in a rounded card (ADR 037).
    // The top band (window buttons, back and forward, listening) is the title bar.
    <div className="relative flex h-dvh flex-col bg-neutral-2 text-cte-text" {...drop.handlers}>
      <RestoredNote />
      <WindowBar />
      <div className="flex min-h-0 flex-1">
        <AppSidebar />
        <div className="relative mb-xs me-xs flex min-w-0 flex-1 flex-col overflow-hidden corner-l bg-cte-canvas ring-[1px] ring-neutral-4">
          <ListeningBanner />
          {/* Hints laid over the screen, at its edges (the calendar's swipe). */}
          <div
            id={SCREEN_OVERLAY_ID}
            className="pointer-events-none absolute inset-0 z-20 overflow-hidden"
          />
          <main id="main" className="min-h-0 flex-1 overflow-y-auto p-xl">
            <Outlet />
          </main>
          {/* Below the screen, not over it: the end of a screen never hides under the player. */}
          <PlayerBar />
        </div>
        {/* The agent panel sits beside the screen, over it in a narrow window; it is not modal. */}
        {agent.open ? (
          <div
            className={narrow ? "absolute inset-y-0 end-zero z-10 shadow-m" : "contents"}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !event.defaultPrevented) agent.close();
            }}
          >
            <ChatPanel />
          </div>
        ) : null}
      </div>
      {drop.dragging ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-s z-20 flex items-center justify-center corner-l bg-cte-canvas/80 outline-2 outline-dashed outline-neutral-6"
        >
          <span className="font-medium text-body-m">{m.imports_drop()}</span>
        </div>
      ) : null}
      <CommandMenu open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}

/** A conversation or a person the menu bar opens (ADR 025): main sends the page. */
function useMainNavigation(): void {
  const router = useRouter();
  useEffect(
    () => window.sondine.onNavigate((path) => void router.navigate({ href: path })),
    [router],
  );
}
