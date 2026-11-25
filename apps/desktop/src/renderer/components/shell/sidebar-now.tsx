import type { EpisodeSummary, LiveStatus } from "@sondine/api";
import { cn } from "@sondine/ui";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@sondine/ui/components/tooltip";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { orpc } from "../../core/orpc";
import { clock, contextLabel, episodeLength, formatDuration } from "../../lib/labels";
import { m } from "../../paraglide/messages.js";
import { EndButton } from "../episode/end-episode";
import { EpisodeAppIcon } from "./app-icon";

// What is being said now, in the sidebar on every screen (Téo, 2026-11-19):
// each open conversation outside media as soon as speech starts, with how
// long it has lasted and its last words while near-live text runs. A click
// opens it, its stop ends it (ADR 044). In a narrow window, a red dot whose tooltip says the same.

/** Today: a conversation that starts shows within seconds, before its text. */
const REFRESH_MS = 4_000;
/** How often the sentence being said is asked for (core redoes it at each commit). */
const PARTIAL_MS = 1_000;
/** A sentence being said older than this is stale: three commits went by without it. */
const FRESH_MS = 6_000;

/** The sentence an open episode is hearing now, while near-live text runs; "" when none. */
export function useSaying(episodeId: number, open: boolean, live: LiveStatus | undefined): string {
  const following = open && live?.enabled === true && live.state === "ready";
  // Transcribed again by core at each 2 s of audio.
  const partial = useQuery(
    orpc.live.partial.queryOptions({
      input: { episodeId },
      enabled: following,
      refetchInterval: PARTIAL_MS,
    }),
  );
  const data = partial.data ?? null;
  // A line from before a pause in following, or older than a few commits, is not shown.
  return following && data !== null && Date.now() - data.atMs < FRESH_MS ? data.text : "";
}

export function SidebarNow({ compact }: { compact: boolean }) {
  const day = useQuery(orpc.episodes.day.queryOptions({ input: {}, refetchInterval: REFRESH_MS }));
  const status = useQuery(orpc.status.watch.experimental_liveOptions({ retry: true }));
  const ongoing = day.data?.ongoing ?? [];
  if (ongoing.length === 0) return null;
  return (
    <section aria-label={m.ongoing_title()} className="flex flex-col gap-xxs pt-s">
      {ongoing.map((episode) =>
        compact ? (
          <NowDot key={episode.id} episode={episode} />
        ) : (
          <NowCard key={episode.id} episode={episode} live={status.data?.live} />
        ),
      )}
    </section>
  );
}

function since(episode: EpisodeSummary): string {
  return m.ongoing_since({
    time: clock(episode.startedAtMs),
    duration: formatDuration(episodeLength(episode, Date.now())),
  });
}

function LiveDot() {
  return (
    <span aria-hidden className="relative flex size-xs shrink-0">
      <span className="absolute inline-flex size-full corner-full bg-error opacity-40 motion-safe:animate-ping" />
      <span className="relative inline-flex size-xs corner-full bg-error opacity-70" />
    </span>
  );
}

const cardClassName = cn(
  "flex flex-col gap-xxs corner-s bg-cte-canvas px-s py-xs ring-[1px] ring-neutral-4",
  "transition-[background-color] duration-motion ease-motion motion-reduce:transition-none",
  "control-hover:bg-neutral-1 focus-ring",
);

function NowCard({ episode, live }: { episode: EpisodeSummary; live: LiveStatus | undefined }) {
  const detail = useQuery(orpc.episodes.get.queryOptions({ input: { episodeId: episode.id } }));
  const saying = useSaying(episode.id, true, live);
  const last = saying === "" ? (detail.data?.segments.at(-1)?.text ?? "") : saying;
  return (
    <div className="relative">
      <Link to="/episode/$id" params={{ id: String(episode.id) }} className={cardClassName}>
        <span className="flex min-w-0 items-center gap-xs pe-l font-body font-medium text-body-s">
          <LiveDot />
          <EpisodeAppIcon episode={episode} />
          <span className="truncate">{contextLabel(episode) ?? m.ongoing_title()}</span>
        </span>
        <span className="text-body-xs tabular-nums text-cte-text-muted">{since(episode)}</span>
        {/* The last words, announced as they come. */}
        <span aria-live="polite" className="line-clamp-2 text-body-xs text-cte-text-muted">
          {last === ""
            ? m.ongoing_listening_short()
            : saying === ""
              ? last
              : m.ongoing_saying({ text: last })}
        </span>
      </Link>
      <EndButton episode={episode} compact className="absolute end-xs top-xs text-cte-text-muted" />
    </div>
  );
}

function NowDot({ episode }: { episode: EpisodeSummary }) {
  const label = `${contextLabel(episode) ?? m.ongoing_title()} · ${since(episode)}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            to="/episode/$id"
            params={{ id: String(episode.id) }}
            aria-label={label}
            className="flex size-[2.25rem] items-center justify-center corner-s control-hover:bg-neutral-3 focus-ring"
          />
        }
      >
        <LiveDot />
      </TooltipTrigger>
      <TooltipPopup side="right">{label}</TooltipPopup>
    </Tooltip>
  );
}
