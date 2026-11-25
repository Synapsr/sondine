import { cn } from "@sondine/ui";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@sondine/ui/components/alert-dialog";
import { Button } from "@sondine/ui/components/button";
import { Input } from "@sondine/ui/components/input";
import {
  Dialog,
  DialogCornerClose,
  DialogDescription,
  DialogPopup,
  DialogTitle,
} from "@sondine/ui/components/dialog";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@sondine/ui/components/menu";
import { ChevronLeftIcon, EllipsisIcon } from "@sondine/ui/icon";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { errorMessage, orpc } from "../../core/orpc";
import { dayOf } from "../../lib/day";
import { dayTitle } from "../../lib/labels";
import { m } from "../../paraglide/messages.js";
import { cardClassName } from "../journal/journal-block";
import { ConversationRow } from "../today/today-rows";
import { VoiceReadSection } from "../voice-read/voice-read-panel";
import { backLinkClassName, screenClassName, titleClassName } from "../shell/screen";

// A person (`/people/$personId`): the conversations their name reaches, and
// those where Sondine only recognized their voice (marked, ADR 030), newest
// first, in a card as on Today. The « ⋯ » renames, merges someone into them
// (two names for one person, ADR 025; ⌘Z undoes it) and deletes them (their
// voices read « Voix N » again; the recordings stay, ADR 012), last and in
// red.

const fold = (text: string) =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase().trim();

