import type { TagSummary } from "@sondine/api";
import { tagKey, tagName } from "@sondine/core/tags";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@sondine/ui/components/alert-dialog";
import { Button } from "@sondine/ui/components/button";
import { Dialog, DialogCornerClose, DialogPopup, DialogTitle } from "@sondine/ui/components/dialog";
import { Input } from "@sondine/ui/components/input";
import { useToastManager } from "@sondine/ui/components/toast";
import { TrashIcon } from "@sondine/ui/icon";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { errorMessage, orpc } from "../../core/orpc";
import { m } from "../../paraglide/messages.js";

// « Gérer les tags… » (ADR 039), the rare actions, at the end of Search's tag
// menu: rename a tag (to another tag's name merges them, after a
// confirmation) and delete one from every recording, after a confirmation.

type Pending =
  | { readonly kind: "merge"; readonly tag: TagSummary; readonly into: TagSummary }
  | { readonly kind: "delete"; readonly tag: TagSummary };

export function TagManager({
  open,
  onOpenChange,
  onRenamed,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A tag's name changed, or it went into another one: the search follows it. */
  onRenamed: (from: string, to: string) => void;
  onDeleted: (name: string) => void;
}) {
  const queryClient = useQueryClient();
  const toasts = useToastManager();
  const tags = useQuery(orpc.tags.list.queryOptions({ enabled: open })).data?.tags ?? [];
  const [pending, setPending] = useState<Pending | null>(null);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.tags.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.episodes.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.search.key() }),
    ]);
  const rename = useMutation(
    orpc.tags.rename.mutationOptions({
      onError: (error) => toasts.add({ title: errorMessage(error) }),
    }),
  );
  const remove = useMutation(
    orpc.tags.delete.mutationOptions({
      onError: (error) => toasts.add({ title: errorMessage(error) }),
    }),
  );
  const renameTo = (tag: TagSummary, typed: string) => {
    const name = tagName(typed);
    if (name === null || name === tag.name) return;
    const into = tags.find((other) => other.id !== tag.id && tagKey(other.name) === tagKey(name));
    if (into !== undefined) {
      setPending({ kind: "merge", tag, into });
      return;
    }
    rename.mutate(
      { tagId: tag.id, name },
      {
        onSuccess: (result) => {
          onRenamed(tag.name, result.tag.name);
          void refresh();
        },
      },
    );
  };
  const confirm = () => {
    if (pending === null) return;
    if (pending.kind === "merge") {
      rename.mutate(
        { tagId: pending.tag.id, name: pending.into.name },
        {
          onSuccess: (result) => {
            onRenamed(pending.tag.name, result.tag.name);
            setPending(null);
            void refresh();
          },
        },
      );
      return;
    }
    remove.mutate(
      { tagId: pending.tag.id },
      {
        onSuccess: () => {
          onDeleted(pending.tag.name);
          setPending(null);
          void refresh();
        },
      },
    );
  };
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogPopup className="w-[28rem]">
          <DialogTitle>{m.tags_label()}</DialogTitle>
          <DialogCornerClose aria-label={m.close()} />
          <ul className="flex max-h-[24rem] flex-col gap-xs overflow-y-auto">
            {tags.map((tag) => (
              <li key={`${tag.id}:${tag.name}`} className="flex items-center gap-xs">
                <Input
                  aria-label={m.tags_rename({ name: tag.name })}
                  defaultValue={tag.name}
                  maxLength={200}
                  className="min-w-0 flex-1"
                  onBlur={(event) => renameTo(tag, event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                    if (event.key === "Escape") event.currentTarget.value = tag.name;
                  }}
                />
                <span className="w-[3rem] text-end text-body-s tabular-nums text-cte-text-muted">
                  {tag.recordings}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={m.tags_delete({ name: tag.name })}
                  onClick={() => setPending({ kind: "delete", tag })}
                >
                  <TrashIcon />
                </Button>
              </li>
            ))}
          </ul>
        </DialogPopup>
      </Dialog>
      <AlertDialog
        open={pending !== null}
        onOpenChange={(next) => (next ? null : setPending(null))}
      >
        <AlertDialogPopup>
          <AlertDialogTitle>
            {pending?.kind === "merge"
              ? m.tags_merge_title({ name: pending.tag.name, into: pending.into.name })
              : m.tags_delete_title({ name: pending?.tag.name ?? "" })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {pending?.kind === "merge"
              ? m.tags_merge_description({ count: pending.tag.recordings, into: pending.into.name })
              : m.tags_delete_description({ count: pending?.tag.recordings ?? 0 })}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogClose>{m.cancel()}</AlertDialogClose>
            <Button
              variant={pending?.kind === "merge" ? "primary" : "danger"}
              isPending={rename.isPending || remove.isPending}
              onClick={confirm}
            >
              {pending?.kind === "merge" ? m.tags_merge() : m.tags_delete_confirm()}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
