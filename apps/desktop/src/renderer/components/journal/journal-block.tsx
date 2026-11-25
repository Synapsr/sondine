import type {
  JournalCitation,
  JournalCommitment,
  JournalConversation,
  JournalDay,
  JournalLine,
  JournalMarkInput,
  JournalVoice,
} from "@sondine/api";
import { cn } from "@sondine/ui";
import { Button } from "@sondine/ui/components/button";
import { Checkbox } from "@sondine/ui/components/checkbox";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@sondine/ui/components/collapsible";
import {
  PreviewCard,
  PreviewCardPopup,
  PreviewCardTrigger,
} from "@sondine/ui/components/preview-card";
import { useToastManager } from "@sondine/ui/components/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@sondine/ui/components/tooltip";
import { CalendarIcon, ChevronRightIcon, EllipsisIcon, PenIcon, XIcon } from "@sondine/ui/icon";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@sondine/ui/components/menu";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { errorMessage, orpc } from "../../core/orpc";
import { useMediaQuery } from "../../lib/media-query";
import { clock, confidenceLabel } from "../../lib/labels";
import { m } from "../../paraglide/messages.js";
import { getLocale } from "../../paraglide/runtime.js";
import { useDisplaySettings } from "../today/display-settings";
import {
  commitmentGroups,
  commitmentPeople,
  commitmentPieces,
  commitmentText,
  dueLabel,
  journalPieces,
  journalText,
  journalVoiceHeard,
  journalVoiceName,
  type JournalPiece,
} from "./journal-view";

// The day's commitments, beside Today's thread (ADR 028, ADR 037): on today,
// the open commitments the user made or that were made to them, made in the
// last 7 days when they have no date, else due no more than 7 days ago; the
// others' and the older ones of the last 30 days fold under a line each (Téo,
// 2026-11-10), and so do the ones done lately, to undo one (Téo, 2026-11-19).
// The heading folds the whole block to one line with its count, a choice
// core keeps for both layouts (Téo, 2026-11-20).
// On another day, that day's own. With none, nothing shows. What happened
// is no longer a block of its own: each conversation of the thread reads its
// journal line. Every line ends with the time of the sentence it cites:
// hovering shows the sentences, a click opens the conversation there.
// The model's words are a reading, not a record: « Fait », « Pas un
// engagement », « Pas juste » and « Modifier » are the user's word, kept when
// the journal is written again. A voice nobody named reads as whom Sondine
// takes it for, to confirm (« Marie ? », ADR 030): a click plays where it
// speaks. When the journal is on but cannot write, the block says so in one
// line with its action; when it is off, Today shows nothing of it.

const REFRESH_MS = 15_000;

/** A block of Today: a hairline card with a small heading. */
export const cardClassName =
  "flex flex-col gap-xs corner-m bg-cte-canvas p-m ring-[1px] ring-neutral-4";
export const headingClassName = "font-body font-medium text-body-s text-cte-text-muted";

/** Done commitments folded under today's: the latest few, to undo one. */
const DONE_SHOWN = 20;

export function DayCommitments({ day, today }: { day: string; today: string }) {
  const isToday = day === today;
  const journal = useQuery(
    orpc.journal.day.queryOptions({ input: { day }, refetchInterval: REFRESH_MS }),
  );
  const enabled = isToday && journal.data?.state.enabled === true;
  const open = useQuery(
    orpc.journal.commitments.queryOptions({
      input: { status: "open" },
      refetchInterval: REFRESH_MS,
      enabled,
    }),
  );
  const done = useQuery(
    orpc.journal.commitments.queryOptions({
      input: { status: "done", limit: DONE_SHOWN },
      refetchInterval: REFRESH_MS,
      enabled,
    }),
  );
  const openList = isToday ? open.data?.commitments : null;
  const doneList = isToday ? (done.data?.commitments ?? []) : [];
  const failed = journal.error ?? (isToday ? (open.error ?? done.error) : null);
  if (failed !== null) {
    return (
      <p role="alert" className="text-error">
        {errorMessage(failed)}
      </p>
    );
  }
  if (journal.data === undefined || !journal.data.state.enabled) return null;
  // Lines already written stay readable without a model; with none, say how to get one.
  const written = journal.data.conversations.length > 0 || journal.data.commitments.length > 0;
  if (!journal.data.state.installed && !written && (openList ?? []).length === 0) {
    return (
      <p className="text-body-s text-cte-text-muted">
        {m.journal_no_model()} <SettingsLink>{m.journal_no_model_link()}</SettingsLink>
      </p>
    );
  }
  if (openList === undefined) return null;
  return <CommitmentsView data={journal.data} open={openList} done={doneList} today={today} />;
}

