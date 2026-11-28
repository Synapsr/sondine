import type {
  ComputeConnectOutcome,
  ComputeDestination,
  ComputeJoinOutcome,
  ComputeStatus,
} from "@sondine/api";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@sondine/ui/components/alert-dialog";
import { Button } from "@sondine/ui/components/button";
import { Field, FieldLabel } from "@sondine/ui/components/field";
import { Input } from "@sondine/ui/components/input";
import { Radio, RadioGroup, RadioLabel } from "@sondine/ui/components/radio-group";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ElementType } from "react";
import { CLOUD_WAITLIST_URL } from "../../../shared/cloud";
import { useWaveFull, WaveGauge } from "./cloud-section";
import { errorMessage, orpc } from "../../core/orpc";
import { m } from "../../paraglide/messages.js";

// Where transcription runs (ADR 040): this Mac, a machine of the user's, or
// the beta in one click. Each server asks first, saying what leaves and who
// could read it. The beta shows only in a build that knows one. Settings asks
// in a dialog; the first run shows the same words and the same calls in its
// page (welcome/transcription-step.tsx).

const connectText: Record<
  Exclude<ComputeConnectOutcome, "connected" | "cancelled">,
  () => string
> = {
  "bad-link": () => m.compute_connect_bad_link(),
  offline: () => m.compute_offline(),
  refused: () => m.compute_connect_refused(),
  mismatch: () => m.compute_mismatch(),
};

const joinText: Record<Exclude<ComputeJoinOutcome, "joined" | "cancelled">, () => string> = {
  "bad-link": () => m.compute_beta_bad_link(),
  refused: () => m.compute_beta_refused(),
  full: () => m.compute_beta_full(),
  closed: () => m.compute_beta_closed(),
  busy: () => m.compute_beta_busy(),
  quota: () => m.compute_beta_quota(),
  offline: () => m.compute_offline(),
  mismatch: () => m.compute_mismatch(),
};

export function useCompute() {
  return useQuery(orpc.compute.get.queryOptions());
}

/** Shows what core keeps, as each answer tells it. */
function useStoreStatus() {
  const queryClient = useQueryClient();
  return (status: ComputeStatus) =>
    void queryClient.setQueryData(orpc.compute.get.queryKey(), status);
}

/**
 * Keeps the choice in force when the user closes a dialog before the server
 * answered: core then drops that answer, and gives back the place it took.
 */
function useKeepChoice() {
  const queryClient = useQueryClient();
  const store = useStoreStatus();
  return useMutation(
    orpc.compute.choose.mutationOptions({
      onSuccess: store,
      onError: () => queryClient.invalidateQueries({ queryKey: orpc.compute.get.queryKey() }),
    }),
  );
}

/** Chooses this Mac, or a server already agreed to, which sends nothing new. */
export function useChoose() {
  return useMutation(orpc.compute.choose.mutationOptions({ onSuccess: useStoreStatus() }));
}

export function destinationOption(
  value: ComputeDestination,
  label: string,
  detail: string,
  disabled = false,
) {
  return (
    <RadioLabel className="items-start">
      <Radio value={value} disabled={disabled} className="mt-xxs" />
      <span className="flex flex-col">
        <span>{label}</span>
        <span className="text-body-s text-cte-text-muted">{detail}</span>
      </span>
    </RadioLabel>
  );
}

