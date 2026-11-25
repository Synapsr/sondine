import type { EpisodeDetail, PeopleDoubtsOutput, PersonRef, VoiceMatch } from "@sondine/api";
import { cn } from "@sondine/ui";
import { Button } from "@sondine/ui/components/button";
import { Input } from "@sondine/ui/components/input";
import {
  Popover,
  PopoverDescription,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "@sondine/ui/components/popover";
import { useToastManager } from "@sondine/ui/components/toast";
import { CheckIcon } from "@sondine/ui/icon";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useRef, useState, type FormEvent } from "react";
import { errorMessage, orpc } from "../../core/orpc";
import { dayOf } from "../../lib/day";
import { confidenceLabel, dayTitle, voiceName } from "../../lib/labels";
import type { EpisodeVoice } from "../../lib/voices";
import { m } from "../../paraglide/messages.js";
import { mergedIn, namedIn, refusedIn, unnamedIn } from "./voice-changes";

// « Qui est-ce ? »: a voice of the transcript named by the user, from their
// people or a new name, or as themselves. The name is anchored to this
// voice's speech in this transcript version (`runId`) and shows wherever the
// voice speaks: the transcript, search, exports. Names stay on this Mac and
// agents never write them.
//
// An unnamed voice that sounds like someone reads « Marie ? »; one Sondine
// recognized (ADR 030) reads « Marie* », until the user confirms or
// corrects it. A ✓ beside the name confirms it in one click; hovering or
// clicking the name shows how sure Sondine is and asks Oui, Non or Modifier.
// Any other voice opens the editor on click. Every answer shows at once
// (ADR 037): the episode on screen changes before core answers, and comes
// back as it was if core refuses.

/** Ids for people named but not created yet, shown until core answers: never a real id. */
let unsaved = 0;

/** People offered under the field. */
const SUGGESTIONS = 5;

const fold = (text: string) =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase().trim();

/** One voice of one transcript version. */
export interface VoiceTarget {
  readonly episodeId: number;
  readonly runId: number;
  readonly label: string;
}

/** Whom a voice is named as, as « Qui est-ce ? » offers it. */
export type NameChoice =
  | { readonly kind: "existing"; readonly person: PersonRef }
  | { readonly kind: "new"; readonly name: string }
  | { readonly kind: "self" };

/** Sondine's guess for a voice nobody named: recognized first, else suggested. */
export function guessOf(
  person: PersonRef | null,
  recognized: VoiceMatch | null,
  suggestion: VoiceMatch | null,
): VoiceMatch | null {
  return person === null ? (recognized ?? suggestion) : null;
}

/**
 * Naming, unnaming, refusing a suggestion and merging voices. Each changes the
 * episode on screen first; then every screen that shows voices reads again.
 */
