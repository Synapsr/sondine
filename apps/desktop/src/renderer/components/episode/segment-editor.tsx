import type { TranscriptSegment } from "@sondine/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { errorMessage, orpc } from "../../core/orpc";
import { m } from "../../paraglide/messages.js";

// Correcting a segment's text in place (M2). Enter saves, Escape cancels,
// leaving the field saves what changed; « Rétablir l'original » puts the
// engine's text back. The correction is the user's: search, exports and
// agents read it, and a new transcript of the same audio keeps it.

export interface SegmentTarget {
  readonly episodeId: number;
  /** The transcript version the segment is in. */
  readonly runId: number;
}

/** How editing ended: by key (focus goes back to the segment) or by leaving the field. */
export type EditEnd = "key" | "away";

export function SegmentEditor({
  target,
  segment,
  onDone,
}: {
  target: SegmentTarget;
  segment: TranscriptSegment;
  onDone: (end: EditEnd) => void;
}) {
  const queryClient = useQueryClient();
  const [text, setText] = useState(segment.text);
  const container = useRef<HTMLDivElement>(null);
  // Once closing, a blur (the field leaving the page) saves nothing more.
  const closing = useRef<EditEnd | null>(null);
  const refresh = async () => {
    onDone(closing.current ?? "key");
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.episodes.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.search.key() }),
    ]);
  };
  // A failed save keeps the draft open, with why.
  const reopen = () => {
    closing.current = null;
  };
  const edit = useMutation(
    orpc.transcript.edit.mutationOptions({ onSuccess: refresh, onError: reopen }),
  );
  const restore = useMutation(
    orpc.transcript.restore.mutationOptions({ onSuccess: refresh, onError: reopen }),
  );
  const pending = edit.isPending || restore.isPending;
  const error = edit.error ?? restore.error;
  const where = { ...target, segmentId: segment.id };

  const save = (end: EditEnd) => {
    if (closing.current !== null || pending) return;
    const next = text.trim();
    closing.current = end;
    if (next === "" || next === segment.text) {
      onDone(end);
      return;
    }
    edit.mutate({ ...where, text: next });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      save("key");
    } else if (event.key === "Escape") {
      event.preventDefault();
      closing.current = "key";
      onDone("key");
    }
  };

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    // Moving to « Rétablir l'original » is not leaving.
    if (event.relatedTarget instanceof Node && container.current?.contains(event.relatedTarget)) {
      return;
    }
    save("away");
  };

  return (
    // ⌘Z inside the editor undoes typing, even from « Rétablir l'original ».
    <div ref={container} data-edit-scope className="-mx-xs flex flex-col gap-xxs" onBlur={onBlur}>
      <textarea
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- the pen asked for this field.
        autoFocus
        aria-label={m.episode_segment_text()}
        value={text}
        maxLength={2_000}
        readOnly={pending}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        onFocus={(event) => event.target.setSelectionRange(text.length, text.length)}
        className="field-sizing-content min-h-(--line-m) resize-none corner-s bg-neutral-2 px-xs py-xxs font-body font-regular text-body-m text-cte-text focus-ring"
      />
      {!segment.edited && error === null ? null : (
        <div className="flex flex-wrap items-baseline gap-s px-xs">
          {segment.edited ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                closing.current = "key";
                restore.mutate(where);
              }}
              className="corner-xs text-body-s text-cte-text-muted underline underline-offset-4 focus-ring"
            >
              {m.episode_segment_restore()}
            </button>
          ) : null}
          {error === null ? null : (
            <span role="alert" className="text-body-s text-error">
              {errorMessage(error)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
