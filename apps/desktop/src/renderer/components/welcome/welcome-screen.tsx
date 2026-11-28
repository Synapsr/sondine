import type {
  OnboardingGoal,
  OnboardingStep,
  PermissionKind,
  Permissions,
  Status,
} from "@sondine/api";
import { cn } from "@sondine/ui";
import { Button } from "@sondine/ui/components/button";
import {
  CheckIcon,
  ClockIcon,
  MicrophoneIcon,
  PhoneIcon,
  VolumeIcon,
  WaveformIcon,
} from "@sondine/ui/icon";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { errorMessage, orpc } from "../../core/orpc";
import { m } from "../../paraglide/messages.js";
import { useModels } from "../models/model-panel";
import { asksForUpdates } from "../updates/update-view";
import { UpdateAnswers, useUpdates } from "../updates/updates";
import { SentReports, UsageAnswers } from "../usage/usage";
import { VoiceReadPanel } from "../voice-read/voice-read-panel";
import { useCompute } from "../settings/compute-section";
import { RestoreDialog } from "../backup/backup-dialogs";
import { modelsReady } from "../models/model-view";
import { Step } from "./step";
import { TranscriptionStep } from "./transcription-step";
import { WelcomeIntro } from "./welcome-intro";
import { nextStep, permissionOffer, previousStep, startNotes, stepIndex } from "./welcome-steps";

// The first run (`/welcome`, ADR 037), shown until it is completed: what the
// user wants to find again, whether to share anonymous statistics (ADR 042),
// the permissions, where to transcribe (transcription-step.tsx: the choice,
// then what the chosen place asks for), the voice read, then starting. Nothing is
// recorded before « Commencer l'écoute »: a fresh install keeps listening
// paused until then. Each step is saved as it shows, so a relaunch after a
// permission prompt comes back to it. The voice read and the model are
// optional; the read records only while the user reads, and never becomes a
// memory (ADR 034). Each step's parts rise in one after the other; going to
// another step, the one left slides away blurred (Téo, 2026-11-19). Before
// anything is chosen, the opening comes first (welcome-intro.tsx).

