import type { DoubtedName, PersonRef, PersonSummary } from "@sondine/api";
import { Badge } from "@sondine/ui/components/badge";
import { Button } from "@sondine/ui/components/button";
import { Toggle } from "@sondine/ui/components/toggle";
import { PlayIcon } from "@sondine/ui/icon";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { errorMessage, orpc } from "../../core/orpc";
import { dayOf } from "../../lib/day";
import { clock, confidenceLabel, contextLabel, dayTitle, formatDuration } from "../../lib/labels";
import { voiceOf } from "../../lib/voices";
import { m } from "../../paraglide/messages.js";
import { useVoiceActions, VoiceName } from "../episode/voice-name";
import { cardClassName, headingClassName } from "../journal/journal-block";
import { usePlayer } from "../player/player-provider";
import { rowDivider } from "../today/today-rows";
import { EpisodeAppIcon } from "../shell/app-icon";
import { screenClassName, titleClassName } from "../shell/screen";

// People (`/people`): everyone the user named, newest heard first, with how
// many conversations their name reaches, in a card. The unnamed voices of the
// last 30 days to name (with Sondine's suggestion when it has one) wait behind
// the « Voix sans nom (n) » chip (ADR 037). « À vérifier » shows above them
// only when a voice the user named sounds like someone else (ADR 030).

export function PeopleScreen() {
  const people = useQuery(orpc.people.list.queryOptions());
  return (
    <div className={screenClassName}>
      <h1 className={titleClassName}>{m.nav_people()}</h1>
      <ToCheck />
      <WhoIsThis />
      {people.error === null ? null : (
        <p role="alert" className="text-error">
          {errorMessage(people.error)}
        </p>
      )}
      {people.data === undefined ? null : people.data.people.length === 0 ? (
        <p className="max-w-[40rem] text-cte-text-muted">{m.people_empty()}</p>
      ) : (
        <ul aria-label={m.nav_people()} className={`${cardClassName} gap-zero p-zero`}>
          {people.data.people.map((summary) => (
            <PersonRow key={summary.person.id} summary={summary} />
          ))}
        </ul>
      )}
    </div>
  );
}

