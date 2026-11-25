import type { EpisodeSummary } from "@sondine/api";
import { cn } from "@sondine/ui";
import { Link } from "@tanstack/react-router";
import { unconfirmed } from "../../lib/labels";
import { m } from "../../paraglide/messages.js";
import { headingClassName } from "../journal/journal-block";
import { dayPeople } from "./day-people-view";

// Whom the user spoke with that day, beside Today's thread (Téo, 2026-11-19):
// the people they named in the day's conversations and those Sondine recognized
// (« Marie* » when it only recognized her, ADR 030), the user left out, most
// conversations first. A click opens the person. Nothing when nobody is named.

const SHOWN = 6;

export function DayPeople({
  conversations,
  className,
}: {
  conversations: readonly EpisodeSummary[];
  className?: string;
}) {
  const people = dayPeople(conversations).slice(0, SHOWN);
  if (people.length === 0) return null;
  return (
    <section aria-labelledby="day-people" className={cn("flex-col gap-xs", className)}>
      <h2 id="day-people" className={headingClassName}>
        {m.today_people()}
      </h2>
      <ul className="-mx-xs flex flex-col">
        {people.map(({ person, count, named }) => (
          <li key={person.id}>
            <Link
              to="/people/$personId"
              params={{ personId: String(person.id) }}
              className="flex items-center gap-xs corner-s px-xs py-xxs control-hover:bg-neutral-3 focus-ring"
            >
              <span
                aria-hidden
                className="flex size-[1.75rem] shrink-0 items-center justify-center corner-full bg-neutral-3 text-body-xs font-medium text-cte-text-muted"
              >
                {person.name.trim().charAt(0).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {named ? person.name : unconfirmed(person.name)}
              </span>
              <span className="shrink-0 text-body-xs tabular-nums text-cte-text-muted">
                {m.today_people_conversations({ count })}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