export function ComputeSection() {
  const store = useStoreStatus();
  const compute = useCompute();
  const [asking, setAsking] = useState<"own" | "beta" | null>(null);
  const choose = useChoose();
  const disconnect = useMutation(orpc.compute.disconnect.mutationOptions({ onSuccess: store }));
  const leave = useMutation(orpc.compute.leaveBeta.mutationOptions({ onSuccess: store }));
  const status = compute.data;
  if (status === undefined) {
    return (
      <p className={compute.isError ? "text-error" : "text-cte-text-muted"}>
        {compute.isError ? errorMessage(compute.error) : m.loading()}
      </p>
    );
  }
  const { destination, own, beta } = status;
  const error = choose.error ?? disconnect.error ?? leave.error;
  return (
    <div className="flex max-w-[40rem] flex-col gap-s">
      <RadioGroup<ComputeDestination>
        aria-label={m.compute_title()}
        value={destination}
        disabled={choose.isPending || disconnect.isPending || leave.isPending}
        onValueChange={(next) => {
          if (next === destination) return;
          if (next === "device") choose.mutate({ destination: next });
          else setAsking(next);
        }}
      >
        {destinationOption("device", m.compute_device(), m.compute_device_detail())}
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
      {own === null ? null : (
        <Button
          variant="ghost"
          className="-ms-s self-start"
          isPending={disconnect.isPending}
          onClick={() => disconnect.mutate({})}
        >
          {m.compute_own_forget()}
        </Button>
      )}
      {beta.joined ? (
        <Button
          variant="ghost"
          className="-ms-s self-start"
          isPending={leave.isPending}
          onClick={() => leave.mutate({})}
        >
          {m.compute_cloud_disconnect()}
        </Button>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="text-body-s text-error">
          {errorMessage(error)}
        </p>
      )}
      <OwnDialog
        open={asking === "own"}
        current={destination}
        connected={own !== null}
        onChoose={() => choose.mutate({ destination: "own" })}
        onClose={() => setAsking(null)}
      />
      <BetaDialog
        open={asking === "beta"}
        current={destination}
        joined={beta.joined}
        onClose={() => setAsking(null)}
      />
    </div>
  );
}

/**
 * Connecting the user's machine with the link it printed (ADR 040). `leave`
 * is the user going away before the answer: the choice in force stays.
 */
export function useConnectOwn(current: ComputeDestination) {
  const store = useStoreStatus();
  const [link, setLink] = useState("");
  const keep = useKeepChoice();
  const connect = useMutation(
    orpc.compute.connect.mutationOptions({ onSuccess: ({ status }) => store(status) }),
  );
  const outcome = connect.data?.outcome;
  const problem =
    connect.error !== null
      ? errorMessage(connect.error)
      : outcome === undefined || outcome === "connected" || outcome === "cancelled"
        ? null
        : connectText[outcome]();
  return {
    link,
    setLink,
    pending: connect.isPending,
    problem,
    submit(onConnected: () => void) {
      connect.mutate(
        { link },
        {
          onSuccess: (answer) => {
            if (answer.outcome === "connected") onConnected();
          },
        },
      );
    },
    /** After the answer. The link holds a token: it goes with the page or the dialog. */
    finish() {
      setLink("");
      connect.reset();
    },
    /** The user's own leaving; an answer that ends the dialog still finds it pending. */
    leave() {
      if (connect.isPending) keep.mutate({ destination: current });
      setLink("");
      connect.reset();
    },
  };
}

/** The link field; its form is submitted by a button that names `id`. */
export function OwnLinkForm({
  id,
  connect,
  onConnected,
}: {
  id: string;
  connect: ReturnType<typeof useConnectOwn>;
  onConnected: () => void;
}) {
  return (
    <form
      id={id}
      onSubmit={(event) => {
        event.preventDefault();
        connect.submit(onConnected);
      }}
    >
      <Field className="items-stretch">
        <FieldLabel>{m.compute_connect_label()}</FieldLabel>
        <Input
          value={connect.link}
          autoComplete="off"
          spellCheck={false}
          placeholder="sondine-compute://connect?…"
          onChange={(event) => connect.setLink(event.target.value)}
        />
      </Field>
    </form>
  );
}

