import type { EpisodeSummary, MomentHour, TimelineLane } from "@sondine/api";
import { Badge } from "@sondine/ui/components/badge";
import { Button } from "@sondine/ui/components/button";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@sondine/ui/components/collapsible";
import { Progress } from "@sondine/ui/components/progress";
import {
  FolderIcon,
  KeyboardIcon,
  PhoneIcon,
  UsersIcon,
  VideoIcon,
  WaveformIcon,
} from "@sondine/ui/icon";
import { cn } from "@sondine/ui";
import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { errorMessage } from "../../core/orpc";
import {
  analysisBadge,
  clock,
  contextLabel,
  keptLabel,
  episodeLength,
  formatDuration,
  pageLabel,
  peopleThere,
  voicesLabel,
} from "../../lib/labels";
import { m } from "../../paraglide/messages.js";
import { getLocale } from "../../paraglide/runtime.js";
import { TranscribeButton } from "../episode/transcribe-button";
import { PlayButton } from "../player/play-button";
import { useEpisodePages } from "./episode-pages";
import { hourSummary } from "./today-view";
import { AppIcon, AppIcons } from "../shell/app-icon";

// The rows of Today: a conversation, a media episode or a dictation on one
// line, an hour of moments (collapsed, its moments loaded when opened), the
// line counting traces, and the short rows that list moments and traces.

export const rowDivider = "inset-shadow-[0_-1px_0_0_var(--neutral-4)] last:inset-shadow-none";
const linkClassName = "corner-s focus-ring";

/** What a row says when it has no words to show; `waitReason` says why the queue waits. */
function noText(episode: EpisodeSummary, waitReason: string | null): string {
  if (episode.state === "open") return m.today_open_text();
  if (episode.analysisState === "failed") return m.episode_analysis_failed();
  if (episode.analysisState === "complete") return m.episode_no_speech();
  return waitReason === null
    ? m.episode_no_text()
    : m.today_untranscribed_because({ reason: waitReason });
}

const tileIcon: Record<NonNullable<EpisodeSummary["context"]> | "none", ReactNode> = {
  call: <PhoneIcon />,
  in_person: <UsersIcon />,
  media: <VideoIcon />,
  mixed: <UsersIcon />,
  dictation: <KeyboardIcon />,
  imported: <FolderIcon />,
  none: <WaveformIcon />,
};

const tileSize = {
  m: "size-[2.25rem] corner-m",
  s: "size-[1.75rem] corner-s",
  xs: "size-[1rem] corner-xs [&_svg]:size-[0.75rem]",
} as const;

/**
 * An episode at a glance: the icon of its app (Discord, Meet, YouTube, the
 * dictation app) when one was heard, else its kind (call, in person…), with a
 * dot while it goes on. `s` for the one-line rows, `xs` in the calendar.
 */
export function KindTile({
  episode,
  size = "m",
}: {
  episode: EpisodeSummary;
  size?: keyof typeof tileSize;
}) {
  const [app] = episode.apps;
  return (
    <span
      aria-hidden
      className={cn(
        "relative flex shrink-0 items-center justify-center text-cte-text-muted",
        tileSize[size],
        app === undefined && "bg-neutral-3",
      )}
    >
      {app === undefined ? (
        tileIcon[episode.context ?? "none"]
      ) : (
        <AppIcon app={{ bundleId: app.bundleId }} name={app.name} className="size-full" />
      )}
      {episode.state === "open" ? (
        <span className="absolute -top-[2px] -right-[2px] size-xs corner-full bg-success ring-[2px] ring-cte-canvas" />
      ) : null}
    </span>
  );
}

