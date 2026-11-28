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
import { EyeOffIcon, InfoIcon, LockIcon, ShieldIcon } from "@sondine/ui/icon";
import { useState } from "react";
import { createPortal } from "react-dom";
import { CLOUD_PRIVACY_URL } from "../../../shared/cloud";
import { errorMessage } from "../../core/orpc";
import { useLocale } from "../../i18n/locale";
import { m } from "../../paraglide/messages.js";
import { ModelPanel, useModels } from "../models/model-panel";
import { memoryAsked, modelsBusy, modelsReady, modelsTooBig } from "../models/model-view";
import { setSmallMac, useSmallMac } from "../models/small-mac";
import { useWaveFull, WaveGauge } from "../settings/cloud-section";
import {
  BetaInviteField,
  BetaTerms,
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
          <div className="flex items-start">
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
      <p>{m.compute_own_confirm()}</p>
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
  // The invite link sits beside the trial's button; its field opens in the page.
  const [inviting, setInviting] = useState(false);
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
            {status.beta.joined || inviting ? null : (
              <Button variant="ghost" onClick={() => setInviting(true)}>
                {m.compute_beta_invite_open()}
              </Button>
            )}
            <Button
              isPending={join.pending}
              disabled={!status.beta.joined && invite.trim() === "" && full}
              onClick={() =>
                join.take(() => {
                  setInvite("");
                  join.finish();
                  onNext();
                }, invite)
              }
            >
              {status.beta.joined || invite.trim() !== ""
                ? m.compute_beta_use()
                : m.compute_trial_start()}
            </Button>
          </>
        )
      }
    >
      {status.beta.joined ? <BetaTerms joined /> : <CloudOffer />}
      {status.beta.joined || !inviting ? null : (
        <BetaInviteField value={invite} onChange={setInvite} opened />
      )}
      {join.problem === null ? null : (
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
      <DialogTrigger
        variant="ghost"
        size="icon-s"
        aria-label={m.welcome_device_why()}
        className="mt-s text-cte-text-muted"
      >
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
    <RadioLabel className="sondine-cloud relative items-start overflow-hidden corner-m p-m inset-ring-[1px] inset-ring-neutral-4 has-data-checked:inset-ring-neutral-10">
      <SkySurface className="sondine-cloud-sky absolute inset-zero" />
      <Radio value="beta" className="relative mt-xxs" />
      <span className="relative flex min-w-0 flex-1 flex-col gap-xxs">
        <span className="flex items-center justify-between gap-s">
          <span className="font-medium">{m.compute_beta()}</span>
          <Badge>{m.welcome_cloud_free()}</Badge>
        </span>
        <span className="text-body-s">{m.welcome_cloud_detail()}</span>
        <span className="text-body-s">{m.compute_trial_terms()}</span>
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
  const { locale } = useLocale();
  return (
    <>
      <div className="sondine-cloud relative flex flex-col gap-xs overflow-hidden corner-l p-l">
        <SkySurface className="sondine-cloud-sky absolute inset-zero" />
        <p className="relative font-display font-heavy text-display-s">{m.welcome_cloud_offer()}</p>
        <p className="relative text-body-s">{m.compute_trial_terms()}</p>
      </div>
      <WaveGauge />
      <ul className="flex flex-col gap-xs text-body-s">
        {[
          { icon: <LockIcon />, text: m.welcome_cloud_point_sent() },
          { icon: <ShieldIcon />, text: m.welcome_cloud_point_access() },
          { icon: <EyeOffIcon />, text: m.welcome_cloud_point_word() },
        ].map(({ icon, text }) => (
          <li key={text} className="flex items-start gap-xs">
            <span aria-hidden className="mt-xxs text-cte-text-muted">
              {icon}
            </span>
            {text}
          </li>
        ))}
      </ul>
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
