import type { JournalCommitment } from "@sondine/api";
import { cn } from "@sondine/ui";
import { Button } from "@sondine/ui/components/button";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@sondine/ui/components/collapsible";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@sondine/ui/components/menu";
import { ChevronDownIcon } from "@sondine/ui/icon";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { errorMessage, orpc } from "../../core/orpc";
import { dayOf } from "../../lib/day";
import { m } from "../../paraglide/messages.js";
import { screenClassName, titleClassName } from "../shell/screen";
import { CommitmentRow, headingClassName } from "./journal-block";
import { commitmentBoard, commitmentNames } from "./journal-view";

// Commitments (`/commitments`, Téo, 2026-11-19): every commitment the
// journal found in the last 90 days, not only today's (ADR 028). Open ones
// by when they are due: late, the next 7 days, later, without a date; those
// between other people fold under a line. « Faits » lists the done ones, to
// undo one. A menu keeps those naming one person. Each list shows its first
// few and more on demand, so the page never opens on everything (Téo,
// 2026-11-19). Each row is Today's: checking it strikes it, then it leaves;
// its time opens the sentence.

const REFRESH_MS = 15_000;
/** How far back the page looks: the journal's longest window. */
const DAYS = 90;
const EVERYONE = "";
/** A group shows this many first, then this many more at each click. */
const FIRST = 5;
const MORE = 10;

const chip = (on: boolean) => cn("px-s", on && "bg-neutral-3");

export function CommitmentsScreen() {
  const today = dayOf(Date.now());
  const [shown, setShown] = useState<"open" | "done">("open");
  const [person, setPerson] = useState(EVERYONE);
  const state = useQuery(orpc.journal.day.queryOptions({ input: {} }));
  const enabled = state.data?.state.enabled === true;
  const open = useQuery(
    orpc.journal.commitments.queryOptions({
      input: { status: "open", days: DAYS },
      refetchInterval: REFRESH_MS,
      enabled,
    }),
  );
  const done = useQuery(
    orpc.journal.commitments.queryOptions({
      input: { status: "done", days: DAYS },
      refetchInterval: REFRESH_MS,
      enabled,
    }),
  );
  const list = shown === "open" ? open : done;
  const all = list.data?.commitments ?? [];
  const names = [...new Set(all.flatMap(commitmentNames))].toSorted((a, b) => a.localeCompare(b));
  const kept =
    person === EVERYONE
      ? all
      : all.filter((commitment) => commitmentNames(commitment).includes(person));

  return (
    <div className={screenClassName}>
      <header className="flex flex-col gap-xs">
        <h1 className={titleClassName}>{m.nav_commitments()}</h1>
        <p className="text-cte-text-muted">{m.commitments_description()}</p>
      </header>
      {state.data !== undefined && !enabled ? (
        <p className="text-cte-text-muted">
          {m.commitments_off()}{" "}
          <Link
            to="/settings/$page"
            params={{ page: "journal" }}
            className="corner-xs underline underline-offset-4 focus-ring"
          >
            {m.commitments_off_link()}
          </Link>
        </p>
      ) : (
        <>
          {/* The buttons' own inset hangs outside, so their labels line up with the text. */}
          <div className="-mx-s flex flex-wrap items-center gap-xxs">
            <Button
              variant="ghost"
              aria-pressed={shown === "open"}
              className={chip(shown === "open")}
              onClick={() => setShown("open")}
            >
              {m.commitments_open()}
              <Count value={open.data?.commitments.length} />
            </Button>
            <Button
              variant="ghost"
              aria-pressed={shown === "done"}
              className={chip(shown === "done")}
              onClick={() => setShown("done")}
            >
              {m.commitments_done()}
              <Count value={done.data?.commitments.length} />
            </Button>
            {names.length === 0 && person === EVERYONE ? null : (
              <Menu>
                <MenuTrigger variant="ghost" className={chip(person !== EVERYONE)}>
                  {person === EVERYONE ? m.commitments_everyone() : person}
                  <ChevronDownIcon />
                </MenuTrigger>
                <MenuPopup align="start">
                  <MenuRadioGroup value={person} onValueChange={(value) => setPerson(value)}>
                    <MenuRadioItem value={EVERYONE}>{m.commitments_everyone()}</MenuRadioItem>
                    {names.map((name) => (
                      <MenuRadioItem key={name} value={name}>
                        {name}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuPopup>
              </Menu>
            )}
          </div>
          {list.error === null ? null : (
            <p role="alert" className="text-error">
              {errorMessage(list.error)}
            </p>
          )}
          {list.data === undefined ? null : shown === "open" ? (
            <OpenBoard commitments={kept} today={today} />
          ) : kept.length === 0 ? (
            <p className="text-cte-text-muted">{m.commitments_none_done()}</p>
          ) : (
            <PagedList key={person} items={kept} today={today} first={MORE} />
          )}
        </>
      )}
    </div>
  );
}

function row(commitment: JournalCommitment, today: string) {
  return (
    <CommitmentRow
      key={`${commitment.itemId ?? "m"}-${commitment.markId ?? "i"}`}
      commitment={commitment}
      today={today}
      showDay
    />
  );
}

function OpenBoard({
  commitments,
  today,
}: {
  commitments: readonly JournalCommitment[];
  today: string;
}) {
  const board = commitmentBoard(commitments, today);
  const groups = [
    { key: "late", title: m.commitments_late(), items: board.late },
    { key: "soon", title: m.commitments_soon(), items: board.soon },
    { key: "later", title: m.commitments_later(), items: board.later },
    { key: "undated", title: m.commitments_undated(), items: board.undated },
  ].filter((group) => group.items.length > 0);
  if (groups.length === 0 && board.others.length === 0) {
    return <p className="text-cte-text-muted">{m.commitments_none_open()}</p>;
  }
  return (
    <div className="flex flex-col gap-l">
      {groups.map((group) => (
        <section
          key={group.key}
          aria-labelledby={`commitments-${group.key}`}
          className="flex flex-col gap-xs"
        >
          <h2 id={`commitments-${group.key}`} className={headingClassName}>
            {group.title}
          </h2>
          <PagedList items={group.items} today={today} first={FIRST} />
        </section>
      ))}
      {board.others.length === 0 ? null : (
        <Collapsible>
          <CollapsibleTrigger className="self-start text-body-s text-cte-text-muted">
            {m.journal_commitments_others({ count: board.others.length })}
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <PagedList items={board.others} today={today} first={FIRST} />
          </CollapsiblePanel>
        </Collapsible>
      )}
    </div>
  );
}

function Count({ value }: { value: number | undefined }) {
  return value === undefined ? null : (
    <span className="tabular-nums text-cte-text-muted">{value}</span>
  );
}

/** The first `first` commitments, and « Afficher N de plus » for the next ones. */
function PagedList({
  items,
  today,
  first,
}: {
  items: readonly JournalCommitment[];
  today: string;
  first: number;
}) {
  const [count, setCount] = useState(first);
  const rest = items.length - count;
  return (
    <div className="flex flex-col gap-xxs">
      <ul className="flex flex-col">
        {items.slice(0, count).map((commitment) => row(commitment, today))}
      </ul>
      {rest <= 0 ? null : (
        <Button
          variant="ghost"
          className="-ms-s self-start text-cte-text-muted"
          onClick={() => setCount((current) => current + MORE)}
        >
          {m.commitments_more({ count: Math.min(rest, MORE) })}
        </Button>
      )}
    </div>
  );
}