export function ConversationRow({
  episode,
  summary,
  progress,
  waitReason,
  nowMs,
}: {
  episode: EpisodeSummary;
  /** What the journal says of it (ADR 028), in place of its first words. */
  summary?: string | undefined;
  /** 0 to 1 while it is the episode being transcribed; null before the first update. */
  progress: number | null | undefined;
  /** Why the transcription queue waits, in words; null when it runs. */
  waitReason: string | null;
  nowMs: number;
}) {
  const time = clock(episode.startedAtMs);
  const context = contextLabel(episode);
  const voices = voicesLabel(episode);
  const kept = keptLabel(episode);
  // The people are the title; the kind is the tile, and named in words when nobody is.
  const title = voices ?? context ?? m.episode_size_conversation();
  const detail = [
    ...(voices === null ? [] : context === null ? [] : [context]),
    ...(kept === null ? [] : [kept]),
  ].join(" · ");
  // Waiting is the normal state: only what differs gets a badge.
  const badge =
    episode.state === "open"
      ? { variant: "warning" as const, label: m.episode_state_open() }
      : episode.live && episode.analysisState !== "running"
        ? { variant: "neutral" as const, label: m.today_live_text() }
        : // A failure says what it was beside « Transcrire » (RequestState).
          episode.analysisState === "running" || episode.analysisState === "stale"
          ? {
              variant: analysisBadge[episode.analysisState].variant,
              label: analysisBadge[episode.analysisState].label(),
            }
          : null;
  return (
    <li className={`flex items-center gap-s p-s ${rowDivider}`}>
      <Link
        to="/episode/$id"
        params={{ id: String(episode.id) }}
        aria-label={`${time} · ${title}`}
        className={`flex min-w-0 flex-1 items-center gap-s ${linkClassName}`}
      >
        <KindTile episode={episode} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-xs">
            <span className="truncate font-medium">{title}</span>
            {/* The tile shows the first app; the others follow the title. */}
            <AppIcons apps={episode.apps.slice(1)} />
            {detail === "" ? null : (
              <span className="truncate text-body-xs text-cte-text-muted">{detail}</span>
            )}
          </span>
          {progress === undefined ? (
            <span className="truncate text-cte-text-muted">
              {summary ?? episode.firstWords ?? noText(episode, waitReason)}
            </span>
          ) : (
            <span className="flex items-center gap-s pt-xs">
              <Progress
                aria-label={m.analysis_running()}
                value={progress === null ? null : Math.round(progress * 100)}
                className="max-w-[16rem]"
              />
              {progress === null ? null : (
                <span className="shrink-0 text-body-xs tabular-nums text-cte-text-muted">
                  {percent(progress)}
                </span>
              )}
            </span>
          )}
        </span>
        <span className="flex shrink-0 flex-col items-end text-body-xs tabular-nums text-cte-text-muted">
          <span className="font-data text-body-s text-cte-text">{time}</span>
          <span>{formatDuration(episodeLength(episode, nowMs))}</span>
        </span>
      </Link>
      <span className="flex shrink-0 items-center gap-xs">
        {badge === null ? null : <Badge variant={badge.variant}>{badge.label}</Badge>}
        <TranscribeButton episode={episode} compact />
        <PlayButton episodeId={episode.id} label={time} variant="ghost" />
      </span>
    </li>
  );
}

function percent(share: number): string {
  return new Intl.NumberFormat(getLocale(), { style: "percent" }).format(share);
}

function hourLabel(startMs: number): string {
  return new Intl.DateTimeFormat(getLocale(), { hour: "numeric" }).format(startMs);
}

export function MomentHourRow({
  day,
  hour,
  revision,
  nowMs,
}: {
  day: string;
  hour: MomentHour;
  revision: string;
  nowMs: number;
}) {
  const [open, setOpen] = useState(false);
  const summary = hourSummary(hour);
  return (
    <li className={`px-s ${rowDivider}`}>
      <Collapsible open={open} onOpenChange={setOpen} className="pb-s data-closed:pb-zero">
        <CollapsibleTrigger className="py-s">
          <span className="flex min-w-0 flex-1 items-center gap-s">
            <span
              aria-hidden
              className="flex size-[2.25rem] shrink-0 items-center justify-center corner-m bg-neutral-2 text-cte-text-muted"
            >
              <WaveformIcon />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex min-w-0 items-center gap-xs">
                {m.today_moments({ count: hour.moments })}
                <AppIcons apps={hour.apps} />
              </span>
              <span className="truncate font-regular text-cte-text-muted">
                {summary.kind === "untranscribed"
                  ? m.today_moments_untranscribed()
                  : summary.texts.join(" · ")}
              </span>
            </span>
            <span className="shrink-0 font-data text-body-s font-regular whitespace-nowrap tabular-nums">
              {hourLabel(hour.startMs)}
            </span>
          </span>
        </CollapsibleTrigger>
        <CollapsiblePanel className="ms-[calc(2.25rem+var(--space-s))]">
          <EpisodeList
            day={day}
            lane="moments"
            hour={hour.hour}
            revision={revision}
            nowMs={nowMs}
          />
        </CollapsiblePanel>
      </Collapsible>
    </li>
  );
}

export function TracesLine({
  day,
  count,
  revision,
  nowMs,
}: {
  day: string;
  count: number;
  revision: string;
  nowMs: number;
}) {
  const [shown, setShown] = useState(false);
  return (
    <section aria-label={m.episode_size_trace()} className="flex flex-col gap-xs pt-s">
      <div className="flex items-center gap-s">
        <p className="text-cte-text-muted">{m.episodes_traces({ count: String(count) })}</p>
        <Button variant="ghost" aria-expanded={shown} onClick={() => setShown((value) => !value)}>
          {shown ? m.episodes_traces_hide() : m.episodes_traces_show()}
        </Button>
      </div>
      {shown ? <EpisodeList day={day} lane="traces" revision={revision} nowMs={nowMs} /> : null}
    </section>
  );
}

