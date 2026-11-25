import type { ContextAddResult, ContextItem, ContextRefusal } from "@sondine/api";
import { cn } from "@sondine/ui";
import { Button } from "@sondine/ui/components/button";
import { Input } from "@sondine/ui/components/input";
import { Popover, PopoverPopup, PopoverTrigger } from "@sondine/ui/components/popover";
import { useToastManager } from "@sondine/ui/components/toast";
import {
  ExternalLinkIcon,
  FileIcon,
  ImageIcon,
  LinkIcon,
  PenIcon,
  PinIcon,
  WaveformIcon,
  XIcon,
} from "@sondine/ui/icon";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  useEffect,
  useState,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { errorMessage, orpc } from "../../core/orpc";
import { formatBytes } from "../../lib/bytes";
import { m } from "../../paraglide/messages.js";
import { getLocale } from "../../paraglide/runtime.js";
import { importFailure } from "../imports/import-actions";

// What the user adds to a conversation (ADR 024): a « Contexte » strip under
// the header (images as thumbnails, links, notes, files), ⌘V and drops
// anywhere on the page, and « Ajouter du contexte » for a note or a link and
// the open panel. Sondine tells a link from a note; nothing is fetched. An
// item pinned to a sentence shows that sentence's time, and the transcript
// marks the sentence. An audio file offers « Transcrire »: an imported
// recording made of it, deleted with the conversation.

const problemText: Record<ContextRefusal["problem"], () => string> = {
  unreadable: m.context_problem_unreadable,
  "too-large": m.context_problem_too_large,
  "disk-full": m.context_problem_disk_full,
  "too-long": m.context_problem_too_long,
  "too-many": m.context_problem_too_many,
  empty: m.context_problem_empty,
};

/** Whether an event's target is a field the user types in (⌘V belongs to it). */
export function typingIn(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

/** The element id of an item in the strip, for the transcript's markers. */
export const contextItemDomId = (itemId: number) => `context-item-${itemId}`;

/** What an item is called on screen and for screen readers. */
export function contextName(item: ContextItem): string {
  if (item.kind === "note") return m.context_note();
  if (item.kind === "link") return item.title ?? hostOf(item.text);
  return item.title ?? "";
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./u, "");
  } catch {
    return url;
  }
}

/** Adding, from anywhere on the conversation; refusals and failures as toasts. */
export function useContextAdd(episodeId: number) {
  const queryClient = useQueryClient();
  const toasts = useToastManager();
  const settle = {
    onSuccess: async (result: ContextAddResult, input: unknown) => {
      for (const refusal of result.refused) {
        toasts.add({
          title:
            refusal.name === null
              ? problemText[refusal.problem]()
              : m.context_refused({
                  name: refusal.name,
                  problem: problemText[refusal.problem](),
                }),
        });
      }
      const pasted = typeof input === "object" && input !== null && !("text" in input);
      if (pasted && result.itemIds.length === 0 && result.refused.length === 0) {
        toasts.add({ title: m.context_clipboard_empty() });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: orpc.episodes.get.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.search.key() }),
      ]);
    },
    onError: (error: Error) => toasts.add({ title: errorMessage(error) }),
  };
  const add = useMutation(orpc.context.add.mutationOptions(settle));
  const paste = useMutation(orpc.context.paste.mutationOptions(settle));
  const pick = useMutation(orpc.context.pick.mutationOptions(settle));
  return {
    add,
    paste,
    pick,
    pending: add.isPending || paste.isPending || pick.isPending,
    /** What a drop carries: files by their paths, else a link or text. */
    drop(event: DragEvent, segmentId?: number) {
      if (window.sondine === undefined) return;
      const paths = window.sondine.pathsOfFiles([...event.dataTransfer.files]);
      const target = segmentId === undefined ? { episodeId } : { episodeId, segmentId };
      if (paths.length > 0) {
        add.mutate({ ...target, paths: paths.slice(0, 20) });
        return;
      }
      const uri = event.dataTransfer
        .getData("text/uri-list")
        .split(/\r?\n/u)
        .find((line) => /^https?:\/\//iu.test(line.trim()));
      const text = uri ?? event.dataTransfer.getData("text/plain");
      if (text.trim() !== "") add.mutate({ ...target, text });
    },
  };
}

