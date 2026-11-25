import type { ImportPickResult } from "@sondine/api";
import { useToastManager } from "@sondine/ui/components/toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState, type DragEvent } from "react";
import { errorMessage, orpc } from "../../core/orpc";
import { m } from "../../paraglide/messages.js";

// Importing a recording from anywhere (ADR 021, ADR 037): the Mac's panel
// (« Importer un enregistrement… » in the day's « ⋯ » and the palette) or a
// file dropped on the window. Each outcome is a toast: « Ouvrir » on the
// recording, or why it failed with « Réessayer ».

/** Why an import failed, for the window (« Transcrire » on a conversation's audio too). */
export const importFailure: Record<
  Extract<ImportPickResult, { outcome: "failed" }>["problem"],
  () => string
> = {
  unreadable: () => m.imports_failed_unreadable(),
  "too-long": () => m.imports_failed_too_long(),
  empty: () => m.imports_failed_empty(),
  "disk-full": () => m.imports_failed_disk_full(),
  conflict: () => m.imports_failed_conflict(),
  deleted: () => m.imports_failed_deleted(),
  internal: () => m.imports_failed_internal(),
};

/** What a phone recording's import says (ADR 032): filed in Today. */
export function phoneNotice(result: ImportPickResult): string | null {
  if (result.outcome === "phone") return m.imports_phone_filed();
  if (result.outcome === "already") return m.imports_phone_already();
  return null;
}

/** At most this many files in one drop or paste. */
const MAX_FILES = 20;

export function useImport() {
  const queryClient = useQueryClient();
  const toasts = useToastManager();
  const navigate = useNavigate();
  const told = (result: ImportPickResult, retry: () => void) => {
    if (result.outcome === "cancelled") return;
    if (result.outcome === "failed") {
      toasts.add({
        title: importFailure[result.problem](),
        actionProps: { children: m.retry(), onClick: retry },
      });
      return;
    }
    toasts.add({
      title: phoneNotice(result) ?? m.imports_done(),
      actionProps: {
        children: m.imports_open(),
        onClick: () =>
          void navigate({ to: "/episode/$id", params: { id: String(result.episodeId) } }),
      },
    });
  };
  const refresh = () => void queryClient.invalidateQueries();
  const pick = useMutation(
    orpc.imports.pick.mutationOptions({
      onSuccess: (result) => {
        told(result, () => pick.mutate({}));
        if (result.outcome !== "cancelled" && result.outcome !== "failed") refresh();
      },
      onError: (error) => toasts.add({ title: errorMessage(error) }),
    }),
  );
  const add = useMutation(
    orpc.imports.add.mutationOptions({
      onSuccess: ({ results }, { paths }) => {
        results.forEach((result, index) =>
          told(result, () => add.mutate({ paths: [paths[index] ?? ""] })),
        );
        if (results.some((result) => result.outcome !== "failed")) refresh();
      },
      onError: (error) => toasts.add({ title: errorMessage(error) }),
    }),
  );
  return {
    pending: pick.isPending || add.isPending,
    pick: () => pick.mutate({}),
    paths: (paths: readonly string[]) => {
      if (paths.length > 0) add.mutate({ paths: paths.slice(0, MAX_FILES) });
    },
  };
}

/**
 * A file dropped anywhere on the window imports it; a screen that takes a
 * drop itself (a conversation's context) handles it first.
 */
export function useImportDrop() {
  const imports = useImport();
  const [dragging, setDragging] = useState(false);
  const carriesFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");
  return {
    dragging,
    handlers: {
      onDragOver: (event: DragEvent) => {
        if (event.defaultPrevented || !carriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDragging(true);
      },
      onDragLeave: (event: DragEvent) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragging(false);
      },
      onDrop: (event: DragEvent) => {
        setDragging(false);
        if (event.defaultPrevented || window.sondine === undefined) return;
        event.preventDefault();
        imports.paths(window.sondine.pathsOfFiles([...event.dataTransfer.files]));
      },
    },
  };
}