/** A group of today's commitments behind one quiet line; nothing when empty. */
function FoldedCommitments({ label, children }: { label: string; children: ReactNode[] }) {
  if (children.length === 0) return null;
  return (
    <Collapsible>
      <CollapsibleTrigger className="self-start text-body-s text-cte-text-muted">
        {label}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <ul className="flex flex-col">{children}</ul>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function CommitmentsView({
  data,
  open,
  done,
  today,
}: {
  data: JournalDay;
  /** Today: the commitments still open from the last 30 days; another day shows its own. */
  open: readonly JournalCommitment[] | null;
  /** Today: the latest done ones. */
  done: readonly JournalCommitment[];
  today: string;
}) {
  const groups = open === null ? null : commitmentGroups(open, today);
  const commitments =
    groups?.mine ?? data.commitments.filter((commitment) => commitment.status !== "dismissed");
  const row = (commitment: JournalCommitment) => (
    <CommitmentRow
      key={`${commitment.itemId ?? "m"}-${commitment.markId ?? "i"}`}
      commitment={commitment}
      today={today}
      showDay={open !== null}
    />
  );
  const display = useDisplaySettings();
  const behindLines = (groups?.others.length ?? 0) + (groups?.older.length ?? 0) + done.length;
  const pending = <PendingLine data={data} />;
  if (commitments.length === 0 && behindLines === 0) return pending;
  const folded = display.settings?.commitmentsFolded === true;
  // Folded, the count is every open commitment the block hides, not only the user's own.
  const openCount = commitments.length + (groups?.others.length ?? 0) + (groups?.older.length ?? 0);
  return (
    <section aria-labelledby="journal-commitments" className="flex flex-col gap-xs">
      <h2 id="journal-commitments" className={headingClassName}>
        <button
          type="button"
          aria-expanded={!folded}
          onClick={() => display.update({ commitmentsFolded: !folded })}
          // Folding changes the layout at once: no animation (docs/ux-redesign.md §6).
          className="group/fold flex w-fit items-center gap-xxs corner-xs focus-ring control-hover:text-cte-text"
        >
          {m.journal_commitments()}
          {folded ? <span className="tabular-nums">{openCount}</span> : null}
          {/* Folded, it says the block opens; open, it shows where the pointer or focus is. */}
          <ChevronRightIcon
            className={
              folded
                ? undefined
                : "rotate-90 opacity-0 group-hover/fold:opacity-100 group-focus-visible/fold:opacity-100"
            }
          />
        </button>
      </h2>
      {folded ? null : commitments.length === 0 ? (
        <p className="text-body-s text-cte-text-muted">{m.journal_no_commitments_mine()}</p>
      ) : (
        <ul className="flex flex-col">{commitments.map(row)}</ul>
      )}
      {folded || groups === null ? null : (
        <>
          <FoldedCommitments label={m.journal_commitments_others({ count: groups.others.length })}>
            {groups.others.map(row)}
          </FoldedCommitments>
          <FoldedCommitments label={m.journal_commitments_older({ count: groups.older.length })}>
            {groups.older.map(row)}
          </FoldedCommitments>
        </>
      )}
      {folded ? null : (
        <>
          <FoldedCommitments label={m.journal_commitments_done({ count: done.length })}>
            {done.map(row)}
          </FoldedCommitments>
          {pending}
        </>
      )}
    </section>
  );
}

function SettingsLink({ children }: { children: string }) {
  return (
    <Link
      to="/settings/$page"
      params={{ page: "journal" }}
      className="corner-xs underline underline-offset-4 focus-ring"
    >
      {children}
    </Link>
  );
}

/**
 * What the day still has to write and « Écrire maintenant », and a word when
 * the user's Claude did not answer. « Réécrire » is in the day's « ⋯ ».
 */
function PendingLine({ data }: { data: JournalDay }) {
  const queryClient = useQueryClient();
  const request = useMutation(
    orpc.journal.request.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.journal.key() }),
    }),
  );
  const { state } = data;
  if (state.pending === 0 && state.failed === 0 && !state.claudePaused) return null;
  return (
    <div className="flex flex-col gap-xxs text-body-s text-cte-text-muted">
      <p className="flex flex-wrap items-baseline gap-s">
        {state.pending === 0 ? null : (
          <span>
            {state.writing
              ? m.journal_writing({ count: state.pending })
              : m.journal_pending({ count: state.pending })}
          </span>
        )}
        {state.failed === 0 ? null : <span>{m.journal_failed({ count: state.failed })}</span>}
        {/* Claude did not answer: asking again asks it at once. */}
        {state.pending === 0 || state.writing || (state.requested && !state.claudePaused) ? null : (
          <Button
            variant="ghost"
            className="px-xs py-zero"
            isPending={request.isPending}
            onClick={() => request.mutate({ day: data.day })}
          >
            {m.journal_write_now()}
          </Button>
        )}
        {request.error === null ? null : (
          <span role="alert" className="text-error">
            {errorMessage(request.error)}
          </span>
        )}
      </p>
      {state.claudePaused ? (
        <p>
          {m.journal_claude_paused()} <SettingsLink>{m.journal_claude_paused_link()}</SettingsLink>
        </p>
      ) : null}
    </div>
  );
}

