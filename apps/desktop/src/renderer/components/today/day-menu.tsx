import type { EpisodeDetail, EpisodeSummary, TimelineLane } from "@sondine/api";
import { Button } from "@sondine/ui/components/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSubmenu,
  MenuSubmenuPopup,
  MenuSubmenuTrigger,
  MenuTrigger,
} from "@sondine/ui/components/menu";
import { useToastManager } from "@sondine/ui/components/toast";
import { EllipsisIcon } from "@sondine/ui/icon";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { errorMessage, orpc } from "../../core/orpc";
import { m } from "../../paraglide/messages.js";
import { dayDocument } from "../episode/transcript-export";
import { useImport } from "../imports/import-actions";

// The day's « ⋯ » in Today: its transcripts, conversations and moments (not
// media, not traces), as one Markdown or JSON document, to the clipboard, a
// file, or the share sheet. Like one episode's export, it goes only while
// nothing was deleted since the window read it. Once the day's journal is
// written, « Réécrire le journal », by whoever writes the journal now (Téo,
// 2026-11-10: to compare a day written by this Mac and by Claude). And
// « Importer un audio… » (import-actions.tsx). What goes wrong shows in a
// toast, so the header's controls never move.

const LANES: readonly TimelineLane[] = ["conversations", "moments"];
/** Transcripts read at once. */
const READS_AT_ONCE = 6;

/** The day's transcribed conversations and moments, every page. */
async function transcribedEpisodes(queryClient: QueryClient, day: string) {
  const found: EpisodeSummary[] = [];
  for (const lane of LANES) {
    let cursor: string | undefined;
    do {
      const page = await queryClient.fetchQuery({
        ...orpc.episodes.list.queryOptions({
          input: { day, lane, limit: 500, ...(cursor === undefined ? {} : { cursor }) },
        }),
        staleTime: 0,
      });
      found.push(...page.episodes.filter((episode) => episode.analysisState === "complete"));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
  }
  return found;
}

async function readAll(queryClient: QueryClient, ids: readonly number[]) {
  const details: EpisodeDetail[] = [];
  for (let start = 0; start < ids.length; start += READS_AT_ONCE) {
    details.push(
      ...(await Promise.all(
        ids.slice(start, start + READS_AT_ONCE).map((episodeId) =>
          queryClient.fetchQuery({
            ...orpc.episodes.get.queryOptions({ input: { episodeId } }),
            staleTime: 0,
          }),
        ),
      )),
    );
  }
  return details;
}

export function DayMenu({ day }: { day: string }) {
  const queryClient = useQueryClient();
  const toasts = useToastManager();
  const status = useQuery(orpc.status.watch.experimental_liveOptions({ retry: true }));
  const exportText = useMutation(orpc.episodes.exportText.mutationOptions());
  const imports = useImport();
  const journal = useQuery(orpc.journal.day.queryOptions({ input: { day } }));
  const rewrite = useMutation(
    orpc.journal.request.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.journal.key() }),
      onError: (error) => toasts.add({ title: errorMessage(error) }),
    }),
  );
  const journalState = journal.data?.state;
  const canRewrite =
    journalState?.installed === true &&
    journalState.pending === 0 &&
    (journal.data?.conversations.length ?? 0) > 0;
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
      const episodes = await transcribedEpisodes(queryClient, day);
      const details = await readAll(
        queryClient,
        episodes.map((episode) => episode.id),
      );
      const text = dayDocument(day, details, format);
      if (text === null) return "empty" as const;
      const result = await exportText.mutateAsync({
        episodeIds: details.map((detail) => detail.episode.id),
        format,
        destination,
        text,
        deletionsSeen,
      });
      return result.outcome;
    },
    onSuccess: (outcome) => {
      const said =
        outcome === "copied"
          ? m.day_copied()
          : outcome === "empty"
            ? m.day_nothing()
            : outcome === "stale"
              ? m.export_stale()
              : outcome === "failed"
                ? m.export_audio_failed()
                : null;
      if (said !== null) toasts.add({ title: said });
    },
    onError: (error) => toasts.add({ title: errorMessage(error) }),
  });
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={m.day_more()}
            isPending={take.isPending}
          />
        }
      >
        <EllipsisIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={() => take.mutate({ format: "md", destination: "clipboard" })}>
          {m.day_copy()}
        </MenuItem>
        <MenuSubmenu>
          <MenuSubmenuTrigger>{m.day_export()}</MenuSubmenuTrigger>
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
          {m.day_share()}
        </MenuItem>
        <MenuSeparator />
        <MenuItem disabled={imports.pending} onClick={imports.pick}>
          {m.imports_add()}
        </MenuItem>
        {canRewrite ? (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => rewrite.mutate({ day, rewrite: true })}>
              {m.journal_rewrite_day()}
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