/** What leaves, then the link the machine printed, unless it is connected already. */
function OwnDialog({
  open,
  current,
  connected,
  onChoose,
  onClose,
}: {
  open: boolean;
  current: ComputeDestination;
  connected: boolean;
  onChoose: () => void;
  onClose: () => void;
}) {
  const connect = useConnectOwn(current);
  const close = () => {
    connect.finish();
    onClose();
  };
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        connect.leave();
        onClose();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogTitle>{m.compute_own_confirm_title()}</AlertDialogTitle>
        <AlertDialogDescription>{m.compute_own_confirm()}</AlertDialogDescription>
        {connected ? null : (
          <OwnLinkForm id="compute-connect" connect={connect} onConnected={close} />
        )}
        {connect.problem === null ? null : (
          <p role="alert" className="text-body-s text-error">
            {connect.problem}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogClose>{m.cancel()}</AlertDialogClose>
          {connected ? (
            <Button
              onClick={() => {
                onChoose();
                close();
              }}
            >
              {m.compute_own_use()}
            </Button>
          ) : (
            <Button
              type="submit"
              form="compute-connect"
              disabled={connect.link.trim() === ""}
              isPending={connect.pending}
            >
              {m.compute_connect()}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/**
 * Taking one of the beta's places (ADR 040). `leave` is the user going away
 * before the answer: the choice in force stays, and core gives the place back.
 */
export function useJoinBeta(current: ComputeDestination) {
  const store = useStoreStatus();
  const keep = useKeepChoice();
  const join = useMutation(
    orpc.compute.joinBeta.mutationOptions({ onSuccess: ({ status }) => store(status) }),
  );
  const outcome = join.data?.outcome;
  const problem =
    join.error !== null
      ? errorMessage(join.error)
      : outcome === undefined || outcome === "joined" || outcome === "cancelled"
        ? null
        : joinText[outcome]();
  return {
    pending: join.isPending,
    problem,
    take(onJoined: () => void, invite?: string) {
      const trimmed = invite?.trim() ?? "";
      join.mutate(trimmed === "" ? {} : { link: trimmed }, {
        onSuccess: (answer) => {
          if (answer.outcome === "joined") onJoined();
        },
      });
    },
    /** After the answer. */
    finish() {
      join.reset();
    },
    /** The user's own leaving; an answer that ends the dialog still finds it pending. */
    leave() {
      if (join.isPending) keep.mutate({ destination: current });
      join.reset();
    },
  };
}

/**
 * The Cloud's warning, in Téo's words (2026-11-24): who could read the audio,
 * the word given that nobody does, and whom to write to for more. Before a
 * place is taken, the wave's gauge and the trial's terms come first (ADR 047).
 * `Lead` holds the first paragraph: the dialog's description, or a plain one.
 */
export function BetaTerms({ Lead = "p", joined }: { Lead?: ElementType; joined: boolean }) {
  return (
    <>
      {joined ? null : <WaveGauge />}
      <Lead>{m.compute_beta_what()}</Lead>
      <p className="text-body-s font-medium">{m.compute_beta_honour()}</p>
      <p className="text-body-s text-cte-text-muted">{m.compute_beta_others()}</p>
      {joined ? null : <p className="text-body-s font-medium">{m.compute_trial_terms()}</p>}
      <p className="text-body-s text-cte-text-muted">
        {m.compute_beta_secure()}{" "}
        <a className="underline" href={CLOUD_WAITLIST_URL} target="_blank" rel="noreferrer">
          {m.compute_beta_write()}
        </a>
      </p>
    </>
  );
}

/**
 * Optional invite link or raw token for invite-only Cloud waves (Settings and
 * first run), behind a link: most people take the trial, and have none.
 * `opened`: the link is elsewhere (the first run's, beside its button).
 */
export function BetaInviteField({
  value,
  onChange,
  opened = false,
}: {
  value: string;
  onChange: (value: string) => void;
  opened?: boolean;
}) {
  const [open, setOpen] = useState(value !== "");
  if (!open && !opened) {
    return (
      <Button variant="ghost" className="-ms-s self-start" onClick={() => setOpen(true)}>
        {m.compute_beta_invite_open()}
      </Button>
    );
  }
  return (
    <Field className="items-stretch">
      <FieldLabel>{m.compute_beta_invite_label()}</FieldLabel>
      <Input
        value={value}
        autoComplete="off"
        spellCheck={false}
        placeholder="sondine-compute://connect?…"
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

/** The beta's terms; one click takes a place, or connects an invite link/code. */
export function BetaDialog({
  open,
  current,
  joined = false,
  onClose,
}: {
  open: boolean;
  current: ComputeDestination;
  joined?: boolean;
  onClose: () => void;
}) {
  const join = useJoinBeta(current);
  const [invite, setInvite] = useState("");
  const full = useWaveFull(open && !joined);
  const close = () => {
    setInvite("");
    join.finish();
    onClose();
  };
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        setInvite("");
        join.leave();
        onClose();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogTitle>{m.compute_beta_title()}</AlertDialogTitle>
        <BetaTerms Lead={AlertDialogDescription} joined={joined} />
        {joined ? null : <BetaInviteField value={invite} onChange={setInvite} />}
        {join.problem === null ? null : (
          <p role="alert" className="text-body-s text-error">
            {join.problem}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogClose>{m.compute_beta_later()}</AlertDialogClose>
          <Button
            isPending={join.pending}
            disabled={!joined && invite.trim() === "" && full}
            onClick={() => join.take(close, invite)}
          >
            {joined || invite.trim() !== "" ? m.compute_beta_use() : m.compute_trial_start()}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
