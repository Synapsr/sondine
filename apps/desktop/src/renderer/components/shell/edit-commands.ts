import type { UndoAction, UndoStep } from "@sondine/api";
import { useToastManager } from "@sondine/ui/components/toast";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import type { EditCommand } from "../../../shared/bridge";
import { errorMessage, orpc } from "../../core/orpc";
import { m } from "../../paraglide/messages.js";
import { usePlayer } from "../player/player-provider";

// Édition ▸ Annuler / Rétablir (⌘Z, ⇧⌘Z). Main sends both the menu and the
// keys here, so one press does one thing: in a text field (or an open
// editor, marked `data-edit-scope`) it undoes typing; anywhere else it asks
// core to undo the last edit (a split, a merge, a type, a correction, a
// name, the context, « Terminer »), says what was undone, and leaves an episode that no
// longer exists.

/** Input types that hold no text: undo there is the window's. */
const NOT_TEXT = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** Whether ⌘Z belongs to what has focus (typing), not to the window's history. */
export function inTextScope(element: Element | null): boolean {
  if (element === null) return false;
  if (element.closest("[data-edit-scope]") !== null) return true;
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return true;
  if (element instanceof HTMLInputElement) return !NOT_TEXT.has(element.type);
  return (
    element instanceof HTMLElement &&
    (element.isContentEditable || element.getAttribute("role") === "textbox")
  );
}

const DONE: Record<EditCommand, Record<UndoAction, () => string>> = {
  undo: {
    split: m.undo_split,
    merge: m.undo_merge,
    kind: m.undo_kind,
    text: m.undo_text,
    name: m.undo_name,
    refusal: m.undo_refusal,
    "people-merge": m.undo_people_merge,
    context: m.undo_context,
    "voice-merge": m.undo_voice_merge,
    end: m.undo_end,
  },
  redo: {
    split: m.redo_split,
    merge: m.redo_merge,
    kind: m.redo_kind,
    text: m.redo_text,
    name: m.redo_name,
    refusal: m.redo_refusal,
    "people-merge": m.redo_people_merge,
    context: m.redo_context,
    "voice-merge": m.redo_voice_merge,
    end: m.redo_end,
  },
};

const EPISODE_PATH = /^\/episode\/(\d+)/u;
const PERSON_PATH = /^\/people\/(\d+)/u;

export function useEditCommands(): void {
  const queryClient = useQueryClient();
  const toasts = useToastManager();
  const router = useRouter();
  const player = usePlayer();

  useEffect(() => {
    const settle = async (command: EditCommand, step: UndoStep) => {
      if (step.outcome === "nothing") return;
      if (step.outcome === "refused") {
        const changed = step.reason === "changed";
        toasts.add({
          title:
            command === "undo"
              ? changed
                ? m.undo_changed()
                : m.undo_impossible()
              : changed
                ? m.redo_changed()
                : m.redo_impossible(),
        });
        return;
      }
      toasts.add({ title: DONE[command][step.action]() });
      const gone = new Set(step.removed);
      const playing = player.getSnapshot().episodeId;
      if (playing !== null && gone.has(playing)) player.stop();
      const shown = EPISODE_PATH.exec(router.state.location.pathname)?.[1];
      const [kept] = step.kept;
      if (shown !== undefined && gone.has(Number(shown)) && kept !== undefined) {
        await router.navigate({
          to: "/episode/$id",
          params: { id: String(kept) },
          replace: true,
        });
      }
      // A person the step took away (a merge redone, a new name undone): their
      // page opens the one who stays in a merge, People otherwise.
      const person = PERSON_PATH.exec(router.state.location.pathname)?.[1];
      const stays = step.action === "people-merge" ? step.keptPeople[0] : undefined;
      if (person !== undefined && step.removedPeople.includes(Number(person))) {
        queryClient.removeQueries({ queryKey: orpc.people.get.key() });
        await router.navigate(
          stays === undefined
            ? { to: "/people", replace: true }
            : { to: "/people/$personId", params: { personId: String(stays) }, replace: true },
        );
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: orpc.episodes.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.search.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.people.key() }),
      ]);
    };
    return window.sondine.onEditCommand((command) => {
      if (inTextScope(document.activeElement)) {
        // oxlint-disable-next-line typescript/no-deprecated -- the only way to reach a field's own undo.
        document.execCommand(command);
        return;
      }
      // Every press counts: core takes the steps one after the other, in order.
      const step = command === "undo" ? orpc.history.undo.call({}) : orpc.history.redo.call({});
      void step
        .then((result) => settle(command, result))
        .catch((error: unknown) => toasts.add({ title: errorMessage(error) }));
    });
  }, [player, queryClient, router, toasts]);
}