export function PersonScreen() {
  const { personId } = useParams({ from: "/shell/people/$personId" });
  const id = Number(personId);
  const person = useQuery(orpc.people.get.queryOptions({ input: { personId: id } }));
  return (
    <div className={screenClassName}>
      <Link to="/people" className={backLinkClassName}>
        <ChevronLeftIcon />
        {m.nav_people()}
      </Link>
      {person.error === null ? null : (
        <p role="alert" className="text-error">
          {errorMessage(person.error)}
        </p>
      )}
      {person.data === undefined ? null : (
        <>
          <PersonHeader personId={id} name={person.data.summary.person.name} />
          {person.data.summary.person.self ? <VoiceReadSection /> : null}
          {person.data.episodes.length === 0 ? (
            <p className="text-cte-text-muted">{m.people_heard_none()}</p>
          ) : (
            <ul
              aria-label={m.people_conversations()}
              className={`${cardClassName} gap-zero p-zero`}
            >
              {person.data.episodes.map((episode) => (
                <ConversationRow
                  key={episode.id}
                  episode={episode}
                  progress={undefined}
                  waitReason={null}
                  nowMs={Date.now()}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function PersonHeader({ personId, name }: { personId: number; name: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(name);
  const [confirming, setConfirming] = useState(false);
  const [merging, setMerging] = useState(false);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.people.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.episodes.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.search.key() }),
      // Deleting the user deletes their voice read (ADR 034).
      queryClient.invalidateQueries({ queryKey: orpc.voiceRead.key() }),
    ]);
  const rename = useMutation(
    orpc.people.rename.mutationOptions({
      onSuccess: async () => {
        setEditing(false);
        await refresh();
      },
    }),
  );
  const remove = useMutation(
    orpc.people.delete.mutationOptions({
      onSuccess: async () => {
        setConfirming(false);
        queryClient.removeQueries({ queryKey: orpc.people.get.key() });
        // Core erased the discussions that read Sondine (ADR 027): so does the window.
        queryClient.removeQueries({ queryKey: orpc.chat.watch.key() });
        await navigate({ to: "/people" });
        await refresh();
      },
    }),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (text.trim() !== "") rename.mutate({ personId, name: text });
  };
  const error = rename.error ?? remove.error;
  return (
    <header className="flex flex-col gap-s">
      {editing ? (
        <form onSubmit={submit} className="flex items-center gap-xs">
          <Input
            autoFocus
            aria-label={m.people_name_label()}
            maxLength={80}
            value={text}
            onValueChange={(value) => setText(value)}
            className="max-w-[24rem]"
          />
          <Button type="submit" isPending={rename.isPending}>
            {m.people_rename_save()}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setEditing(false);
              setText(name);
            }}
          >
            {m.cancel()}
          </Button>
        </form>
      ) : (
        <div className="flex items-center gap-xs">
          <h1 className={cn(titleClassName, "min-w-0 flex-1 truncate")}>{name}</h1>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={m.people_more()}
                  // Its inset hangs outside: the icon lines up with the content's edge.
                  className="-me-s"
                />
              }
            >
              <EllipsisIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem
                onClick={() => {
                  setText(name);
                  setEditing(true);
                }}
              >
                {m.people_rename()}
              </MenuItem>
              <MenuItem onClick={() => setMerging(true)}>{m.people_merge()}</MenuItem>
              <MenuSeparator />
              <MenuItem variant="danger" onClick={() => setConfirming(true)}>
                {m.people_delete()}
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      )}
      {error === null ? null : (
        <p role="alert" className="text-error">
          {errorMessage(error)}
        </p>
      )}
      <MergePerson
        personId={personId}
        name={name}
        open={merging}
        onOpenChange={setMerging}
        onMerged={refresh}
      />
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup>
          <AlertDialogTitle>{m.people_delete_title({ name })}</AlertDialogTitle>
          <AlertDialogDescription>{m.people_delete_description()}</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogClose>{m.cancel()}</AlertDialogClose>
            <Button
              variant="danger"
              isPending={remove.isPending}
              onClick={() => remove.mutate({ personId })}
            >
              {m.people_delete_confirm()}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </header>
  );
}

/**
 * « Fusionner avec… »: the person picked was this one under another name.
 * Their conversations join this page, which keeps its name.
 */
function MergePerson({
  personId,
  name,
  open,
  onOpenChange,
  onMerged,
}: {
  personId: number;
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMerged: () => Promise<unknown>;
}) {
  const queryClient = useQueryClient();
  const setOpen = onOpenChange;
  const [text, setText] = useState("");
  const people = useQuery({ ...orpc.people.list.queryOptions(), enabled: open });
  const merge = useMutation(
    orpc.people.merge.mutationOptions({
      onSuccess: async () => {
        setOpen(false);
        setText("");
        // Core erased the discussions that read the name merged away (ADR 027).
        queryClient.removeQueries({ queryKey: orpc.chat.watch.key() });
        await onMerged();
      },
    }),
  );
  const query = fold(text);
  const others = (people.data?.people ?? []).filter(
    (summary) =>
      summary.person.id !== personId && (query === "" || fold(summary.person.name).includes(query)),
  );
  const today = dayOf(Date.now());
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) merge.reset();
      }}
    >
      <DialogPopup className="w-[24rem] gap-s">
        <DialogCornerClose aria-label={m.close()} />
        <DialogTitle>{m.people_merge_title()}</DialogTitle>
        <DialogDescription>{m.people_merge_description({ name })}</DialogDescription>
        <Input
          autoFocus
          aria-label={m.people_merge_filter()}
          placeholder={m.people_merge_filter()}
          maxLength={80}
          value={text}
          onValueChange={(value) => setText(value)}
        />
        {people.data === undefined ? null : others.length === 0 ? (
          <p className="text-body-s text-cte-text-muted">{m.people_merge_none()}</p>
        ) : (
          <ul
            aria-label={m.voice_people()}
            className="-mx-xxs flex max-h-[16rem] flex-col overflow-y-auto px-xxs"
          >
            {others.map(({ person, lastHeardMs }) => (
              <li key={person.id}>
                <Button
                  variant="ghost"
                  className="w-full justify-start"
                  isPending={merge.isPending && merge.variables.otherId === person.id}
                  disabled={merge.isPending}
                  onClick={() => merge.mutate({ personId, otherId: person.id })}
                >
                  <span className="min-w-0 flex-1 truncate text-start">{person.name}</span>
                  {person.self ? (
                    <span className="text-body-xs text-cte-text-muted">{m.voice_self()}</span>
                  ) : lastHeardMs === null ? null : (
                    <span className="text-body-xs text-cte-text-muted">
                      {dayTitle(dayOf(lastHeardMs), today)}
                    </span>
                  )}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {merge.error === null ? null : (
          <p role="alert" className="text-body-s text-error">
            {errorMessage(merge.error)}
          </p>
        )}
      </DialogPopup>
    </Dialog>
  );
}