/** Whether a drag carries something the conversation takes (files, a link, text). */
export function carriesContext(event: DragEvent): boolean {
  const types = event.dataTransfer.types;
  return types.includes("Files") || types.includes("text/uri-list") || types.includes("text/plain");
}

/** ⌘V outside a field adds the clipboard to the conversation. */
export function useContextPaste(adding: ReturnType<typeof useContextAdd>, episodeId: number) {
  const { paste } = adding;
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (typingIn(event.target) || typingIn(document.activeElement)) return;
      event.preventDefault();
      paste.mutate({ episodeId });
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [paste, episodeId]);
}

/**
 * One field for a note or a link, and « Choisir des fichiers… »; pinned to
 * a sentence when `segmentId` is given.
 */
export function ContextAddPopover({
  episodeId,
  segmentId,
  adding,
  trigger,
  size = "icon",
  className,
}: {
  episodeId: number;
  segmentId?: number;
  adding: ReturnType<typeof useContextAdd>;
  trigger: ReactNode;
  /** `icon-s` beside a sentence. */
  size?: "icon" | "icon-s";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const target = segmentId === undefined ? { episodeId } : { episodeId, segmentId };
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (text.trim() === "") return;
    adding.add.mutate(
      { ...target, text },
      {
        onSuccess: (result) => {
          if (result.itemIds.length > 0) {
            setText("");
            setOpen(false);
          }
        },
      },
    );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) submit();
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size={size}
            className={className}
            aria-label={segmentId === undefined ? m.context_add() : m.context_add_here()}
          />
        }
      >
        {trigger}
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-[22rem] gap-s">
        <form className="flex flex-col gap-s" onSubmit={submit}>
          <textarea
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- the button asked for this field.
            autoFocus
            data-edit-scope
            aria-label={m.context_field_label()}
            placeholder={m.context_field_placeholder()}
            value={text}
            maxLength={20_000}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            className={cn(
              "field-sizing-content min-h-[calc(var(--line-s)*2)] max-h-[16rem] focus-ring",
              "corner-s px-xs py-xxs",
              "text-body-s",
              "resize-none bg-neutral-2 text-cte-text",
            )}
          />
          <div className="flex items-center justify-between gap-s">
            <Button
              variant="ghost"
              disabled={adding.pending}
              onClick={() => {
                setOpen(false);
                adding.pick.mutate(target);
              }}
            >
              {m.context_pick()}
            </Button>
            <Button type="submit" isPending={adding.add.isPending} disabled={text.trim() === ""}>
              {m.context_add_submit()}
            </Button>
          </div>
          {segmentId === undefined ? (
            <p className="text-body-xs text-cte-text-muted">{m.context_shortcut_hint()}</p>
          ) : null}
        </form>
      </PopoverPopup>
    </Popover>
  );
}

/** The conversation's context, oldest first; nothing when it has none. */
export function ContextStrip({
  items,
  pinnedAt,
  onShowSentence,
}: {
  items: readonly ContextItem[];
  /** Where a pinned item's sentence is, as the transcript says it (« 00:40 »). */
  pinnedAt: (item: ContextItem) => string;
  /** Scrolls the transcript to a pinned item's sentence. */
  onShowSentence: (segmentId: number) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section aria-label={m.context_title()} className="flex flex-col gap-s">
      <h2 className="font-body font-medium text-body-s text-cte-text-muted">{m.context_title()}</h2>
      <ul className="flex flex-wrap items-start gap-x-s gap-y-m">
        {items.map((item) => (
          <ContextEntry
            key={item.id}
            item={item}
            time={pinnedAt(item)}
            onShowSentence={onShowSentence}
          />
        ))}
      </ul>
    </section>
  );
}