export function ConversationLines({ conversation }: { conversation: JournalConversation }) {
  return (
    <ul className="flex flex-col gap-xxs">
      {conversation.lines.map((line) => (
        <JournalLineRow key={`${line.itemId ?? "m"}-${line.markId ?? "i"}`} line={line} />
      ))}
    </ul>
  );
}

/** Marks a line or a commitment; a mark the model's line no longer matches is gone. */
function useMark() {
  const queryClient = useQueryClient();
  const toasts = useToastManager();
  return useMutation(
    orpc.journal.mark.mutationOptions({
      onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.journal.key() }),
      onError: (error) => toasts.add({ title: errorMessage(error) }),
    }),
  );
}

/**
 * A line's own actions in one « ⋯ » (ADR 037), shown while the pointer is over
 * the line or the menu has focus, so hidden actions take one slot, not three.
 */
function LineMenu({
  items,
}: {
  items: readonly {
    label: string;
    icon: ReactNode;
    danger?: boolean;
    run: () => void;
  }[];
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-s"
            aria-label={m.journal_line_more()}
            className="shrink-0 text-cte-text-muted opacity-0 group-hover/journal:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
          />
        }
      >
        <EllipsisIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        {items.map((item) => (
          <MenuItem
            key={item.label}
            icon={item.icon}
            variant={item.danger === true ? "danger" : undefined}
            onClick={item.run}
          >
            {item.label}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function JournalLineRow({ line }: { line: JournalLine }) {
  const mark = useMark();
  const toasts = useToastManager();
  const [editing, setEditing] = useState(false);
  const target = { itemId: line.itemId, markId: line.markId };
  const text = journalText(line.text, line.voices);
  if (editing) {
    return (
      <li>
        <LineEditor
          text={text}
          edited={line.edited}
          onSave={(next) => mark.mutate({ ...target, change: { text: next } })}
          onDone={() => setEditing(false)}
        />
      </li>
    );
  }
  return (
    <li className="group/journal flex items-start gap-xxs">
      <p className={`min-w-0 flex-1 ${line.stale ? "text-cte-text-muted" : ""}`}>
        <JournalWords
          pieces={journalPieces(line.text, line.voices)}
          voices={line.voices}
          citations={line.citations}
        />{" "}
        <Citations citations={line.citations} voices={line.voices} />
      </p>
      <LineMenu
        items={[
          { label: m.journal_edit(), icon: <PenIcon />, run: () => setEditing(true) },
          {
            label: m.journal_dismiss_line(),
            icon: <XIcon />,
            danger: true,
            run: () =>
              mark.mutate(
                { ...target, change: { status: "dismissed" } },
                {
                  onSuccess: (result) =>
                    toasts.add({
                      title: m.journal_dismissed(),
                      actionProps: {
                        children: m.journal_undo(),
                        onClick: () =>
                          mark.mutate({
                            itemId: line.itemId,
                            markId: result.markId,
                            change: { status: "open" },
                          }),
                      },
                    }),
                },
              ),
          },
        ]}
      />
    </li>
  );
}

/**
 * How long checking an open commitment takes on Today, in ms: the check
 * draws, the text is struck through (STRIKE), the row holds a beat, then folds
 * away (FOLD) before it is marked done and leaves the list (Téo, 2026-11-19).
 */
const STRIKE_MS = 450;
const HOLD_MS = 250;
const FOLD_MS = 300;

/** A line drawn through the text from start to end, on every wrapped line. */
const strikeClassName = cn(
  "bg-[linear-gradient(currentColor,currentColor)] bg-no-repeat bg-[position:0_58%] box-decoration-clone",
  "transition-[background-size,color] duration-[450ms] ease-out motion-reduce:transition-none",
);

export function CommitmentRow({
  commitment,
  today,
  showDay,
}: {
  commitment: JournalCommitment;
  today: string;
  /** Open commitments of several days: say which day each was made. */
  showDay: boolean;
}) {
  const mark = useMark();
  const toasts = useToastManager();
  const calm = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [editing, setEditing] = useState(false);
  const [dating, setDating] = useState(false);
  // Checking an open commitment on Today: struck, then folding, then gone.
  const [finishing, setFinishing] = useState<"struck" | "folding" | null>(null);
  const target = { itemId: commitment.itemId, markId: commitment.markId };
  const done = commitment.status === "done" || finishing !== null;
  const people = commitmentPeople(commitment);
  const due = commitment.due === null ? null : dueLabel(commitment.due, today);
  const change = (next: JournalMarkInput["change"]) => mark.mutate({ ...target, change: next });
  const finish = () => {
    // The list of open commitments loses the row once it is done: show the strike first.
    if (!showDay || calm) {
      change({ status: "done" });
      return;
    }
    setFinishing("struck");
    // Timers, not effects: the mark is sent even if the screen changes meanwhile.
    setTimeout(() => setFinishing("folding"), STRIKE_MS + HOLD_MS);
    setTimeout(
      () =>
        mark.mutate(
          { ...target, change: { status: "done" } },
          { onError: () => setFinishing(null) },
        ),
      STRIKE_MS + HOLD_MS + FOLD_MS,
    );
  };
  return (
    <li
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-[300ms] ease-in-out motion-reduce:transition-none",
        finishing === "folding" ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr]",
      )}
    >
      <div className={cn("min-h-0", finishing === "folding" && "overflow-hidden")}>
        <div className="group/journal flex items-start gap-s py-xxs">
          <Checkbox
            aria-label={m.journal_done()}
            checked={done}
            disabled={mark.isPending || finishing !== null}
            className="mt-xxs"
            onCheckedChange={(checked) => (checked ? finish() : change({ status: "open" }))}
          />
          <div className="flex min-w-0 flex-1 flex-col">
            {editing ? (
              <LineEditor
                text={commitmentText(commitment)}
                edited={commitment.edited}
                onSave={(next) => change({ text: next })}
                onDone={() => setEditing(false)}
              />
            ) : (
              <p>
                <span
                  className={cn(
                    strikeClassName,
                    done ? "bg-[length:100%_1.5px] text-cte-text-muted" : "bg-[length:0%_1.5px]",
                  )}
                >
                  <JournalWords
                    pieces={commitmentPieces(commitment)}
                    voices={commitment.voices}
                    citations={commitment.citations}
                  />
                </span>
              </p>
            )}
            <p className="flex flex-wrap items-baseline gap-x-xs text-body-s text-cte-text-muted">
              {people === null ? null : (
                <span>
                  <JournalWords
                    pieces={people}
                    voices={commitment.voices}
                    citations={commitment.citations}
                  />
                </span>
              )}
              {dating ? (
                <DueEditor
                  due={commitment.due}
                  onSave={(next) => change({ due: next })}
                  onDone={() => setDating(false)}
                />
              ) : due === null ? null : (
                <span className={due.tone === "past" && !done ? "text-error" : ""}>{due.text}</span>
              )}
              <Citations
                citations={commitment.citations}
                voices={commitment.voices}
                label={showDay ? dayAndTime(commitment.startMs, today) : undefined}
              />
            </p>
          </div>
          <LineMenu
            items={[
              { label: m.journal_edit(), icon: <PenIcon />, run: () => setEditing(true) },
              { label: m.journal_due_edit(), icon: <CalendarIcon />, run: () => setDating(true) },
              {
                label: m.journal_not_commitment(),
                icon: <XIcon />,
                danger: true,
                run: () =>
                  mark.mutate(
                    { ...target, change: { status: "dismissed" } },
                    {
                      onSuccess: (result) =>
                        toasts.add({
                          title: m.journal_not_commitment_done(),
                          actionProps: {
                            children: m.journal_undo(),
                            onClick: () =>
                              mark.mutate({
                                itemId: commitment.itemId,
                                markId: result.markId,
                                change: { status: "open" },
                              }),
                          },
                        }),
                    },
                  ),
              },
            ]}
          />
        </div>
      </div>
    </li>
  );
}

/** « 14:03 », or « 7 nov. 14:03 » among several days. */
function dayAndTime(ms: number, today: string): string {
  const date = new Date(ms);
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  if (day === today) return clock(ms);
  // Short: the due date beside it is the one that matters.
  const label = new Intl.DateTimeFormat(getLocale(), {
    day: "numeric",
    month: "short",
    ...(day.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }),
  }).format(date);
  return `${label} ${clock(ms)}`;
}

