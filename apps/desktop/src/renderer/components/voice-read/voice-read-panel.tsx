import type { VoiceReadFailure } from "@sondine/api";
import { Button } from "@sondine/ui/components/button";
import { cn } from "@sondine/ui";
import { Meter, MeterLabel, MeterValue } from "@sondine/ui/components/meter";
import { CheckIcon } from "@sondine/ui/icon";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { errorMessage, orpc } from "../../core/orpc";
import { m } from "../../paraglide/messages.js";
import { getLocale } from "../../paraglide/runtime.js";
import { SkySurface } from "../welcome/sky-surface";
import { QUIET_LEVEL, voiceReadView } from "./voice-read-view";

// The voice read (ADR 034): the user reads a short text aloud and Sondine
// keeps its voice print as one of the user's references, so « Moi » is
// suggested from the first day. The same panel serves the first run, where
// « Passer » is as plain as « Commencer », and Settings ▸ Voix and the user's
// page, where reading again replaces the read.

const failureText: Record<VoiceReadFailure, () => string> = {
  "recognition-off": () => m.voice_read_recognition_off(),
  "no-microphone": () => m.voice_read_no_microphone(),
  unavailable: () => m.voice_read_unavailable(),
  busy: () => m.voice_read_busy(),
  "too-short": () => m.voice_read_too_short(),
  failed: () => m.voice_read_failed(),
};

/**
 * After a read is kept or forgotten, or recognition turned on: who reads as
 * « Moi » changes with the user's references, and the read's own status.
 */
export function refreshVoices(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: orpc.voiceRead.key() }),
    queryClient.invalidateQueries({ queryKey: orpc.episodes.key() }),
    queryClient.invalidateQueries({ queryKey: orpc.search.key() }),
    queryClient.invalidateQueries({ queryKey: orpc.people.key() }),
  ]);
}

/** The read's live status: the level about ten times a second while recording. */
export function useVoiceRead() {
  return useQuery(orpc.voiceRead.watch.experimental_liveOptions({ retry: true }));
}

