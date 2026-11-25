import type { ChatProvider, ChatStatus } from "@sondine/api";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@sondine/ui/components/alert-dialog";
import { Button } from "@sondine/ui/components/button";
import { Switch, SwitchLabel } from "@sondine/ui/components/switch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { errorMessage, orpc } from "../../core/orpc";
import { m } from "../../paraglide/messages.js";

// Settings ▸ Discussion avec un agent (ADR 027): off until Téo agrees to
// what leaves the Mac, then who is signed in to Claude Code, from which
// folder, and a way to check again after signing in or updating.

/** Who is signed in to Claude Code, as the discussions and the journal show it. */
export function accountLine(provider: ChatProvider): string | null {
  const account = provider.account;
  if (provider.state !== "ready" || account === null) return null;
  const email = account.email ?? "—";
  const who =
    account.billing === "api-key"
      ? m.chat_api_key({ email })
      : account.plan === null
        ? email
        : m.chat_account_plan({ email, plan: account.plan });
  return m.chat_account({ account: who, version: provider.version ?? "?" });
}

/** What keeps Claude Code from answering, if anything. */
export function problemLine(provider: ChatProvider): string | null {
  switch (provider.state) {
    case "ready":
      return null;
    case "missing":
      return m.chat_provider_missing();
    case "signed-out":
      return m.chat_provider_signed_out();
    case "unsupported":
      return m.chat_provider_unsupported();
    case "failed":
      return m.chat_provider_failed();
  }
}

export function ChatSection() {
  const queryClient = useQueryClient();
  const status = useQuery(orpc.chat.status.queryOptions());
  const [confirming, setConfirming] = useState(false);
  const store = (next: ChatStatus) => queryClient.setQueryData(orpc.chat.status.queryKey(), next);
  const setEnabled = useMutation(
    orpc.chat.setEnabled.mutationOptions({
      onSuccess: (next) => {
        store(next);
        setConfirming(false);
        // Off forgets every discussion: the window forgets them too.
        if (!next.enabled) queryClient.removeQueries({ queryKey: orpc.chat.watch.key() });
      },
    }),
  );
  const refresh = useMutation({
    mutationFn: () => orpc.chat.status.call({ refresh: true }),
    onSuccess: store,
  });
  const enabled = status.data?.enabled;
  const provider = status.data?.providers?.[0] ?? null;
  const error = status.error ?? setEnabled.error ?? refresh.error;

  return (
    <div className="flex max-w-[40rem] flex-col gap-m">
      <div className="flex flex-col gap-xs">
        <SwitchLabel>
          <Switch
            checked={enabled ?? false}
            disabled={enabled === undefined || setEnabled.isPending}
            onCheckedChange={(checked) =>
              checked ? setConfirming(true) : setEnabled.mutate({ enabled: false })
            }
          />
          {m.chat_access()}
        </SwitchLabel>
        {enabled === undefined ? null : (
          <p className="text-body-s text-cte-text-muted">
            {enabled ? m.chat_access_on() : m.chat_access_off()}
          </p>
        )}
      </div>
      {enabled !== true || provider === null ? null : (
        <div className="flex flex-col gap-xxs text-body-s">
          {accountLine(provider) === null ? null : <p>{accountLine(provider)}</p>}
          {problemLine(provider) === null ? null : (
            <p className="text-error">{problemLine(provider)}</p>
          )}
          {provider.home === null ? null : (
            <p className="text-cte-text-muted">{m.chat_home({ home: provider.home })}</p>
          )}
          {status.data?.canRead === false ? (
            <p className="text-error">{m.chat_no_relay()}</p>
          ) : null}
          <div>
            <Button variant="ghost" isPending={refresh.isPending} onClick={() => refresh.mutate()}>
              {m.chat_refresh()}
            </Button>
          </div>
        </div>
      )}
      {error === null ? null : (
        <p role="alert" className="text-body-s text-error">
          {errorMessage(error)}
        </p>
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup>
          <AlertDialogTitle>{m.chat_confirm_title()}</AlertDialogTitle>
          <AlertDialogDescription>{m.chat_confirm_description()}</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogClose>{m.cancel()}</AlertDialogClose>
            <Button
              isPending={setEnabled.isPending}
              onClick={() => setEnabled.mutate({ enabled: true })}
            >
              {m.chat_confirm()}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
