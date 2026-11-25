import { Switch, SwitchLabel } from "@sondine/ui/components/switch";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessage, orpc } from "../../core/orpc";
import { m } from "../../paraglide/messages.js";

/**
 * « Apprendre ma voix depuis mes dictées » (ADR 030): off by default, and
 * only while voices are recognized at all.
 */
export function DictationVoiceSwitch() {
  const queryClient = useQueryClient();
  const recognition = useQuery(orpc.people.recognition.queryOptions());
  const learning = useQuery(orpc.people.dictationLearning.queryOptions());
  const set = useMutation(
    orpc.people.setDictationLearning.mutationOptions({
      onSuccess: async (next) => {
        queryClient.setQueryData(orpc.people.dictationLearning.queryKey(), next);
        // What is recognized changes with the user's references.
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.episodes.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.search.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.people.key() }),
        ]);
      },
    }),
  );
  const on = learning.data?.on;
  const error = learning.error ?? set.error;
  return (
    <div className="flex max-w-[40rem] flex-col gap-xs">
      <SwitchLabel>
        <Switch
          checked={on ?? false}
          disabled={on === undefined || recognition.data?.on !== true || set.isPending}
          onCheckedChange={(checked) => set.mutate({ on: checked })}
        />
        {m.settings_voice_dictations()}
      </SwitchLabel>
      {on === undefined ? null : (
        <p className="text-body-s text-cte-text-muted">
          {on ? m.settings_voice_dictations_on() : m.settings_voice_dictations_off()}
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
