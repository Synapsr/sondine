import type { PhoneDeviceState, PhonePairing, PhoneStatus } from "@sondine/api";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@sondine/ui/components/alert-dialog";
import { Button } from "@sondine/ui/components/button";
import {
  Dialog,
  DialogCornerClose,
  DialogDescription,
  DialogFooter,
  DialogPopup,
  DialogTitle,
} from "@sondine/ui/components/dialog";
import { QrCode } from "@sondine/ui/components/qr-code";
import { Switch, SwitchLabel } from "@sondine/ui/components/switch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { errorMessage, orpc } from "../../core/orpc";
import { dayClock } from "../../lib/labels";
import { m } from "../../paraglide/messages.js";

// Settings ▸ Téléphone (ADR 008): whether paired iPhones sync with this Mac
// (off: the relay is stopped and nothing listens), the phones with their
// last contact and counts of what they did, never the words; pairing by a
// QR and six digits; Tailscale as a second path; and a reset that takes a
// new key and revokes every phone.

/** How often the phones' last contact reads again while Settings is open. */
const REFRESH_MS = 5_000;
/** While pairing: the QR appears once the relay listens, the digits once a phone asks. */
const PAIRING_REFRESH_MS = 1_000;

/** « À l'instant », « Il y a 5 min », « Il y a 3 h », then the day and hour. */
function contactLabel(atMs: number | null, nowMs: number): string {
  if (atMs === null) return m.settings_phone_never();
  const minutes = Math.floor((nowMs - atMs) / 60_000);
  if (minutes < 1) return m.settings_phone_now();
  if (minutes < 60) return m.settings_phone_minutes_ago({ minutes });
  if (minutes < 12 * 60) return m.settings_phone_hours_ago({ hours: Math.floor(minutes / 60) });
  return dayClock(atMs, nowMs);
}

/** How its last request came: « à la maison » or « par Tailscale » (nothing for development's loopback). */
function viaLabel(phone: PhoneDeviceState): string | null {
  if (phone.lastContactAtMs === null) return null;
  if (phone.lastVia === "lan") return m.settings_phone_via_lan();
  if (phone.lastVia === "tailnet") return m.settings_phone_via_tailnet();
  return null;
}

