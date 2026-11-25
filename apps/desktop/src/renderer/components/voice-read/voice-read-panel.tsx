import type { VoiceReadFailure } from "@sondine/api";
import { Button } from "@sondine/ui/components/button";
import { Meter, MeterLabel, MeterValue } from "@sondine/ui/components/meter";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { errorMessage, orpc } from "../../core/orpc";
import { m } from "../../paraglide/messages.js";
import { getLocale } from "../../paraglide/runtime.js";
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
}: {
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
          <Button
            isPending={start.isPending}
            onClick={() => start.mutate({ selfName: m.voice_self() })}
          >
            {view.failure === null ? m.voice_read_start() : m.voice_read_again()}
          </Button>
        </>
      );
      break;
    case "recording":
      body = (
        <>
          <ReadText />
          <Meter
            value={view.level * 100}
            low={QUIET_LEVEL * 100}
            aria-label={m.voice_read_level()}
            getAriaValueText={() =>
              m.voice_read_counter({
                seconds: String(view.voicedSeconds),
                target: String(view.targetSeconds),
              })
            }
          >
            <MeterLabel>{m.voice_read_heard()}</MeterLabel>
            <MeterValue>
              {(_formatted: string) =>
                m.voice_read_counter({
                  seconds: String(view.voicedSeconds),
                  target: String(view.targetSeconds),
                })
              }
            </MeterValue>
          </Meter>
          <p className="text-body-xs text-cte-text-muted">
            {view.level > 0 && view.level < QUIET_LEVEL
              ? m.voice_read_quiet()
              : m.voice_read_recording_hint()}
          </p>
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
      body = <p>{m.voice_read_done()}</p>;
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

/** The text to read, in the window's language. */
function ReadText({ muted = false }: { readonly muted?: boolean }) {
  return (
    <blockquote
      lang={getLocale()}
      className={
        muted
          ? "m-zero corner-s bg-cte-surface-muted p-m text-body-m text-cte-text-muted"
          : "m-zero corner-s bg-cte-surface-muted p-m text-body-l"
      }
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