/** A line's words and its voices, each voice as it reads now. */
function JournalWords({
  pieces,
  voices,
  citations,
}: {
  pieces: readonly JournalPiece[];
  voices: readonly JournalVoice[];
  citations: readonly JournalCitation[];
}) {
  return pieces.map((piece, index) =>
    typeof piece === "string" ? (
      piece
    ) : (
      <JournalVoiceName key={index} voice={piece} voices={voices} citations={citations} />
    ),
  );
}

/**
 * A voice's name; for one nobody named that Sondine takes for someone (ADR
 * 030), « Marie ? » (« Marie* » once recognized), marked to confirm: a click
 * plays the conversation where that voice speaks, to hear it.
 */
function JournalVoiceName({
  voice,
  voices,
  citations,
}: {
  voice: JournalVoice;
  voices: readonly JournalVoice[];
  citations: readonly JournalCitation[];
}) {
  const guess = voice.name === null && !voice.self ? voice.guess : null;
  if (guess === null) return journalVoiceName(voice, voices);
  const where = citations.find((citation) => citation.speaker?.ref === voice.ref) ?? citations[0];
  const className = "corner-xs underline decoration-dotted underline-offset-4 focus-ring";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          where === undefined ? (
            <span tabIndex={0} className={className} />
          ) : (
            <Link
              to="/episode/$id"
              params={{ id: String(where.episodeId) }}
              search={{ t: where.startMs }}
              className={className}
            />
          )
        }
      >
        {journalVoiceHeard(voice, voices)}
      </TooltipTrigger>
      <TooltipPopup>
        {m.journal_voice_guess({ percent: confidenceLabel(guess.confidence) })}
      </TooltipPopup>
    </Tooltip>
  );
}