/** « 4:59 » left until `untilMs`. */
function countdown(untilMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.ceil((untilMs - nowMs) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function PhoneRow({
  phone,
  nowMs,
  pending,
  onRevoke,
}: {
  phone: PhoneDeviceState;
  nowMs: number;
  pending: boolean;
  onRevoke: () => void;
}) {
  const revoked = phone.revokedAtMs !== null;
  const via = revoked ? null : viaLabel(phone);
  return (
    <li className="flex items-center gap-m py-xs">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-body font-medium">{phone.name}</span>
        <span className="truncate text-body-s text-cte-text-muted">
          {revoked ? m.settings_phone_revoked() : contactLabel(phone.lastContactAtMs, nowMs)}
          {via === null ? null : `, ${via}`}
          {" · "}
          <span className="tabular-nums">
            {m.settings_phone_uploads({ count: phone.uploads })} ·{" "}
            {m.settings_phone_reads({ count: phone.reads })} ·{" "}
            {m.settings_phone_deletions({ count: phone.deletions })}
          </span>
        </span>
      </div>
      {revoked ? null : (
        <Button variant="ghost" isPending={pending} onClick={onRevoke}>
          {m.settings_phone_revoke()}
        </Button>
      )}
    </li>
  );
}

/** How a pairing ended, once core no longer shows it. */
type Ending =
  | { readonly kind: "done"; readonly name: string }
  | { readonly kind: "refused" | "expired" | "abandoned" | "failed" };

/** Ticks every second while `active`, for the countdown. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function PairingDialog({
  open,
  status,
  opening,
  onStart,
  onClose,
}: {
  open: boolean;
  status: PhoneStatus | undefined;
  /** The pairing's opening: pending, or failed (the relay did not start). */
  opening: { readonly pending: boolean; readonly failed: boolean };
  onStart: () => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const store = (next: PhoneStatus) => queryClient.setQueryData(orpc.phone.status.queryKey(), next);
  const [ended, setEnded] = useState<Ending | null>(null);
  // The pairing as last seen, to tell how it ended once core no longer shows it.
  const seen = useRef<PhonePairing | null>(null);
  const answer = useMutation(
    orpc.phone.answer.mutationOptions({
      onSuccess: (next, { accept }) => {
        store(next);
        const name = seen.current?.deviceName ?? null;
        seen.current = null;
        setEnded(accept && name !== null ? { kind: "done", name } : { kind: "refused" });
      },
    }),
  );
  // Closing the dialog: the same « Annuler », without an ending to show.
  const cancel = useMutation(orpc.phone.answer.mutationOptions({ onSuccess: store }));
  const ending: Ending | null = opening.failed ? { kind: "failed" } : ended;
  const now = useNow(open && ending === null);
  const pairing = status?.pairing ?? null;

  // Gone without an answer from here: expired, or the iPhone left.
  useEffect(() => {
    if (!open || ending !== null || opening.pending || answer.isPending) return;
    if (pairing !== null) {
      seen.current = pairing;
      return;
    }
    const last = seen.current;
    if (last === null) return;
    seen.current = null;
    setEnded({ kind: Date.now() >= last.expiresAtMs - 1_000 ? "expired" : "abandoned" });
  }, [open, ending, pairing, opening.pending, answer.isPending]);

  const forget = () => {
    setEnded(null);
    seen.current = null;
    answer.reset();
  };
  const again = () => {
    forget();
    onStart();
  };
  const close = () => {
    // « Annuler » ends the pairing on both sides, whatever its phase.
    if (pairing !== null && ending === null) cancel.mutate({ accept: false });
    onClose();
  };

  const relay = status?.relay;
  const endingText =
    ending === null
      ? null
      : ending.kind === "done"
        ? m.settings_phone_pair_done({ name: ending.name })
        : ending.kind === "refused"
          ? m.settings_phone_pair_refused()
          : ending.kind === "expired"
            ? m.settings_phone_pair_expired()
            : ending.kind === "abandoned"
              ? m.settings_phone_pair_abandoned()
              : m.settings_phone_pair_failed();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? undefined : close())}
      onOpenChangeComplete={(next) => (next ? undefined : forget())}
    >
      <DialogPopup>
        <DialogTitle>{m.settings_phone_pair_title()}</DialogTitle>
        {ending !== null ? (
          <>
            <DialogDescription>{endingText}</DialogDescription>
            {ending.kind === "failed" && relay?.problem != null ? (
              <p className="text-body-s text-cte-text-muted">{relay.problem}</p>
            ) : null}
            <DialogFooter>
              {ending.kind === "done" || ending.kind === "refused" ? null : (
                <Button variant="secondary" onClick={again}>
                  {m.settings_phone_pair_again()}
                </Button>
              )}
              <Button onClick={onClose}>{m.settings_phone_close()}</Button>
            </DialogFooter>
          </>
        ) : pairing?.phase === "asked" && pairing.digits !== null ? (
          <>
            <p
              aria-live="polite"
              className="py-s text-center font-data text-display-xl tabular-nums"
            >
              {pairing.digits.slice(0, 3)} {pairing.digits.slice(3)}
            </p>
            <DialogDescription>
              {m.settings_phone_pair_asked({ name: pairing.deviceName ?? "iPhone" })}
            </DialogDescription>
            <p className="text-body-s text-cte-text-muted tabular-nums">
              {m.settings_phone_pair_left({ time: countdown(pairing.expiresAtMs, now) })}
            </p>
            <DialogFooter>
              <Button
                variant="ghost"
                disabled={answer.isPending}
                onClick={() => answer.mutate({ accept: false })}
              >
                {m.cancel()}
              </Button>
              <Button
                isPending={answer.isPending && answer.variables?.accept === true}
                onClick={() => answer.mutate({ accept: true })}
              >
                {m.settings_phone_pair_accept()}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogDescription>{m.settings_phone_pair_scan()}</DialogDescription>
            <div className="flex flex-col items-center gap-xs py-xs">
              {pairing?.url != null ? (
                <QrCode
                  value={pairing.url}
                  label={m.settings_phone_pair_code()}
                  className="w-[16rem]"
                />
              ) : (
                <div className="flex aspect-square w-[16rem] items-center justify-center text-body-s text-cte-text-muted">
                  {m.loading()}
                </div>
              )}
              {pairing === null ? null : (
                <p className="text-body-s text-cte-text-muted tabular-nums">
                  {m.settings_phone_pair_left({ time: countdown(pairing.expiresAtMs, now) })}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={close}>
                {m.cancel()}
              </Button>
            </DialogFooter>
          </>
        )}
        {answer.error === null ? null : (
          <p role="alert" className="text-body-s text-error">
            {errorMessage(answer.error)}
          </p>
        )}
        <DialogCornerClose aria-label={m.settings_phone_close()} />
      </DialogPopup>
    </Dialog>
  );
}

