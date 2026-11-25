import { cn } from "@sondine/ui";
import type { EpisodeContext, Statistics } from "@sondine/api";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@sondine/ui/components/tooltip";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { errorMessage, orpc } from "../../core/orpc";
import { dayOf } from "../../lib/day";
import { formatDuration } from "../../lib/labels";
import { m } from "../../paraglide/messages.js";
import { getLocale } from "../../paraglide/runtime.js";
import { cardClassName, headingClassName } from "../journal/journal-block";

// Settings ▸ Statistiques (ADR 037): what the database already holds, read
// on demand and shown on this Mac only. Speech heard each of the last 7 days
// (one series: no legend, values on hover and in the tile above), where the
// last 30 days' speech came from, who the user talked with most, the words
// transcribed and the agents' reads. Bars are one neutral ink; their labels
// carry the identity.

const contextText: Record<EpisodeContext, () => string> = {
  call: () => m.episode_context_call(),
  in_person: () => m.episode_context_in_person(),
  media: () => m.episode_context_media(),
  mixed: () => m.episode_context_mixed(),
  dictation: () => m.episode_context_dictation(),
  imported: () => m.episode_context_imported(),
};

export function StatisticsSection() {
  const stats = useQuery(orpc.statistics.get.queryOptions());
  if (stats.data === undefined) {
    return (
      <p
        role={stats.isError ? "alert" : undefined}
        className={stats.isError ? "text-error" : "text-cte-text-muted"}
      >
        {stats.isError ? errorMessage(stats.error) : m.loading()}
      </p>
    );
  }
  return <StatisticsView stats={stats.data} />;
}

function StatisticsView({ stats }: { stats: Statistics }) {
  const week = stats.days.reduce((sum, day) => sum + day.voicedMs, 0);
  const conversations = stats.days.reduce((sum, day) => sum + day.conversations, 0);
  const number = new Intl.NumberFormat(getLocale());
  return (
    <div className="flex flex-col gap-l">
      <div className="grid grid-cols-2 gap-s min-[48rem]:grid-cols-4">
        <Tile label={m.stats_week_speech()} value={formatDuration(week)} />
        <Tile label={m.stats_week_conversations()} value={number.format(conversations)} />
        <Tile label={m.stats_words()} value={number.format(stats.words)} />
        <Tile label={m.stats_agent_reads()} value={number.format(stats.agentReads)} />
      </div>
      <DaysChart days={stats.days} />
      <section aria-labelledby="stats-contexts" className={cardClassName}>
        <h2 id="stats-contexts" className={headingClassName}>
          {m.stats_contexts()}
        </h2>
        {stats.contexts.length === 0 ? (
          <p className="text-cte-text-muted">{m.stats_nothing()}</p>
        ) : (
          <Bars
            rows={stats.contexts.map((row) => ({
              key: row.context,
              label: contextText[row.context](),
              value: row.voicedMs,
            }))}
          />
        )}
      </section>
      <section aria-labelledby="stats-people" className={cardClassName}>
        <h2 id="stats-people" className={headingClassName}>
          {m.stats_people()}
        </h2>
        {stats.people.length === 0 ? (
          <p className="text-cte-text-muted">{m.stats_nothing()}</p>
        ) : (
          <Bars
            rows={stats.people.map((row) => ({
              key: String(row.personId),
              label: (
                <Link
                  to="/people/$personId"
                  params={{ personId: String(row.personId) }}
                  className="corner-xs focus-ring"
                >
                  {row.name}
                </Link>
              ),
              value: row.talkMs,
            }))}
          />
        )}
      </section>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    // The figures line up at the bottom, whatever their label's length.
    <div className={cn(cardClassName, "justify-between")}>
      <span className="text-body-xs text-cte-text-muted">{label}</span>
      <span className="font-display font-heavy text-display-xxs tabular-nums">{value}</span>
    </div>
  );
}

/** Speech heard each day: one bar per day, anchored to the baseline, the value on hover. */
function DaysChart({ days }: { days: Statistics["days"] }) {
  const max = Math.max(1, ...days.map((day) => day.voicedMs));
  const weekday = new Intl.DateTimeFormat(getLocale(), { weekday: "short" });
  const today = dayOf(Date.now());
  return (
    <section aria-labelledby="stats-days" className={cardClassName}>
      <h2 id="stats-days" className={headingClassName}>
        {m.stats_days()}
      </h2>
      <ul className="grid h-[9rem] grid-cols-7 items-end gap-xs">
        {days.map((day) => {
          const label = weekday.format(new Date(`${day.day}T12:00:00`));
          const value = `${formatDuration(day.voicedMs)} · ${m.stats_conversations({ count: day.conversations })}`;
          return (
            <li key={day.day} className="flex h-full flex-col items-center justify-end gap-xxs">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      tabIndex={0}
                      aria-label={`${label} : ${value}`}
                      className="flex w-full flex-1 items-end justify-center corner-xs focus-ring"
                    />
                  }
                >
                  <span
                    className={`w-[60%] min-h-[2px] corner-t-xs ${day.day === today ? "bg-neutral-10" : "bg-neutral-6"}`}
                    style={{ height: `${(day.voicedMs / max) * 100}%` }}
                  />
                </TooltipTrigger>
                <TooltipPopup>{value}</TooltipPopup>
              </Tooltip>
              <span className="text-body-xs text-cte-text-muted">{label}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** A labelled horizontal bar per row, the value written at its end. */
function Bars({ rows }: { rows: readonly { key: string; label: ReactNode; value: number }[] }) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  return (
    <ul className="flex flex-col gap-xs">
      {rows.map((row) => (
        <li key={row.key} className="grid grid-cols-[9rem_minmax(0,1fr)_4.5rem] items-center gap-s">
          <span className="truncate">{row.label}</span>
          <span className="h-xs overflow-hidden corner-full bg-neutral-3">
            <span
              className="block h-full corner-full bg-neutral-8"
              style={{ width: `${(row.value / max) * 100}%` }}
            />
          </span>
          <span className="text-end text-body-s tabular-nums text-cte-text-muted">
            {formatDuration(row.value)}
          </span>
        </li>
      ))}
    </ul>
  );
}
