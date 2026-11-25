import { Button } from "@sondine/ui/components/button";
import { Switch, SwitchLabel } from "@sondine/ui/components/switch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessage, orpc } from "../../core/orpc";
import { dayOf } from "../../lib/day";
import { clock, dayTitle } from "../../lib/labels";
import { m } from "../../paraglide/messages.js";
import { AppIcon } from "../shell/app-icon";

// « Dictées » (ADR 020): every app seen listening to the microphone outside a
// call, the known dictation apps installed that have not yet, and the apps the
// user added (« Ajouter une app… », an open panel on /Applications), each with
// a switch for whether what is said to it is a dictation. A
// dictation goes in its own lane, is transcribed by the small model with one
// voice, and its voice is never identified. A change applies to what is
// grouped from now on.

export function DictationSection() {
  const queryClient = useQueryClient();
  const apps = useQuery(orpc.dictation.apps.queryOptions());
  const set = useMutation(
    orpc.dictation.setApp.mutationOptions({
      onSuccess: (data) => queryClient.setQueryData(orpc.dictation.apps.queryKey(), data),
    }),
  );
  const setText = useMutation(
    orpc.dictation.setText.mutationOptions({
      onSuccess: (data) => queryClient.setQueryData(orpc.dictation.apps.queryKey(), data),
    }),
  );
  const error = set.error ?? setText.error;
  const today = dayOf(Date.now());
  const add = async () => {
    const picked = await window.sondine?.pickApp();
    if (picked === null || picked === undefined) return;
    set.mutate({ bundleId: picked.bundleId, name: picked.name, dictation: true });
  };
  return (
    <div className="flex max-w-[40rem] flex-col gap-s">
      <p className="text-body-s text-cte-text-muted">{m.settings_dictation_detail()}</p>
      {apps.data === undefined ? (
        <p className={apps.isError ? "text-body-s text-error" : "text-body-s text-cte-text-muted"}>
          {apps.isError ? errorMessage(apps.error) : m.loading()}
        </p>
      ) : apps.data.apps.length === 0 ? (
        <p className="text-body-s text-cte-text-muted">{m.settings_dictation_none()}</p>
      ) : (
        <ul className="flex flex-col">
          {apps.data.apps.map((app) => (
            <li key={app.bundleId} className="flex flex-wrap items-center gap-s py-xs">
              <AppIcon app={{ bundleId: app.bundleId }} name={app.name} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{app.name}</span>
                {/* When it last listened: « Aujourd'hui · 14:22 ». */}
                <span className="text-body-xs text-cte-text-muted">
                  {app.lastListenedAtMs === null
                    ? m.settings_dictation_not_yet()
                    : [
                        dayTitle(dayOf(app.lastListenedAtMs), today),
                        clock(app.lastListenedAtMs),
                      ].join(" · ")}
                </span>
              </span>
              <Switch
                aria-label={m.settings_dictation_switch({ app: app.name })}
                checked={app.dictation}
                disabled={set.isPending}
                onCheckedChange={(checked) =>
                  set.mutate({ bundleId: app.bundleId, dictation: checked })
                }
              />
              {app.text === null || !app.dictation ? null : (
                <div className="flex w-full flex-col gap-xxs">
                  <SwitchLabel>
                    <Switch
                      checked={app.text}
                      disabled={setText.isPending}
                      onCheckedChange={(on) => setText.mutate({ bundleId: app.bundleId, on })}
                    />
                    {m.settings_dictation_text({ app: app.name })}
                  </SwitchLabel>
                  <p className="text-body-xs text-cte-text-muted">
                    {m.settings_dictation_text_detail({ app: app.name })}
                  </p>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {window.sondine === undefined ? null : (
        <Button
          variant="ghost"
          className="self-start"
          disabled={set.isPending}
          onClick={() => void add()}
        >
          {m.settings_dictation_add()}
        </Button>
      )}
      {error === null ? null : (
        <p role="alert" className="text-body-s text-error">
          {errorMessage(error)}
        </p>
      )}
    </div>
  );
}
