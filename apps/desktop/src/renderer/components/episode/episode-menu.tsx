import type { EpisodeDetail, EpisodeKind, PrivacyStatus, TranscriptFormat } from "@sondine/api";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@sondine/ui/components/alert-dialog";
import { Button } from "@sondine/ui/components/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSubmenu,
  MenuSubmenuPopup,
  MenuSubmenuTrigger,
  MenuTrigger,
} from "@sondine/ui/components/menu";
import { useToastManager } from "@sondine/ui/components/toast";
import { ArrowUpIcon, EllipsisIcon } from "@sondine/ui/icon";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { errorMessage, orpc } from "../../core/orpc";
import { dayOf } from "../../lib/day";
import { clock, dayTitle, timeRange } from "../../lib/labels";
import { siteRule } from "../../lib/site-rule";
import { m } from "../../paraglide/messages.js";
import { usePlayer } from "../player/player-provider";
import { transcriptDocument } from "./transcript-export";

const exportFormats: readonly { format: TranscriptFormat; label: () => string }[] = [
  { format: "md", label: () => m.transcript_export_md() },
  { format: "srt", label: () => m.transcript_export_srt() },
  { format: "vtt", label: () => m.transcript_export_vtt() },
  { format: "json", label: () => m.transcript_export_json() },
];

/**
 * The conversation's Share menu and « ⋯ » (ADR 037). Share holds « Copier la
 * transcription » (Markdown), « Exporter la transcription ▸ » (Markdown,
 * subtitles or JSON, in a file the user chooses), « Partager… » (the Markdown
 * through the macOS share sheet) and « Exporter l'audio… » (a WAV, written by
 * main). The « ⋯ » holds the conversation's own actions: « Garder l'audio »,
 * « Fusionner avec la précédente / la suivante » (the episode that remains is
 * the earlier one), « Reconnaître les voix ici » (off: no name or guess here,
 * its voice embeddings deleted), « Ne plus garder <site> » on a page's media
 * while the site is kept (a zone at « Rien » from now on, ADR 029; undone
 * from its toast), « Type ▸ » (what the user says it is, or Sondine's
 * choice), « Retranscrire » (first in the queue: the new transcript replaces
 * the old one and keeps names and corrections), and last « Supprimer
 * l'enregistrement… » with its confirmation. Deleting erases the audio and
 * the text for good, then returns to the screen it came from.
 */
const KINDS: readonly { value: EpisodeKind; label: () => string }[] = [
  { value: "conversation", label: () => m.episode_size_conversation() },
  { value: "moment", label: () => m.episode_size_moment() },
  { value: "media", label: () => m.episode_kind_media() },
];

/** « 10:05 – 10:42 » the same day, « Hier, 10:05 » before. */
function neighbourTime(neighbour: { startedAtMs: number; endedAtMs: number | null }, day: string) {
  const other = dayOf(neighbour.startedAtMs);
  return other === day
    ? timeRange(neighbour.startedAtMs, neighbour.endedAtMs)
    : `${dayTitle(other, dayOf(Date.now()))}, ${clock(neighbour.startedAtMs)}`;
}

