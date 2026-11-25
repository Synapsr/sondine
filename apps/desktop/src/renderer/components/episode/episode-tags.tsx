import { tagKey, tagName } from "@sondine/core/tags";
import { cn } from "@sondine/ui";
import { Button } from "@sondine/ui/components/button";
import { Popover, PopoverPopup, PopoverTrigger } from "@sondine/ui/components/popover";
import { useToastManager } from "@sondine/ui/components/toast";
import { CheckIcon, PlusIcon, TagIcon } from "@sondine/ui/icon";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { errorMessage, orpc } from "../../core/orpc";
import { m } from "../../paraglide/messages.js";

// An episode's tags (ADR 039): free words the user gives a whole recording,
// to find it again. The header's tag button opens the tags, most recent
// first, ticked when on, and a field; a tag on the episode is a chip that
// opens the search on it.

/** The episode's tags as chips, each opening the search on it; nothing when none. */
export function EpisodeTagChips({ tags }: { tags: readonly string[] }) {
  if (tags.length === 0) return null;
  return (
    <ul aria-label={m.tags_label()} className="flex flex-wrap items-center gap-xs">
      {tags.map((tag) => (
        <li key={tag}>
          <Link
            to="/search"
            search={{ tag }}
            className={cn(
              "flex items-center gap-xxs corner-full px-s py-xxs focus-ring",
              "text-cte-text-muted ring-[1px] ring-neutral-4",
              "transition-[background-color,color] duration-motion ease-motion motion-reduce:transition-none",
              "control-hover:bg-neutral-3 control-hover:text-cte-text",
            )}
          >
            <span aria-hidden>#</span>
            {tag}
          </Link>
        </li>
      ))}
    </ul>
  );
}

const rowClassName = cn(
  "flex w-full items-center gap-xs corner-s px-xs py-xxs text-start focus-ring",
  "control-hover:bg-neutral-3",
);

/** The header's tag button: the tags to tick, and a field for a new one. */
export function TagPopover({ episodeId, tags }: { episodeId: number; tags: readonly string[] }) {
  const [text, setText] = useState("");
  const queryClient = useQueryClient();
  const toasts = useToastManager();
  const all = useQuery(orpc.tags.list.queryOptions()).data?.tags ?? [];
  const set = useMutation(
    orpc.tags.set.mutationOptions({
      onSuccess: () =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.episodes.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.tags.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.search.key() }),
        ]),
      onError: (error) => toasts.add({ title: errorMessage(error) }),
    }),
  );
  const typed = tagName(text);
  const wanted = typed === null ? "" : tagKey(typed);
  const shown = all.filter((tag) => tagKey(tag.name).includes(wanted));
  const exact = all.find((tag) => tagKey(tag.name) === wanted);
  const has = (name: string) => tags.some((tag) => tagKey(tag) === tagKey(name));
  const toggle = (name: string) => set.mutate({ episodeId, name, on: !has(name) });
  // Return ticks the tag with that name, else creates it: the last row says which.
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (typed === null) return;
    if (exact === undefined || !has(exact.name)) {
      set.mutate({ episodeId, name: exact?.name ?? typed, on: true });
    }
    setText("");
  };
  return (
    <Popover onOpenChange={(open) => (open ? null : setText(""))}>
      <PopoverTrigger render={<Button variant="ghost" size="icon" aria-label={m.tags_add()} />}>
        <TagIcon />
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-[18rem] gap-xs p-xs">
        <form onSubmit={submit}>
          <input
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- the button asked for this field.
            autoFocus
            data-edit-scope
            aria-label={m.tags_field()}
            placeholder={m.tags_placeholder()}
            value={text}
            maxLength={200}
            onChange={(event) => setText(event.target.value)}
            className="w-full corner-s bg-neutral-2 px-xs py-xxs text-body-s text-cte-text focus-ring"
          />
        </form>
        <ul className="flex max-h-[16rem] flex-col overflow-y-auto">
          {shown.map((tag) => (
            <li key={tag.id}>
              <button
                type="button"
                aria-pressed={has(tag.name)}
                onClick={() => toggle(tag.name)}
                className={rowClassName}
              >
                <span className="min-w-0 flex-1 truncate">{tag.name}</span>
                {has(tag.name) ? <CheckIcon className="text-cte-text" /> : null}
              </button>
            </li>
          ))}
          {typed === null || exact !== undefined ? null : (
            <li>
              <button
                type="button"
                onClick={() => {
                  set.mutate({ episodeId, name: typed, on: true });
                  setText("");
                }}
                className={cn(rowClassName, "text-cte-text-muted")}
              >
                <PlusIcon />
                <span className="min-w-0 flex-1 truncate">{m.tags_create({ name: typed })}</span>
              </button>
            </li>
          )}
        </ul>
      </PopoverPopup>
    </Popover>
  );
}
