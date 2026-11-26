import type { VocabularyEntry } from "@sondine/api";
import { Button } from "@sondine/ui/components/button";
import { Input } from "@sondine/ui/components/input";
import { useToastManager } from "@sondine/ui/components/toast";
import { TrashIcon } from "@sondine/ui/icon";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { errorMessage, orpc } from "../../core/orpc";
import { m } from "../../paraglide/messages.js";

// Settings ▸ « Vocabulaire » (ADR 046): the user's words, each with an
// optional note the journal's model reads, then their People's names, which
// count too. A word or a note is saved when its field is left; « Ajouter »
// adds one. Without the journal's model, one line says what still works.

export function VocabularySection() {
  const queryClient = useQueryClient();
  const toasts = useToastManager();
  const list = useQuery(orpc.vocabulary.list.queryOptions());
  const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.vocabulary.key() });
  const onError = (error: unknown) => toasts.add({ title: errorMessage(error) });
  const update = useMutation(
    orpc.vocabulary.update.mutationOptions({ onSuccess: refresh, onError }),
  );
  const remove = useMutation(
    orpc.vocabulary.remove.mutationOptions({ onSuccess: refresh, onError }),
  );
  const data = list.data;
  if (data === undefined) return null;
  return (
    <div className="flex flex-col gap-m">
      <p className="text-cte-text-muted">{m.vocabulary_intro()}</p>
      {data.words.length === 0 ? null : (
        <ul className="flex flex-col gap-xs">
          {data.words.map((entry) => (
            <WordRow
              key={`${entry.id}:${entry.word}:${entry.note ?? ""}`}
              entry={entry}
              onChange={(word, note) => update.mutate({ id: entry.id, word, note })}
              onRemove={() => remove.mutate({ id: entry.id })}
            />
          ))}
        </ul>
      )}
      <AddForm onAdded={refresh} />
      {data.people.length === 0 ? null : (
        <p className="text-body-s text-cte-text-muted">
          {m.vocabulary_people({ names: data.people.join(", ") })}
        </p>
      )}
      {data.modelReads ? null : (
        <p className="text-body-s text-cte-text-muted">{m.vocabulary_no_model()}</p>
      )}
    </div>
  );
}

/** One word of the list: its word and note, each saved when left. */
function WordRow({
  entry,
  onChange,
  onRemove,
}: {
  entry: VocabularyEntry;
  onChange: (word: string, note: string | null) => void;
  onRemove: () => void;
}) {
  const save = (word: string, note: string) => {
    const nextWord = word.trim();
    const nextNote = note.trim() === "" ? null : note.trim();
    if (nextWord === "" || (nextWord === entry.word && nextNote === entry.note)) return;
    onChange(nextWord, nextNote);
  };
  return (
    <li className="flex items-center gap-xs">
      <Input
        aria-label={m.vocabulary_word_of({ word: entry.word })}
        defaultValue={entry.word}
        maxLength={60}
        className="w-[12rem] shrink-0"
        onBlur={(event) => save(event.currentTarget.value, entry.note ?? "")}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") event.currentTarget.value = entry.word;
        }}
      />
      <Input
        aria-label={m.vocabulary_note_of({ word: entry.word })}
        placeholder={m.vocabulary_note_placeholder()}
        defaultValue={entry.note ?? ""}
        maxLength={200}
        className="min-w-0 flex-1"
        onBlur={(event) => save(entry.word, event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") event.currentTarget.value = entry.note ?? "";
        }}
      />
      <Button
        variant="ghost"
        size="icon"
        aria-label={m.vocabulary_remove({ word: entry.word })}
        onClick={onRemove}
      >
        <TrashIcon />
      </Button>
    </li>
  );
}

function AddForm({ onAdded }: { onAdded: () => void }) {
  const toasts = useToastManager();
  const [word, setWord] = useState("");
  const [note, setNote] = useState("");
  const add = useMutation(
    orpc.vocabulary.add.mutationOptions({
      onSuccess: () => {
        setWord("");
        setNote("");
        onAdded();
      },
      onError: (error) => toasts.add({ title: errorMessage(error) }),
    }),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (word.trim() === "") return;
    add.mutate({ word: word.trim(), note: note.trim() === "" ? null : note.trim() });
  };
  return (
    <form onSubmit={submit} className="flex items-center gap-xs">
      <Input
        aria-label={m.vocabulary_word_label()}
        placeholder={m.vocabulary_word_label()}
        maxLength={60}
        value={word}
        onValueChange={(next) => setWord(next)}
        className="w-[12rem] shrink-0"
      />
      <Input
        aria-label={m.vocabulary_note_label()}
        placeholder={m.vocabulary_note_placeholder()}
        maxLength={200}
        value={note}
        onValueChange={(next) => setNote(next)}
        className="min-w-0 flex-1"
      />
      <Button
        type="submit"
        variant="secondary"
        isPending={add.isPending}
        disabled={word.trim() === ""}
      >
        {m.vocabulary_add()}
      </Button>
    </form>
  );
}
