import { Switch, SwitchLabel } from "@sondine/ui/components/switch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessage, orpc } from "../../core/orpc";
import { m } from "../../paraglide/messages.js";

/** « Reconnaître les voix » (ADR 012), with what on and off mean. */
export function RecognitionSwitch() {
  const queryClient = useQueryClient();
  const recognition = useQuery(orpc.people.recognition.queryOptions());
  const set = useMutation(
    orpc.people.setRecognition.mutationOptions({
      onSuccess: async (next) => {
        queryClient.setQueryData(orpc.people.recognition.queryKey(), next);
        await Promise.all([
          // Off deletes the voice read too (ADR 034).
          queryClient.invalidateQueries({ queryKey: orpc.voiceRead.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.episodes.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.search.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.people.key() }),
        ]);
      },
    }),
  );
  const on = recognition.data?.on;
  const error = recognition.error ?? set.error;
  return (
    <div className="flex max-w-[40rem] flex-col gap-xs">
      <SwitchLabel>
        <Switch
          checked={on ?? false}
          disabled={on === undefined || set.isPending}
          onCheckedChange={(checked) => set.mutate({ on: checked })}
        />
        {m.settings_recognition()}
      </SwitchLabel>
      {on === undefined ? null : (
        <p className="text-body-s text-cte-text-muted">
          {on ? m.settings_recognition_on() : m.settings_recognition_off()}
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
