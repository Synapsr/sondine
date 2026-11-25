import type { SearchEpisode, SearchInput } from "@sondine/api";
import { Button } from "@sondine/ui/components/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSubmenu,
  MenuSubmenuPopup,
  MenuSubmenuTrigger,
  MenuTrigger,
} from "@sondine/ui/components/menu";
import { useToastManager } from "@sondine/ui/components/toast";
import { EllipsisIcon } from "@sondine/ui/icon";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessage, orpc } from "../../core/orpc";
import { m } from "../../paraglide/messages.js";
import { searchDocument } from "./search-export";

// The results' « ⋯ »: every matching episode (up to 500) with its best
// matches, to the clipboard, a file (Markdown or JSON) or the share sheet,
// refused once anything was deleted since the window read them.

/** Episodes an export takes at most. */
const MAX_EPISODES = 500;

export function SearchMenu({ input }: { input: SearchInput }) {
  const queryClient = useQueryClient();
  const toasts = useToastManager();
  const status = useQuery(orpc.status.watch.experimental_liveOptions({ retry: true }));
  const exportText = useMutation(orpc.episodes.exportText.mutationOptions());
  const take = useMutation({
    mutationFn: async ({
      format,
      destination,
    }: {
      format: "md" | "json";
      destination: "file" | "clipboard" | "share";
    }) => {
      const deletionsSeen = status.data?.deletions;
      if (deletionsSeen === undefined) throw new Error("Sondine's status is not known yet.");
      const results: SearchEpisode[] = [];
      let total = 0;
      do {
        const page = await queryClient.fetchQuery({
          ...orpc.search.query.queryOptions({
            input: { ...input, limit: 50, offset: results.length },
          }),
          staleTime: 0,
        });
        total = page.total;
        if (page.episodes.length === 0) break;
        results.push(...page.episodes);
      } while (results.length < Math.min(total, MAX_EPISODES));
      const text = searchDocument(input, results, total, format);
      if (text === null) return "empty" as const;
      const result = await exportText.mutateAsync({
        episodeIds: results.map((item) => item.episode.id),
        format,
        destination,
        text,
        deletionsSeen,
      });
      return result.outcome;
    },
    onSuccess: (outcome) => {
      if (outcome === "copied") toasts.add({ title: m.search_copied() });
    },
  });
  const problem =
    take.error !== null
      ? errorMessage(take.error)
      : take.data === "stale"
        ? m.export_stale()
        : take.data === "failed"
          ? m.export_audio_failed()
          : null;
  return (
    <>
      {problem === null ? null : (
        <span role="alert" className="text-body-s text-error">
          {problem}
        </span>
      )}
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label={m.search_more()}
              isPending={take.isPending}
              // Its inset hangs outside: the icon lines up with the content's edge.
              className="-me-s"
            />
          }
        >
          <EllipsisIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem onClick={() => take.mutate({ format: "md", destination: "clipboard" })}>
            {m.search_copy()}
          </MenuItem>
          <MenuSubmenu>
            <MenuSubmenuTrigger>{m.search_export()}</MenuSubmenuTrigger>
            <MenuSubmenuPopup>
              <MenuItem onClick={() => take.mutate({ format: "md", destination: "file" })}>
                {m.transcript_export_md()}
              </MenuItem>
              <MenuItem onClick={() => take.mutate({ format: "json", destination: "file" })}>
                {m.transcript_export_json()}
              </MenuItem>
            </MenuSubmenuPopup>
          </MenuSubmenu>
          <MenuItem onClick={() => take.mutate({ format: "md", destination: "share" })}>
            {m.search_share()}
          </MenuItem>
        </MenuPopup>
      </Menu>
    </>
  );
}
