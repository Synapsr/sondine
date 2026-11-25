import type { JournalDay } from "@sondine/api";
import { cn } from "@sondine/ui";
import { useQueries } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { orpc } from "../../core/orpc";
import { addDays, dayNoonMs } from "../../lib/day";
import { HOUR_PX, placeDay, zoomTransition, type Placed } from "./calendar-view";
import { clock, contextLabel, longDate, voicesLabel } from "../../lib/labels";
import { m } from "../../paraglide/messages.js";
import { getLocale } from "../../paraglide/runtime.js";
import { journalReading } from "../journal/journal-view";
import {
  Dialog,
  DialogCornerClose,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@sondine/ui/components/dialog";
import { BookOpenIcon } from "@sondine/ui/icon";
import { useState } from "react";
import { KindTile } from "../today/today-rows";

// A week in the calendar (Téo, 2026-11-19): seven columns, Monday first,
// each day's conversations at their hour as on a diary, with their app's
// icon and whom they were with. A block opens its conversation, a day's
// head opens the day in the calendar, and the small book beside it, in a
// drawer, what mattered that day (its journal lines and commitments). The hours shown span the week's
// conversations, at least 8:00 to 20:00.

const FIRST_HOUR = 8;
const LAST_HOUR = 20;
const REFRESH_MS = 15_000;

export function WeekView({ start, today }: { start: string; today: string }) {
  const days = Array.from({ length: 7 }, (_, index) => addDays(start, index));
  const episodes = useQueries({
    queries: days.map((day) =>
      orpc.episodes.day.queryOptions({
        input: { day },
        enabled: day <= today,
        refetchInterval: day === today ? REFRESH_MS : false,
      }),
    ),
  });
  const journals = useQueries({
    queries: days.map((day) =>
      orpc.journal.day.queryOptions({ input: { day }, enabled: day <= today }),
    ),
  });
  const nowMs = Date.now();
  const conversations = episodes.map((query) => query.data?.conversations.episodes ?? []);
  const hours = conversations.flat().flatMap((episode) => {
    const at = new Date(episode.startedAtMs);
    const end = new Date(episode.endedAtMs ?? nowMs);
    return [at.getHours(), end.getHours() + 1];
  });
  const fromHour = Math.min(FIRST_HOUR, ...hours);
  const toHour = Math.max(LAST_HOUR, ...hours.map((hour) => Math.min(hour, 24)));
  const weekday = new Intl.DateTimeFormat(getLocale(), { weekday: "short" });
  const hourLabels = Array.from({ length: toHour - fromHour + 1 }, (_, index) => fromHour + index);
  return (
    <div className="grid grid-cols-[2.5rem_repeat(7,minmax(0,1fr))] gap-x-xs gap-y-s">
      <span aria-hidden />
      {days.map((day, index) => (
        <div key={day} className="relative flex min-w-0 justify-center">
          <Link
            to="/calendar"
            search={{ zoom: "day", day }}
            viewTransition={zoomTransition("week", "day")}
            disabled={day > today}
            aria-current={day === today ? "date" : undefined}
            className={cn(
              "flex min-w-0 flex-col items-center gap-xxs corner-s py-xxs text-body-xs focus-ring",
              day > today ? "text-neutral-5" : "text-cte-text-muted control-hover:bg-neutral-3",
            )}
          >
            <span className="max-w-full truncate first-letter:uppercase">
              {weekday.format(dayNoonMs(day))}
            </span>
            <span
              className={cn(
                "font-medium text-body-s tabular-nums",
                day === today && "corner-full bg-cte-text px-xs text-cte-canvas",
                day !== today && day <= today && "text-cte-text",
              )}
            >
              {Number(day.slice(8))}
            </span>
          </Link>
          <DayHighlights day={day} today={today} journal={journals[index]?.data} />
        </div>
      ))}
      {/* The hours, then each day's column on the same scale. */}
      <div aria-hidden className="relative" style={{ height: (toHour - fromHour) * HOUR_PX }}>
        {hourLabels.map((hour) => (
          <span
            key={hour}
            className="absolute end-zero -translate-y-1/2 text-body-xs tabular-nums text-cte-text-muted"
            style={{ top: (hour - fromHour) * HOUR_PX }}
          >
            {hour}
          </span>
        ))}
      </div>
      {days.map((day, index) => (
        <DayColumn
          key={day}
          day={day}
          placed={placeDay(conversations[index] ?? [], day, fromHour, nowMs)}
          height={(toHour - fromHour) * HOUR_PX}
          future={day > today}
          isToday={day === today}
        />
      ))}
    </div>
  );
}

function DayColumn({
  day,
  placed,
  height,
  future,
  isToday,
}: {
  day: string;
  placed: readonly Placed[];
  height: number;
  future: boolean;
  isToday: boolean;
}) {
  return (
    <ul
      aria-label={day}
      className={cn(
        "relative overflow-hidden corner-s bg-neutral-2",
        isToday && "ring-[1px] ring-neutral-6",
        future && "opacity-50",
      )}
      // A hairline each hour.
      style={{
        height,
        backgroundImage: `repeating-linear-gradient(to bottom, transparent 0 ${HOUR_PX - 1}px, var(--neutral-4) ${HOUR_PX - 1}px ${HOUR_PX}px)`,
      }}
    >
      {placed.map(({ episode, top, height: blockHeight, lane, lanes }) => {
        const title =
          voicesLabel(episode) ?? contextLabel(episode) ?? m.episode_size_conversation();
        return (
          <li
            key={episode.id}
            className="absolute px-[2px]"
            style={{
              top,
              height: blockHeight,
              left: `${(lane / lanes) * 100}%`,
              width: `${100 / lanes}%`,
            }}
          >
            <Link
              to="/episode/$id"
              params={{ id: String(episode.id) }}
              aria-label={`${clock(episode.startedAtMs)} · ${title}`}
              className={cn(
                "flex size-full items-start gap-xxs overflow-hidden corner-xs bg-cte-canvas px-xxs py-[2px]",
                "text-body-xs ring-[1px] ring-neutral-4 control-hover:ring-neutral-6 focus-ring",
              )}
            >
              <KindTile episode={episode} size="xs" />
              <span className="min-w-0 truncate font-medium">{title}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * What mattered that day, behind a small icon beside its head (Téo,
 * 2026-11-19): its journal lines, each opening its conversation, and the
 * commitments made that day; nothing when the journal has none.
 */
function DayHighlights({
  day,
  today,
  journal,
}: {
  day: string;
  today: string;
  journal: JournalDay | undefined;
}) {
  const [open, setOpen] = useState(false);
  if (journal === undefined || !journal.state.enabled) return null;
  const conversations = journal.conversations.filter(
    (conversation) => conversation.lines.length > 0,
  );
  const commitments = journal.commitments.filter((commitment) => commitment.status !== "dismissed");
  if (conversations.length === 0 && commitments.length === 0) return null;
  const date = longDate(day, today);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        variant="ghost"
        size="icon-s"
        aria-label={m.calendar_highlights({ date })}
        className="absolute end-zero top-zero text-cte-text-muted"
      >
        <BookOpenIcon />
      </DialogTrigger>
      <DialogPopup side="end" className="gap-m">
        <DialogTitle className="first-letter:uppercase">{date}</DialogTitle>
        {conversations.length === 0 ? null : (
          <ul className="flex flex-col gap-xs">
            {conversations.map((conversation) => (
              <li key={conversation.episodeId}>
                <Link
                  to="/episode/$id"
                  params={{ id: String(conversation.episodeId) }}
                  onClick={() => setOpen(false)}
                  className="flex gap-s corner-xs focus-ring control-hover:text-cte-text"
                >
                  <span className="w-[4.5rem] shrink-0 text-body-s whitespace-nowrap tabular-nums text-cte-text-muted">
                    {clock(conversation.startedAtMs)}
                  </span>
                  <span className="flex min-w-0 flex-col text-body-s">
                    {conversation.lines.map((line) => (
                      <span key={`${line.itemId ?? "m"}-${line.markId ?? "i"}`}>
                        {journalReading(line.text, line.voices)}
                      </span>
                    ))}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {commitments.length === 0 ? null : (
          <div className="flex flex-col gap-xxs">
            <p className="font-medium text-body-xs text-cte-text-muted">
              {m.journal_commitments()}
            </p>
            <ul className="flex flex-col gap-xxs text-body-s">
              {commitments.map((commitment) => (
                <li
                  key={`${commitment.itemId ?? "m"}-${commitment.markId ?? "i"}`}
                  className={commitment.status === "done" ? "text-cte-text-muted line-through" : ""}
                >
                  {journalReading(commitment.text, commitment.voices)}
                </li>
              ))}
            </ul>
          </div>
        )}
        <Link
          to="/calendar"
          search={{ zoom: "day", day }}
          viewTransition={zoomTransition("week", "day")}
          onClick={() => setOpen(false)}
          className="self-start corner-xs text-body-s underline underline-offset-4 focus-ring"
        >
          {m.calendar_open_day()}
        </Link>
        <DialogCornerClose aria-label={m.close()} />
      </DialogPopup>
    </Dialog>
  );
}
