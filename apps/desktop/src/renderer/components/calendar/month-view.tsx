import { cn } from "@sondine/ui";
import {
  PreviewCard,
  PreviewCardPopup,
  PreviewCardTrigger,
} from "@sondine/ui/components/preview-card";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { orpc } from "../../core/orpc";
import { addDays, dayNoonMs } from "../../lib/day";
import { formatDuration, longDate } from "../../lib/labels";
import { m } from "../../paraglide/messages.js";
import { getLocale } from "../../paraglide/runtime.js";
import { journalReading } from "../journal/journal-view";
import { monthStart, weekStart, zoomTransition } from "./calendar-view";
import { SWIPE_START_EVENT } from "./calendar-zoom";

// A month in the calendar (Téo, 2026-11-19): a cell per day, Monday first,
// with how many conversations it had and a bar for how long people spoke
// (`statistics.month`); hovering a day shows its first journal lines, a
// click opens the day, in the calendar. A week's number on the left opens that week.

const LONGEST_MS = 3 * 3_600_000;
const PREVIEW_LINES = 4;

export function MonthView({
  start,
  today,
  onWeek,
}: {
  start: string;
  today: string;
  onWeek: (day: string) => void;
}) {
  const month = useQuery(
    orpc.statistics.month.queryOptions({ input: { month: start.slice(0, 7) }, staleTime: 60_000 }),
  );
  const totals = new Map((month.data?.days ?? []).map((day) => [day.day, day]));
  const first = weekStart(start);
  const last = weekStart(addDays(monthStart(addDays(start, 40)), -1));
  const weeks = Math.round((dayNoonMs(last) - dayNoonMs(first)) / (7 * 86_400_000)) + 1;
  const weekday = new Intl.DateTimeFormat(getLocale(), { weekday: "short" });
  return (
    <div className="grid grid-cols-[2rem_repeat(7,minmax(0,1fr))] gap-xxs">
      <span aria-hidden />
      {Array.from({ length: 7 }, (_, index) => (
        <span
          key={index}
          aria-hidden
          className="pb-xxs text-center text-body-s text-cte-text-muted first-letter:uppercase"
        >
          {weekday.format(dayNoonMs(addDays(first, index)))}
        </span>
      ))}
      {Array.from({ length: weeks }, (_, week) => {
        const monday = addDays(first, week * 7);
        return [
          <button
            key={`w${monday}`}
            type="button"
            aria-label={m.calendar_open_week({ date: longDate(monday, today) })}
            onClick={() => onWeek(monday)}
            className="corner-s text-body-xs tabular-nums text-cte-text-muted control-hover:bg-neutral-3 focus-ring"
          >
            {weekNumber(monday)}
          </button>,
          ...Array.from({ length: 7 }, (_, index) => {
            const day = addDays(monday, index);
            return (
              <DayCell
                key={day}
                day={day}
                today={today}
                outside={day.slice(0, 7) !== start.slice(0, 7)}
                voicedMs={totals.get(day)?.voicedMs ?? 0}
                conversations={totals.get(day)?.conversations ?? 0}
              />
            );
          }),
        ];
      })}
    </div>
  );
}

function DayCell({
  day,
  today,
  outside,
  voicedMs,
  conversations,
}: {
  day: string;
  today: string;
  outside: boolean;
  voicedMs: number;
  conversations: number;
}) {
  const [open, setOpen] = useState(false);
  // A swipe closes the preview hovering opened.
  useEffect(() => {
    const close = () => setOpen(false);
    window.addEventListener(SWIPE_START_EVENT, close);
    return () => window.removeEventListener(SWIPE_START_EVENT, close);
  }, []);
  const future = day > today;
  const cell = cn(
    "flex min-h-[5.5rem] flex-col justify-between gap-xxs corner-s p-xs text-start",
    outside || future ? "bg-neutral-2 text-neutral-5" : "bg-neutral-2 control-hover:bg-neutral-3",
    day === today && "ring-[1px] ring-neutral-10",
    "focus-ring",
  );
  const body = (
    <>
      <span className={cn("tabular-nums", day === today && "font-heavy")}>
        {Number(day.slice(8))}
      </span>
      {/* How long people spoke; the count of conversations is in the day's name and preview. */}
      {voicedMs === 0 ? null : (
        <span className="flex min-w-0 flex-col gap-xxs">
          <span className="truncate text-body-xs whitespace-nowrap tabular-nums text-cte-text-muted">
            {formatDuration(voicedMs)}
          </span>
          <span className="h-[4px] overflow-hidden corner-full bg-neutral-4">
            <span
              className="block h-full corner-full bg-cte-text"
              style={{ width: `${Math.min(100, (voicedMs / LONGEST_MS) * 100)}%` }}
            />
          </span>
        </span>
      )}
    </>
  );
  if (future || outside) {
    return (
      <div aria-hidden={outside} className={cell}>
        {body}
      </div>
    );
  }
  return (
    <PreviewCard open={open} onOpenChange={setOpen}>
      <PreviewCardTrigger
        aria-label={m.calendar_day_label({ date: longDate(day, today), count: conversations })}
        className={cell}
        render={
          <Link
            to="/calendar"
            search={{ zoom: "day", day }}
            viewTransition={zoomTransition("month", "day")}
          />
        }
      >
        {body}
      </PreviewCardTrigger>
      {conversations === 0 ? null : (
        <PreviewCardPopup className="w-[20rem] gap-xs">
          {open ? <DayPreview day={day} today={today} conversations={conversations} /> : null}
        </PreviewCardPopup>
      )}
    </PreviewCard>
  );
}

/** The first journal lines of a day, loaded when its preview opens. */
function DayPreview({
  day,
  today,
  conversations,
}: {
  day: string;
  today: string;
  conversations: number;
}) {
  const journal = useQuery(orpc.journal.day.queryOptions({ input: { day } }));
  const lines = (journal.data?.state.enabled === true ? journal.data.conversations : [])
    .flatMap((conversation) => conversation.lines)
    .slice(0, PREVIEW_LINES);
  return (
    <>
      <p className="font-medium text-body-s first-letter:uppercase">
        {longDate(day, today)} · {m.today_people_conversations({ count: conversations })}
      </p>
      {lines.length === 0 ? (
        <p className="text-body-s text-cte-text-muted">
          {journal.data === undefined ? m.loading() : m.calendar_no_journal()}
        </p>
      ) : (
        <ul className="flex flex-col gap-xxs text-body-s">
          {lines.map((line) => (
            <li key={`${line.itemId ?? "m"}-${line.markId ?? "i"}`}>
              {journalReading(line.text, line.voices)}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** The ISO week number of a Monday. */
function weekNumber(monday: string): number {
  const thursday = new Date(dayNoonMs(addDays(monday, 3)));
  const yearStart = new Date(thursday.getFullYear(), 0, 1, 12);
  return Math.floor((thursday.getTime() - yearStart.getTime()) / (7 * 86_400_000)) + 1;
}
