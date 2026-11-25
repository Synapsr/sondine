import { cn } from "@sondine/ui";
import { Kbd } from "@sondine/ui/components/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@sondine/ui/components/tooltip";
import {
  CalendarIcon,
  ChipIcon,
  CircleCheckIcon,
  SearchIcon,
  SettingsIcon,
  SparkleIcon,
  SunIcon,
  UsersIcon,
  SlidersIcon,
} from "@sondine/ui/icon";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { orpc } from "../../core/orpc";
import { useMediaQuery } from "../../lib/media-query";
import { m } from "../../paraglide/messages.js";
import { useJournalLanguage } from "../journal/journal-language";
import { useShortcutLabel } from "../../shortcuts/shortcuts-provider";
import { useAgentPanel } from "../chat/agent-panel-state";
import { SidebarUpdateNote, SidebarUpdateQuestion } from "../updates/updates";
import { SidebarQuestion, useUsage } from "../usage/usage";
import { SidebarNow } from "./sidebar-now";

// Navigation on the left: Today (with the day's journal, ADR 037), the
// Calendar (a week or a month), Commitments, Search (⌘K, imported files
// under its « Importé » filter), « Demander » (⌘J), which opens and closes
// the agent panel and stays lit while it is open, People, what is being
// said now, then Settings. Listening is in the top bar (ADR 037). In a
// narrow window it folds to a rail of icons, with the labels as tooltips.

/** Below this window width the sidebar is a rail (the window's minimum is 720 px). */
export const NARROW_WINDOW = "(max-width: 55rem)";

const itemClassName = cn(
  "flex items-center gap-xs corner-s px-s py-xs",
  "font-body font-medium text-body-s text-cte-text-muted",
  "transition-[background-color,color] duration-motion ease-motion motion-reduce:transition-none",
  "focus-ring",
);
const linkClassName = cn(
  itemClassName,
  "control-hover:bg-neutral-3 data-[status=active]:bg-neutral-4 data-[status=active]:text-cte-text",
);
const toggleClassName = cn(
  itemClassName,
  "control-hover:bg-neutral-3 aria-pressed:bg-neutral-4 aria-pressed:text-cte-text",
);

type NavTarget =
  | "/"
  | "/calendar"
  | "/commitments"
  | "/search"
  | "/people"
  | "/settings"
  | "/design-system"
  | "/notch-lab";

function NavLink({
  to,
  icon,
  label,
  shortcut,
  compact,
}: {
  to: NavTarget;
  icon: ReactNode;
  label: string;
  shortcut?: string | null;
  compact: boolean;
}) {
  const linkProps = {
    to,
    activeOptions: { exact: to === "/", includeSearch: false },
  } as const;
  if (compact) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={<Link {...linkProps} aria-label={label} className={cn(linkClassName, "px-xs")} />}
        >
          {icon}
        </TooltipTrigger>
        <TooltipPopup side="right">
          {label}
          {shortcut === null || shortcut === undefined ? null : <span aria-hidden>{shortcut}</span>}
        </TooltipPopup>
      </Tooltip>
    );
  }
  return (
    <Link {...linkProps} className={linkClassName}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {shortcut === null || shortcut === undefined ? null : <Kbd>{shortcut}</Kbd>}
    </Link>
  );
}

/** « Demander »: opens and closes the agent panel, lit while it is open. */
function AskItem({ compact }: { compact: boolean }) {
  const agent = useAgentPanel();
  const shortcut = useShortcutLabel("agent.open");
  const label = m.nav_ask();
  if (compact) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={label}
              aria-pressed={agent.open}
              onClick={agent.toggle}
              className={cn(toggleClassName, "px-xs")}
            />
          }
        >
          <SparkleIcon />
        </TooltipTrigger>
        <TooltipPopup side="right">
          {label}
          {shortcut === null ? null : <span aria-hidden>{shortcut}</span>}
        </TooltipPopup>
      </Tooltip>
    );
  }
  return (
    <button
      type="button"
      aria-pressed={agent.open}
      onClick={agent.toggle}
      className={cn(toggleClassName, "text-start")}
    >
      <SparkleIcon />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {shortcut === null ? null : <Kbd>{shortcut}</Kbd>}
    </button>
  );
}

/** The note of the last update, then one question at a time. */
function SidebarCards() {
  const usage = useUsage();
  return (
    <>
      <SidebarUpdateNote />
      <SidebarQuestion />
      {usage.data === undefined || usage.data.answer === null ? null : <SidebarUpdateQuestion />}
    </>
  );
}

export function AppSidebar() {
  const compact = useMediaQuery(NARROW_WINDOW);
  // On by default; its state also tells core the window's language for new lines.
  const journal = useQuery(orpc.journal.day.queryOptions({ input: {} }));
  useJournalLanguage(journal.data);
  const searchShortcut = useShortcutLabel("search.open");
  return (
    <aside
      className={cn(
        "flex shrink-0 flex-col gap-xxs px-s pb-s",
        compact ? "items-center px-xs" : "w-[15rem]",
      )}
    >
      <nav aria-label={m.nav_label()} className="flex flex-1 flex-col gap-xxs">
        <NavLink to="/" icon={<SunIcon />} label={m.nav_today()} compact={compact} />
        <NavLink
          to="/calendar"
          icon={<CalendarIcon />}
          label={m.nav_calendar()}
          compact={compact}
        />
        <NavLink
          to="/commitments"
          icon={<CircleCheckIcon />}
          label={m.nav_commitments()}
          compact={compact}
        />
        <NavLink
          to="/search"
          icon={<SearchIcon />}
          label={m.nav_search()}
          shortcut={searchShortcut}
          compact={compact}
        />
        <AskItem compact={compact} />
        <NavLink to="/people" icon={<UsersIcon />} label={m.nav_people()} compact={compact} />
        <SidebarNow compact={compact} />
        <div className="mt-auto flex flex-col gap-xxs">
          {compact ? null : <SidebarCards />}
          <NavLink
            to="/settings"
            icon={<SettingsIcon />}
            label={m.nav_settings()}
            compact={compact}
          />
          {import.meta.env.DEV ? (
            <>
              <NavLink
                to="/design-system"
                icon={<ChipIcon />}
                label={m.nav_design_system()}
                compact={compact}
              />
              <NavLink
                to="/notch-lab"
                icon={<SlidersIcon />}
                label={m.nav_notch_lab()}
                compact={compact}
              />
            </>
          ) : null}
        </div>
      </nav>
    </aside>
  );
}
