import type { ComputeDestination, ComputeStatus } from "@sondine/api";
import { Button } from "@sondine/ui/components/button";
import { Badge } from "@sondine/ui/components/badge";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@sondine/ui/components/dialog";
import { Radio, RadioGroup, RadioLabel } from "@sondine/ui/components/radio-group";
import {
  ExternalLinkIcon,
  EyeOffIcon,
  InfoIcon,
  LockIcon,
  ShieldIcon,
  type IconProps,
} from "@sondine/ui/icon";
import { useState, type ComponentType } from "react";
import { createPortal } from "react-dom";
import { CLOUD_PRIVACY_URL, COMPUTE_GUIDE_URL } from "../../../shared/cloud";
import { errorMessage } from "../../core/orpc";
import { useLocale } from "../../i18n/locale";
import { m } from "../../paraglide/messages.js";
import { ModelPanel, useModels } from "../models/model-panel";
import { memoryAsked, modelsBusy, modelsReady, modelsTooBig } from "../models/model-view";
import { setSmallMac, useSmallMac } from "../models/small-mac";
import { useWaveFull, WaveGauge } from "../settings/cloud-section";
import {
  BetaInviteField,
  destinationOption,
  OwnLinkForm,
  useChoose,
  useCompute,
  useConnectOwn,
  useJoinBeta,
} from "../settings/compute-section";
import { SkySurface } from "./sky-surface";
import { Step } from "./step";
import {
  firstPick,
  modelStepContinues,
  serverAction,
  type TranscriptionScreen,
} from "./welcome-steps";

// The first run's transcription step (ADR 037, ADR 040), in two screens:
// where to transcribe, one line per place, then what that place asks for.
// This Mac shows what the model needs and its download; a server shows what
// leaves and who could read it, as Settings' dialogs say it, and nothing
// leaves before its button. « Retour » goes back to the choice. A Mac too
// small for the model shows « Ce Mac » unavailable, and why on demand. The
// Cloud is a card of its own, its terms in it (Téo, 2026-11-28).

export function TranscriptionStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const compute = useCompute();
  const [screen, setScreen] = useState<TranscriptionScreen>("choice");
  const status = compute.data;
  if (status === undefined) {
    return (
      <Step title={m.welcome_where_title()} onBack={onBack} next={null}>
        <p className={compute.isError ? "text-error" : "text-cte-text-muted"}>
          {compute.isError ? errorMessage(compute.error) : m.loading()}
        </p>
      </Step>
    );
  }
  const choice = () => setScreen("choice");
  switch (screen) {
    case "choice":
      return <ChoiceScreen status={status} onBack={onBack} onOpen={setScreen} onSkip={onNext} />;
    case "device":
      return <DeviceScreen onBack={choice} onNext={onNext} />;
    case "own":
      return <OwnScreen status={status} onBack={choice} onNext={onNext} />;
    case "beta":
      return <BetaScreen status={status} onBack={choice} onNext={onNext} />;
  }
}

/** Only the question: one line per place, nothing downloaded or sent yet. */
function ChoiceScreen({
  status,
  onBack,
  onOpen,
  onSkip,
}: {
  status: ComputeStatus;
  onBack: () => void;
  onOpen: (screen: ComputeDestination) => void;
  onSkip: () => void;
}) {
  const models = useModels();
  const choose = useChoose();
  const tooBig = models.data !== undefined && modelsTooBig(models.data);
  const [picked, setPicked] = useState<ComputeDestination | null>(null);
  const shown = picked ?? firstPick(status.destination, tooBig);
  const { own, beta } = status;
  return (
    <Step
      title={m.welcome_where_title()}
      onBack={onBack}
      next={
        shown === null ? (
          <Button variant="secondary" onClick={onSkip}>
            {m.welcome_without_model()}
          </Button>
        ) : (
          <Button
            onClick={() => {
              // This Mac sends nothing: no consent to ask.
              if (shown === "device" && status.destination !== "device") {
                choose.mutate({ destination: "device" });
              }
              onOpen(shown);
            }}
          >
            {m.welcome_continue()}
          </Button>
        )
      }
    >
      <RadioGroup<ComputeDestination | null>
        aria-labelledby="welcome-title"
        className="w-full"
        value={shown}
        onValueChange={(next) => setPicked(next)}
      >
        {tooBig && models.data !== undefined ? (
          <div className="flex items-center">
            <span className="min-w-0 flex-1">
              {destinationOption("device", m.compute_device(), m.welcome_cloud_title(), true)}
            </span>
            <DeviceWhy {...memoryAsked(models.data)} />
          </div>
        ) : (
          destinationOption("device", m.compute_device(), m.compute_device_detail())
        )}
        {destinationOption(
          "own",
          m.compute_own(),
          own === null
            ? m.compute_own_detail()
            : m.compute_own_connected({ name: own.name, host: own.host }),
        )}
        {beta.available || beta.joined ? <CloudOption /> : null}
      </RadioGroup>
      {import.meta.env.DEV ? <SmallMacSwitch /> : null}
    </Step>
  );
}

