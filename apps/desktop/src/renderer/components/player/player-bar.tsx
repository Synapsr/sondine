import { Button } from "@sondine/ui/components/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@sondine/ui/components/tooltip";
import { ToggleGroup, ToggleGroupItem } from "@sondine/ui/components/toggle-group";
import { PauseIcon, PlayIcon, XIcon } from "@sondine/ui/icon";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { useMemo } from "react";
import { orpc } from "../../core/orpc";
import { clock, contextLabel, rateLabel, voiceName } from "../../lib/labels";
import { formatOffset } from "../../lib/time";
import { voiceOfLabel, voicesByLabel } from "../../lib/voices";
import { m } from "../../paraglide/messages.js";
import { useShortcut } from "../../shortcuts/shortcuts-provider";
import { speechLanes, type Timeline } from "./player-time";
import { usePlayer, usePlayerState } from "./player-provider";
import {
  PLAYBACK_RATES,
  type PlaybackRate,
  type PlayerProblem,
  type PlayerSnapshot,
} from "./player-store";
import { SpeechScrubber } from "./speech-scrubber";
import { EpisodeAppIcon } from "../shell/app-icon";

// The player at the foot of the screen while an episode is loaded, below the
// screen's scroll so nothing passes under it (Téo, 2026-11-20): play or
// pause, the position over where each voice speaks, the length, the speed,
// and, away from the episode's own page, a link to it. Space plays or
// pauses and ←/→ move 5 s from anywhere but a text field.

const SEEK_STEP_SECONDS = 5;

const problemText: Record<PlayerProblem, () => string> = {
  nothing: () => m.player_nothing(),
  gone: () => m.error_not_found(),
  failed: () => m.player_failed(),
};

const whole = (snapshot: PlayerSnapshot) => snapshot;

export function PlayerBar() {
  const player = usePlayer();
  const snapshot = usePlayerState(whole);
  const active = snapshot.episodeId !== null && snapshot.status !== "error";
  useShortcut("player.toggle", () => player.toggle(), { enabled: active });
  useShortcut("player.back", () => player.seekBy(-SEEK_STEP_SECONDS), { enabled: active });
  useShortcut("player.forward", () => player.seekBy(SEEK_STEP_SECONDS), { enabled: active });
  if (snapshot.episodeId === null) return null;
  return (
    <div className="flex shrink-0 justify-center px-l pt-xs pb-m">
      <section
        data-slot="player"
        aria-label={m.player_label()}
        className="flex w-full max-w-[48rem] items-center gap-m corner-l bg-cte-surface px-m py-xs shadow-m ring-[1px] ring-neutral-4"
      >
        {snapshot.status === "error" ? (
          <p role="alert" className="flex-1 text-error">
            {problemText[snapshot.problem ?? "failed"]()}
          </p>
        ) : (
          <LoadedEpisode episodeId={snapshot.episodeId} snapshot={snapshot} />
        )}
        <Button
          variant="ghost"
          size="icon"
          aria-label={m.player_close()}
          onClick={() => player.stop()}
        >
          <XIcon />
        </Button>
      </section>
    </div>
  );
}

