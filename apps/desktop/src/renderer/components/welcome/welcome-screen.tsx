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
  Popover,
  PopoverDescription,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "@sondine/ui/components/popover";
import {
  CheckIcon,
  ClockIcon,
  ExternalLinkIcon,
  InfoIcon,
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
import { CLOUD_WAITLIST_URL } from "../../../shared/cloud";
import { ModelPanel, useModels } from "../models/model-panel";
import { setSmallMac, useSmallMac } from "../models/small-mac";
import { asksForUpdates } from "../updates/update-view";
import { UpdateAnswers, useUpdates } from "../updates/updates";
import { SentReports, UsageAnswers } from "../usage/usage";
import { VoiceReadPanel } from "../voice-read/voice-read-panel";
import { ComputeSection, useCompute } from "../settings/compute-section";
import { modelsBusy, modelsReady, modelsTooBig } from "../models/model-view";
import {
  modelStepContinues,
  nextStep,
  permissionOffer,
  previousStep,
  startNotes,
  stepIndex,
  WELCOME_STEPS,
} from "./welcome-steps";

// The first run (`/welcome`, ADR 037), shown until it is completed: what the
// user wants to find again, whether to share anonymous statistics (ADR 042),
// the permissions, the model (with the cloud card
// on a Mac too small for it), the voice read, then starting. Nothing is
// recorded before « Commencer l'écoute »: a fresh install keeps listening
// paused until then. Each step is saved as it shows, so a relaunch after a
// permission prompt comes back to it. The voice read and the model are
// optional; the read records only while the user reads, and never becomes a
// memory (ADR 034). Each step's parts rise in one after the other; going to
// another step, the one left slides away blurred (Téo, 2026-11-19).

export function WelcomeScreen() {
  const onboarding = useQuery(orpc.onboarding.get.queryOptions());
  const queryClient = useQueryClient();
  const advance = useMutation(orpc.onboarding.advance.mutationOptions());
  const [step, setStep] = useState<OnboardingStep | null>(null);
  // After a change of step, the next one waits for the one left to be mostly gone.
  const [moved, setMoved] = useState(false);
  const shown = step ?? onboarding.data?.step ?? "welcome";
  const go = (next: OnboardingStep | null, goal?: OnboardingGoal) => {
    if (next === null) return;
    // The step left slides away blurred, toward where the user goes (renderer/styles.css).
    const change = () =>
      flushSync(() => {
        setStep(next);
        setMoved(true);
      });
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (calm || typeof document.startViewTransition !== "function") change();
    else {
      document.startViewTransition({
        update: change,
        types: [stepIndex(next) > stepIndex(shown) ? "step-forward" : "step-back"],
      });
    }
    advance.mutate(
      { step: next, ...(goal === undefined ? {} : { goal }) },
      { onSuccess: (status) => queryClient.setQueryData(orpc.onboarding.get.queryKey(), status) },
    );
  };

  return (
    <div className="relative flex min-h-dvh flex-col items-center bg-cte-canvas px-l pt-xxl text-cte-text">
      {/* No title bar: the top edge drags the window. */}
      <div
        aria-hidden
        className="absolute inset-x-zero top-zero h-[2.5rem] [-webkit-app-region:drag]"
      />
      {/* The steps stay at the top, the width of the column, whatever the step's height (Téo, 2026-11-19). */}
      <ol
        aria-label={m.welcome_progress({
          step: String(stepIndex(shown) + 1),
          count: String(WELCOME_STEPS.length),
        })}
        className="flex w-full max-w-[30rem] gap-xxs"
      >
        {WELCOME_STEPS.map((candidate, index) => (
          <li
            key={candidate}
            aria-current={candidate === shown ? "step" : undefined}
            className={cn(
              "h-xxs flex-1 corner-full transition-[background-color] duration-motion ease-motion motion-reduce:transition-none",
              candidate === shown
                ? "bg-color-1"
                : index < stepIndex(shown)
                  ? "bg-neutral-8"
                  : "bg-neutral-4",
            )}
          />
        ))}
      </ol>
      {/* The step in the middle of what is left, both ways; a tall step scrolls from the top. */}
      <div
        className={cn(
          "my-auto flex w-full max-w-[30rem] flex-col gap-xl py-xl [view-transition-name:welcome-step]",
          moved && "[--stagger-offset:160ms]",
        )}
      >
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
          <ModelStep onBack={() => go(previousStep(shown))} onNext={() => go(nextStep(shown))} />
        ) : null}
        {shown === "start" ? <StartStep onBack={() => go(previousStep(shown))} /> : null}
      </div>
    </div>
  );
}

