import type { ChatFocus } from "@sondine/api";
import { useRouterState } from "@tanstack/react-router";
import { createContext, use, useMemo, useState, type ReactNode } from "react";
import { dayOf } from "../../lib/day";

// Whether the agent panel is open and which discussion it shows (ADR 037).
// The panel lives beside every screen, so its state is the window's, not a
// route's. A new discussion starts on the screen it opens on (its focus), with
// « Limiter » as the user set it before sending; once it exists, core keeps
// both with the discussion.

export interface AgentPanelState {
  readonly open: boolean;
  /** Null for a new discussion. */
  readonly discussionId: number | null;
  /** The conversation, day or person on screen: where a new discussion starts. */
  readonly screenFocus: ChatFocus | null;
  /** « Limiter » for the new discussion, before its first message. */
  readonly newLimited: boolean;
  setNewLimited(limited: boolean): void;
  toggle(): void;
  close(): void;
  /** Opens the panel on a discussion, or a new one (null). */
  show(discussionId: number | null): void;
}

const AgentPanelContext = createContext<AgentPanelState | null>(null);

export function AgentPanelProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [discussionId, setDiscussionId] = useState<number | null>(null);
  const [newLimited, setNewLimited] = useState(false);
  const screenFocus = useScreenFocus();
  const value = useMemo<AgentPanelState>(
    () => ({
      open,
      discussionId,
      screenFocus,
      newLimited,
      setNewLimited,
      toggle: () => setOpen((current) => !current),
      close: () => setOpen(false),
      show: (id) => {
        setDiscussionId(id);
        if (id !== null) setNewLimited(false);
        setOpen(true);
      },
    }),
    [open, discussionId, screenFocus, newLimited],
  );
  return <AgentPanelContext value={value}>{children}</AgentPanelContext>;
}

export function useAgentPanel(): AgentPanelState {
  const state = use(AgentPanelContext);
  if (state === null) throw new Error("useAgentPanel outside AgentPanelProvider");
  return state;
}

/** The conversation, person or day on screen; null elsewhere (search, settings…). */
function useScreenFocus(): ChatFocus | null {
  const location = useRouterState({ select: (state) => state.location });
  return useMemo(() => screenFocus(location.pathname, location.search), [location]);
}

export function screenFocus(pathname: string, search: Record<string, unknown>): ChatFocus | null {
  const episode = /^\/episode\/(\d+)$/u.exec(pathname);
  if (episode?.[1] !== undefined) return { kind: "episode", episodeId: Number(episode[1]) };
  const person = /^\/people\/(\d+)$/u.exec(pathname);
  if (person?.[1] !== undefined) return { kind: "person", personId: Number(person[1]) };
  if (pathname === "/") {
    const day = typeof search["day"] === "string" ? search["day"] : null;
    return { kind: "day", day: day ?? dayOf(Date.now()) };
  }
  return null;
}