/** What the model needs on this Mac, and its download. */
function DeviceScreen({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const models = useModels();
  const ready = models.data !== undefined && modelsReady(models.data);
  const busy = models.data !== undefined && modelsBusy(models.data);
  const continues = modelStepContinues(ready, busy);
  return (
    <Step
      title={m.compute_device()}
      onBack={onBack}
      next={
        <Button variant={continues === "continue" ? "primary" : "secondary"} onClick={onNext}>
          {continues === "continue" ? m.welcome_continue() : m.welcome_without_model()}
        </Button>
      }
    >
      <p className="text-cte-text-muted">{m.welcome_model_intro()}</p>
      <ModelPanel />
      {busy ? <p className="text-cte-text-muted">{m.welcome_model_continues()}</p> : null}
    </Step>
  );
}

/** What leaves for the user's machine, then the link it printed. */
function OwnScreen({
  status,
  onBack,
  onNext,
}: {
  status: ComputeStatus;
  onBack: () => void;
  onNext: () => void;
}) {
  const connect = useConnectOwn(status.destination);
  const choose = useChoose();
  const action = serverAction("own", status.destination, status.own !== null);
  const problem = connect.problem ?? (choose.error === null ? null : errorMessage(choose.error));
  return (
    <Step
      title={m.compute_own()}
      onBack={() => {
        connect.leave();
        onBack();
      }}
      next={
        action === "continue" ? (
          <Button onClick={onNext}>{m.welcome_continue()}</Button>
        ) : action === "use" ? (
          <Button
            isPending={choose.isPending}
            onClick={() => choose.mutate({ destination: "own" }, { onSuccess: onNext })}
          >
            {m.compute_own_use()}
          </Button>
        ) : (
          <Button
            type="submit"
            form="welcome-connect"
            disabled={connect.link.trim() === ""}
            isPending={connect.pending}
          >
            {m.compute_connect()}
          </Button>
        )
      }
    >
      <Points
        points={[
          { Icon: LockIcon, text: m.welcome_own_point_sent() },
          { Icon: ShieldIcon, text: m.welcome_own_point_access() },
          { Icon: InfoIcon, text: m.welcome_own_point_back() },
        ]}
      />
      {status.own === null ? (
        <a
          className="flex items-center gap-xxs self-start text-body-s underline"
          href={COMPUTE_GUIDE_URL}
          target="_blank"
          rel="noreferrer"
        >
          {m.welcome_own_guide()}
          <ExternalLinkIcon aria-hidden />
        </a>
      ) : null}
      {status.own === null ? (
        <OwnLinkForm
          id="welcome-connect"
          connect={connect}
          onConnected={() => {
            connect.finish();
            onNext();
          }}
        />
      ) : (
        <p className="text-cte-text-muted">
          {m.compute_own_connected({ name: status.own.name, host: status.own.host })}
        </p>
      )}
      {problem === null ? null : (
        <p role="alert" className="text-body-s text-error">
          {problem}
        </p>
      )}
    </Step>
  );
}

/** The Cloud terms in the page; « Essayer 60 min gratuites » takes a place, or connects an invite. */
function BetaScreen({
  status,
  onBack,
  onNext,
}: {
  status: ComputeStatus;
  onBack: () => void;
  onNext: () => void;
}) {
  const join = useJoinBeta(status.destination);
  const [invite, setInvite] = useState("");
  // The invite link sits beside the trial's button; its field opens in a dialog.
  const [inviting, setInviting] = useState(false);
  const take = () =>
    join.take(() => {
      setInvite("");
      setInviting(false);
      join.finish();
      onNext();
    }, invite);
  const full = useWaveFull(!status.beta.joined);
  const action = serverAction("beta", status.destination, status.own !== null);
  return (
    <Step
      title={m.compute_beta_title()}
      onBack={() => {
        setInvite("");
        join.leave();
        onBack();
      }}
      next={
        action === "continue" ? (
          <Button onClick={onNext}>{m.welcome_continue()}</Button>
        ) : (
          <>
            {status.beta.joined ? null : (
              <Button variant="outline" onClick={() => setInviting(true)}>
                {m.compute_beta_invite_open()}
              </Button>
            )}
            <Button
              isPending={join.pending && !inviting}
              disabled={!status.beta.joined && full}
              onClick={() => {
                setInvite("");
                join.take(() => {
                  join.finish();
                  onNext();
                }, "");
              }}
            >
              {status.beta.joined ? m.compute_beta_use() : m.compute_trial_start()}
            </Button>
          </>
        )
      }
    >
      {status.beta.joined ? <CloudPoints /> : <CloudOffer />}
      <Dialog
        open={inviting}
        onOpenChange={(open) => {
          if (!open) setInviting(false);
        }}
      >
        <DialogPopup className="w-[min(28rem,calc(100vw-var(--space-xl)))]">
          <DialogTitle>{m.compute_beta_invite_open()}</DialogTitle>
          <BetaInviteField value={invite} onChange={setInvite} opened />
          {join.problem === null ? null : (
            <p role="alert" className="text-body-s text-error">
              {join.problem}
            </p>
          )}
          <DialogFooter>
            <DialogClose>{m.usage_close()}</DialogClose>
            <Button isPending={join.pending} disabled={invite.trim() === ""} onClick={take}>
              {m.compute_beta_use()}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      {join.problem === null || inviting ? null : (
        <p role="alert" className="text-body-s text-error">
          {join.problem}
        </p>
      )}
    </Step>
  );
}

/** Why this Mac cannot transcribe well, and that it may later (Téo, 2026-11-28). */
function DeviceWhy({ needed, memory }: { needed: number; memory: number }) {
  return (
    <Dialog>
      <DialogTrigger variant="secondary" size="icon" aria-label={m.welcome_device_why()}>
        <InfoIcon />
      </DialogTrigger>
      <DialogPopup className="w-[min(28rem,calc(100vw-var(--space-xl)))]">
        <DialogTitle>{m.welcome_device_why()}</DialogTitle>
        <DialogDescription>
          {m.welcome_device_why_detail({ needed: String(needed), memory: String(memory) })}
        </DialogDescription>
        <DialogFooter>
          <DialogClose>{m.usage_close()}</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * Sondine Cloud, a card apart from the other places: the site's moving sky
 * under its terms (Téo, 2026-11-28).
 */
function CloudOption() {
  return (
    <RadioLabel className="sondine-cloud relative items-start overflow-hidden corner-m p-m shadow-s inset-ring-[1px] inset-ring-neutral-4-transparent has-data-checked:inset-ring-neutral-10">
      <SkySurface className="sondine-cloud-sky absolute inset-zero" />
      <Radio value="beta" className="relative mt-xxs" />
      <span className="relative flex min-w-0 flex-1 flex-col gap-xxs">
        <span className="flex items-center justify-between gap-s">
          <span className="font-display font-heavy text-body-m">{m.compute_beta()}</span>
          <Badge>{m.welcome_cloud_free()}</Badge>
        </span>
        <span className="text-body-s">{m.welcome_cloud_detail()}</span>
      </span>
    </RadioLabel>
  );
}

/**
 * Development only: see the choice as a Mac too small for the model would
 * (small-mac.ts). Out of the step's layout, in the window's bottom left
 * corner (Téo, 2026-11-28).
 */
function SmallMacSwitch() {
  const on = useSmallMac();
  return createPortal(
    <Button
      variant="ghost"
      className="fixed start-l bottom-l z-[100] text-body-xs text-cte-text-muted"
      onClick={() => setSmallMac(!on)}
    >
      {on ? "Dev : revenir à ce Mac" : "Dev : simuler un Mac de 16 Go"}
    </Button>,
    document.body,
  );
}

/**
 * The first run's Cloud, before a place is taken (ADR 047; Téo, 2026-11-28:
 * fewer words, the sky): the offer on the sky, then what leaves, who could
 * read it and the word given (ADR 040), one short line each, and the rest on
 * the site. Settings' dialog keeps the whole text.
 */
function CloudOffer() {
  return (
    <>
      <div className="sondine-cloud relative flex flex-col gap-xs overflow-hidden corner-l p-l">
        <SkySurface className="sondine-cloud-sky absolute inset-zero" />
        <p className="relative font-display font-heavy text-display-s">{m.welcome_cloud_offer()}</p>
        <p className="relative text-body-s">{m.compute_trial_terms()}</p>
        {/* On the sky, the gauge's share in the card's own color, as legible as the rest. */}
        <div className="relative pt-s **:data-[slot=meter-value]:text-current">
          <WaveGauge />
        </div>
      </div>
      <CloudPoints />
    </>
  );
}

/** What leaves for the Cloud, who could read it and the word given (ADR 040), then the rest on the site. */
function CloudPoints() {
  const { locale } = useLocale();
  return (
    <>
      <Points
        points={[
          { Icon: LockIcon, text: m.welcome_cloud_point_sent() },
          { Icon: ShieldIcon, text: m.welcome_cloud_point_access() },
          { Icon: EyeOffIcon, text: m.welcome_cloud_point_word() },
        ]}
      />
      <a
        className="self-start text-body-s text-cte-text-muted underline"
        href={locale === "fr" ? CLOUD_PRIVACY_URL.fr : CLOUD_PRIVACY_URL.en}
        target="_blank"
        rel="noreferrer"
      >
        {m.compute_trial_privacy()}
      </a>
    </>
  );
}

/** A server's terms, one short line each beside its icon (Téo, 2026-11-28). */
function Points({
  points,
}: {
  points: readonly { readonly Icon: ComponentType<IconProps>; readonly text: string }[];
}) {
  return (
    <ul className="flex flex-col gap-xs text-body-s">
      {points.map(({ Icon, text }) => (
        <li key={text} className="flex items-center gap-s">
          <span
            aria-hidden
            className="flex size-[2.25rem] shrink-0 items-center justify-center corner-full bg-neutral-3 text-body-l text-cte-text-muted"
          >
            <Icon />
          </span>
          {text}
        </li>
      ))}
    </ul>
  );
}