export function WelcomeScreen() {
  const onboarding = useQuery(orpc.onboarding.get.queryOptions());
  const queryClient = useQueryClient();
  const advance = useMutation(orpc.onboarding.advance.mutationOptions());
  const [step, setStep] = useState<OnboardingStep | null>(null);
  // After a change of step, the next one waits for the one left to be mostly gone,
  // and comes in from the side the user goes toward.
  const [moved, setMoved] = useState<"forward" | "back" | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [opened, setOpened] = useState(false);
  const shown = step ?? onboarding.data?.step ?? "welcome";
  const go = (next: OnboardingStep | null, goal?: OnboardingGoal) => {
    if (next === null) return;
    const direction = stepIndex(next) > stepIndex(shown) ? "forward" : "back";
    // The step left slides away blurred, toward where the user goes (renderer/styles.css).
    const change = () =>
      flushSync(() => {
        setStep(next);
        setMoved(direction);
      });
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (calm || typeof document.startViewTransition !== "function") change();
    else {
      document.startViewTransition({
        update: change,
        types: [direction === "forward" ? "step-forward" : "step-back"],
      });
    }
    advance.mutate(
      { step: next, ...(goal === undefined ? {} : { goal }) },
      { onSuccess: (status) => queryClient.setQueryData(orpc.onboarding.get.queryKey(), status) },
    );
  };

  // The window waits for the first run, so the opening never shows after a later step.
  if (onboarding.isPending) return <div className="min-h-dvh bg-cte-canvas" />;
  if (
    !opened &&
    step === null &&
    onboarding.data?.step === "welcome" &&
    onboarding.data.goal === null
  )
    return <WelcomeIntro onDone={() => setOpened(true)} />;

  return (
    <div className="relative flex min-h-dvh flex-col items-center bg-cte-canvas px-l pt-xxl text-cte-text">
      {/* No title bar: the top edge drags the window. */}
      <div
        aria-hidden
        className="absolute inset-x-zero top-zero h-[2.5rem] [-webkit-app-region:drag]"
      />
      {/* A Mac reinstalled, or a new one (ADR 048): everything back from one file,
          offered lightly in the corner of the first step, on the traffic lights' line (Téo, 2026-11-28). */}
      {shown === "welcome" ? (
        <Button
          variant="ghost"
          className="absolute end-xxs top-xxs text-body-s text-cte-text-muted [-webkit-app-region:no-drag]"
          onClick={() => setRestoring(true)}
        >
          {m.backup_welcome_restore()}
        </Button>
      ) : null}
      <RestoreDialog open={restoring} replaces={false} onClose={() => setRestoring(false)} />
      {/* The steps all share one box, all that is left of the window, so a step
          left behind does not move up or down as it goes (Téo, 2026-11-28). */}
      <div
        className={cn(
          "flex w-full max-w-[30rem] flex-1 flex-col [view-transition-name:welcome-step]",
          moved !== null && "[--stagger-offset:160ms]",
          moved === "forward" && "[--rise-from:40px_0]",
          moved === "back" && "[--rise-from:-40px_0]",
        )}
      >
        {/* The step in the middle of it, both ways; a tall step scrolls from the top. */}
        <div className="my-auto flex flex-col gap-xl py-xl">
          {shown === "welcome" ? (
            <GoalStep
              goal={onboarding.data?.goal ?? null}
              onPick={(goal) => go(nextStep(shown), goal)}
            />
          ) : null}
          {shown === "statistics" ? (
            <StatisticsStep
              onBack={() => go(previousStep(shown))}
              onNext={() => go(nextStep(shown))}
            />
          ) : null}
          {shown === "permissions" ? (
            <PermissionsStep
              onBack={() => go(previousStep(shown))}
              onNext={() => go(nextStep(shown))}
            />
          ) : null}
          {shown === "voice" ? (
            <VoiceStep onBack={() => go(previousStep(shown))} onNext={() => go(nextStep(shown))} />
          ) : null}
          {shown === "model" ? (
            <TranscriptionStep
              onBack={() => go(previousStep(shown))}
              onNext={() => go(nextStep(shown))}
            />
          ) : null}
          {shown === "start" ? <StartStep onBack={() => go(previousStep(shown))} /> : null}
        </div>
      </div>
    </div>
  );
}

const GOALS: readonly {
  readonly goal: OnboardingGoal;
  readonly icon: ReactNode;
  readonly title: () => string;
  readonly detail: () => string;
}[] = [
  {
    goal: "meetings",
    icon: <PhoneIcon />,
    title: () => m.welcome_goal_meetings(),
    detail: () => m.welcome_goal_meetings_detail(),
  },
  {
    goal: "day",
    icon: <ClockIcon />,
    title: () => m.welcome_goal_day(),
    detail: () => m.welcome_goal_day_detail(),
  },
  {
    goal: "everything",
    icon: <WaveformIcon />,
    title: () => m.welcome_goal_everything(),
    detail: () => m.welcome_goal_everything_detail(),
  },
];

/**
 * Step 1 (ADR 037): what the user wants to find again, under the promise in
 * one line. A card is one click: it sets what Today shows first, never what
 * Sondine records, and moves on.
 */
