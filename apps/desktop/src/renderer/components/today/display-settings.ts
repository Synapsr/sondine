import type { DisplaySettings, DisplayUpdateInput } from "@sondine/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../../core/orpc";

// How the window shows things, kept by core across launches (Today's
// commitments folded, the day's filter menu). A change shows at once and is
// stored behind it; a refusal puts back what core holds. Core applies the
// changes in order, so only the last one still out writes core's answer:
// an earlier answer would undo a later choice already on screen.

export function useDisplaySettings(): {
  readonly settings: DisplaySettings | undefined;
  readonly settled: boolean;
  readonly update: (patch: DisplayUpdateInput) => void;
} {
  const queryClient = useQueryClient();
  const queryKey = orpc.display.get.queryKey();
  const mutationKey = orpc.display.update.mutationKey();
  const query = useQuery(orpc.display.get.queryOptions());
  const mutation = useMutation(
    orpc.display.update.mutationOptions({
      onMutate: async (patch) => {
        // A read still out would bring back the state before this change.
        await queryClient.cancelQueries({ queryKey });
        const current = queryClient.getQueryData<DisplaySettings>(queryKey);
        if (current === undefined) return;
        queryClient.setQueryData(queryKey, {
          commitmentsFolded: patch.commitmentsFolded ?? current.commitmentsFolded,
          media: patch.media === undefined ? current.media : patch.media,
          dictations: patch.dictations === undefined ? current.dictations : patch.dictations,
        });
      },
      onSuccess: (next) => {
        if (queryClient.isMutating({ mutationKey }) === 1) queryClient.setQueryData(queryKey, next);
      },
      onError: () => queryClient.invalidateQueries({ queryKey }),
    }),
  );
  return {
    settings: query.data,
    settled: query.data !== undefined || query.isError,
    update: (patch) => mutation.mutate(patch),
  };
}
