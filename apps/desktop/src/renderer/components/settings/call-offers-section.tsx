import { Button } from "@sondine/ui/components/button";
import { Switch, SwitchLabel } from "@sondine/ui/components/switch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { NotificationPermission } from "../../../shared/bridge";
import { errorMessage, orpc } from "../../core/orpc";
import { m } from "../../paraglide/messages.js";
import { AppIcon } from "../shell/app-icon";

// « Écoute » (ADR 036): whether a call is said when it starts, with its switch
// (beside the notch, else as a notification), on by default; under it, when macOS keeps them off the screen, says so with a way to System
// Settings (read again when the window comes back, from System Settings
// most likely); and the apps the user asked never to be notified for again
// (« Pas pour <app> »), each with « Prévenir à nouveau ».

export function CallOffersSection() {
  const queryClient = useQueryClient();
  const settings = useQuery(orpc.callOffers.settings.queryOptions());
  const onSuccess = (next: NonNullable<typeof settings.data>) =>
    queryClient.setQueryData(orpc.callOffers.settings.queryKey(), next);
  const setEnabled = useMutation(orpc.callOffers.setEnabled.mutationOptions({ onSuccess }));
  const allow = useMutation(orpc.callOffers.allowApp.mutationOptions({ onSuccess }));
  const on = settings.data?.enabled;
  const error = settings.error ?? setEnabled.error ?? allow.error;
  const muted = settings.data?.mutedApps ?? [];
  const permission = useNotificationPermission();
  return (
    <div className="flex max-w-[40rem] flex-col gap-s">
      <div className="flex flex-col gap-xs">
        <SwitchLabel>
          <Switch
            checked={on ?? false}
            disabled={on === undefined || setEnabled.isPending}
            onCheckedChange={(checked) => setEnabled.mutate({ enabled: checked })}
          />
          {m.settings_call_offers()}
        </SwitchLabel>
        <p className="text-body-s text-cte-text-muted">{m.settings_call_offers_detail()}</p>
        {on === true ? <PermissionNote permission={permission} /> : null}
      </div>
      {muted.length === 0 ? null : (
        <div className="flex flex-col gap-xs">
          <p className="text-body-s text-cte-text-muted">{m.settings_call_offers_muted()}</p>
          <ul className="flex flex-col">
            {muted.map((app) => (
              <li key={app.bundleId} className="flex items-center gap-s py-xs">
                <AppIcon app={{ bundleId: app.bundleId }} name={app.name} />
                <span className="min-w-0 flex-1 truncate">{app.name}</span>
                <Button
                  variant="ghost"
                  disabled={allow.isPending}
                  aria-label={m.settings_call_offers_allow_app({ app: app.name })}
                  onClick={() => allow.mutate({ bundleId: app.bundleId })}
                >
                  {m.settings_call_offers_allow()}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {error === null ? null : (
        <p role="alert" className="text-body-s text-error">
          {errorMessage(error)}
        </p>
      )}
    </div>
  );
}

/** macOS's word on Sondine's notifications, read on mount and when the window gets focus back. */
function useNotificationPermission(): NotificationPermission {
  const [permission, setPermission] = useState<NotificationPermission>("unknown");
  useEffect(() => {
    let live = true;
    const read = () =>
      void window.sondine.notificationPermission().then(
        (value) => {
          if (live) setPermission(value);
        },
        () => {
          if (live) setPermission("unknown");
        },
      );
    read();
    window.addEventListener("focus", read);
    return () => {
      live = false;
      window.removeEventListener("focus", read);
    };
  }, []);
  return permission;
}

function PermissionNote({ permission }: { permission: NotificationPermission }) {
  if (permission === "allowed" || permission === "unknown") return null;
  return (
    <div className="flex flex-wrap items-center gap-s">
      <p role="alert" className="text-body-s text-error">
        {permission === "blocked"
          ? m.settings_call_notice_blocked()
          : m.settings_call_notice_silent()}
      </p>
      <Button variant="ghost" onClick={() => window.sondine.openNotificationSettings()}>
        {m.settings_call_notice_open()}
      </Button>
    </div>
  );
}
