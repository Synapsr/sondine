import type { Status } from "@sondine/api";
import { cn } from "@sondine/ui";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@sondine/ui/components/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@sondine/ui/components/tooltip";
import { ChevronDownIcon, PauseIcon, PlayIcon, WaveformIcon } from "@sondine/ui/icon";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { errorMessage, orpc } from "../../core/orpc";
import { m } from "../../paraglide/messages.js";
import { getLocale } from "../../paraglide/runtime.js";
import { holdLines } from "../../../shared/hold-lines";
import { keepFeedback } from "../../../shared/keep-recent";
import { queueLine, queueLineText } from "../../../shared/queue-line";
import { pauseEndLabel, TIMED_PAUSES_MS } from "../../../shared/timed-pause";
import { listeningView, type ListeningState, type ListeningView } from "../status/listening-view";
import { FORGET_CHOICES, ForgetDialog, forgetLabel, type ForgetMinutes } from "./forget-dialog";
import { ListeningWave } from "./listening-wave";

// The listening control in the window's top band (ADR 037): two targets. The button shows
// the state the helper confirmed (a wave that moves with speech, a play icon
// when paused, words otherwise) and does its one action (pause, resume,
// « Écouter quand même »); the chevron opens the listening menu, with the
// status first (why it holds, the queue), then timed pauses, keep and erase.
// A failure that stops capture opens the menu from the button too.

const label: Record<ListeningState, () => string> = {
  listening: () => m.listening_control_on(),
  partial: () => m.listening_control_partial(),
  paused: () => m.listening_control_paused(),
  unknown: () => m.listening_control_starting(),
  "pause-unconfirmed": () => m.listening_control_pausing(),
  held: () => m.listening_control_held(),
  "disk-full": () => m.listening_control_problem(),
  "write-error": () => m.listening_control_problem(),
};

/** What the menu's first line says, as the menu bar does. */
const detail: Record<ListeningState, () => string> = {
  listening: () => m.tray_state_listening(),
  partial: () => m.tray_state_partial(),
  paused: () => m.tray_state_paused(),
  unknown: () => m.tray_state_connecting(),
  "pause-unconfirmed": () => m.tray_state_pause_unconfirmed(),
  held: () => m.listening_control_held(),
  "disk-full": () => m.sidebar_disk_full_detail(),
  "write-error": () => m.tray_state_write_error(),
};

const dot: Record<ListeningState, string> = {
  listening: "bg-success",
  partial: "bg-warning",
  paused: "bg-neutral-6",
  unknown: "bg-neutral-5",
  "pause-unconfirmed": "bg-warning",
  held: "bg-neutral-6",
  "disk-full": "bg-error",
  "write-error": "bg-error",
};

function buttonText(view: ListeningView): string {
  return view.state === "paused" && view.pausedUntilMs !== null
    ? m.listening_control_paused_until({
        time: pauseEndLabel(view.pausedUntilMs, Date.now(), getLocale()),
      })
    : label[view.state]();
}

/** How long « Gardé : les 2 dernières minutes » stays, as in the menu bar. */
const KEPT_FEEDBACK_MS = 2_500;

const segment = cn(
  "inline-flex h-[2.25rem] items-center gap-xs whitespace-nowrap",
  "font-body font-medium text-body-s text-cte-text",
  "transition-[background-color] duration-motion ease-motion motion-reduce:transition-none",
  "control-hover:bg-neutral-4 focus-ring",
  "disabled:text-cte-text-muted",
);

export function ListeningControl() {
  const status = useQuery(orpc.status.watch.experimental_liveOptions({ retry: true }));
  if (status.data === undefined) {
    return (
      <span className={cn(segment, "corner-s px-s text-cte-text-muted")} role="status">
        <span aria-hidden className="size-xs shrink-0 corner-full bg-neutral-5" />
        {m.listening_control_starting()}
      </span>
    );
  }
  return <Control status={status.data} />;
}