/** The cited sentences behind the time of the first: hover to read, click to open there. */
function Citations({
  citations,
  voices,
  label,
}: {
  citations: readonly JournalCitation[];
  voices: JournalLine["voices"];
  label?: string | undefined;
}) {
  const [first] = citations;
  if (first === undefined) return null;
  return (
    <PreviewCard>
      <PreviewCardTrigger
        aria-label={m.journal_cited_at({ time: clock(first.startMs) })}
        className="font-regular text-body-s tabular-nums text-cte-text-muted"
        render={
          <Link
            to="/episode/$id"
            params={{ id: String(first.episodeId) }}
            search={{ t: first.startMs }}
          />
        }
      >
        {label ?? clock(first.startMs)}
      </PreviewCardTrigger>
      <PreviewCardPopup className="gap-xs">
        {citations.map((citation) => (
          <blockquote key={citation.segmentId} className="flex flex-col">
            <span className="text-body-xs text-cte-text-muted">
              {clock(citation.startMs)}
              {citation.speaker === null ? "" : ` · ${journalVoiceHeard(citation.speaker, voices)}`}
            </span>
            <span className="font-body font-regular">« {citation.text} »</span>
          </blockquote>
        ))}
      </PreviewCardPopup>
    </PreviewCard>
  );
}

