import type { ImportsListOutput } from "@sondine/api";
import { Badge } from "@sondine/ui/components/badge";
import { Button } from "@sondine/ui/components/button";
import { Progress } from "@sondine/ui/components/progress";
import { PlusIcon } from "@sondine/ui/icon";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { errorMessage, orpc } from "../../core/orpc";
import { dayOf } from "../../lib/day";
import { analysisBadge, clock, dayTitle, episodeLength, formatDuration } from "../../lib/labels";
import { m } from "../../paraglide/messages.js";
import { waitReasonText } from "../../../shared/queue-line";
import { PlayButton } from "../player/play-button";
import { rowDivider } from "../today/today-rows";
import { useImport } from "./import-actions";

// The imported audio files (ADR 021), in Search when its « Importé » filter
// is on and nothing is typed (Téo, 2026-11-19: no sidebar entry of their
// own): newest import first, each transcribed with its voices as a user
// request. « Importer un audio… » opens the Mac's panel; files pasted here
// (⌘V, copied in Finder) or dropped on the window are imported too
// (import-actions.tsx), as from Today's « ⋯ » and the command palette. A row
// opens the recording.

type Imported = ImportsListOutput["imports"][number];

/** Typing in a field: ⌘V is the field's, not an import. */
function typingIn(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

/** While one is not transcribed yet, the list follows its progress. */
const PENDING_REFRESH_MS = 4_000;

export function ImportedList() {
  const list = useInfiniteQuery(
    orpc.imports.list.infiniteOptions({
      input: (cursor: string | undefined) => (cursor === undefined ? {} : { cursor }),
      initialPageParam: undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
      refetchInterval: (query) =>
        query.state.data?.pages.some((page) =>
          page.imports.some(
            (item) =>
              item.episode.analysisState !== "complete" && item.episode.analysisState !== "failed",
          ),
        ) === true
          ? PENDING_REFRESH_MS
          : false,
    }),
  );
  const imports = useImport();
  // ⌘V of files copied in Finder.
  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      if (typingIn(event.target) || window.sondine === undefined) return;
      event.preventDefault();
      void window.sondine.pastedFiles().then(imports.paths);
    };
    document.addEventListener("paste", paste);
    return () => document.removeEventListener("paste", paste);
  });
  const status = useQuery(orpc.status.watch.experimental_liveOptions({ retry: true }));
  const running = status.data?.analysis.running ?? null;
  const analysis = status.data?.analysis;
  const imported = list.data?.pages.flatMap((page) => page.imports) ?? [];

  return (
    <section aria-label={m.nav_imports()} className="flex flex-col gap-m">
      <div className="flex flex-wrap items-center gap-m">
        <p className="min-w-0 flex-1 text-body-s text-cte-text-muted">{m.imports_drop_hint()}</p>
        <Button variant="secondary" isPending={imports.pending} onClick={imports.pick}>
          <PlusIcon />
          {imports.pending ? m.imports_importing() : m.imports_add()}
        </Button>
      </div>
      {list.data === undefined ? (
        <p className={list.isError ? "text-error" : "text-cte-text-muted"}>
          {list.isError ? errorMessage(list.error) : m.loading()}
        </p>
      ) : imported.length === 0 ? (
        <p className="text-cte-text-muted">{m.imports_empty()}</p>
      ) : (
        <ul className="flex flex-col">
          {imported.map((item) => (
            <ImportRow
              key={item.episode.id}
              item={item}
              progress={running?.episodeId === item.episode.id ? running.progress : undefined}
              waitReason={analysis === undefined ? null : waitReasonText(analysis, item.episode)}
            />
          ))}
        </ul>
      )}
      {list.hasNextPage ? (
        <Button
          variant="ghost"
          className="self-start"
          isPending={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {m.show_more()}
        </Button>
      ) : null}
    </section>
  );
}

function ImportRow({
  item,
  progress,
  waitReason,
}: {
  item: Imported;
  /** 0 to 1 while it is being transcribed; null before the first update. */
  progress: number | null | undefined;
  waitReason: string | null;
}) {
  const { episode } = item;
  const today = dayOf(Date.now());
  const when = [dayTitle(dayOf(item.importedAtMs), today), clock(item.importedAtMs)].join(" · ");
  const length = formatDuration(episodeLength(episode, Date.now()));
  const state = episode.analysisState;
  const badge =
    state === "running" || state === "failed" || state === "stale" ? analysisBadge[state] : null;
  return (
    <li className={`flex items-center gap-m py-s ${rowDivider}`}>
      <Link
        to="/episode/$id"
        params={{ id: String(episode.id) }}
        className="flex min-w-0 flex-1 items-center gap-m corner-s focus-ring"
      >
        <span className="flex w-[8rem] shrink-0 flex-col">
          <span className="text-body-s whitespace-nowrap">{when}</span>
          <span className="text-body-xs text-cte-text-muted">{length}</span>
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{item.fileName}</span>
          {progress === undefined ? (
            <span className="truncate text-body-s text-cte-text-muted">
              {episode.firstWords ??
                (state === "complete"
                  ? m.episode_no_speech()
                  : state === "failed"
                    ? m.episode_analysis_failed()
                    : waitReason === null
                      ? m.imports_waiting()
                      : m.today_untranscribed_because({ reason: waitReason }))}
            </span>
          ) : (
            <span className="flex items-center gap-s pt-xs">
              <Progress
                aria-label={m.analysis_running()}
                value={progress === null ? null : Math.round(progress * 100)}
                className="max-w-[16rem]"
              />
            </span>
          )}
        </span>
      </Link>
      <span className="flex shrink-0 items-center gap-xs">
        {badge === null ? null : <Badge variant={badge.variant}>{badge.label()}</Badge>}
        <PlayButton episodeId={episode.id} label={item.fileName} variant="ghost" />
      </span>
    </li>
  );
}
