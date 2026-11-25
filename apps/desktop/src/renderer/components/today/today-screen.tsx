import type { AnalysisStatus, EpisodeSummary, EpisodesDayOutput } from "@sondine/api";
import { Button } from "@sondine/ui/components/button";
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from "@sondine/ui/components/menu";
import { ChevronDownIcon } from "@sondine/ui/icon";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { errorMessage, orpc } from "../../core/orpc";
import { addDays, dayOf } from "../../lib/day";
import { m } from "../../paraglide/messages.js";
import { waitReasonText } from "../../../shared/queue-line";
import { DayCommitments } from "../journal/journal-block";
import { journalReading } from "../journal/journal-view";
import { DayCalendar } from "./day-calendar";
import { DayMenu } from "./day-menu";
import { DayPeople } from "./day-people";
import { useDisplaySettings } from "./display-settings";
import { useEpisodePages } from "./episode-pages";
import { ConversationRow, LaneRow, MomentHourRow, TracesLine } from "./today-rows";
import { mergePages, timelineItems, timelineParts, type DayPart } from "./today-view";
import { dayHeading } from "../calendar/period-heading";
import { PeriodHeader } from "../calendar/period-header";
import { useCalendarGestures, ZoomSwitch, type Place } from "../calendar/calendar-zoom";
import { zoomTransition } from "../calendar/calendar-view";
import type { TodaySearch } from "../../routes/search-params";

// Today (`/`, ADR 037): one day from `episodes.day`, refreshed every 4 s (15 s
// for other days), with the previous and next days. One thread, without
// cards (Téo, 2026-11-19): the conversations by part of the day, each read by
// its journal line (ADR 028) when it has one, with the media and dictations
// the filter menu shows on one line each. Each hour's moments are one row
// that loads its moments when opened, keyed on the day's revision so they
// reload only when the day changes; traces are counted on one line. Beside
// it, in a wide window: a month to go to any day, the commitments, and whom
// the user spoke with; in a narrow one, the commitments above the thread.
// What is being said now is in the sidebar (sidebar-now.tsx); a dot on the
// filter says a video or music is being recorded now, since that leaves
// media out. The filter's choice is kept by core, one for Today and the
// calendar's day (Téo, 2026-11-20): media on and dictations by the first
// run's goal until the user picks; a `media` or `dictations` in the link
// shows that link's choice until the menu changes it. The header keeps one
// shape from day to day (period-header.tsx). The « ⋯ » takes the day's
// transcripts out (day-menu.tsx).
// The same day is the calendar's day zoom (DayView): a two-finger swipe goes
// to the day before or after, a pinch out or ⌘− to its week.

const JOURNAL_REFRESH_MS = 15_000;

const route = getRouteApi("/shell/");

const REFRESH_MS = 15_000;
/** Today: a conversation that starts shows within seconds, before its text. */
const TODAY_REFRESH_MS = 4_000;

export function TodayScreen() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  return (
    <DayView
      place="today"
      search={search}
      update={(patch) => void navigate({ search: (previous) => ({ ...previous, ...patch }) })}
    />
  );
}

/**
 * One day: Today's own screen, and the calendar's day (`place`), where
 * zooming and swiping keep the user in the calendar (Téo, 2026-11-19).
 */