export function useVoiceActions(onStart: () => void = () => {}) {
  const queryClient = useQueryClient();
  const toasts = useToastManager();
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.episodes.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.search.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.people.key() }),
    ]);
  /** The way back for each action under way, by its input: run before the episode is read again. */
  const rollbacks = useRef(new WeakMap<object, () => void>());
  // A replaced transcript answers INVALID_INPUT: reading the episode again shows the new voices.
  const settle = {
    onError: (error: Error, input: object) => {
      rollbacks.current.get(input)?.();
      toasts.add({ title: errorMessage(error) });
    },
    onSettled: (_data: unknown, _error: unknown, input: object) => {
      rollbacks.current.delete(input);
      return refresh();
    },
  };
  /** Shows the change now, keeps its way back, then asks core. */
  const run = async <I extends VoiceTarget>(
    input: I,
    change: (detail: EpisodeDetail) => EpisodeDetail,
    mutate: (input: I) => void,
  ) => {
    rollbacks.current.set(input, await apply(input, change));
    mutate(input);
  };
  const name = useMutation(orpc.speakers.name.mutationOptions(settle));
  const unname = useMutation(orpc.speakers.unname.mutationOptions(settle));
  const refuse = useMutation(orpc.speakers.refuse.mutationOptions(settle));
  const merge = useMutation(orpc.speakers.merge.mutationOptions(settle));

  /** The episode as it will be, now; the way back if core refuses. */
  const apply = async (target: VoiceTarget, change: (detail: EpisodeDetail) => EpisodeDetail) => {
    onStart();
    const filter = {
      queryKey: orpc.episodes.get.key({ input: { episodeId: target.episodeId } }),
    };
    const doubtsKey = orpc.people.doubts.queryKey();
    // A read in flight would land over the change.
    await Promise.all([
      queryClient.cancelQueries(filter),
      queryClient.cancelQueries({ queryKey: doubtsKey }),
    ]);
    const before = queryClient.getQueriesData<EpisodeDetail>(filter);
    const doubts = queryClient.getQueryData<PeopleDoubtsOutput>(doubtsKey);
    // Any answer about a voice settles the doubt on its name (« À vérifier »).
    queryClient.setQueryData<PeopleDoubtsOutput>(doubtsKey, (data) =>
      data === undefined
        ? data
        : {
            voices: data.voices.filter(
              (voice) => voice.runId !== target.runId || voice.label !== target.label,
            ),
          },
    );
    queryClient.setQueriesData<EpisodeDetail>(filter, (detail) =>
      detail === undefined ? detail : change(detail),
    );
    return () => {
      for (const [key, data] of before) queryClient.setQueryData(key, data);
      queryClient.setQueryData(doubtsKey, doubts);
    };
  };
  /** The user's own row, when the window knows it: « C'est moi » shows at once as « Moi ». */
  const selfRef = (): PersonRef => {
    const people = queryClient.getQueryData(orpc.people.list.queryKey());
    const self = people?.people.find((summary) => summary.person.self)?.person;
    return self ?? { id: -1, name: m.voice_self(), self: true };
  };

  return {
    async name(target: VoiceTarget, choice: NameChoice) {
      const shown: PersonRef =
        choice.kind === "existing"
          ? choice.person
          : choice.kind === "self"
            ? selfRef()
            : // Its id comes with core's answer; until then one no person has.
              { id: (unsaved -= 1), name: choice.name.trim(), self: false };
      await run(
        {
          ...target,
          person:
            choice.kind === "existing"
              ? { kind: "existing" as const, personId: choice.person.id }
              : choice.kind === "self"
                ? { kind: "self" as const, name: m.voice_self() }
                : { kind: "new" as const, name: choice.name.trim() },
        },
        (detail) => namedIn(detail, target.label, shown),
        name.mutate,
      );
    },
    async unname(target: VoiceTarget) {
      await run({ ...target }, (detail) => unnamedIn(detail, target.label), unname.mutate);
    },
    async refuse(target: VoiceTarget, personId: number) {
      await run(
        { ...target, personId },
        (detail) => refusedIn(detail, target.label, personId),
        refuse.mutate,
      );
    },
    async merge(target: VoiceTarget, other: string) {
      await run(
        { ...target, other },
        (detail) => mergedIn(detail, target.label, other),
        merge.mutate,
      );
    },
  };
}

export type VoiceActions = ReturnType<typeof useVoiceActions>;

/** The name of a voice as a control: underlined, small in the transcript's narrow column. */
export const voiceTriggerClassName = (compact: boolean) =>
  cn(
    "self-start corner-xs font-body font-medium text-start underline decoration-dotted underline-offset-4 focus-ring",
    compact && "text-body-xs",
  );

/** « Marie », « Marie ? », or « Marie* » once recognized. */
export function VoiceLabel({
  voice,
  guess,
  recognized,
}: {
  voice: EpisodeVoice;
  /** `guessOf(…)` for the voice. */
  guess: VoiceMatch | null;
  /** The guess is a recognition (ADR 030): the voice already reads as the person, marked. */
  recognized: boolean;
}) {
  return guess === null || recognized
    ? voiceName(voice.voice)
    : m.voice_guess({ name: guess.person.name });
}

/** The likely answer in one click (ADR 037): a target of its own beside the name. */
export function ConfirmButton({ name, onConfirm }: { name: string; onConfirm?: () => void }) {
  return (
    <button
      type="button"
      aria-label={m.voice_confirm({ name })}
      title={m.voice_confirm({ name })}
      onClick={onConfirm}
      className="inline-flex size-[1.25rem] items-center justify-center self-center corner-full text-cte-text-muted control-hover:bg-neutral-3 control-hover:text-cte-text focus-ring"
    >
      <CheckIcon />
    </button>
  );
}

/**
 * A voice's name as `VoiceName` shows it, without its popover: what a
 * transcript turn shows until the pointer or the focus reaches it.
 */
export function VoiceNameStandIn({
  entry,
  person,
  recognized,
  suggestion,
  compact = false,
}: {
  entry: EpisodeVoice;
  person: PersonRef | null;
  recognized: VoiceMatch | null;
  suggestion: VoiceMatch | null;
  compact?: boolean;
}) {
  const guess = guessOf(person, recognized, suggestion);
  return (
    <span className="inline-flex items-baseline gap-xxs">
      <button type="button" aria-haspopup="dialog" className={voiceTriggerClassName(compact)}>
        <VoiceLabel
          voice={entry}
          guess={guess}
          recognized={guess !== null && guess === recognized}
        />
      </button>
      {guess === null ? null : <ConfirmButton name={guess.person.name} />}
    </span>
  );
}