function LoadedEpisode({ episodeId, snapshot }: { episodeId: number; snapshot: PlayerSnapshot }) {
  const player = usePlayer();
  const params = useParams({ strict: false });
  const search = useSearch({ strict: false });
  const onEpisodePage = params.id === String(episodeId);
  // The transcript the episode page shows, with its search when it has one.
  const q = onEpisodePage && typeof search.q === "string" ? search.q : undefined;
  const detail = useQuery(
    orpc.episodes.get.queryOptions({ input: { episodeId, ...(q === undefined ? {} : { q }) } }),
  );
  const timeline = snapshot.timeline;
  const episode = detail.data?.episode;
  // Times read from the episode's start, like the transcript's.
  const originMs = episode?.startedAtMs ?? timeline?.startedAtMs ?? 0;
  const atMs = (seconds: number) => (timeline?.startedAtMs ?? originMs) + seconds * 1000 - originMs;

  const lanes = useMemo(() => {
    if (detail.data === undefined || timeline === null) return [];
    // Before a transcript, where someone speaks and on which side.
    if (detail.data.segments.length === 0) {
      return speechLanes(
        timeline.speech.map((span) => ({
          startMs: span.startMs,
          endMs: span.endMs,
          voice: { kind: "track", track: span.track } as const,
        })),
        timeline,
      );
    }
    const voices = voicesByLabel(detail.data.speakers);
    return speechLanes(
      detail.data.segments.map((segment) => ({
        startMs: segment.startMs,
        endMs: segment.endMs,
        voice: voiceOfLabel(voices, segment.speakerLabel),
      })),
      timeline,
    );
  }, [detail.data, timeline]);
  const marks = useMemo(
    () => matchMarks(detail.data?.segments ?? [], timeline),
    [detail.data, timeline],
  );

  const playing = snapshot.status === "playing" || snapshot.status === "loading";
  const durationSeconds = (timeline?.durationMs ?? 0) / 1000;
  const endText = formatOffset(atMs(durationSeconds));
  return (
    <>
      {/* The keys work everywhere outside a text field; this is where they are told. */}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon"
              className="corner-full"
              aria-label={playing ? m.player_pause() : m.player_play()}
              isPending={snapshot.status === "loading" && timeline === null}
              onClick={() => player.toggle()}
            />
          }
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </TooltipTrigger>
        <TooltipPopup>{m.player_keys_hint()}</TooltipPopup>
      </Tooltip>
      {onEpisodePage || episode === undefined ? null : (
        <Link
          to="/episode/$id"
          params={{ id: String(episodeId) }}
          className="flex max-w-[12rem] shrink-0 items-center gap-xxs corner-xs font-body font-medium text-body-s focus-ring"
        >
          <EpisodeAppIcon episode={episode} />
          <span className="truncate">
            {[clock(episode.startedAtMs), contextLabel(episode)].filter(Boolean).join(" · ")}
          </span>
        </Link>
      )}
      <span className="shrink-0 font-data text-body-s tabular-nums">
        {formatOffset(atMs(snapshot.seconds))}
      </span>
      {lanes.length > 0 && lanes.every((lane) => lane.others !== true) ? (
        <span aria-hidden className="flex shrink-0 flex-col text-body-xxs text-cte-text-muted">
          {lanes.map((lane, index) => (
            <span key={index}>{voiceName(lane.voice)}</span>
          ))}
        </span>
      ) : null}
      <SpeechScrubber
        seconds={snapshot.seconds}
        durationSeconds={durationSeconds}
        lanes={lanes}
        marks={marks}
        onSeek={(seconds) => player.seek(seconds)}
        label={m.player_position()}
        valueText={(seconds) =>
          m.player_position_value({ position: formatOffset(atMs(seconds)), length: endText })
        }
      />
      <span className="shrink-0 font-data text-body-s tabular-nums text-cte-text-muted">
        {endText}
      </span>
      {/* A narrow window keeps the timeline: one button cycles the speeds. */}
      <Button
        variant="ghost"
        className="shrink-0 tabular-nums min-[72rem]:hidden"
        aria-label={m.player_speed_value({ speed: rateLabel(snapshot.rate) })}
        onClick={() => {
          const next =
            PLAYBACK_RATES[(PLAYBACK_RATES.indexOf(snapshot.rate) + 1) % PLAYBACK_RATES.length];
          if (next !== undefined) player.setRate(next);
        }}
      >
        {rateLabel(snapshot.rate)}
      </Button>
      <ToggleGroup<string>
        className="hidden min-[72rem]:flex"
        aria-label={m.player_speed()}
        value={[String(snapshot.rate)]}
        onValueChange={(values) => {
          const rate = PLAYBACK_RATES.find((candidate) => String(candidate) === values[0]);
          if (rate !== undefined) player.setRate(rate satisfies PlaybackRate);
        }}
      >
        {PLAYBACK_RATES.map((rate) => (
          <ToggleGroupItem<string> key={rate} value={String(rate)}>
            {rateLabel(rate)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </>
  );
}

/** Where the search matches sit on the timeline, as fractions. */
function matchMarks(
  segments: readonly { startMs: number; highlights: readonly unknown[] }[],
  timeline: Timeline | null,
): number[] {
  if (timeline === null || timeline.durationMs <= 0) return [];
  return segments
    .filter((segment) => segment.highlights.length > 0)
    .map((segment) =>
      Math.min(Math.max((segment.startMs - timeline.startedAtMs) / timeline.durationMs, 0), 1),
    );
}