export function DayView({
  place,
  search,
  update,
}: {
  place: Place;
  search: TodaySearch;
  update: (patch: Partial<TodaySearch>) => void;
}) {
  const queryClient = useQueryClient();
  const day = useQuery(
    orpc.episodes.day.queryOptions({
      input: search.day === undefined ? {} : { day: search.day },
      refetchInterval: search.day === undefined ? TODAY_REFRESH_MS : REFRESH_MS,
      // The day before stays on screen while the next one loads, so nothing jumps.
      placeholderData: keepPreviousData,
    }),
  );
  const status = useQuery(orpc.status.watch.experimental_liveOptions({ retry: true }));
  const running = status.data?.analysis.running ?? null;

  // A job started or finished: analysis states changed, maybe without a new revision.
  const jobId = running?.jobId ?? null;
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: orpc.episodes.key() });
  }, [jobId, queryClient]);

  const today = dayOf(Date.now());
  const shown = search.day ?? today;
  const display = useDisplaySettings();
  // Dictations follow the first run's goal (ADR 037) until the user picks; media show.
  const goal = useQuery(orpc.onboarding.get.queryOptions()).data?.goal ?? null;
  const showMedia = search.media ?? display.settings?.media ?? true;
  const showDictations =
    search.dictations ?? display.settings?.dictations ?? (goal === "day" || goal === "everything");
  const pick = (patch: { media: boolean } | { dictations: boolean }) => {
    display.update(patch);
    // The link's own choice for that kind gives way to the one just made.
    update("media" in patch ? { media: undefined } : { dictations: undefined });
  };
  const journal = useQuery(
    orpc.journal.day.queryOptions({
      input: { day: shown },
      refetchInterval: JOURNAL_REFRESH_MS,
    }),
  );
  // What the journal says of each conversation: its lines, in one sentence.
  const summaries = useMemo(
    () =>
      new Map(
        (journal.data?.state.enabled === true ? journal.data.conversations : []).map(
          (conversation) => [
            conversation.episodeId,
            conversation.lines.map((line) => journalReading(line.text, line.voices)).join(" · "),
          ],
        ),
      ),
    [journal.data],
  );
  // While the next day loads, the day before keeps the layout (no jump) but
  // none of its rows or counts show under the new date.
  const current = day.isPlaceholderData ? undefined : day.data;
  const mediaOngoing = current?.media.episodes.some((episode) => episode.state === "open") === true;
  const goTo = (next: string) => update({ day: next === today ? undefined : next });
  // ⌘− or a pinch out shows the day's week; a swipe goes to the day before or after.
  const navigate = useNavigate();
  const swipe = useCalendarGestures({
    hasNext: shown < today,
    onZoom: (direction) => {
      if (direction === "out")
        void navigate({
          to: "/calendar",
          search: { zoom: "week", day: shown },
          viewTransition: zoomTransition("day", "week"),
        });
    },
    onSwipe: (direction) => {
      const next = addDays(shown, direction === "next" ? 1 : -1);
      if (next <= today) goTo(next);
    },
  });

  return (
    <div ref={swipe.contentRef} className="mx-auto flex w-full max-w-[76rem] flex-col gap-l">
      {swipe.hint}
      <PeriodHeader
        heading={dayHeading(shown, today)}
        filter={
          <Menu>
            <MenuTrigger variant="ghost">
              {[
                ...(showMedia ? [m.today_media()] : []),
                ...(showDictations ? [m.today_dictations()] : []),
              ].join(", ") || m.today_filter_conversations()}
              {mediaOngoing ? (
                <>
                  <span aria-hidden className="size-xs shrink-0 corner-full bg-warning" />
                  <span className="sr-only">{m.today_media_ongoing()}</span>
                </>
              ) : null}
              <ChevronDownIcon />
            </MenuTrigger>
            <MenuPopup align="start">
              <MenuCheckboxItem
                checked={showMedia}
                onCheckedChange={(checked) => pick({ media: checked })}
                detail={current?.media.total}
              >
                {m.today_media()}
              </MenuCheckboxItem>
              <MenuCheckboxItem
                checked={showDictations}
                onCheckedChange={(checked) => pick({ dictations: checked })}
                detail={current?.dictations.total}
              >
                {m.today_dictations()}
              </MenuCheckboxItem>
            </MenuPopup>
          </Menu>
        }
        zoom={<ZoomSwitch zoom="day" day={search.day} place={place} />}
        atToday={shown === today}
        onToday={() => goTo(today)}
        previous={{ label: m.today_previous_day(), onClick: () => goTo(addDays(shown, -1)) }}
        next={{
          label: m.today_next_day(),
          onClick: () => goTo(addDays(shown, 1)),
          disabled: shown >= today,
        }}
        menu={<DayMenu day={shown} />}
      />
      {day.data === undefined || !display.settled ? (
        <p
          className={day.isError ? "text-error" : "text-cte-text-muted"}
          role={day.isError ? "alert" : undefined}
        >
          {day.isError ? errorMessage(day.error) : m.loading()}
        </p>
      ) : (
        <div
          className={
            "grid grid-cols-1 items-start gap-xl min-[68rem]:grid-cols-[minmax(0,1fr)_17rem]"
          }
        >
          {/* First in a narrow window, so the commitments come before the thread. */}
          <section
            data-slot="day-beside"
            aria-label={m.today_beside()}
            className={
              "flex flex-col gap-l min-[68rem]:sticky min-[68rem]:top-zero min-[68rem]:col-start-2 min-[68rem]:row-start-1"
            }
          >
            <DayCalendar
              shown={shown}
              today={today}
              onPick={goTo}
              className="hidden min-[68rem]:flex"
            />
            <DayCommitments day={shown} today={today} />
            <DayPeople
              conversations={current?.conversations.episodes ?? []}
              className="hidden min-[68rem]:flex"
            />
          </section>
          {current === undefined ? (
            <p className="text-cte-text-muted">{m.loading()}</p>
          ) : (
            <Timeline
              day={current}
              isToday={shown === today}
              running={running}
              analysis={status.data?.analysis}
              summaries={summaries}
              shorts={[
                ...(showMedia ? current.media.episodes : []),
                ...(showDictations ? current.dictations.episodes : []),
              ]}
            />
          )}
        </div>
      )}
    </div>
  );
}

