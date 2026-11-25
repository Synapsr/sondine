import { Switch, SwitchLabel } from "@sondine/ui/components/switch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessage, orpc } from "../../core/orpc";
import { m } from "../../paraglide/messages.js";

/** « Ouvrir l'encoche au survol » (ADR 025): on by default; off, a click opens it. */
export function NotchSwitch() {
  const queryClient = useQueryClient();
  const notch = useQuery(orpc.calls.notch.queryOptions());
  const set = useMutation(
    orpc.calls.setNotch.mutationOptions({
      onSuccess: (next) => queryClient.setQueryData(orpc.calls.notch.queryKey(), next),
    }),
  );
  const on = notch.data?.openOnHover;
  const error = notch.error ?? set.error;
  return (
    <div className="flex max-w-[40rem] flex-col gap-xs">
      <SwitchLabel>
        <Switch
          checked={on ?? false}
          disabled={on === undefined || set.isPending}
          onCheckedChange={(checked) => set.mutate({ openOnHover: checked })}
        />
        {m.settings_notch_hover()}
      </SwitchLabel>
      {on === undefined ? null : (
        <p className="text-body-s text-cte-text-muted">
          {on ? m.settings_notch_hover_on() : m.settings_notch_hover_off()}
        </p>
      )}
      {error === null ? null : (
        <p role="alert" className="text-body-s text-error">
          {errorMessage(error)}
        </p>
      )}
    </div>
  );
}
