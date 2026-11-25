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
import { useState } from "react";
import { CLOUD_WAITLIST_URL } from "../../../shared/cloud";
import { errorMessage, orpc } from "../../core/orpc";
import { m } from "../../paraglide/messages.js";

// Where transcription runs (ADR 040): this Mac, a machine of the user's, or
// the beta in one click. Each server asks first, saying what leaves and who
// could read it. The beta shows only in a build that knows one.

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
  full: () => m.compute_beta_full(),
  closed: () => m.compute_beta_closed(),
  busy: () => m.compute_beta_busy(),
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

function destinationOption(value: ComputeDestination, label: string, detail: string) {
  return (
    <RadioLabel className="items-start">
      <Radio value={value} className="mt-xxs" />
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
  const choose = useMutation(orpc.compute.choose.mutationOptions({ onSuccess: store }));
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
          {m.compute_beta_leave()}
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
      <BetaDialog open={asking === "beta"} current={destination} onClose={() => setAsking(null)} />
    </div>
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
  const store = useStoreStatus();
  const [link, setLink] = useState("");
  const keep = useKeepChoice();
  const connect = useMutation(
    orpc.compute.connect.mutationOptions({ onSuccess: ({ status }) => store(status) }),
  );
  const close = () => {
    // The link holds a token: it goes with the dialog.
    setLink("");
    connect.reset();
    onClose();
  };
  // Only the user's own closing: an answer that closes the dialog still finds it pending.
  const dismiss = () => {
    if (connect.isPending) keep.mutate({ destination: current });
    close();
  };
  const outcome = connect.data?.outcome;
  const problem =
    connect.error !== null
      ? errorMessage(connect.error)
      : outcome === undefined || outcome === "connected" || outcome === "cancelled"
        ? null
        : connectText[outcome]();
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) dismiss();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogTitle>{m.compute_own_confirm_title()}</AlertDialogTitle>
        <AlertDialogDescription>{m.compute_own_confirm()}</AlertDialogDescription>
        {connected ? null : (
          <form
            id="compute-connect"
            onSubmit={(event) => {
              event.preventDefault();
              connect.mutate(
                { link },
                {
                  onSuccess: ({ outcome }) => {
                    if (outcome === "connected") close();
                  },
                },
              );
            }}
          >
            <Field className="items-stretch">
              <FieldLabel>{m.compute_connect_label()}</FieldLabel>
              <Input
                value={link}
                autoComplete="off"
                spellCheck={false}
                placeholder="sondine-compute://connect?…"
                onChange={(event) => setLink(event.target.value)}
              />
            </Field>
          </form>
        )}
        {problem === null ? null : (
          <p role="alert" className="text-body-s text-error">
            {problem}
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
              disabled={link.trim() === ""}
              isPending={connect.isPending}
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
 * The beta's warning, in Téo's words (2026-11-24): who could read the audio,
 * the word given that nobody does, and whom to write to for more. One click
 * takes a place.
 */
export function BetaDialog({
  open,
  current,
  onClose,
}: {
  open: boolean;
  current: ComputeDestination;
  onClose: () => void;
}) {
  const store = useStoreStatus();
  const keep = useKeepChoice();
  const join = useMutation(
    orpc.compute.joinBeta.mutationOptions({ onSuccess: ({ status }) => store(status) }),
  );
  const close = () => {
    join.reset();
    onClose();
  };
  // Only the user's own closing: an answer that closes the dialog still finds it pending.
  const dismiss = () => {
    if (join.isPending) keep.mutate({ destination: current });
    close();
  };
  const outcome = join.data?.outcome;
  const problem =
    join.error !== null
      ? errorMessage(join.error)
      : outcome === undefined || outcome === "joined" || outcome === "cancelled"
        ? null
        : joinText[outcome]();
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) dismiss();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogTitle>{m.compute_beta_title()}</AlertDialogTitle>
        <AlertDialogDescription>{m.compute_beta_what()}</AlertDialogDescription>
        <p className="text-body-s font-medium">{m.compute_beta_honour()}</p>
        <p className="text-body-s text-cte-text-muted">{m.compute_beta_others()}</p>
        <p className="text-body-s text-cte-text-muted">
          {m.compute_beta_secure()}{" "}
          <a className="underline" href={CLOUD_WAITLIST_URL} target="_blank" rel="noreferrer">
            {m.compute_beta_write()}
          </a>
        </p>
        {problem === null ? null : (
          <p role="alert" className="text-body-s text-error">
            {problem}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogClose>{m.compute_beta_later()}</AlertDialogClose>
          <Button
            isPending={join.isPending}
            onClick={() =>
              join.mutate(
                {},
                {
                  onSuccess: ({ outcome }) => {
                    if (outcome === "joined") close();
                  },
                },
              )
            }
          >
            {m.compute_beta_use()}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
