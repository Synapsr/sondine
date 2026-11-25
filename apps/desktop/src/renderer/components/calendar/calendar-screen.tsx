import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { addDays, dayOf } from "../../lib/day";
import { m } from "../../paraglide/messages.js";
import {
  monthStart,
  weekStart,
  zoomedIn,
  zoomedOut,
  zoomTransition,
  type Zoom,
} from "./calendar-view";
import { useCalendarGestures, ZoomSwitch } from "./calendar-zoom";
import { DayView } from "../today/today-screen";
import { MonthView } from "./month-view";
import { monthHeading, weekHeading } from "./period-heading";
import { PeriodHeader } from "./period-header";
import { WeekView } from "./week-view";

// The calendar (`/calendar`, Téo, 2026-11-19): a day, as Today shows it; a
// week, the conversations at their hour with each day's journal under them;
// or a month, how much was said each day with its journal on hover. The
// switch, ⌘− / ⌘+ and a pinch zoom between them around the day in the URL,
// staying in the calendar; the arrows and a two-finger swipe go by a day, a
// week or a month. The header has the day's shape (period-header.tsx), so
// the zoom and the arrows stay put from one zoom to the next.

const route = getRouteApi("/shell/calendar");

export function CalendarScreen() {
  const search = route.useSearch();
  const navigate = useNavigate();
  const zoom = search.zoom ?? "week";
  const today = dayOf(Date.now());
  const day = search.day ?? today;
  const go = (next: Zoom, at: string) =>
    void navigate({
      to: "/calendar",
      search: { zoom: next, day: at },
      viewTransition: zoomTransition(zoom, next),
    });
  const start = zoom === "week" ? weekStart(day) : monthStart(day);
  const shift = (by: number) =>
    zoom === "week" ? addDays(start, 7 * by) : monthStart(addDays(start, by > 0 ? 40 : -1));
  const atToday = start === (zoom === "week" ? weekStart(today) : monthStart(today));
  const swipe = useCalendarGestures({
    // At the day's zoom, the day's view shows its own hint and turns its own days.
    hasNext: !atToday,
    onZoom: (direction) => {
      if (zoom === "day") {
        if (direction === "out") go("week", day);
        return;
      }
      const next = direction === "in" ? zoomedIn(zoom) : zoomedOut(zoom);
      if (next !== null) go(next, day);
    },
    // The day's view turns its own days.
    onSwipe: (direction) => {
      if (zoom === "day" || (direction === "next" && atToday)) return;
      go(zoom, shift(direction === "next" ? 1 : -1));
    },
  });
  if (zoom === "day") {
    return (
      <DayView
        place="calendar"
        search={{ day: search.day, media: search.media, dictations: search.dictations }}
        update={(patch) =>
          void navigate({
            to: "/calendar",
            search: (previous) => ({ ...previous, zoom: "day", ...patch }),
          })
        }
      />
    );
  }
  return (
    <div ref={swipe.contentRef} className="mx-auto flex w-full max-w-[76rem] flex-col gap-l">
      {swipe.hint}
      <PeriodHeader
        heading={zoom === "week" ? weekHeading(start, today) : monthHeading(start)}
        zoom={<ZoomSwitch zoom={zoom} day={search.day} />}
        atToday={atToday}
        onToday={() => go(zoom, today)}
        previous={{
          label: zoom === "week" ? m.calendar_previous_week() : m.calendar_previous_month(),
          onClick: () => go(zoom, shift(-1)),
        }}
        next={{
          label: zoom === "week" ? m.calendar_next_week() : m.calendar_next_month(),
          onClick: () => go(zoom, shift(1)),
          disabled: atToday,
        }}
      />
      {zoom === "week" ? (
        <WeekView start={start} today={today} />
      ) : (
        <MonthView start={start} today={today} onWeek={(at) => go("week", at)} />
      )}
    </div>
  );
}