function useItemActions(item: ContextItem) {
  const queryClient = useQueryClient();
  const toasts = useToastManager();
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.episodes.get.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.search.key() }),
    ]);
  const onError = (error: Error) => toasts.add({ title: errorMessage(error) });
  return {
    open: useMutation(orpc.context.open.mutationOptions({ onError })),
    remove: useMutation(
      orpc.context.remove.mutationOptions({
        onSuccess: async () => {
          // « Retirer » keeps the transcription: the toast says where it stays.
          toasts.add({
            title:
              item.file?.transcript?.episodeId == null
                ? m.context_removed()
                : m.context_removed_transcribed(),
          });
          await refresh();
        },
        onError,
      }),
    ),
    transcribe: useMutation(
      orpc.context.transcribe.mutationOptions({
        onSuccess: async (result) => {
          if (result.outcome === "failed") {
            toasts.add({ title: importFailure[result.problem]() });
          }
          await Promise.all([
            refresh(),
            queryClient.invalidateQueries({ queryKey: orpc.imports.key() }),
          ]);
        },
        onError,
      }),
    ),
    edit: useMutation(orpc.context.edit.mutationOptions({ onSuccess: refresh, onError })),
    unpin: useMutation(orpc.context.unpin.mutationOptions({ onSuccess: refresh, onError })),
    target: { itemId: item.id },
  };
}

const entryClassName =
  "group/context relative flex max-w-[20rem] flex-col corner-s bg-neutral-2 focus-ring";

function ContextEntry({
  item,
  time,
  onShowSentence,
}: {
  item: ContextItem;
  time: string;
  onShowSentence: (segmentId: number) => void;
}) {
  const actions = useItemActions(item);
  const [editing, setEditing] = useState(false);
  const name = contextName(item);
  const body =
    item.kind === "image" && item.file?.preview != null ? (
      <button
        type="button"
        aria-label={m.context_open({ name })}
        onClick={() => actions.open.mutate(actions.target)}
        className="block overflow-hidden corner-s focus-ring"
      >
        <img
          src={item.file.preview}
          alt={name}
          className="block h-[6rem] w-auto max-w-[16rem] object-cover"
          draggable={false}
        />
      </button>
    ) : item.kind === "note" ? (
      editing ? (
        <NoteEditor
          item={item}
          pending={actions.edit.isPending}
          onSave={(text) =>
            actions.edit.mutate(
              { itemId: item.id, kind: "note", text },
              { onSettled: () => setEditing(false) },
            )
          }
          onCancel={() => setEditing(false)}
        />
      ) : (
        <p className="line-clamp-4 whitespace-pre-line px-s py-xs text-body-s">{item.text}</p>
      )
    ) : (
      <button
        type="button"
        aria-label={m.context_open({ name })}
        onClick={() => actions.open.mutate(actions.target)}
        className={cn(
          "flex min-w-0 items-center gap-xxs focus-ring",
          "corner-s px-s py-xs",
          "text-start text-body-s",
          "control-hover:text-cte-text",
        )}
      >
        {item.kind === "link" ? (
          <LinkIcon className="shrink-0 text-cte-text-muted" />
        ) : item.kind === "image" ? (
          <ImageIcon className="shrink-0 text-cte-text-muted" />
        ) : (
          <FileIcon className="shrink-0 text-cte-text-muted" />
        )}
        <span className="truncate underline underline-offset-4">{name}</span>
        {item.kind === "link" ? (
          <ExternalLinkIcon className="shrink-0 text-cte-text-muted" />
        ) : (
          <span className="shrink-0 text-body-xs text-cte-text-muted">
            {item.file === null ? "" : formatBytes(item.file.bytes, getLocale())}
          </span>
        )}
      </button>
    );
  const transcript = item.file?.transcript ?? null;
  return (
    <li id={contextItemDomId(item.id)} tabIndex={-1} className={entryClassName}>
      {body}
      {transcript === null ? null : (
        <span className="flex items-center gap-xxs px-xs pb-xxs text-body-xs text-cte-text-muted">
          <WaveformIcon />
          {transcript.episodeId === null ? (
            <button
              type="button"
              disabled={actions.transcribe.isPending}
              onClick={() => actions.transcribe.mutate(actions.target)}
              className="corner-xs underline underline-offset-4 focus-ring control-hover:text-cte-text disabled:no-underline"
            >
              {actions.transcribe.isPending ? m.context_transcribing() : m.context_transcribe()}
            </button>
          ) : (
            <Link
              to="/episode/$id"
              params={{ id: String(transcript.episodeId) }}
              className="corner-xs underline underline-offset-4 focus-ring control-hover:text-cte-text"
            >
              {m.context_transcript()}
            </Link>
          )}
        </span>
      )}
      {item.pinned ? (
        <span className="flex items-center gap-xs px-xs pb-xxs text-body-xs text-cte-text-muted">
          <button
            type="button"
            disabled={item.segmentId === null}
            aria-label={m.context_pinned_at({ time })}
            title={m.context_pinned_at({ time })}
            onClick={() => item.segmentId !== null && onShowSentence(item.segmentId)}
            className={cn(
              "flex items-center gap-xxs focus-ring",
              "corner-xs",
              "font-data tabular-nums",
              "control-hover:text-cte-text",
            )}
          >
            <PinIcon />
            {time}
          </button>
          <button
            type="button"
            aria-label={m.context_unpin_label()}
            disabled={actions.unpin.isPending}
            onClick={() => actions.unpin.mutate(actions.target)}
            className={cn(
              "invisible focus-ring",
              "corner-xs",
              "underline underline-offset-4",
              "group-hover/context:visible group-focus-within/context:visible control-hover:text-cte-text",
            )}
          >
            {m.context_unpin()}
          </button>
        </span>
      ) : null}
      {/* On hover, on the item's corner: they take no room and hide nothing that matters. */}
      <div
        className={cn(
          "absolute bottom-full end-xs z-[1] flex translate-y-[40%] items-center corner-s bg-cte-surface shadow-m",
          "opacity-0 transition-opacity duration-motion ease-motion motion-reduce:transition-none",
          "group-hover/context:opacity-100 group-focus-within/context:opacity-100",
          editing && "hidden",
        )}
      >
        {item.kind === "note" ? (
          <Button
            variant="ghost"
            size="icon-s"
            aria-label={m.context_edit({ name })}
            onClick={() => setEditing(true)}
          >
            <PenIcon />
          </Button>
        ) : null}
        {item.kind === "link" ? <LinkEditor item={item} actions={actions} /> : null}
        <Button
          variant="ghost"
          size="icon-s"
          aria-label={m.context_remove({ name })}
          isPending={actions.remove.isPending}
          onClick={() => actions.remove.mutate(actions.target)}
        >
          <XIcon />
        </Button>
      </div>
    </li>
  );
}

