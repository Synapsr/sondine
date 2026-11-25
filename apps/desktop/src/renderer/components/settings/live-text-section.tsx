import type { LiveState } from "@sondine/api";
import { Switch, SwitchLabel } from "@sondine/ui/components/switch";
import { useMutation, useQuery } from "@tanstack/react-query";
import { errorMessage, orpc } from "../../core/orpc";
import { m } from "../../paraglide/messages.js";
import { ModelPanel } from "../models/model-panel";

// « Texte en direct » (architecture §10): the switch, what it does, why it
// rests now, and its small model, installed like the transcript's.

const restText: Partial<Record<LiveState, () => string>> = {
  "no-model": () => m.settings_live_no_model(),
  blocked: () => m.settings_live_blocked(),
  "on-battery": () => m.settings_live_on_battery(),
  hot: () => m.settings_live_hot(),
  memory: () => m.settings_live_memory(),
};

export function LiveTextSection() {
  const status = useQuery(orpc.status.watch.experimental_liveOptions({ retry: true }));
  const set = useMutation(orpc.live.setEnabled.mutationOptions());
  const live = status.data?.live;
  const on = live?.enabled;
  const rest = on === true && live !== undefined ? restText[live.state] : undefined;
  return (
    <div className="flex max-w-[40rem] flex-col gap-s">
      <div className="flex flex-col gap-xs">
        <SwitchLabel>
          <Switch
            checked={on ?? false}
            disabled={on === undefined || set.isPending}
            onCheckedChange={(checked) => set.mutate({ enabled: checked })}
          />
          {m.settings_live()}
        </SwitchLabel>
        <p className="text-body-s text-cte-text-muted">{m.settings_live_detail()}</p>
        {rest === undefined ? null : <p className="text-body-s text-cte-text-muted">{rest()}</p>}
        {set.error === null ? null : (
          <p role="alert" className="text-body-s text-error">
            {errorMessage(set.error)}
          </p>
        )}
      </div>
      {on === true ? <ModelPanel role="live" /> : null}
    </div>
  );
}
