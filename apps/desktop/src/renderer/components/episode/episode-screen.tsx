import { cn } from "@sondine/ui";
import { ORPCError } from "@orpc/client";
import type { EpisodeDetail, EpisodeWebPage, LiveStatus, Status } from "@sondine/api";
import { Badge } from "@sondine/ui/components/badge";
import { Button } from "@sondine/ui/components/button";
import { Progress } from "@sondine/ui/components/progress";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@sondine/ui/components/tooltip";
import { ChevronLeftIcon, ExternalLinkIcon, PaperclipIcon } from "@sondine/ui/icon";
import { useMutation, useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { errorMessage, orpc } from "../../core/orpc";
import { dayOf, relativeDay } from "../../lib/day";
import {
  analysisBadge,
  contextLabel,
  keptLabel,
  dayTitle,
  episodeLength,
  formatDuration,
  longDate,
  pageLabel,
  timeRange,
  peopleThere,
} from "../../lib/labels";
import { formatOffset } from "../../lib/time";
import { filtersOf, type EpisodeSearch } from "../../routes/search-params";
import { behindRunning, waitingForOf, waitReasonText } from "../../../shared/queue-line";
import { requestView } from "../../lib/request-view";
import { failureText, waitingText } from "./request-state";
import { m } from "../../paraglide/messages.js";
import { PlayButton } from "../player/play-button";
import { useEpisodePlayState, usePlayer, usePlayerState } from "../player/player-provider";
import type { PlayerSnapshot } from "../player/player-store";
import { heardMs } from "../player/player-time";
import { useSaying } from "../shell/sidebar-now";
import {
  carriesContext,
  ContextAddPopover,
  ContextStrip,
  useContextAdd,
  useContextPaste,
} from "./context-strip";
import { EndButton } from "./end-episode";
import { EpisodeMenu } from "./episode-menu";
import { EpisodeTagChips, TagPopover } from "./episode-tags";
import { PrivacyLine } from "./privacy-line";
import { SameMomentLines } from "./same-moment-line";
import { VoiceBadges } from "./voice-badge";
import { Transcript } from "./transcript";
import { TranscribeButton } from "./transcribe-button";
import { EpisodeAppIcon, PageMark } from "../shell/app-icon";
import { siteMark } from "../../lib/site-mark";
import { cardClassName, ConversationLines, headingClassName } from "../journal/journal-block";
import { backLinkClassName, titleClassName } from "../shell/screen";

// The Conversation view (`/episode/$id`): when and how long, the context and
// apps, the voices with their speaking time, the transcription state and the
// engine (provisional until the engines are compared), then the transcript.
// `t` starts playing at that wall-clock time (a search hit); `q` highlights
// that search with previous and next. On arrival the episode is cued in the
// player bar, paused, unless something else is loaded.

const route = getRouteApi("/shell/episode/$id");

/** Below this share of its audio, a transcript says some was missing. */
const FULL_COVERAGE = 0.995;
const REFRESH_MS = 15_000;

export function EpisodeScreen() {
  const { id } = route.useParams();
  const episodeId = Number(id);
  if (!Number.isSafeInteger(episodeId) || episodeId <= 0) {
    return (
      <p role="alert" className="text-error">
        {m.error_not_found()}
      </p>
    );
  }
  return <EpisodeView key={episodeId} episodeId={episodeId} />;
}

function EpisodeView({ episodeId }: { episodeId: number }) {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const player = usePlayer();
  const detail = useQuery(
    orpc.episodes.get.queryOptions({
      input: { episodeId, ...(search.q === undefined ? {} : { q: search.q }) },
      // An ongoing episode, or one waiting for its transcript, still changes.
      refetchInterval: (query) => {
        const episode = query.state.data?.episode;
        return episode === undefined ||
          episode.state === "open" ||
          episode.analysisState !== "complete"
          ? REFRESH_MS
          : false;
      },
      retry: (count, error) =>
        !(error instanceof ORPCError && error.code === "NOT_FOUND") && count < 2,
    }),
  );
  const status = useQuery(orpc.status.watch.experimental_liveOptions({ retry: true }));
  // ⌘V and drops add to the conversation (ADR 024).
  const adding = useContextAdd(episodeId);
  useContextPaste(adding, episodeId);
  const [dragging, setDragging] = useState(false);

  // From a search hit: play from its time once, then drop `t` so a reload does not replay.
  const startAt = useRef(search.t);
  const started = useRef(false);
  useEffect(() => {
    const at = startAt.current;
    if (at !== undefined && !started.current) {
      started.current = true;
      void player.play(episodeId, at);
      void navigate({ search: (previous) => ({ ...previous, t: undefined }), replace: true });
    } else void player.cue(episodeId);
    return () => player.releaseCue(episodeId);
  }, [episodeId, navigate, player]);

  // Coming back to something that was said, once a visit; never which (ADR 042).
  const state = detail.data?.episode.state;
  const finished = state !== undefined && state !== "open";
  useEffect(() => {
    if (finished) orpc.usage.conversationOpened.call({}).catch(() => undefined);
  }, [finished]);

  if (detail.data === undefined) {
    if (!detail.isError) return <p className="text-cte-text-muted">{m.loading()}</p>;
    const gone = detail.error instanceof ORPCError && detail.error.code === "NOT_FOUND";
    return (
      <div className="mx-auto flex w-full max-w-[56rem] flex-col items-start gap-m">
        <BackLink episodeDay={dayOf(Date.now())} search={{}} />
        <p className="text-error" role="alert">
          {gone ? m.error_not_found() : errorMessage(detail.error)}
        </p>
        {gone ? null : (
          <Button variant="secondary" onClick={() => void detail.refetch()}>
            {m.retry()}
          </Button>
        )}
      </div>
    );
  }
  return (
    <div
      className={`mx-auto flex w-full max-w-[56rem] flex-col gap-l corner-m ${dragging ? "outline-2 outline-dashed outline-color-1 outline-offset-8" : ""}`}
      onDragOver={(event) => {
        if (!carriesContext(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        adding.drop(event);
      }}
    >
      <Header
        detail={detail.data}
        search={search}
        status={status.data}
        addContext={
          <ContextAddPopover episodeId={episodeId} adding={adding} trigger={<PaperclipIcon />} />
        }
      />
      <EpisodeJournal episodeId={episodeId} day={dayOf(detail.data.episode.startedAtMs)} />
      <ContextStrip
        items={detail.data.context}
        pinnedAt={(item) => {
          const sentence = detail.data.segments.find((segment) => segment.id === item.segmentId);
          return formatOffset((sentence?.startMs ?? item.atMs) - detail.data.episode.startedAtMs);
        }}
        onShowSentence={showSentence}
      />
      <Transcript
        detail={detail.data}
        adding={adding}
        onDropped={() => setDragging(false)}
        q={search.q}
        results={{ q: search.q, ...filtersOf(search) }}
        initialWallMs={startAt.current}
        onCloseSearch={() =>
          void navigate({ search: (previous) => ({ ...previous, q: undefined }), replace: true })
        }
        onEpisodeDeleted={() => {
          const day = dayOf(detail.data.episode.startedAtMs);
          void navigate({
            to: "/",
            search: relativeDay(day, dayOf(Date.now())) === "today" ? {} : { day },
          });
        }}
      />
      <Saying
        episodeId={episodeId}
        open={detail.data.episode.state === "open"}
        live={status.data?.live}
      />
    </div>
  );
}

/**
 * The day's journal lines that cite this conversation, first (ADR 037): read
 * from what the journal already wrote, never generated here.
 */
function EpisodeJournal({ episodeId, day }: { episodeId: number; day: string }) {
  const journal = useQuery(orpc.journal.day.queryOptions({ input: { day } }));
  const conversation = journal.data?.conversations.find((item) => item.episodeId === episodeId);
  if (journal.data?.state.enabled !== true || conversation === undefined) return null;
  return (
    <section aria-labelledby="episode-journal" className={cardClassName}>
      <h2 id="episode-journal" className={headingClassName}>
        {m.journal_title()}
      </h2>
      <ConversationLines conversation={conversation} />
    </section>
  );
}

/** Under an ongoing conversation's text, the sentence being said (near-live text). */
function Saying({
  episodeId,
  open,
  live,
}: {
  episodeId: number;
  open: boolean;
  live: LiveStatus | undefined;
}) {
  const saying = useSaying(episodeId, open, live);
  return (
    <p aria-live="polite" className="text-cte-text-muted">
      {saying === "" ? null : m.ongoing_saying({ text: saying })}
    </p>
  );
}

/**
 * « YouTube · Le titre »: the page an episode's media came from (ADR 023),
 * opened in the default browser by main, never in the window.
 */
function PageLink({ episodeId, page }: { episodeId: number; page: EpisodeWebPage }) {
  const label = pageLabel(page);
  const open = useMutation(orpc.episodes.openPage.mutationOptions());
  return (
    <span className="flex flex-col items-start gap-xxs">
      <button
        type="button"
        className="flex min-w-0 max-w-full items-center gap-xxs corner-xs text-start underline underline-offset-4 focus-ring"
        aria-label={m.episode_page_open({ page: label })}
        onClick={() => open.mutate({ episodeId })}
      >
        <PageMark page={page} />
        <span className="truncate">{label}</span>
        <ExternalLinkIcon className="text-cte-text-muted" />
      </button>
      {open.error === null ? null : (
        <span role="alert" className="text-body-xs text-error">
          {errorMessage(open.error)}
        </span>
      )}
    </span>
  );
}

function BackLink({ episodeDay, search }: { episodeDay: string; search: EpisodeSearch }) {
  const today = dayOf(Date.now());
  const className = backLinkClassName;
  if (search.q !== undefined) {
    return (
      <Link to="/search" search={{ q: search.q, ...filtersOf(search) }} className={className}>
        <ChevronLeftIcon />
        {m.nav_search()}
      </Link>
    );
  }
  return (
    <Link
      to="/"
      search={relativeDay(episodeDay, today) === "today" ? {} : { day: episodeDay }}
      className={className}
    >
      <ChevronLeftIcon />
      {dayTitle(episodeDay, today)}
    </Link>
  );
}

/** Scrolls the transcript to a sentence and focuses it: where a pinned item belongs. */
function showSentence(segmentId: number) {
  const button = document.querySelector<HTMLElement>(`[data-segment-id="${segmentId}"]`);
  if (button === null) return;
  button.scrollIntoView({ block: "center" });
  button.focus({ preventScroll: true });
}

function Header({
  detail,
  search,
  status,
  addContext,
}: {
  detail: EpisodeDetail;
  search: EpisodeSearch;
  status: Status | undefined;
  addContext: ReactNode;
}) {
  const { episode, analysis } = detail;
  const today = dayOf(Date.now());
  const episodeDay = dayOf(episode.startedAtMs);
  const playState = useEpisodePlayState(episode.id);
  const navigate = useNavigate();
  const named = peopleThere(episode).filter((person) => !person.self);
  // The people are the title (« Avec Camille »); the time joins the line under it.
  const title =
    named.length === 0
      ? timeRange(episode.startedAtMs, episode.endedAtMs)
      : m.episode_with({ names: named.map((person) => person.name).join(", ") });
  const meta = [
    ...(named.length === 0 ? [] : [timeRange(episode.startedAtMs, episode.endedAtMs)]),
    longDate(episodeDay, today),
    formatDuration(episodeLength(episode, Date.now())),
    contextLabel(episode),
    keptLabel(episode),
  ].filter((part) => part !== null);
  // Waiting needs no badge (the card under the header says why), nor a
  // finished transcript (the normal state): only what differs.
  const badge =
    episode.state === "open"
      ? { variant: "warning" as const, label: m.episode_state_open() }
      : episode.analysisState === "queued" ||
          episode.analysisState === "pending" ||
          episode.analysisState === "complete"
        ? null
        : {
            variant: analysisBadge[episode.analysisState].variant,
            label: analysisBadge[episode.analysisState].label(),
          };
  const running = status?.analysis.running;
  return (
    <header className="flex flex-col gap-s">
      <BackLink episodeDay={episodeDay} search={search} />
      {/* The title keeps its width; in a narrow window the actions wrap under it. */}
      <div className="flex flex-wrap items-start gap-x-xs gap-y-s">
        <div className="me-auto flex min-w-[16rem] flex-1 flex-col gap-xs">
          <h1 className={cn(titleClassName, "tabular-nums")}>{title}</h1>
          <p className="flex items-center gap-xxs text-cte-text-muted">
            {/* A site's mark leads the page's line below, not this one. */}
            {siteMark(episode.page) === null ? <EpisodeAppIcon episode={episode} /> : null}
            {meta.join(" · ")}
          </p>
          {episode.page === null ? null : <PageLink episodeId={episode.id} page={episode.page} />}
          <SameMomentLines episodeId={episode.id} moments={detail.sameMoments} />
          <PrivacyLine privacy={detail.privacy} />
        </div>
        {/* Wrapped under the title, the first icon's inset hangs outside so it lines up. */}
        <div className="-ms-s flex items-center gap-xxs">
          {/* The player bar holds this episode unless another one plays. */}
          {playState === "idle" ? (
            <PlayButton
              episodeId={episode.id}
              label={timeRange(episode.startedAtMs, episode.endedAtMs)}
              variant="ghost"
            />
          ) : null}
          {addContext}
          <TagPopover episodeId={episode.id} tags={episode.tags} />
          <EpisodeMenu
            episodeId={episode.id}
            hasTranscript={detail.segments.length > 0}
            transcribed={episode.state === "closed" && episode.analysisState === "complete"}
            closed={episode.state === "closed"}
            startedAtMs={episode.startedAtMs}
            neighbours={detail.neighbours}
            kindOverride={detail.kindOverride}
            kindFixed={episode.context === "imported"}
            keptAudio={
              detail.privacy.kept || !detail.privacy.audioGone ? detail.privacy.kept : null
            }
            site={
              episode.page === null ? null : { site: episode.page.site, name: episode.page.name }
            }
            // Never identified there: no switch to show.
            recognition={
              episode.context === "media" || episode.context === "dictation"
                ? null
                : detail.recognized
            }
            onMerged={(id) =>
              void navigate({ to: "/episode/$id", params: { id: String(id) }, replace: true })
            }
            backTo={() =>
              void (search.q === undefined
                ? navigate({
                    to: "/",
                    search: relativeDay(episodeDay, today) === "today" ? {} : { day: episodeDay },
                  })
                : navigate({ to: "/search", search: { q: search.q, ...filtersOf(search) } }))
            }
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-m gap-y-xs">
        <VoiceBadges detail={detail} />
        <EpisodeTagChips tags={episode.tags} />
        <span className="ms-auto flex items-center gap-xs">
          {badge === null ? null : analysis === null ? (
            <Badge variant={badge.variant}>{badge.label}</Badge>
          ) : (
            // Which engine wrote it matters while engines are compared, not while reading.
            <Tooltip>
              <TooltipTrigger render={<span tabIndex={0} className="corner-full focus-ring" />}>
                <Badge variant={badge.variant}>{badge.label}</Badge>
              </TooltipTrigger>
              <TooltipPopup>
                {m.episode_engine({ engine: engineName(analysis.engineId) })}
              </TooltipPopup>
            </Tooltip>
          )}
          {episode.state === "open" ? <EndButton episode={episode} /> : null}
        </span>
      </div>
      {detail.episode.live && detail.segments.length > 0 ? (
        <p className="text-cte-text-muted">{m.episode_live_note()}</p>
      ) : null}
      {analysis !== null && analysis.coverage !== null && analysis.coverage < FULL_COVERAGE ? (
        <p className="text-cte-text-muted">
          {m.episode_partial_audio({ percent: String(Math.round(analysis.coverage * 100)) })}
        </p>
      ) : null}
      {detail.segments.length === 0 ? (
        <Untranscribed detail={detail} status={status} />
      ) : running?.episodeId === episode.id ? (
        <RunningProgress progress={running.progress} />
      ) : detail.requested ? (
        // « Retranscrire »: the transcript shown stays until the new one replaces it.
        <p className="text-cte-text-muted">{m.episode_retranscribe_requested()}</p>
      ) : null}
    </header>
  );
}

/** « nemotron-3.5-transcribe-iq4nl » as « Nemotron 3.5 transcribe iq4nl ». */
function engineName(engineId: string): string {
  const words = engineId.split(/[-_]/u).filter(Boolean).join(" ");
  return words.charAt(0).toLocaleUpperCase() + words.slice(1);
}

function RunningProgress({ progress }: { progress: number | null }) {
  const percent = progress === null ? null : Math.round(progress * 100);
  return (
    <div className="flex w-full max-w-[24rem] flex-col gap-xxs">
      <p className="text-body-s">
        {percent === null
          ? m.episode_transcribing_starting()
          : m.episode_transcribing({ percent: String(percent) })}
      </p>
      <Progress aria-label={m.analysis_running()} value={percent} />
    </div>
  );
}

/** No transcript yet: why, what happens next, and « Transcrire maintenant ». */
function Untranscribed({ detail, status }: { detail: EpisodeDetail; status: Status | undefined }) {
  const { episode } = detail;
  const running = status?.analysis.running ?? null;
  const noModel =
    status !== undefined && waitingForOf(status.analysis, episode).includes("no-model");
  const reason = status === undefined ? null : waitReasonText(status.analysis, episode);
  const behind = status !== undefined && behindRunning(status.analysis, episode);
  const view = status === undefined ? null : requestView(status.analysis, episode);
  const text =
    episode.state === "open"
      ? m.episode_untranscribed_open()
      : episode.analysisState === "complete"
        ? m.episode_no_speech()
        : running?.episodeId === episode.id || episode.analysisState === "running"
          ? null
          : noModel
            ? m.episode_untranscribed_no_model()
            : view?.kind === "failed"
              ? `${failureText(view.failure)} ${m.episode_untranscribed_failed()}`
              : view?.kind === "waiting"
                ? // Asked already: nothing more to click, only why this one waits.
                  waitingText(view.cause)
                : detail.requested
                  ? m.episode_requested_first()
                  : behind
                    ? m.episode_waiting_other_running()
                    : reason === null
                      ? m.episode_untranscribed_waiting()
                      : m.episode_waiting_because({ reason });
  // The player cues the episode for its page: its plan says where speech is.
  const heard = usePlayerState(
    useCallback(
      (snapshot: PlayerSnapshot) =>
        snapshot.episodeId === episode.id && snapshot.timeline !== null
          ? heardMs(snapshot.timeline.speech)
          : null,
      [episode.id],
    ),
  );
  return (
    <section className="flex flex-col items-start gap-s corner-m bg-neutral-2 p-m">
      {running?.episodeId === episode.id ? <RunningProgress progress={running.progress} /> : null}
      {text === null ? null : <p>{text}</p>}
      {heard === null || heard === 0 || episode.analysisState === "complete" ? null : (
        <p className="text-body-s text-cte-text-muted">
          {m.episode_speech_heard({ duration: formatDuration(heard) })}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-s">
        {noModel || detail.requested ? null : <TranscribeButton episode={episode} />}
        {noModel ? (
          <Link
            to="/settings/$page"
            params={{ page: "transcription" }}
            className="corner-xs font-body font-medium underline underline-offset-4 focus-ring"
          >
            {m.episode_get_model()}
          </Link>
        ) : null}
      </div>
    </section>
  );
}