function NoteEditor({
  item,
  pending,
  onSave,
  onCancel,
}: {
  item: ContextItem;
  pending: boolean;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(item.text);
  const save = () => {
    const next = text.trim();
    if (next === "" || next === item.text) onCancel();
    else onSave(next);
  };
  return (
    <textarea
      // oxlint-disable-next-line jsx-a11y/no-autofocus -- the pen asked for this field.
      autoFocus
      data-edit-scope
      aria-label={m.context_text()}
      value={text}
      maxLength={20_000}
      readOnly={pending}
      onChange={(event) => setText(event.target.value)}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          save();
        } else if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
      className={cn(
        "field-sizing-content min-h-(--line-m) w-[18rem] focus-ring",
        "corner-s px-xs py-xxs",
        "text-body-s",
        "resize-none bg-neutral-3 text-cte-text",
      )}
    />
  );
}

/** A link's title and address, in a popover. */
function LinkEditor({
  item,
  actions,
}: {
  item: ContextItem;
  actions: ReturnType<typeof useItemActions>;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(item.title ?? "");
  const [url, setUrl] = useState(item.text);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setTitle(item.title ?? "");
          setUrl(item.text);
        }
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-s"
            aria-label={m.context_edit({ name: contextName(item) })}
          />
        }
      >
        <PenIcon />
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-[22rem] gap-s">
        <form
          className="flex flex-col gap-s"
          onSubmit={(event) => {
            event.preventDefault();
            actions.edit.mutate(
              { itemId: item.id, kind: "link", url, title: title.trim() === "" ? null : title },
              { onSuccess: () => setOpen(false) },
            );
          }}
        >
          <label className="flex flex-col gap-xxs text-body-s">
            {m.context_link_title()}
            <Input value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label className="flex flex-col gap-xxs text-body-s">
            {m.context_link_url()}
            <Input value={url} onChange={(event) => setUrl(event.target.value)} />
          </label>
          <Button type="submit" className="self-end" isPending={actions.edit.isPending}>
            {m.context_save()}
          </Button>
        </form>
      </PopoverPopup>
    </Popover>
  );
}