function Timeline({
  day,
  isToday,
  running,
  analysis,
  summaries,
  shorts,
}: {
  day: EpisodesDayOutput;
  isToday: boolean;
  running: { episodeId: number; progress: number | null } | null;
  analysis: AnalysisStatus | undefined;
  /** The journal's line for each conversation that has one. */
  summaries: ReadonlyMap<number, string>;
  /** The media and dictations shown in the thread. */
  shorts: readonly EpisodeSummary[];
}) {
  const nowMs = Date.now();
  const [moreAsked, setMoreAsked] = useState(false);
  const more = useEpisodePages(
    { day: day.day, lane: "conversations", after: day.conversations.nextCursor },
    day.revision,
    moreAsked && day.conversations.nextCursor !== null,
  );
  const extra = more.data?.pages.map((page) => page.episodes) ?? [];
  const conversations = mergePages([day.conversations.episodes, ...extra]);
  const complete =
    day.conversations.nextCursor === null || (more.data !== undefined && !more.hasNextPage);
  const items = timelineItems(conversations, day.momentHours, complete, shorts);

  if (items.length === 0 && day.traces === 0) {
    return <p className="text-cte-text-muted">{isToday ? m.today_empty() : m.today_empty_day()}</p>;
  }
  return (
    <section aria-label={m.today_timeline()} className="flex flex-col gap-m">
      {timelineParts(items).map(({ part, items: partItems }) => (
        <div key={part} className="flex flex-col gap-xxs">
          <h2 className="font-body font-medium text-body-s text-cte-text-muted">
            {partTitle(part, isToday)}
          </h2>
          {/* The rows' inset hangs outside, so their tiles line up with the text above. */}
          <ul className="-mx-s flex flex-col">
            {partItems.map((item) =>
              item.kind === "conversation" ? (
                <ConversationRow
                  key={`c${item.episode.id}`}
                  episode={item.episode}
                  summary={summaries.get(item.episode.id)}
                  progress={running?.episodeId === item.episode.id ? running.progress : undefined}
                  waitReason={
                    analysis === undefined ? null : waitReasonText(analysis, item.episode)
                  }
                  nowMs={nowMs}
                />
              ) : item.kind === "short" ? (
                <LaneRow key={`s${item.episode.id}`} episode={item.episode} nowMs={nowMs} />
              ) : (
                <MomentHourRow
                  key={`h${item.hour.hour}`}
                  day={day.day}
                  hour={item.hour}
                  revision={day.revision}
                  nowMs={nowMs}
                />
              ),
            )}
          </ul>
        </div>
      ))}
      {complete ? null : (
        <Button
          variant="ghost"
          className="self-start"
          isPending={more.isFetching}
          onClick={() => (moreAsked ? void more.fetchNextPage() : setMoreAsked(true))}
        >
          {m.today_more_conversations({ count: day.conversations.total - conversations.length })}
        </Button>
      )}
      {day.traces > 0 ? (
        <TracesLine day={day.day} count={day.traces} revision={day.revision} nowMs={nowMs} />
      ) : null}
    </section>
  );
}

function partTitle(part: DayPart, isToday: boolean): string {
  switch (part) {
    case "morning":
      return isToday ? m.today_part_morning_today() : m.today_part_morning();
    case "afternoon":
      return isToday ? m.today_part_afternoon_today() : m.today_part_afternoon();
    case "evening":
      return isToday ? m.today_part_evening_today() : m.today_part_evening();
  }
}