function GoalStep({
  goal,
  onPick,
}: {
  goal: OnboardingGoal | null;
  onPick: (goal: OnboardingGoal) => void;
}) {
  return (
    <section aria-labelledby="welcome-title" className="sondine-stagger flex flex-col gap-l">
      <h1 id="welcome-title" className="font-display font-heavy text-display-m">
        {m.welcome_goal_title()}
      </h1>
      <ul className="sondine-stagger flex flex-col gap-xs [--stagger-start:70ms]">
        {GOALS.map((card) => (
          <li key={card.goal}>
            <button
              type="button"
              aria-pressed={goal === card.goal}
              onClick={() => onPick(card.goal)}
              className={cn(
                "flex w-full items-center gap-s corner-m p-m text-start ring-[1px] focus-ring",
                // Only the ground eases: an edge (a shadow) in transition thickens as it goes (Téo, 2026-11-28).
                "transition-[background-color] duration-motion ease-motion motion-reduce:transition-none",
                "control-hover:bg-neutral-2",
                // The card chosen, quietly: a grey edge on a faint ground, not black.
                goal === card.goal ? "bg-neutral-2 ring-neutral-6" : "ring-neutral-4",
              )}
            >
              <span
                aria-hidden
                className="flex size-[2.5rem] shrink-0 items-center justify-center corner-m bg-neutral-3 text-cte-text-muted"
              >
                {card.icon}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium text-body-m">{card.title()}</span>
                <span className="text-body-s text-cte-text-muted">{card.detail()}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * What may leave this Mac by itself, each asked once: anonymous statistics
 * (ADR 042), then updates (ADR 045), where this app can install them. Either
 * answer moves on.
 */
function StatisticsStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const updates = useUpdates();
  const [statisticsAnswered, setStatisticsAnswered] = useState(false);
  if (statisticsAnswered) {
    return (
      <section aria-labelledby="welcome-title" className="sondine-stagger flex flex-col gap-l">
        <h1 id="welcome-title" className="font-display font-heavy text-display-m">
          {m.update_question()}
        </h1>
        <p>{m.update_what()}</p>
        <div className="flex flex-wrap items-center gap-xs pt-m">
          <Button variant="ghost" className="-ms-s" onClick={() => setStatisticsAnswered(false)}>
            {m.welcome_back()}
          </Button>
          <UpdateAnswers className="ms-auto min-w-[14rem]" onAnswered={onNext} />
        </div>
      </section>
    );
  }
  return (
    <section aria-labelledby="welcome-title" className="sondine-stagger flex flex-col gap-l">
      <h1 id="welcome-title" className="font-display font-heavy text-display-m">
        {m.usage_question()}
      </h1>
      <p>{m.usage_what()}</p>
      <SentReports className="self-start text-cte-text-muted" />
      <div className="flex flex-wrap items-center gap-xs pt-m">
        <Button variant="ghost" className="-ms-s" onClick={onBack}>
          {m.welcome_back()}
        </Button>
        <UsageAnswers
          className="ms-auto min-w-[14rem]"
          onAnswered={() => (asksForUpdates(updates) ? setStatisticsAnswered(true) : onNext())}
        />
      </div>
    </section>
  );
}

function PermissionsStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const status = useQuery(orpc.status.watch.experimental_liveOptions({ retry: true }));
  const permissions = status.data?.permissions ?? null;
  return (
    <Step
      title={m.permissions_heading()}
      onBack={onBack}
      next={<Button onClick={onNext}>{m.welcome_continue()}</Button>}
    >
      <p>{m.welcome_permissions_intro()}</p>
      {permissions === null ? (
        <p className="text-cte-text-muted">{m.permissions_waiting()}</p>
      ) : (
        <ul className="flex flex-col">
          <PermissionRow
            kind="microphone"
            icon={<MicrophoneIcon />}
            label={m.permission_microphone()}
            description={m.welcome_microphone_use()}
            permissions={permissions}
          />
          <PermissionRow
            kind="systemAudio"
            icon={<VolumeIcon />}
            label={m.permission_system_audio()}
            description={m.welcome_system_audio_use()}
            permissions={permissions}
          />
        </ul>
      )}
      <p className="text-body-s text-cte-text-muted">{m.welcome_others()}</p>
    </Step>
  );
}

function PermissionRow({
  kind,
  icon,
  label,
  description,
  permissions,
}: {
  kind: PermissionKind;
  icon: ReactNode;
  label: string;
  description: string;
  permissions: Permissions;
}) {
  const request = useMutation(orpc.permissions.request.mutationOptions());
  const offer = permissionOffer(permissions[kind]);
  return (
    <li className="flex items-start gap-s py-s inset-shadow-[0_-1px_0_0_var(--neutral-4)] last:inset-shadow-none">
      <span aria-hidden className="mt-xxs text-cte-text-muted">
        {icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-xs">
        <div className="flex items-start gap-s">
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="font-body font-medium">{label}</span>
            <span className="text-body-xs text-cte-text-muted">{description}</span>
          </div>
          {/* A quiet state when granted; otherwise what to do, in its place (Téo, 2026-11-19). */}
          {offer === "granted" ? (
            <span className="flex shrink-0 items-center gap-xxs text-body-s text-cte-text-muted">
              <CheckIcon aria-hidden />
              {m.permission_granted()}
            </span>
          ) : offer === "restricted" ? (
            <span className="shrink-0 text-body-s text-cte-text-muted">
              {m.permission_restricted()}
            </span>
          ) : (
            <Button
              variant="secondary"
              className="shrink-0"
              isPending={request.isPending}
              onClick={() => request.mutate({ kind })}
            >
              {offer === "ask" ? m.permission_grant() : m.welcome_open_settings()}
            </Button>
          )}
        </div>
        {offer === "restricted" ? (
          <p className="text-body-xs text-cte-text-muted">{m.welcome_restricted()}</p>
        ) : null}
        {request.data?.outcome === "opened-settings" ? (
          <p className="text-body-xs text-cte-text-muted">{m.permission_settings_opened()}</p>
        ) : null}
        {request.error === null ? null : (
          <p role="alert" className="text-error">
            {errorMessage(request.error)}
          </p>
        )}
      </div>
    </li>
  );
}

/**
 * « Apprendre ma voix » (ADR 034): the user reads a text so « Moi » is
 * suggested from the first day; « Passer » is as plain as « Commencer ».
 */
function VoiceStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  return (
    <section aria-labelledby="welcome-title" className="sondine-stagger flex flex-col gap-l">
      <h1 id="welcome-title" className="font-display font-heavy text-display-m">
        {m.welcome_voice_title()}
      </h1>
      <p>
        {m.welcome_voice_intro()} {m.voice_read_privacy()}
      </p>
      {/* Back on the same row as Skip and Start, as on the other steps. */}
      <VoiceReadPanel
        onSkip={onNext}
        onDone={onNext}
        leading={
          <Button variant="ghost" className="-ms-s" onClick={onBack}>
            {m.welcome_back()}
          </Button>
        }
      />
    </section>
  );
}

function StartStep({ onBack }: { onBack: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const status = useQuery(orpc.status.watch.experimental_liveOptions({ retry: true }));
  const models = useModels();
  const compute = useCompute();
  const remote = compute.data !== undefined && compute.data.destination !== "device";
  const complete = useMutation(
    orpc.onboarding.complete.mutationOptions({
      onSuccess: (result) => {
        queryClient.setQueryData(orpc.onboarding.get.queryKey(), result.onboarding);
        void navigate({ to: "/" });
      },
    }),
  );
  const notes = startNotes(
    status.data?.permissions ?? null,
    remote || (models.data !== undefined && modelsReady(models.data)),
  );
  const listening = isListening(status.data);
  return (
    <Step
      title={m.welcome_start_title()}
      onBack={onBack}
      next={
        <Button
          isPending={complete.isPending}
          onClick={() => complete.mutate({ startListening: true })}
        >
          {listening ? m.welcome_open_today() : m.welcome_start()}
        </Button>
      }
    >
      <p className="text-body-m">
        {listening ? m.welcome_already_listening() : m.welcome_start_intro()}
      </p>
      <p>{m.welcome_menu_bar()}</p>
      <ul className="flex flex-col gap-xs text-cte-text-muted">
        <li>{m.welcome_transcription_when()}</li>
        {notes.noModel ? <li>{m.welcome_no_model_note()}</li> : null}
        {notes.missing.includes("microphone") ? <li>{m.welcome_no_microphone_note()}</li> : null}
        {notes.missing.includes("systemAudio") ? <li>{m.welcome_no_system_audio_note()}</li> : null}
      </ul>
      {complete.error === null ? null : (
        <p role="alert" className="text-error">
          {errorMessage(complete.error)}
        </p>
      )}
    </Step>
  );
}

/** Listening already started (from the menu bar) before the first run ended. */
function isListening(status: Status | undefined): boolean {
  const effective = status?.listening.effective;
  return effective === "listening" || effective === "partial";
}