export function PhoneSection() {
  const queryClient = useQueryClient();
  const [pairingOpen, setPairingOpen] = useState(false);
  const [revoking, setRevoking] = useState<PhoneDeviceState | null>(null);
  const [resetting, setResetting] = useState(false);
  const status = useQuery({
    ...orpc.phone.status.queryOptions(),
    refetchInterval: pairingOpen ? PAIRING_REFRESH_MS : REFRESH_MS,
  });
  const store = (next: PhoneStatus) => queryClient.setQueryData(orpc.phone.status.queryKey(), next);
  const setEnabled = useMutation(orpc.phone.setEnabled.mutationOptions({ onSuccess: store }));
  const setTailnet = useMutation(orpc.phone.setTailnet.mutationOptions({ onSuccess: store }));
  // « Appairer un iPhone… » and « Nouveau code »: a new pairing (core closes any other).
  const pair = useMutation(orpc.phone.pair.mutationOptions({ onSuccess: store }));
  const startPairing = () => {
    setPairingOpen(true);
    pair.mutate({});
  };
  const revoke = useMutation(
    orpc.phone.revoke.mutationOptions({
      onSuccess: (next) => {
        store(next);
        setRevoking(null);
      },
    }),
  );
  const reset = useMutation(
    orpc.phone.reset.mutationOptions({
      onSuccess: (next) => {
        store(next);
        setResetting(false);
      },
    }),
  );
  const data = status.data;
  const error = setEnabled.error ?? setTailnet.error ?? revoke.error ?? reset.error;
  const relay = data?.relay;
  // As of the last read, which renders again every few seconds.
  const nowMs = status.dataUpdatedAt;

  return (
    <div className="flex max-w-[40rem] flex-col gap-m">
      <div className="flex flex-col gap-xs">
        <SwitchLabel>
          <Switch
            checked={data?.enabled ?? false}
            disabled={data === undefined || !data.available || setEnabled.isPending}
            onCheckedChange={(checked) => setEnabled.mutate({ enabled: checked })}
          />
          {m.settings_phone_switch()}
        </SwitchLabel>
        {data === undefined ? null : (
          <p className="text-body-s text-cte-text-muted">
            {!data.available
              ? m.settings_phone_unavailable()
              : data.enabled
                ? m.settings_phone_on()
                : m.settings_phone_off()}
          </p>
        )}
        {data?.enabled && relay?.phase === "failed" ? (
          <p role="alert" className="text-body-s text-error">
            {relay.problem === null
              ? m.settings_phone_relay_stopped()
              : m.settings_phone_relay_failed({ problem: relay.problem })}
          </p>
        ) : null}
      </div>

      {data === undefined ? (
        <p
          className={status.isError ? "text-body-s text-error" : "text-body-s text-cte-text-muted"}
        >
          {status.isError ? errorMessage(status.error) : m.loading()}
        </p>
      ) : !data.available ? null : (
        <>
          {/* Phones stay listed with sync off, so one can still be revoked. */}
          {data.phones.length === 0 ? null : (
            <ul className="flex flex-col">
              {data.phones.map((phone) => (
                <PhoneRow
                  key={phone.deviceId}
                  phone={phone}
                  nowMs={nowMs}
                  pending={revoke.isPending && revoke.variables?.deviceId === phone.deviceId}
                  onRevoke={() => setRevoking(phone)}
                />
              ))}
            </ul>
          )}
          <Button variant="secondary" className="self-start" onClick={startPairing}>
            {m.settings_phone_pair()}
          </Button>
          {!data.enabled ? null : (
            <div className="flex flex-col gap-xs">
              <SwitchLabel>
                <Switch
                  checked={data.tailnet}
                  disabled={setTailnet.isPending}
                  onCheckedChange={(checked) => setTailnet.mutate({ enabled: checked })}
                />
                {m.settings_phone_tailnet()}
              </SwitchLabel>
              <p className="text-body-s text-cte-text-muted">{m.settings_phone_tailnet_detail()}</p>
              {data.tailnet ? (
                <p className="text-body-s text-cte-text-muted">
                  {m.settings_phone_tailnet_learn()}
                </p>
              ) : null}
            </div>
          )}
          {data.phones.length === 0 ? null : (
            <Button variant="ghost" className="self-start" onClick={() => setResetting(true)}>
              {m.settings_phone_reset()}
            </Button>
          )}
        </>
      )}

      {error === null ? null : (
        <p role="alert" className="text-body-s text-error">
          {errorMessage(error)}
        </p>
      )}

      <PairingDialog
        open={pairingOpen}
        status={data}
        opening={{ pending: pair.isPending, failed: pair.isError }}
        onStart={startPairing}
        onClose={() => setPairingOpen(false)}
      />
      <AlertDialog
        open={revoking !== null}
        onOpenChange={(open) => (open ? undefined : setRevoking(null))}
      >
        <AlertDialogPopup>
          <AlertDialogTitle>
            {revoking === null ? null : m.settings_phone_revoke_title({ name: revoking.name })}
          </AlertDialogTitle>
          <AlertDialogDescription>{m.settings_phone_revoke_description()}</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogClose>{m.cancel()}</AlertDialogClose>
            <Button
              variant="danger"
              isPending={revoke.isPending}
              onClick={() => {
                if (revoking !== null) revoke.mutate({ deviceId: revoking.deviceId });
              }}
            >
              {m.settings_phone_revoke()}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog open={resetting} onOpenChange={setResetting}>
        <AlertDialogPopup>
          <AlertDialogTitle>{m.settings_phone_reset_title()}</AlertDialogTitle>
          <AlertDialogDescription>{m.settings_phone_reset_description()}</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogClose>{m.cancel()}</AlertDialogClose>
            <Button variant="danger" isPending={reset.isPending} onClick={() => reset.mutate({})}>
              {m.settings_phone_reset_confirm()}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
