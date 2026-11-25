import { cn } from "@sondine/ui";
import { Button } from "@sondine/ui/components/button";
import { ChevronLeftIcon, ChevronRightIcon, EllipsisIcon } from "@sondine/ui/icon";
import type { ReactNode } from "react";
import { m } from "../../paraglide/messages.js";
import { titleClassName } from "../shell/screen";
import type { PeriodHeading } from "./period-heading";

// The header of a day, a week or a month (Today and the calendar), one shape
// for all (Téo, 2026-11-20: going to another day moved the title, the
// controls and the column beside the thread). Always a title and a line
// under it; the controls keep their places: « Aujourd'hui » holds its slot
// while hidden, and so does the « ⋯ » where a period has none. The header's
// own width, never its words, puts the controls beside the title or under
// it, so each layout stays still from one period to the next.

export function PeriodHeader({
  heading,
  filter,
  zoom,
  atToday,
  onToday,
  previous,
  next,
  menu,
}: {
  heading: PeriodHeading;
  /** Day only: the filter menu, first, so its label's width moves nothing after it. */
  filter?: ReactNode;
  zoom: ReactNode;
  atToday: boolean;
  onToday: () => void;
  previous: { label: string; onClick: () => void };
  next: { label: string; onClick: () => void; disabled: boolean };
  /** Day only: the « ⋯ ». */
  menu?: ReactNode;
}) {
  return (
    <header data-slot="period-header" className="@container">
      <div className="flex flex-col gap-m @min-[44rem]:flex-row @min-[44rem]:items-end">
        <div className="flex min-w-0 flex-1 flex-col gap-xs">
          <h1 data-slot="period-title" className={cn(titleClassName, "truncate")}>
            {heading.title}
          </h1>
          <p data-slot="period-subtitle" className="truncate text-cte-text-muted">
            {heading.subtitle}
          </p>
        </div>
        {/* The buttons' own inset hangs outside, so their labels and icons line up with the text. */}
        <div data-slot="period-controls" className="-mx-s flex shrink-0 items-center gap-xxs">
          {filter}
          <span className="flex-1" />
          {zoom}
          <Button
            variant="ghost"
            className={atToday ? "invisible" : undefined}
            aria-hidden={atToday}
            tabIndex={atToday ? -1 : undefined}
            onClick={onToday}
          >
            {m.day_today()}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={previous.label}
            onClick={previous.onClick}
          >
            <ChevronLeftIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={next.label}
            disabled={next.disabled}
            onClick={next.onClick}
          >
            <ChevronRightIcon />
          </Button>
          {menu ?? (
            // The « ⋯ »'s place, held, so the arrows and the zoom stay put from a day to its week.
            <Button variant="ghost" size="icon" className="invisible" aria-hidden tabIndex={-1}>
              <EllipsisIcon />
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}