export function EpisodeMenu({
  episodeId,
  hasTranscript,
  transcribed,
  closed,
  startedAtMs,
  neighbours,
  kindOverride,
  kindFixed,
  recognition,
  keptAudio,
  site,
  backTo,
  onMerged,
}: {
  episodeId: number;
  hasTranscript: boolean;
  /** « Retranscrire »: a closed episode whose transcript is done. */
  transcribed: boolean;
  /** Only a closed episode merges. */
  closed: boolean;
  startedAtMs: number;
  neighbours: EpisodeDetail["neighbours"];
  kindOverride: EpisodeKind | null;
  /** An imported recording: its kind is not the user's to change. */
  kindFixed: boolean;
  /** « Reconnaître les voix ici »: null where voices are never recognised (media). */
  recognition: boolean | null;
  /** « Garder l'audio » (ADR 029): null when no audio is left to keep. */
  keptAudio: boolean | null;
  /** The site of the page its media came from (ADR 023), for « Ne plus garder »; null without one. */
  site: { site: string; name: string } | null;
  backTo: () => void;
  /** The merged episode, when it is not this one. */
  onMerged: (episodeId: number) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const queryClient = useQueryClient();
  const keepAudio = useMutation(
    orpc.episodes.keepAudio.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.episodes.key() }),
    }),
  );
  const merge = useMutation(
    orpc.episodes.merge.mutationOptions({
      onSuccess: async (result) => {
        if (result.episodeId !== episodeId) onMerged(result.episodeId);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.episodes.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.search.key() }),
        ]);
      },
    }),
  );
  const day = dayOf(startedAtMs);
  const setKind = useMutation(
    orpc.episodes.setKind.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.episodes.key() }),
    }),
  );
  const setRecognition = useMutation(
    orpc.episodes.setRecognition.mutationOptions({
      onSuccess: () =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.episodes.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.search.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.people.key() }),
        ]),
    }),
  );
  const exportAudio = useMutation(orpc.episodes.exportAudio.mutationOptions());
  const retranscribe = useMutation(
    orpc.analysis.request.mutationOptions({
      onSuccess: () =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.episodes.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.search.key() }),
        ]),
    }),
  );
  const takeText = useTakeTranscript(episodeId);
  const leaveOut = useLeaveOutSite(site);
  const outcome = exportAudio.data?.outcome;
  const failure =
    exportAudio.error ??
    takeText.error ??
    retranscribe.error ??
    merge.error ??
    setKind.error ??
    setRecognition.error ??
    leaveOut.error;
  const problem =
    failure !== null
      ? errorMessage(failure)
      : outcome === "failed" || takeText.data === "failed"
        ? m.export_audio_failed()
        : outcome === "empty"
          ? m.player_nothing()
          : takeText.data === "empty"
            ? m.episode_no_speech()
            : takeText.data === "stale"
              ? m.export_stale()
              : retranscribe.data?.outcome === "private-zone"
                ? m.episode_private_zone()
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
            <Button variant="secondary" isPending={exportAudio.isPending || takeText.isPending} />
          }
        >
          <ArrowUpIcon />
          {m.episode_share()}
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem
            disabled={!hasTranscript}
            onClick={() => takeText.mutate({ format: "md", destination: "clipboard" })}
          >
            {m.transcript_copy()}
          </MenuItem>
          <MenuSubmenu>
            <MenuSubmenuTrigger disabled={!hasTranscript}>
              {m.transcript_export()}
            </MenuSubmenuTrigger>
            <MenuSubmenuPopup>
              {exportFormats.map(({ format, label }) => (
                <MenuItem
                  key={format}
                  onClick={() => takeText.mutate({ format, destination: "file" })}
                >
                  {label()}
                </MenuItem>
              ))}
            </MenuSubmenuPopup>
          </MenuSubmenu>
          <MenuItem
            disabled={!hasTranscript}
            onClick={() => takeText.mutate({ format: "md", destination: "share" })}
          >
            {m.transcript_share()}
          </MenuItem>
          <MenuItem onClick={() => exportAudio.mutate({ episodeId })}>{m.export_audio()}</MenuItem>
        </MenuPopup>
      </Menu>
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label={m.episode_more()}
              // Its inset hangs outside: the icon lines up with the content's edge.
              className="-me-s"
              isPending={retranscribe.isPending || merge.isPending}
            />
          }
        >
          <EllipsisIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          {keptAudio === null ? null : (
            <MenuCheckboxItem
              checked={keptAudio}
              disabled={keepAudio.isPending}
              onCheckedChange={(keep) => keepAudio.mutate({ episodeId, keep })}
            >
              {m.episode_keep_audio()}
            </MenuCheckboxItem>
          )}
          {!closed || (neighbours.previous === null && neighbours.next === null) ? null : (
            <>
              {neighbours.previous === null ? null : (
                <MenuItem
                  onClick={() =>
                    neighbours.previous !== null &&
                    merge.mutate({ episodeId, otherId: neighbours.previous.id })
                  }
                >
                  {m.episode_merge_previous({ time: neighbourTime(neighbours.previous, day) })}
                </MenuItem>
              )}
              {neighbours.next === null ? null : (
                <MenuItem
                  onClick={() =>
                    neighbours.next !== null &&
                    merge.mutate({ episodeId, otherId: neighbours.next.id })
                  }
                >
                  {m.episode_merge_next({ time: neighbourTime(neighbours.next, day) })}
                </MenuItem>
              )}
            </>
          )}
          {recognition === null ? null : (
            <MenuCheckboxItem
              checked={recognition}
              disabled={setRecognition.isPending}
              onCheckedChange={(allowed) => setRecognition.mutate({ episodeId, allowed })}
            >
              {m.episode_recognize()}
            </MenuCheckboxItem>
          )}
          {leaveOut.available && site !== null ? (
            <MenuItem disabled={leaveOut.isPending} onClick={leaveOut.run}>
              {m.episode_leave_out_site({ site: site.name })}
            </MenuItem>
          ) : null}
          {closed && !kindFixed ? (
            <MenuSubmenu>
              <MenuSubmenuTrigger>{m.episode_kind()}</MenuSubmenuTrigger>
              <MenuSubmenuPopup>
                <MenuRadioGroup
                  value={kindOverride ?? "auto"}
                  onValueChange={(value) => {
                    const kind = KINDS.find((choice) => choice.value === value)?.value ?? null;
                    setKind.mutate({ episodeId, kind });
                  }}
                >
                  <MenuRadioItem value="auto">{m.episode_kind_auto()}</MenuRadioItem>
                  {KINDS.map((choice) => (
                    <MenuRadioItem key={choice.value} value={choice.value}>
                      {choice.label()}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuSubmenuPopup>
            </MenuSubmenu>
          ) : null}
          {transcribed ? (
            <MenuItem onClick={() => retranscribe.mutate({ episodeId })}>
              {m.episode_retranscribe()}
            </MenuItem>
          ) : null}
          <MenuSeparator />
          <MenuItem variant="danger" onClick={() => setConfirming(true)}>
            {m.episode_delete()}
          </MenuItem>
        </MenuPopup>
      </Menu>
      <DeleteDialog
        episodeId={episodeId}
        open={confirming}
        onOpenChange={setConfirming}
        onDeleted={backTo}
      />
    </>
  );
}

/**
 * « Ne plus garder <site> »: the site's zone on, keeping nothing, from now on
 * (an episode still open that goes on hearing it goes with it at its end).
 * Adds the zone, or turns on the one there is; the toast's « Annuler » puts
 * back what was. Available while the site is kept.
 */
function useLeaveOutSite(site: { site: string; name: string } | null) {
  const queryClient = useQueryClient();
  const toasts = useToastManager();
  const status = useQuery({ ...orpc.privacy.status.queryOptions(), enabled: site !== null });
  const store = (next: PrivacyStatus) =>
    queryClient.setQueryData(orpc.privacy.status.queryKey(), next);
  const addZone = useMutation(orpc.privacy.addZone.mutationOptions({ onSuccess: store }));
  const updateZone = useMutation(orpc.privacy.updateZone.mutationOptions({ onSuccess: store }));
  const removeZone = useMutation(orpc.privacy.removeZone.mutationOptions({ onSuccess: store }));
  const rule =
    site === null || status.data === undefined ? null : siteRule(status.data.zones, site.site);
  const run = () => {
    if (site === null || rule === null) return;
    const before = rule.zone;
    const undo = (next: PrivacyStatus) => {
      if (before !== null) {
        updateZone.mutate({ id: before.id, on: before.on, outcome: before.outcome });
        return;
      }
      const added = siteRule(next.zones, site.site).zone;
      if (added !== null) removeZone.mutate({ id: added.id });
    };
    const done = (next: PrivacyStatus) =>
      toasts.add({
        title: m.episode_site_left_out({ site: site.name }),
        actionProps: { children: m.episode_site_undo(), onClick: () => undo(next) },
      });
    if (before === null) addZone.mutate({ kind: "site", site: site.site }, { onSuccess: done });
    else updateZone.mutate({ id: before.id, on: true, outcome: "nothing" }, { onSuccess: done });
  };
  return {
    available: rule?.kept === true,
    isPending: addZone.isPending || updateZone.isPending || removeZone.isPending,
    error: addZone.error ?? updateZone.error ?? removeZone.error,
    run,
  };
}

/**
 * Reads the episode again, writes the document, and hands it to core for the
 * clipboard or a file with the deletion count seen before the read: core
 * refuses it (`stale`) once anything was deleted since. Subtitles are timed on
 * the playback timeline, as the exported audio.
 */
function useTakeTranscript(episodeId: number) {
  const queryClient = useQueryClient();
  const toasts = useToastManager();
  const status = useQuery(orpc.status.watch.experimental_liveOptions({ retry: true }));
  const exportText = useMutation(orpc.episodes.exportText.mutationOptions());
  return useMutation({
    mutationFn: async ({
      format,
      destination,
    }: {
      format: TranscriptFormat;
      destination: "file" | "clipboard" | "share";
    }) => {
      const deletionsSeen = status.data?.deletions;
      if (deletionsSeen === undefined) throw new Error("Sondine's status is not known yet.");
      const [detail, playback] = await Promise.all([
        queryClient.fetchQuery({
          ...orpc.episodes.get.queryOptions({ input: { episodeId } }),
          staleTime: 0,
        }),
        format === "md"
          ? null
          : queryClient.fetchQuery({
              ...orpc.episodes.playback.queryOptions({ input: { episodeId } }),
              staleTime: 0,
            }),
      ]);
      const text = transcriptDocument(detail, format, playback?.startedAtMs ?? null);
      if (text === null) return "empty" as const;
      const result = await exportText.mutateAsync({
        episodeIds: [episodeId],
        format,
        destination,
        text,
        deletionsSeen,
      });
      return result.outcome;
    },
    onSuccess: (outcome) => {
      if (outcome === "copied") toasts.add({ title: m.transcript_copied() });
    },
  });
}

/** « Supprimer » a whole recording, from the menu or from every sentence chosen in the transcript. */
export function useDeleteEpisode(episodeId: number, onDeleted: () => void) {
  const player = usePlayer();
  const queryClient = useQueryClient();
  return useMutation(
    orpc.episodes.delete.mutationOptions({
      onMutate: () => {
        // Nothing of it may keep playing from a buffer.
        if (player.getSnapshot().episodeId === episodeId) player.stop();
      },
      onSuccess: async () => {
        onDeleted();
        queryClient.removeQueries({ queryKey: orpc.episodes.get.key() });
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.episodes.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.search.key() }),
        ]);
      },
    }),
  );
}

function DeleteDialog({
  episodeId,
  open,
  onOpenChange,
  onDeleted,
}: {
  episodeId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const remove = useDeleteEpisode(episodeId, () => {
    onOpenChange(false);
    onDeleted();
  });
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogTitle>{m.episode_delete_title()}</AlertDialogTitle>
        <AlertDialogDescription>{m.episode_delete_description()}</AlertDialogDescription>
        {remove.error === null ? null : (
          <p role="alert" className="text-error">
            {errorMessage(remove.error)}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogClose>{m.cancel()}</AlertDialogClose>
          <Button
            variant="danger"
            isPending={remove.isPending}
            onClick={() => remove.mutate({ episodeId })}
          >
            {m.episode_delete_confirm()}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