/** Short rows for one lane (and hour) of the day, loaded when shown. */
export function EpisodeList({
  day,
  lane,
  hour,
  revision,
  nowMs,
}: {
  day: string;
  lane: TimelineLane;
  hour?: number;
  revision: string;
  nowMs: number;
}) {
  const pages = useEpisodePages(
    { day, lane, ...(hour === undefined ? {} : { hour }) },
    revision,
    true,
  );
  if (pages.data === undefined) {
    return (
      <p className={pages.isError ? "text-error" : "text-cte-text-muted"}>
        {pages.isError ? errorMessage(pages.error) : m.loading()}
      </p>
    );
  }
  const episodes = pages.data.pages.flatMap((page) => page.episodes);
  return (
    <div className="flex flex-col gap-xs">
      <ul className="flex flex-col">
        {episodes.map((episode) => (
          <ShortRow key={episode.id} episode={episode} nowMs={nowMs} />
        ))}
      </ul>
      {pages.hasNextPage ? (
        <Button
          variant="ghost"
          className="self-start"
          isPending={pages.isFetchingNextPage}
          onClick={() => void pages.fetchNextPage()}
        >
          {m.show_more()}
        </Button>
      ) : null}
    </div>
  );
}

/** A moment or a trace: its time, its words, its length, play. */
export function ShortRow({ episode, nowMs }: { episode: EpisodeSummary; nowMs: number }) {
  const time = clock(episode.startedAtMs);
  const kept = keptLabel(episode);
  return (
    <li className={`flex items-center gap-s py-xxs ${rowDivider}`}>
      <Link
        to="/episode/$id"
        params={{ id: String(episode.id) }}
        className={`flex min-w-0 flex-1 items-center gap-s py-xxs ${linkClassName}`}
      >
        <span className="flex w-[4.5rem] shrink-0 flex-col gap-xxs">
          <span className="font-data text-body-xs whitespace-nowrap tabular-nums text-cte-text-muted">
            {time}
          </span>
          <AppIcons apps={episode.apps} />
        </span>
        <span
          className={
            episode.firstWords === null
              ? "min-w-0 flex-1 truncate text-cte-text-muted"
              : "min-w-0 flex-1 truncate text-cte-text"
          }
        >
          {episode.firstWords ?? noText(episode, null)}
        </span>
        <span className="shrink-0 text-body-xs tabular-nums text-cte-text-muted">
          {[
            ...(peopleThere(episode).length === 0 ? [] : [voicesLabel(episode)]),
            ...(kept === null ? [] : [kept]),
            formatDuration(episodeLength(episode, nowMs)),
          ].join(" · ")}
        </span>
      </Link>
      <PlayButton episodeId={episode.id} label={time} variant="ghost" />
    </li>
  );
}

/**
 * A media episode or a dictation in the day's thread, on one line: its app,
 * what played it or where it was said, its first words; its time and length
 * where a conversation has them.
 */
export function LaneRow({ episode, nowMs }: { episode: EpisodeSummary; nowMs: number }) {
  const time = clock(episode.startedAtMs);
  const [app] = episode.apps;
  // The page a browser played names it better than the browser does.
  const source =
    episode.page === null
      ? (app?.name ?? contextLabel(episode) ?? m.episode_size_moment())
      : pageLabel(episode.page);
  return (
    <li className={`flex items-center gap-s px-s py-xs ${rowDivider}`}>
      <Link
        to="/episode/$id"
        params={{ id: String(episode.id) }}
        aria-label={`${time} · ${source}`}
        className={`flex min-w-0 flex-1 items-center gap-s ${linkClassName}`}
      >
        {/* The small tile centred in the large one's column, so the titles line up. */}
        <span className="flex w-[2.25rem] shrink-0 justify-center">
          <KindTile episode={episode} size="s" />
        </span>
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">{source}</span>{" "}
          <span className="text-cte-text-muted">{episode.firstWords ?? noText(episode, null)}</span>
        </span>
        <span className="flex shrink-0 items-baseline gap-xs text-body-xs tabular-nums text-cte-text-muted">
          <span>{formatDuration(episodeLength(episode, nowMs))}</span>
          <span className="font-data text-body-s text-cte-text">{time}</span>
        </span>
      </Link>
      <PlayButton episodeId={episode.id} label={time} variant="ghost" />
    </li>
  );
}
