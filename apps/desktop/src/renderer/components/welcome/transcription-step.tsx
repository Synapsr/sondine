import type { ComputeDestination, ComputeStatus } from "@sondine/api";
import { Button } from "@sondine/ui/components/button";
import {
  Popover,
  PopoverDescription,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "@sondine/ui/components/popover";
import { RadioGroup } from "@sondine/ui/components/radio-group";
import { ExternalLinkIcon, InfoIcon } from "@sondine/ui/icon";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { CLOUD_WAITLIST_URL } from "../../../shared/cloud";
import { errorMessage, orpc } from "../../core/orpc";
import { m } from "../../paraglide/messages.js";
import { ModelPanel, useModels } from "../models/model-panel";
import { modelsBusy, modelsReady, modelsTooBig } from "../models/model-view";
import { setSmallMac, useSmallMac } from "../models/small-mac";
import { useWaveFull } from "../settings/cloud-section";
import {
  BetaInviteField,
  BetaTerms,
  TrialTerms,
  destinationOption,
  OwnLinkForm,
  useChoose,
  useCompute,
  useConnectOwn,
  useJoinBeta,
} from "../settings/compute-section";
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
// small for the model shows « Ce Mac » unavailable, with why, and the cloud
// sign-up.

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
        {destinationOption(
          "device",
          m.compute_device(),
          tooBig ? m.welcome_cloud_title() : m.compute_device_detail(),
          tooBig,
        )}
        {destinationOption(
          "own",
          m.compute_own(),
          own === null
            ? m.compute_own_detail()
            : m.compute_own_connected({ name: own.name, host: own.host }),
        )}
        {beta.available || beta.joined
          ? destinationOption("beta", m.compute_beta(), m.compute_beta_detail())
          : null}
      </RadioGroup>
      {tooBig ? <CloudCard /> : null}
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
        )
      }
    >
      {status.beta.joined ? <BetaTerms joined /> : <TrialTerms />}
      {status.beta.joined ? null : <BetaInviteField value={invite} onChange={setInvite} />}
      {join.problem === null ? null : (
        <p role="alert" className="text-body-s text-error">
          {join.problem}
        </p>
      )}
    </Step>
  );
}

/**
 * A Mac too small for the local model (ADR 037): the cloud designed to keep
 * nothing is an intention, not a service. « Me prévenir » opens the sign-up
 * page in the browser, where the user leaves an e-mail (Téo, 2026-11-19), and
 * stores a flag on this Mac. The « ⓘ » says how that cloud is designed.
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
    <div className="flex flex-col gap-s">
      <p className="text-cte-text-muted">
        {m.compute_beta_secure()}{" "}
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
    </div>
  );
}

/** Development only: see the choice as a Mac too small for the model would (small-mac.ts). */
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