/** A commitment's date: Enter or leaving saves, Escape cancels, emptied clears it. */
function DueEditor({
  due,
  onSave,
  onDone,
}: {
  due: string | null;
  onSave: (due: string | null) => void;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(due ?? "");
  const save = () => {
    const next = draft === "" ? null : draft;
    if (next !== due) onSave(next);
    onDone();
  };
  return (
    <input
      type="date"
      // oxlint-disable-next-line jsx-a11y/no-autofocus -- the calendar asked for this field.
      autoFocus
      aria-label={m.journal_due_edit()}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          save();
        } else if (event.key === "Escape") {
          event.preventDefault();
          onDone();
        }
      }}
      className="corner-xs bg-neutral-2 px-xxs text-body-s text-cte-text focus-ring"
    />
  );
}

/** Enter saves, Escape cancels; an empty text gives the model's line back. */
function LineEditor({
  text,
  edited,
  onSave,
  onDone,
}: {
  text: string;
  edited: boolean;
  onSave: (text: string | null) => void;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(text);
  const save = () => {
    const next = draft.trim();
    if (next !== text) onSave(next === "" ? null : next);
    onDone();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      save();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onDone();
    }
  };
  return (
    <div className="flex flex-col gap-xxs">
      <textarea
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- the pen asked for this field.
        autoFocus
        aria-label={m.journal_edit_label()}
        value={draft}
        maxLength={400}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={save}
        className="field-sizing-content min-h-(--line-m) resize-none corner-s bg-neutral-2 px-xs py-xxs text-cte-text focus-ring"
      />
      {edited ? (
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onSave(null);
            onDone();
          }}
          className="self-start corner-xs text-body-s text-cte-text-muted underline underline-offset-4 focus-ring"
        >
          {m.journal_restore()}
        </button>
      ) : null}
    </div>
  );
}