export function VoiceReadPanel({
  onSkip,
  onDone,
  doneLabel,
  leading,
  selfName,
  autoStart = false,
  large = false,
}: {
  /** The user's name, should the read make their row; « Moi » by default. */
  readonly selfName?: string | undefined;
  /** Starts at once (the first run's dialog: its button was the start). */
  readonly autoStart?: boolean;
  /** The progress wide and its share big (the first run's dialog). */
  readonly large?: boolean;
  /** At the start of the buttons' row (the first run's « Retour »), the others at its end. */
  readonly leading?: ReactNode;
  /** The first run: « Passer » beside « Commencer ». */
  readonly onSkip?: () => void;
  /** Once kept, the button that leaves (« Continuer »); none: the panel closes itself. */
  readonly onDone?: () => void;
  readonly doneLabel?: string;
}) {
  const queryClient = useQueryClient();
  const status = useVoiceRead();
  // An outcome left by an earlier read is not this panel's.
  const [mine, setMine] = useState(false);
  const start = useMutation(
    orpc.voiceRead.start.mutationOptions({ onMutate: () => setMine(true) }),
  );
  const finish = useMutation(
    orpc.voiceRead.finish.mutationOptions({ onSuccess: () => refreshVoices(queryClient) }),
  );
  const cancel = useMutation(orpc.voiceRead.cancel.mutationOptions());
  const enable = useMutation(
    orpc.people.setRecognition.mutationOptions({
      onSuccess: async (next) => {
        queryClient.setQueryData(orpc.people.recognition.queryKey(), next);
        await refreshVoices(queryClient);
      },
    }),
  );
  // Leaving the screen mid-read keeps nothing, a start still on its way included.
  const phase = status.data?.session.phase;
  const underWay = start.isPending || phase === "recording" || phase === "embedding";
  const cancelOnLeave = useRef<() => void>(() => undefined);
  cancelOnLeave.current = () => {
    if (mine && underWay) cancel.mutate({});
  };
  useEffect(() => () => cancelOnLeave.current(), []);
  const name = selfName ?? m.voice_self();
  // Once, as the panel opens ready to read.
  const started = useRef(false);
  const ready = status.data !== undefined && voiceReadView(status.data, mine).kind === "ready";
  useEffect(() => {
    if (!autoStart || started.current || !ready) return;
    started.current = true;
    start.mutate({ selfName: name });
  }, [autoStart, ready, start, name]);

  if (status.data === undefined) {
    return status.error === null ? null : (
      <p role="alert" className="text-error">
        {errorMessage(status.error)}
      </p>
    );
  }
  const view = voiceReadView(status.data, mine);
  const error = start.error ?? finish.error ?? cancel.error ?? enable.error;
  const skip =
    onSkip === undefined ? null : (
      <Button variant="secondary" onClick={onSkip}>
        {m.voice_read_skip()}
      </Button>
    );

  let body: ReactNode;
  let actions: ReactNode;
  switch (view.kind) {
    case "recognition-off":
      body = <p className="text-cte-text-muted">{m.voice_read_recognition_off()}</p>;
      // Only the user's explicit yes turns it on, and only in the first run:
      // Settings has its switch right above.
      actions = (
        <>
          {skip}
          {onSkip === undefined ? null : (
            <Button isPending={enable.isPending} onClick={() => enable.mutate({ on: true })}>
              {m.voice_read_enable_recognition()}
            </Button>
          )}
        </>
      );
      break;
    case "unavailable":
      body = <p className="text-cte-text-muted">{m.voice_read_unavailable()}</p>;
      actions = skip;
      break;
    case "ready":
      body = (
        <>
          <ReadText muted />
          {/* The progress's place, kept from the start: nothing moves once it begins. */}
          <div aria-hidden className="invisible">
            <Progress percent={0} level={0} large={large} />
          </div>
          {view.failure === null ? null : (
            <p role="alert" className="text-error">
              {failureText[view.failure]()}
            </p>
          )}
        </>
      );
      actions = (
        <>
          {skip}
          <Button isPending={start.isPending} onClick={() => start.mutate({ selfName: name })}>
            {view.failure === null ? m.voice_read_start() : m.voice_read_again()}
          </Button>
        </>
      );
      break;
    case "recording":
      body = (
        <>
          <ReadText />
          <Progress
            large={large}
            percent={view.percent}
            level={view.level}
            label={m.voice_read_counter({
              seconds: String(view.voicedSeconds),
              target: String(view.targetSeconds),
            })}
            hint={
              view.level > 0 && view.level < QUIET_LEVEL
                ? m.voice_read_quiet()
                : m.voice_read_recording_hint()
            }
          />
        </>
      );
      actions = (
        <>
          <Button
            variant="secondary"
            isPending={cancel.isPending}
            onClick={() => cancel.mutate({})}
          >
            {m.cancel()}
          </Button>
          <Button
            disabled={!view.canFinish}
            isPending={finish.isPending}
            onClick={() => finish.mutate({})}
          >
            {m.voice_read_finish()}
          </Button>
        </>
      );
      break;
    case "embedding":
      body = (
        <p role="status" className="text-cte-text-muted">
          {m.voice_read_learning()}
        </p>
      );
      actions = null;
      break;
    case "done":
      body = (
        <div className="sondine-cloud relative flex items-center gap-m overflow-hidden corner-l p-l">
          <SkySurface className="sondine-cloud-sky absolute inset-zero" />
          <span className="relative flex size-[3rem] shrink-0 items-center justify-center corner-full bg-neutral-1 text-display-xs text-neutral-10">
            <CheckIcon aria-hidden />
          </span>
          <p className="relative font-display font-heavy text-display-xs">{m.voice_read_done()}</p>
        </div>
      );
      actions =
        onDone === undefined ? null : (
          <Button onClick={onDone}>{doneLabel ?? m.welcome_continue()}</Button>
        );
      break;
  }

  return (
    <div className="flex flex-col gap-m">
      {body}
      {error === null ? null : (
        <p role="alert" className="text-error">
          {errorMessage(error)}
        </p>
      )}
      {actions === null && leading === undefined ? null : (
        <div className="flex items-center gap-xs">
          {leading}
          <span className="ms-auto flex items-center gap-xs">{actions}</span>
        </div>
      )}
    </div>
  );
}

/**
 * The voice heard toward the target, as a share, and beside it the
 * microphone's level, live (Téo, 2026-11-28): bars that follow the voice.
 */