function PersonRow({ summary }: { summary: PersonSummary }) {
  const { person, episodeCount, lastHeardMs, recognizedCount } = summary;
  const today = dayOf(Date.now());
  return (
    <li className={rowDivider}>
      <Link
        to="/people/$personId"
        params={{ personId: String(person.id) }}
        className="flex items-center gap-s corner-s p-s focus-ring"
      >
        <span
          aria-hidden
          className="flex size-[2.25rem] shrink-0 items-center justify-center corner-full bg-neutral-3 font-medium text-cte-text-muted"
        >
          {person.name.slice(0, 1).toLocaleUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate font-body font-medium">{person.name}</span>
        {person.self ? <Badge variant="neutral">{m.voice_self()}</Badge> : null}
        <span className="shrink-0 text-body-s text-cte-text-muted">
          {[
            ...(episodeCount === 0 && recognizedCount === 0 ? [m.people_heard_none()] : []),
            ...(episodeCount === 0
              ? []
              : [
                  m.people_heard({
                    count: episodeCount,
                    day: lastHeardMs === null ? "" : dayTitle(dayOf(lastHeardMs), today),
                  }),
                ]),
            // Conversations where only Sondine recognized them (ADR 030), apart.
            ...(recognizedCount === 0 ? [] : [m.people_recognized({ count: recognizedCount })]),
          ].join(" · ")}
        </span>
      </Link>
    </li>
  );
}

/** A transcript made again in the background gives its voices other questions. */
const DOUBTS_REFRESH_MS = 60_000;

/** « Moi », or the person's name. */
const nameOf = (person: PersonRef) => (person.self ? m.voice_self() : person.name);

/** The names the user may have given to the wrong voice: hear it, then confirm or correct. */
function ToCheck() {
  const doubts = useQuery(orpc.people.doubts.queryOptions({ refetchInterval: DOUBTS_REFRESH_MS }));
  const voices = doubts.data?.voices ?? [];
  if (voices.length === 0) return null;
  return (
    <section aria-labelledby="people-doubts" className="flex flex-col gap-s">
      <h2 id="people-doubts" className={headingClassName}>
        {m.people_doubts()}
      </h2>
      <p className="text-body-s text-cte-text-muted">{m.people_doubts_hint()}</p>
      <ul className={`${cardClassName} gap-zero p-zero`}>
        {voices.map((voice) => (
          <DoubtRow key={`${voice.runId}:${voice.label}`} voice={voice} />
        ))}
      </ul>
    </section>
  );
}

function DoubtRow({ voice }: { voice: DoubtedName }) {
  const { episode, person, match } = voice;
  const actions = useVoiceActions();
  const player = usePlayer();
  const target = { episodeId: episode.id, runId: voice.runId, label: voice.label };
  const meta = [
    formatDuration(voice.voicedMs),
    contextLabel(episode),
    `${dayTitle(dayOf(episode.startedAtMs), dayOf(Date.now()))} ${clock(episode.startedAtMs)}`,
  ].filter((part) => part !== null);
  const names = {
    name: nameOf(person),
    other: nameOf(match.person),
    otherPercent: confidenceLabel(match.confidence),
  };
  const title =
    voice.confidence === null
      ? m.people_doubt_alone(names)
      : m.people_doubt_likeness({ ...names, percent: confidenceLabel(voice.confidence) });
  return (
    <li className={`flex flex-wrap items-center gap-m p-s ${rowDivider}`}>
      <Button
        variant="secondary"
        size="icon"
        aria-label={m.people_doubt_listen()}
        onClick={() => void player.play(episode.id, voice.startMs)}
      >
        <PlayIcon />
      </Button>
      <span className="flex min-w-[14rem] flex-1 flex-col">
        <span className="font-body font-medium">{title}</span>
        <span className="flex min-w-0 items-center gap-xxs text-body-s text-cte-text-muted">
          <EpisodeAppIcon episode={episode} />
          <span className="truncate">{meta.join(" · ")}</span>
        </span>
      </span>
      {/* A question: neither answer stands out. */}
      <span className="flex flex-wrap items-center gap-xs">
        <Button
          variant="secondary"
          // « Non » to the other person: the name stays and is not asked about again.
          onClick={() => void actions.refuse(target, match.person.id)}
        >
          {person.self ? m.people_doubt_keep_self() : m.people_doubt_keep({ name: person.name })}
        </Button>
        <Button
          variant="secondary"
          onClick={() => void actions.name(target, { kind: "existing", person: match.person })}
        >
          {match.person.self ? m.voice_is_me() : m.people_doubt_is({ name: match.person.name })}
        </Button>
        <Link
          to="/episode/$id"
          params={{ id: String(episode.id) }}
          search={{ t: voice.startMs }}
          className="shrink-0 corner-xs text-body-s underline underline-offset-4 focus-ring"
        >
          {m.people_open_conversation()}
        </Link>
      </span>
    </li>
  );
}

function WhoIsThis() {
  const unnamed = useQuery(orpc.people.unnamed.queryOptions());
  const [shown, setShown] = useState(false);
  const voices = unnamed.data?.voices ?? [];
  if (voices.length === 0) return null;
  const today = dayOf(Date.now());
  return (
    <section aria-label={m.voice_who()} className="flex flex-col gap-s">
      <Toggle
        pressed={shown}
        onPressedChange={setShown}
        className="self-start corner-full px-s py-xxs ring-[1px] ring-neutral-4"
      >
        {m.people_unnamed_chip({ count: voices.length })}
      </Toggle>
      {shown ? <p className="text-body-s text-cte-text-muted">{m.people_unnamed_hint()}</p> : null}
      {shown ? (
        <ul className={`${cardClassName} gap-zero p-zero`}>
          {voices.map((item) => {
            const voice = voiceOf(
              item.ordinal,
              item.self,
              item.selfOrdinal,
              null,
              item.recognized?.person ?? null,
            );
            const meta = [
              formatDuration(item.voicedMs),
              contextLabel(item.episode),
              `${dayTitle(dayOf(item.episode.startedAtMs), today)} ${clock(item.episode.startedAtMs)}`,
            ].filter((part) => part !== null);
            return (
              <li
                key={`${item.runId}:${item.label}`}
                className={`flex items-baseline gap-m p-s ${rowDivider}`}
              >
                <VoiceName
                  entry={{ label: item.label, voice, voicedMs: item.voicedMs }}
                  episodeId={item.episode.id}
                  runId={item.runId}
                  person={null}
                  recognized={item.recognized}
                  suggestion={item.suggestion}
                />
                <span className="flex min-w-0 flex-1 items-center gap-xxs text-body-s text-cte-text-muted">
                  <EpisodeAppIcon episode={item.episode} />
                  <span className="truncate">{meta.join(" · ")}</span>
                </span>
                <Link
                  to="/episode/$id"
                  params={{ id: String(item.episode.id) }}
                  className="shrink-0 corner-xs text-body-s underline underline-offset-4 focus-ring"
                >
                  {m.people_open_conversation()}
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