function Control({ status }: { status: Status }) {
  const pause = useMutation(orpc.listening.pause.mutationOptions());
  const resume = useMutation(orpc.listening.resume.mutationOptions());
  const lift = useMutation(orpc.privacy.lift.mutationOptions());
  const keep = useMutation(orpc.episodes.keepRecent.mutationOptions());
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [forgetting, setForgetting] = useState<ForgetMinutes | null>(null);
  const { data: kept, reset: resetKept } = keep;
  useEffect(() => {
    if (kept === undefined) return;
    const timer = setTimeout(resetKept, KEPT_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [kept, resetKept]);

  const view = listeningView(status.listening, status.spool);
  const speaking = status.tracks.some((track) => track.speaking);
  const holds = status.listening.holds.filter((hold) => !hold.lifted);
  const failing = view.state === "disk-full" || view.state === "write-error";
  const error = pause.error ?? resume.error ?? lift.error ?? keep.error;
  const pending = pause.isPending || resume.isPending || lift.isPending;
  const text = kept === undefined ? buttonText(view) : keepFeedback(kept);

  const main = view.actions[0];
  const act = () => {
    if (failing || main === undefined) return setMenuOpen(true);
    switch (main) {
      case "pause":
      case "retry-pause":
        return pause.mutate({});
      case "resume":
        return resume.mutate({});
      case "lift":
        for (const hold of holds) lift.mutate({ occurrenceId: hold.occurrenceId });
    }
  };
  const actionLabel = failing
    ? m.listening_control_menu()
    : main === "resume"
      ? m.tray_resume()
      : main === "lift"
        ? m.tray_lift()
        : main === "retry-pause"
          ? m.tray_retry_pause()
          : m.tray_pause();
  const pauseFor = (durationMs: number | null) =>
    pause.mutate(durationMs === null ? {} : { untilMs: Date.now() + durationMs });
  const queue = queueLine(status.analysis);

  return (
    <div className="flex items-center">
      <span role="status" className="sr-only">
        {text}
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={actionLabel}
              aria-busy={pending || undefined}
              disabled={view.state === "unknown" && main === "pause"}
              onClick={act}
              className={cn(segment, "group/listen corner-l-s ps-s pe-xs")}
            />
          }
        >
          <Mark view={view} speaking={speaking} kept={kept === undefined ? null : text} />
        </TooltipTrigger>
        <TooltipPopup side="bottom">{actionLabel}</TooltipPopup>
      </Tooltip>
      <Menu open={menuOpen} onOpenChange={setMenuOpen}>
        <MenuTrigger
          render={
            <button
              type="button"
              id="listening-menu"
              aria-label={m.listening_control_menu()}
              className={cn(segment, "w-[2.25rem] justify-center corner-r-s text-cte-text-muted")}
            />
          }
        >
          <ChevronDownIcon />
        </MenuTrigger>
        <MenuPopup side="bottom" align="end" sideOffset={8} className="w-[18rem]">
          <MenuGroup>
            <MenuGroupLabel>
              {view.state === "paused" && view.pausedUntilMs !== null
                ? m.tray_state_paused_until({
                    time: pauseEndLabel(view.pausedUntilMs, Date.now(), getLocale()),
                  })
                : detail[view.state]()}
            </MenuGroupLabel>
            {holdLines(holds, getLocale()).map((line) => (
              <p key={line} className="px-s pb-xxs text-body-xs text-cte-text-muted">
                {line}
              </p>
            ))}
            {error === null ? null : (
              <p role="alert" className="px-s pb-xxs text-body-xs text-error">
                {errorMessage(error)}
              </p>
            )}
            <MenuItem
              icon={<WaveformIcon />}
              onClick={() => void navigate({ to: "/settings/$page", params: { page: "advanced" } })}
              label={queueLineText(queue)}
            >
              <span className={cn(queue.kind === "running" ? undefined : "text-cte-text-muted")}>
                {queueLineText(queue)}
              </span>
            </MenuItem>
          </MenuGroup>
          <MenuSeparator />
          {view.actions.includes("resume") ? (
            <MenuItem onClick={() => resume.mutate({})}>{m.tray_resume()}</MenuItem>
          ) : null}
          {view.actions.includes("lift") ? (
            <MenuItem onClick={act}>{m.tray_lift()}</MenuItem>
          ) : null}
          {view.actions.includes("pause") ? (
            <>
              <MenuItem onClick={() => pauseFor(TIMED_PAUSES_MS["15-min"])}>
                {m.tray_pause_15_min()}
              </MenuItem>
              <MenuItem onClick={() => pauseFor(TIMED_PAUSES_MS["1-hour"])}>
                {m.tray_pause_1_hour()}
              </MenuItem>
              <MenuItem onClick={() => pauseFor(null)}>{m.tray_pause_until_resumed()}</MenuItem>
            </>
          ) : null}
          <MenuSeparator />
          <MenuItem onClick={() => keep.mutate({})}>{m.tray_keep()}</MenuItem>
          {FORGET_CHOICES.map((minutes) => (
            <MenuItem key={minutes} variant="danger" onClick={() => setForgetting(minutes)}>
              {m.forget_menu({ range: forgetLabel(minutes) })}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
      <ForgetDialog minutes={forgetting} onClose={() => setForgetting(null)} />
    </div>
  );
}

/**
 * What the button shows (ADR 037): the wave while listening (a pause icon
 * under the pointer or focus), a play icon while paused, in the same box so
 * the button keeps its width (a timed pause's end heads the menu), and words
 * for every other state, which needs them.
 */
function Mark({
  view,
  speaking,
  kept,
}: {
  view: ListeningView;
  speaking: boolean;
  /** « Gardé : … » for a moment after keeping. */
  kept: string | null;
}) {
  if (kept !== null) return <span aria-hidden>{kept}</span>;
  if (view.state === "listening" || view.state === "partial") {
    return (
      <span aria-hidden className="flex w-[1.75rem] items-center justify-center">
        <span className="group-hover/listen:hidden group-focus-visible/listen:hidden">
          <ListeningWave speaking={speaking} tone={view.state === "partial" ? "partial" : "live"} />
        </span>
        <PauseIcon className="hidden group-hover/listen:inline group-focus-visible/listen:inline" />
      </span>
    );
  }
  if (view.state === "paused") {
    // The wave's box: the button keeps its width; a timed pause's end is in the menu.
    return (
      <span aria-hidden className="flex w-[1.75rem] items-center justify-center">
        <PlayIcon />
      </span>
    );
  }
  return (
    <>
      <span aria-hidden className={cn("size-xs shrink-0 corner-full", dot[view.state])} />
      <span aria-hidden>{buttonText(view)}</span>
    </>
  );
}