export function VoiceName({
  entry,
  episodeId,
  runId,
  person,
  recognized = null,
  suggestion,
  compact = false,
}: {
  entry: EpisodeVoice;
  episodeId: number;
  runId: number;
  /** The person the voice is named as; null when unnamed (« Moi » may still be a guess). */
  person: PersonRef | null;
  /** Whom Sondine recognized an unnamed voice as: shown as them, marked, until the user answers. */
  recognized?: VoiceMatch | null;
  /** Whom Sondine thinks an unnamed voice may be; the user says yes or no. */
  suggestion: VoiceMatch | null;
  /** Small text, for the transcript's narrow voice column. */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const actions = useVoiceActions(() => {
    setOpen(false);
    setEditing(false);
  });
  const target = { episodeId, runId, label: entry.label };
  const guess = guessOf(person, recognized, suggestion);
  // Only a guess asks first; « Modifier » turns the question into the editor.
  const asked = editing ? null : guess;

  return (
    <span className="inline-flex items-baseline gap-xxs">
      <Popover
        open={open}
        onOpenChange={(next, details) => {
          // Hovering opened the question; once editing, only a click or Escape closes.
          if (!next && editing && details.reason === "trigger-hover") return;
          setOpen(next);
          if (!next) setEditing(false);
        }}
      >
        <PopoverTrigger
          openOnHover={guess !== null}
          closeDelay={150}
          render={<button type="button" className={voiceTriggerClassName(compact)} />}
        >
          <VoiceLabel
            voice={entry}
            guess={guess}
            recognized={guess !== null && guess === recognized}
          />
        </PopoverTrigger>
        <PopoverPopup
          align="start"
          aria-label={asked === null ? undefined : m.voice_is_it({ name: asked.person.name })}
          className={asked === null ? "w-[18rem] gap-s" : "w-auto gap-xs p-s"}
        >
          {asked === null ? (
            <VoiceEditor
              entry={entry}
              target={target}
              person={person}
              recognized={recognized !== null}
              actions={actions}
              onLeave={() => setOpen(false)}
            />
          ) : (
            <GuessQuestion
              guess={asked}
              recognized={asked === recognized}
              onYes={() => void actions.name(target, { kind: "existing", person: asked.person })}
              onNo={() => void actions.refuse(target, asked.person.id)}
              onEdit={() => setEditing(true)}
            />
          )}
        </PopoverPopup>
      </Popover>
      {guess === null ? null : (
        <ConfirmButton
          name={guess.person.name}
          onConfirm={() => void actions.name(target, { kind: "existing", person: guess.person })}
        />
      )}
    </span>
  );
}

/** How sure Sondine is, and Oui, Non or Modifier. */
export function GuessQuestion({
  guess,
  recognized,
  onYes,
  onNo,
  onEdit,
}: {
  guess: VoiceMatch;
  recognized: boolean;
  onYes: () => void;
  onNo: () => void;
  onEdit: () => void;
}) {
  return (
    <>
      <p className="text-body-xs text-cte-text-muted">{confidenceSentence(guess, recognized)}</p>
      <div className="flex items-center gap-xs">
        <Button onClick={onYes}>{m.voice_yes()}</Button>
        <Button variant="secondary" onClick={onNo}>
          {m.voice_no()}
        </Button>
        <Button variant="ghost" onClick={onEdit}>
          {m.voice_edit()}
        </Button>
      </div>
    </>
  );
}

/** « Qui est-ce ? »: a name typed or picked from the user's people, or « C'est moi ». */
export function VoiceEditor({
  entry,
  target,
  person,
  recognized,
  actions,
  onLeave,
  titled = true,
}: {
  entry: EpisodeVoice;
  target: VoiceTarget;
  person: PersonRef | null;
  /** Sondine recognized the voice: « Moi » is then no guess from the sources. */
  recognized: boolean;
  actions: VoiceActions;
  onLeave: () => void;
  /** « Qui est-ce ? » above the field; a popover titled already leaves it out. */
  titled?: boolean;
}) {
  const [text, setText] = useState("");
  const people = useQuery(orpc.people.list.queryOptions());
  // How much the voice sounds like each person (ADR 030), shown beside each name.
  const likeness = useQuery(orpc.speakers.likeness.queryOptions({ input: target }));
  const confidenceOf = new Map(
    (likeness.data?.people ?? []).map((like) => [like.person.id, like.confidence]),
  );
  const selfConfidence = likeness.data?.people.find((like) => like.person.self)?.confidence;
  const query = fold(text);
  const others = (people.data?.people ?? [])
    .filter((summary) => !summary.person.self && summary.person.id !== person?.id)
    // The likeliest first, the most recently heard among equals.
    .toSorted(
      (a, b) => (confidenceOf.get(b.person.id) ?? 0) - (confidenceOf.get(a.person.id) ?? 0),
    );
  const matches = (
    query === "" ? others : others.filter((summary) => fold(summary.person.name).includes(query))
  ).slice(0, SUGGESTIONS);
  const exact = others.filter((summary) => fold(summary.person.name) === query);
  // Enter takes the one person the text names, or adds a new one; two people
  // with that name wait for a click.
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (query === "" || exact.length > 1) return;
    const [chosen] = exact;
    void actions.name(
      target,
      chosen === undefined
        ? { kind: "new", name: text }
        : { kind: "existing", person: chosen.person },
    );
  };
  const today = dayOf(Date.now());
  const guessedSelf = entry.voice.kind === "self" && person === null && !recognized;

  return (
    <>
      {titled ? <PopoverTitle>{m.voice_who()}</PopoverTitle> : null}
      {guessedSelf ? <PopoverDescription>{m.voice_self_hint()}</PopoverDescription> : null}
      <form onSubmit={submit} className="flex flex-col gap-xs">
        <Input
          autoFocus
          aria-label={m.voice_name_label()}
          placeholder={titled ? m.voice_name_placeholder() : m.voice_who()}
          maxLength={80}
          value={text}
          onValueChange={(value) => setText(value)}
        />
        {matches.length === 0 && query === "" ? null : (
          <ul aria-label={m.voice_people()} className="flex flex-col">
            {matches.map(({ person: candidate, lastHeardMs }) => (
              <li key={candidate.id}>
                <Button
                  variant="ghost"
                  className="w-full justify-start"
                  onClick={() => void actions.name(target, { kind: "existing", person: candidate })}
                >
                  <span className="min-w-0 flex-1 truncate text-start">{candidate.name}</span>
                  {confidenceOf.has(candidate.id) ? (
                    <span className="text-body-xs tabular-nums text-cte-text-muted">
                      {confidenceLabel(confidenceOf.get(candidate.id) ?? 0)}
                    </span>
                  ) : null}
                  {lastHeardMs === null ? null : (
                    <span className="text-body-xs text-cte-text-muted">
                      {dayTitle(dayOf(lastHeardMs), today)}
                    </span>
                  )}
                </Button>
              </li>
            ))}
            {query === "" ? null : (
              <li>
                <Button
                  variant="ghost"
                  className="w-full justify-start"
                  onClick={() => void actions.name(target, { kind: "new", name: text })}
                >
                  {exact.length === 0
                    ? m.voice_add({ name: text.trim() })
                    : m.voice_add_another({ name: text.trim() })}
                </Button>
              </li>
            )}
          </ul>
        )}
      </form>
      <div className="flex flex-wrap items-center gap-xs">
        {person?.self === true ? null : (
          <Button variant="secondary" onClick={() => void actions.name(target, { kind: "self" })}>
            {m.voice_is_me()}
            {selfConfidence === undefined ? null : (
              <span className="tabular-nums text-cte-text-muted">
                {confidenceLabel(selfConfidence)}
              </span>
            )}
          </Button>
        )}
        {person === null ? null : (
          <Button variant="ghost" onClick={() => void actions.unname(target)}>
            {m.voice_unname()}
          </Button>
        )}
      </div>
      {person === null || person.self || person.id <= 0 ? null : (
        <Link
          to="/people/$personId"
          params={{ personId: String(person.id) }}
          className="self-start corner-xs text-body-s text-cte-text-muted underline underline-offset-4 focus-ring"
          onClick={onLeave}
        >
          {m.voice_see_person({ name: person.name })}
        </Link>
      )}
    </>
  );
}

/**
 * « 98 % de confiance, d'après 5 voix nommées, votre lecture et 55 dictées »:
 * what the confidence rests on, the voices the user named first, then their
 * voice read (ADR 034) and their dictations (ADR 030).
 */
function confidenceSentence(match: VoiceMatch, recognized: boolean): string {
  const percent = confidenceLabel(match.confidence);
  const named = match.references - match.dictations - match.reads;
  if (named <= 0 && match.reads > 0) {
    return (
      (recognized ? m.voice_recognized_confidence_read : m.voice_suggested_confidence_read)({
        percent,
      }) + (match.dictations > 0 ? m.voice_and_dictations({ count: match.dictations }) : "")
    );
  }
  const read =
    match.reads > 0 ? (match.dictations > 0 ? m.voice_comma_read() : m.voice_and_read()) : "";
  return (
    (recognized ? m.voice_recognized_confidence : m.voice_suggested_confidence)({
      percent,
      count: named,
    }) +
    read +
    (match.dictations > 0 ? m.voice_and_dictations({ count: match.dictations }) : "")
  );
}