function Progress({
  percent,
  level,
  label,
  hint,
  large = false,
}: {
  readonly percent: number;
  readonly level: number;
  readonly label?: string;
  readonly hint?: string;
  readonly large?: boolean;
}) {
  if (large) {
    return (
      <div className="flex flex-col gap-s">
        <div className="flex items-end justify-between gap-s">
          <span className="flex flex-col">
            <span className="text-body-s text-cte-text-muted">{m.voice_read_heard()}</span>
            <span className="font-display font-heavy text-display-m tabular-nums">{percent} %</span>
          </span>
          <LevelBars level={level} large />
        </div>
        <Meter
          value={percent}
          aria-label={m.voice_read_heard()}
          getAriaValueText={() => label ?? ""}
        />
        <p className="text-body-xs text-cte-text-muted">{hint ?? m.voice_read_recording_hint()}</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-xs">
      <div className="flex items-center gap-s">
        <Meter
          className="min-w-0 flex-1"
          value={percent}
          aria-label={m.voice_read_heard()}
          getAriaValueText={() => label ?? ""}
        >
          <MeterLabel>{m.voice_read_heard()}</MeterLabel>
          <MeterValue>{(_formatted: string) => `${percent} %`}</MeterValue>
        </Meter>
        <LevelBars level={level} />
      </div>
      <p className="text-body-xs text-cte-text-muted">{hint ?? m.voice_read_recording_hint()}</p>
    </div>
  );
}

const BARS = [0.55, 0.85, 1, 0.7, 0.45] as const;

/** Five bars that rise with the microphone's level. */
function LevelBars({ level, large = false }: { readonly level: number; readonly large?: boolean }) {
  return (
    <span
      role="img"
      aria-label={m.voice_read_level()}
      className={cn(
        "flex shrink-0 items-center self-end",
        large ? "h-[3rem] gap-[4px]" : "h-[1.5rem] gap-[3px]",
      )}
    >
      {BARS.map((weight, index) => (
        <span
          key={index}
          className={cn(
            "corner-full transition-[height] duration-100 ease-out motion-reduce:transition-none",
            large ? "w-[4px]" : "w-[3px]",
            level < QUIET_LEVEL ? "bg-neutral-6" : "bg-cte-text",
          )}
          style={{ height: `${Math.round(15 + 85 * Math.min(1, level * 1.6) * weight)}%` }}
        />
      ))}
    </span>
  );
}

/** The text to read, in the window's language: the same size before and during the read. */
function ReadText({ muted = false }: { readonly muted?: boolean }) {
  return (
    <blockquote
      lang={getLocale()}
      className={cn(
        "m-zero corner-s bg-cte-surface-muted p-m text-body-l transition-colors duration-motion motion-reduce:transition-none",
        muted && "text-cte-text-muted",
      )}
    >
      {m.voice_read_text()}
    </blockquote>
  );
}

/**
 * Settings ▸ Voix and the user's page: the read kept (when, how much voice),
 * « Relire » and « Oublier ma voix lue », or « Lire un texte ».
 */
export function VoiceReadSection() {
  const queryClient = useQueryClient();
  const status = useVoiceRead();
  const [open, setOpen] = useState(false);
  const forget = useMutation(
    orpc.voiceRead.forget.mutationOptions({ onSuccess: () => refreshVoices(queryClient) }),
  );
  const data = status.data;
  if (data === undefined) return null;
  const running = data.session.phase === "recording" || data.session.phase === "embedding";
  const shown = open || running;
  const read = data.read;
  return (
    <div className="flex max-w-[40rem] flex-col gap-s">
      <span className="font-body font-medium">{m.voice_read_title()}</span>
      {!data.recognition ? (
        <p className="text-body-s text-cte-text-muted">{m.voice_read_recognition_off()}</p>
      ) : shown ? (
        <VoiceReadPanel onDone={() => setOpen(false)} doneLabel={m.voice_read_close()} />
      ) : (
        <>
          <p className="text-body-s text-cte-text-muted">
            {read === null
              ? m.voice_read_none()
              : m.voice_read_kept({
                  date: new Intl.DateTimeFormat(getLocale(), { dateStyle: "long" }).format(
                    read.readAtMs,
                  ),
                  seconds: String(Math.round(read.speechMs / 1000)),
                })}{" "}
            {m.voice_read_privacy()}
          </p>
          <div className="flex items-center gap-xs">
            <Button variant="secondary" disabled={!data.available} onClick={() => setOpen(true)}>
              {read === null ? m.voice_read_open() : m.voice_read_again()}
            </Button>
            {read === null ? null : (
              <Button
                variant="ghost"
                isPending={forget.isPending}
                onClick={() => forget.mutate({})}
              >
                {m.voice_read_forget()}
              </Button>
            )}
          </div>
          {forget.error === null ? null : (
            <p role="alert" className="text-body-s text-error">
              {errorMessage(forget.error)}
            </p>
          )}
        </>
      )}
    </div>
  );
}