function Step({
  title,
  children,
  onBack,
  next,
}: {
  title: string;
  children: ReactNode;
  onBack?: () => void;
  next: ReactNode;
}) {
  return (
    <section aria-labelledby="welcome-title" className="sondine-stagger flex flex-col gap-l">
      <h1 id="welcome-title" className="font-display font-heavy text-display-m">
        {title}
      </h1>
      {children}
      {/* Back on the left, the way forward on the right. */}
      <div className="flex items-center gap-xs pt-m">
        {onBack === undefined ? null : (
          <Button variant="ghost" className="-ms-s" onClick={onBack}>
            {m.welcome_back()}
          </Button>
        )}
        <span className="ms-auto flex items-center gap-xs">{next}</span>
      </div>
    </section>
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
                "transition-[background-color,box-shadow] duration-motion ease-motion motion-reduce:transition-none",
                "control-hover:bg-neutral-2",
                goal === card.goal ? "ring-neutral-10" : "ring-neutral-4",
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

function ModelStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const models = useModels();
  const compute = useCompute();
  const remote = compute.data !== undefined && compute.data.destination !== "device";
  const ready = remote || (models.data !== undefined && modelsReady(models.data));
  const busy = models.data !== undefined && modelsBusy(models.data);
  const continues = modelStepContinues(ready, busy);
  const tooBig = models.data !== undefined && modelsTooBig(models.data);
  return (
    <Step
      title={m.welcome_model_title()}
      onBack={onBack}
      next={
        <Button variant={continues === "continue" ? "primary" : "secondary"} onClick={onNext}>
          {continues === "continue" ? m.welcome_continue() : m.welcome_without_model()}
        </Button>
      }
    >
      {/* Too small a Mac: no download to offer, only what comes next (Téo, 2026-11-19). */}
      {remote ? (
        <ComputeSection />
      ) : tooBig ? (
        <CloudCard />
      ) : (
        <>
          <p className="text-cte-text-muted">{m.welcome_model_intro()}</p>
          <ModelPanel />
          {busy ? <p className="text-cte-text-muted">{m.welcome_model_continues()}</p> : null}
        </>
      )}
      {import.meta.env.DEV ? <SmallMacSwitch /> : null}
    </Step>
  );
}

/** Development only: see this step as a Mac too small for the model would (small-mac.ts). */
function SmallMacSwitch() {
  const on = useSmallMac();
  return (
    <Button
      variant="ghost"
      className="-ms-s self-start text-body-xs text-cte-text-muted"
      onClick={() => setSmallMac(!on)}
    >
      {on ? "Dev : revenir à ce Mac" : "Dev : simuler un Mac de 16 Go"}
    </Button>
  );
}

/**
 * A Mac too small for the local model (ADR 037): an intention, not a
 * service, so it says what is planned, never that it is there. « Me
 * prévenir » opens the sign-up page in the browser, where the user leaves
 * an e-mail (Téo, 2026-11-19), and stores a flag on this Mac. The « ⓘ »
 * says how the cloud is designed. Below, the servers that exist (ADR 040): a
 * machine of the user's, and the beta in a build that knows one.
 */
function CloudCard() {
  const queryClient = useQueryClient();
  const onboarding = useQuery(orpc.onboarding.get.queryOptions());
  const advance = useMutation(
    orpc.onboarding.advance.mutationOptions({
      onSuccess: (status) => queryClient.setQueryData(orpc.onboarding.get.queryKey(), status),
    }),
  );
  const asked = onboarding.data?.cloudNotify === true;
  return (
    <div className="flex flex-col gap-m">
      <p className="text-body-m">
        {m.welcome_cloud_title()}{" "}
        <Popover>
          <PopoverTrigger
            variant="ghost"
            size="icon-s"
            aria-label={m.welcome_cloud_how()}
            className="align-middle text-cte-text-muted"
          >
            <InfoIcon />
          </PopoverTrigger>
          <PopoverPopup className="w-[20rem] gap-xs">
            <PopoverTitle>{m.welcome_cloud_how()}</PopoverTitle>
            <PopoverDescription>{m.welcome_cloud_how_detail()}</PopoverDescription>
          </PopoverPopup>
        </Popover>
      </p>
      {/* The page asks for an e-mail; Sondine sends nothing itself (shared/cloud.ts). */}
      <Button
        variant="secondary"
        className="self-start"
        nativeButton={false}
        render={<a href={CLOUD_WAITLIST_URL} target="_blank" rel="noreferrer" />}
        onClick={() => {
          if (!asked) advance.mutate({ step: onboarding.data?.step ?? "model", cloudNotify: true });
        }}
      >
        {m.welcome_cloud_notify()}
        <ExternalLinkIcon />
      </Button>
      {/* Each server says what leaves before anything does. */}
      <ComputeSection />
    </div>
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
