import { cn } from "@sondine/ui";
import { Button } from "@sondine/ui/components/button";
import { ChevronLeftIcon, ChevronRightIcon } from "@sondine/ui/icon";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { orpc } from "../../core/orpc";
import { longDate } from "../../lib/labels";
import { m } from "../../paraglide/messages.js";
import { getLocale } from "../../paraglide/runtime.js";
import { headingClassName } from "../journal/journal-block";

// A month beside Today's thread, to go to any day in one click (Téo,
// 2026-11-19): each day shows by a dot how much was said, the day shown is in
// ink, today in bold, days to come are out of reach. The arrows change the
// month; the thread follows only the day clicked.

/** Voiced time from which a day's dot is medium, then full (ms). */
const SOME_MS = 10 * 60_000;
const MUCH_MS = 45 * 60_000;

const monthOf = (day: string) => day.slice(0, 7);

function shiftMonth(month: string, by: number): string {
  const [year = 1970, index = 1] = month.split("-").map(Number);
  const at = new Date(year, index - 1 + by, 1);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}`;
}

/** Monday first: the empty cells before the 1st. */
function leadingBlanks(month: string): number {
  const [year = 1970, index = 1] = month.split("-").map(Number);
  return (new Date(year, index - 1, 1).getDay() + 6) % 7;
}

function monthTitle(month: string): string {
  const [year = 1970, index = 1] = month.split("-").map(Number);
  return new Intl.DateTimeFormat(getLocale(), { month: "long", year: "numeric" }).format(
    new Date(year, index - 1, 1),
  );
}

/** Narrow weekday names, Monday first (16 November 2026 is a Monday). */
function weekdays(): string[] {
  const format = new Intl.DateTimeFormat(getLocale(), { weekday: "narrow" });
  return Array.from({ length: 7 }, (_, index) => format.format(new Date(2026, 10, 16 + index)));
}

export function DayCalendar({
  shown,
  today,
  onPick,
  className,
}: {
  shown: string;
  today: string;
  onPick: (day: string) => void;
  className?: string;
}) {
  const [picked, setPicked] = useState(monthOf(shown));
  // Another day chosen elsewhere (the arrows, a link) brings its month back.
  const [follows, setFollows] = useState(shown);
  if (follows !== shown) {
    setFollows(shown);
    setPicked(monthOf(shown));
  }
  const month = picked;
  // The thread's own refresh brings new days; a minute is fresh enough for the dots.
  const data = useQuery(
    orpc.statistics.month.queryOptions({ input: { month }, staleTime: 60_000 }),
  );
  const days = data.data?.days ?? [];
  return (
    <section aria-label={m.calendar_label()} className={cn("flex-col gap-xs", className)}>
      <div className="flex items-center justify-between gap-xs">
        <h2 className={cn(headingClassName, "first-letter:uppercase")}>{monthTitle(month)}</h2>
        <div className="-me-xxs flex items-center">
          <Button
            variant="ghost"
            size="icon-s"
            aria-label={m.calendar_previous_month()}
            onClick={() => setPicked(shiftMonth(month, -1))}
          >
            <ChevronLeftIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-s"
            aria-label={m.calendar_next_month()}
            disabled={month >= monthOf(today)}
            onClick={() => setPicked(shiftMonth(month, 1))}
          >
            <ChevronRightIcon />
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-xxs text-center text-body-xs">
        {weekdays().map((name, index) => (
          <span key={index} aria-hidden className="py-xxs text-cte-text-muted">
            {name}
          </span>
        ))}
        {Array.from({ length: leadingBlanks(month) }, (_, index) => (
          <span key={`blank-${index}`} aria-hidden />
        ))}
        {days.map(({ day, voicedMs, conversations }) => {
          const future = day > today;
          const current = day === shown;
          const level = voicedMs >= MUCH_MS ? 3 : voicedMs >= SOME_MS ? 2 : voicedMs > 0 ? 1 : 0;
          return (
            <button
              key={day}
              type="button"
              disabled={future}
              aria-current={current ? "date" : undefined}
              aria-label={m.calendar_day_label({
                date: longDate(day, today),
                count: conversations,
              })}
              onClick={() => onPick(day)}
              className={cn(
                "relative flex aspect-square flex-col items-center justify-center corner-s tabular-nums",
                "transition-[background-color] duration-motion ease-motion motion-reduce:transition-none focus-ring",
                current
                  ? "bg-cte-text text-cte-canvas"
                  : future
                    ? "text-neutral-5"
                    : "control-hover:bg-neutral-3",
                day === today && "font-heavy",
              )}
            >
              {Number(day.slice(8))}
              <span
                aria-hidden
                className={cn(
                  "absolute bottom-[3px] size-[4px] corner-full",
                  current ? "bg-cte-canvas" : "bg-cte-text",
                  ["opacity-0", "opacity-30", "opacity-60", "opacity-100"][level],
                )}
              />
            </button>
          );
        })}
      </div>
    </section>
  );
}
