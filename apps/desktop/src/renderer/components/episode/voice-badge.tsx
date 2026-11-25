import type { EpisodeDetail, EpisodeSpeaker, VoiceMatch } from "@sondine/api";
import { Button } from "@sondine/ui/components/button";
import {
  Popover,
  PopoverDescription,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "@sondine/ui/components/popover";
import { ChevronLeftIcon, ChevronRightIcon, PlayIcon } from "@sondine/ui/icon";
import { useMemo, useState } from "react";
import { clock, formatDuration, voiceName } from "../../lib/labels";
import { formatOffset } from "../../lib/time";
import { episodeVoices, voiceGroups, type EpisodeVoice, type VoiceGroup } from "../../lib/voices";
import { m } from "../../paraglide/messages.js";
import { usePlayer } from "../player/player-provider";
import { passagesOf } from "./voice-changes";
import {
  ConfirmButton,
  GuessQuestion,
  guessOf,
  useVoiceActions,
  VoiceEditor,
  VoiceLabel,
  type VoiceActions,
  type VoiceTarget,
} from "./voice-name";

// The episode's voices in its header, one badge per person (ADR 038): two
// voices diarization numbered apart for « Marie » are one badge with their
// time added, and they stay visible in its popover. A click on a badge shows
// where the voice speaks: « Écouter » plays its first passage, each passage
// plays from its time, and that is where it is named, its guess answered, or
// (an unnamed voice) merged with another the user hears is the same person.
// A guess keeps its ✓ beside the badge, one click (ADR 037).

/** What the popover shows: the badge, one of its voices, naming one, or merging one. */
type View =
  | { readonly kind: "main" }
  | { readonly kind: "voice"; readonly label: string }
  | { readonly kind: "edit"; readonly label: string; readonly back: View }
  | { readonly kind: "merge"; readonly label: string; readonly back: View };

const MAIN: View = { kind: "main" };

export function VoiceBadges({ detail }: { detail: EpisodeDetail }) {
  const groups = useMemo(() => voiceGroups(episodeVoices(detail.speakers)), [detail.speakers]);
  if (groups.length === 0) return null;
  return (
    <ul aria-label={m.episode_voices()} className="flex flex-wrap items-center gap-xs">
      {groups.map((group) => (
        <VoiceBadge
          // A new transcript is a new voice, even under the same label.
          key={`${detail.analysis?.runId ?? 0}:${group.key}`}
          group={group}
          detail={detail}
        />
      ))}
    </ul>
  );
}

function VoiceBadge({ group, detail }: { group: VoiceGroup; detail: EpisodeDetail }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>(MAIN);
  const actions = useVoiceActions(() => {
    setOpen(false);
    setView(MAIN);
  });
  const runId = detail.analysis?.runId ?? null;
  const naming = runId !== null && detail.recognized;
  const speakerOf = (label: string) => detail.speakers.find((speaker) => speaker.label === label);
  const guessFor = (label: string) => {
    const speaker = speakerOf(label);
    return !naming || speaker === undefined
      ? null
      : guessOf(speaker.person, speaker.recognized, speaker.suggestion);
  };
  const isRecognition = (label: string) => {
    const guess = guessFor(label);
    return guess !== null && guess === speakerOf(label)?.recognized;
  };
  const shown = group.entries.find((entry) => entry.voice === group.voice) ?? group.entries[0];
  const guesses = group.entries.flatMap((entry) => {
    const guess = guessFor(entry.label);
    return guess === null ? [] : [{ entry, guess }];
  });
  if (shown === undefined) return null;
  const target = (label: string): VoiceTarget | null =>
    runId === null ? null : { episodeId: detail.episode.id, runId, label };
  const confirmAll = () => {
    for (const { entry, guess } of guesses) {
      const at = target(entry.label);
      if (at !== null) void actions.name(at, { kind: "existing", person: guess.person });
    }
  };
  const close = () => {
    setOpen(false);
    setView(MAIN);
  };

  return (
    <li className="flex items-baseline gap-xxs corner-full px-s py-xxs ring-[1px] ring-neutral-4">
      <Popover
        open={open}
        onOpenChange={(next, details) => {
          // Hovering opened it on a guess; once the user went further, only a click or Escape closes.
          if (!next && view !== MAIN && details.reason === "trigger-hover") return;
          setOpen(next);
          if (!next) setView(MAIN);
        }}
      >
        <PopoverTrigger
          openOnHover={guesses.length > 0}
          closeDelay={150}
          render={
            <button
              type="button"
              className="flex items-baseline gap-xxs corner-xs font-body font-medium text-start focus-ring"
            />
          }
        >
          <span className="underline decoration-dotted underline-offset-4">
            <VoiceLabel
              voice={shown}
              guess={guessFor(shown.label)}
              recognized={isRecognition(shown.label)}
            />
          </span>
          <span className="text-body-xs font-regular text-cte-text-muted">
            {formatDuration(group.voicedMs)}
          </span>
        </PopoverTrigger>
        <PopoverPopup align="start" className="w-[20rem] gap-s">
          <BadgeView
            view={view}
            group={group}
            shown={shown}
            detail={detail}
            naming={naming}
            guessFor={guessFor}
            isRecognition={isRecognition}
            speakerOf={speakerOf}
            target={target}
            actions={actions}
            onView={setView}
            onLeave={close}
          />
        </PopoverPopup>
      </Popover>
      {guesses[0] === undefined ? null : (
        <ConfirmButton name={guesses[0].guess.person.name} onConfirm={confirmAll} />
      )}
    </li>
  );
}

function BadgeView({
  view,
  group,
  shown,
  detail,
  naming,
  guessFor,
  isRecognition,
  speakerOf,
  target,
  actions,
  onView,
  onLeave,
}: {
  view: View;
  group: VoiceGroup;
  shown: EpisodeVoice;
  detail: EpisodeDetail;
  naming: boolean;
  guessFor: (label: string) => VoiceMatch | null;
  isRecognition: (label: string) => boolean;
  speakerOf: (label: string) => EpisodeSpeaker | undefined;
  target: (label: string) => VoiceTarget | null;
  actions: VoiceActions;
  onView: (view: View) => void;
  onLeave: () => void;
}) {
  const entryOf = (label: string) => group.entries.find((entry) => entry.label === label);
  if (view.kind === "edit" || view.kind === "merge") {
    const entry = entryOf(view.label);
    const at = target(view.label);
    if (entry === undefined || at === null) return null;
    return (
      <>
        <BackButton onBack={() => onView(view.back)} />
        {view.kind === "edit" ? (
          <VoiceEditor
            entry={entry}
            target={at}
            person={speakerOf(view.label)?.person ?? null}
            recognized={speakerOf(view.label)?.recognized != null}
            actions={actions}
            onLeave={onLeave}
          />
        ) : (
          <MergeList
            entry={entry}
            candidates={mergeCandidates(detail, view.label)}
            guessFor={guessFor}
            isRecognition={isRecognition}
            onMerge={(other) => void actions.merge(at, other)}
          />
        )}
      </>
    );
  }
  const single =
    view.kind === "voice" ? entryOf(view.label) : group.entries.length === 1 ? shown : null;
  if (single === null || single === undefined) {
    // A person with several voices: each listed, opened in a second step.
    return (
      <>
        <BadgeTitle
          voice={shown}
          guess={guessFor(shown.label)}
          recognized={isRecognition(shown.label)}
          voicedMs={group.voicedMs}
        />
        <Listen
          episodeId={detail.episode.id}
          episodeStart={detail.episode.startedAtMs}
          segments={detail.segments}
          labels={group.entries.map((entry) => entry.label)}
          listed={false}
        />
        <ul aria-label={m.voice_group_voices()} className="flex flex-col">
          {group.entries.map((entry) => (
            <li key={entry.label}>
              <Button
                variant="ghost"
                className="w-full justify-start"
                onClick={() => onView({ kind: "voice", label: entry.label })}
              >
                <span className="min-w-0 flex-1 truncate text-start">
                  {voiceNumberOf(entry)}
                  {guessFor(entry.label) === null ? null : (
                    <span className="text-cte-text-muted">
                      {" · "}
                      <VoiceLabel
                        voice={entry}
                        guess={guessFor(entry.label)}
                        recognized={isRecognition(entry.label)}
                      />
                    </span>
                  )}
                </span>
                <span className="text-body-xs tabular-nums text-cte-text-muted">
                  {formatDuration(entry.voicedMs)}
                </span>
                <ChevronRightIcon className="text-cte-text-muted" />
              </Button>
            </li>
          ))}
        </ul>
      </>
    );
  }
  const speaker = speakerOf(single.label);
  const guess = guessFor(single.label);
  const at = target(single.label);
  const person = speaker?.person ?? null;
  const candidates = naming && person === null ? mergeCandidates(detail, single.label) : [];
  const here: View = view.kind === "voice" ? view : MAIN;
  return (
    <>
      {view.kind === "voice" ? <BackButton onBack={() => onView(MAIN)} /> : null}
      <BadgeTitle
        voice={single}
        guess={guess}
        recognized={isRecognition(single.label)}
        voicedMs={view.kind === "voice" ? single.voicedMs : group.voicedMs}
        number={view.kind === "voice" ? voiceNumberOf(single) : null}
      />
      {guess !== null && at !== null ? (
        <GuessQuestion
          guess={guess}
          recognized={isRecognition(single.label)}
          onYes={() => void actions.name(at, { kind: "existing", person: guess.person })}
          onNo={() => void actions.refuse(at, guess.person.id)}
          onEdit={() => onView({ kind: "edit", label: single.label, back: here })}
        />
      ) : null}
      <Listen
        episodeId={detail.episode.id}
        episodeStart={detail.episode.startedAtMs}
        segments={detail.segments}
        labels={[single.label]}
      />
      {!naming && single.voice.kind === "self" ? (
        <PopoverDescription>{m.voice_self_hint()}</PopoverDescription>
      ) : null}
      {naming && at !== null && guess === null && person === null ? (
        // An unknown voice: hear it, then say who it is, here.
        <VoiceEditor
          entry={single}
          target={at}
          person={null}
          recognized={false}
          actions={actions}
          onLeave={onLeave}
          titled={false}
        />
      ) : null}
      {(naming && person !== null) || candidates.length > 0 ? (
        <div className="flex flex-wrap items-center gap-xs">
          {naming && person !== null ? (
            <Button
              variant="secondary"
              onClick={() => onView({ kind: "edit", label: single.label, back: here })}
            >
              {m.voice_edit()}
            </Button>
          ) : null}
          {candidates.length > 0 ? (
            <Button
              variant="ghost"
              onClick={() => onView({ kind: "merge", label: single.label, back: here })}
            >
              {m.voice_merge()}
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** « Voix 2 »: a voice by its number, where a person has several. */
function voiceNumberOf(entry: EpisodeVoice): string {
  return entry.voice.kind === "person" || entry.voice.kind === "other"
    ? m.voice_number({ number: String(entry.voice.number) })
    : voiceName(entry.voice);
}

function BadgeTitle({
  voice,
  guess,
  recognized,
  voicedMs,
  number = null,
}: {
  voice: EpisodeVoice;
  guess: VoiceMatch | null;
  recognized: boolean;
  voicedMs: number;
  /** « Voix 2 », when the badge holds several voices. */
  number?: string | null;
}) {
  return (
    <PopoverTitle className="flex items-baseline gap-xs">
      <span className="min-w-0 truncate">
        {number ?? <VoiceLabel voice={voice} guess={guess} recognized={recognized} />}
      </span>
      <span className="text-body-xs font-regular text-cte-text-muted">
        {formatDuration(voicedMs)}
      </span>
    </PopoverTitle>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <Button variant="ghost" className="-ms-s self-start" onClick={onBack}>
      <ChevronLeftIcon />
      {m.welcome_back()}
    </Button>
  );
}

/**
 * « Écouter » plays the first passage now; each passage, by its time, plays
 * from there. The transcript follows what plays.
 */
function Listen({
  episodeId,
  episodeStart,
  segments,
  labels,
  listed = true,
}: {
  episodeId: number;
  segments: EpisodeDetail["segments"];
  labels: readonly string[];
  /** Each passage by its time; a person's several voices list theirs one voice at a time. */
  listed?: boolean;
  /** Passages read as the transcript's times: into the recording. */
  episodeStart: number;
}) {
  const player = usePlayer();
  const key = labels.join("\n");
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- the labels by value.
  const passages = useMemo(() => passagesOf(segments, new Set(labels)), [segments, key]);
  const first = passages[0];
  if (first === undefined) return null;
  const start = episodeStart;
  return (
    <div className="flex flex-col gap-xs">
      <Button
        variant="secondary"
        className="self-start"
        onClick={() => void player.play(episodeId, first.startMs)}
      >
        <PlayIcon />
        {m.voice_listen()}
      </Button>
      {!listed || passages.length < 2 ? null : (
        <ul
          aria-label={m.voice_passages()}
          className="flex max-h-[7.5rem] flex-wrap gap-xxs overflow-y-auto"
        >
          {passages.map((passage) => (
            <li key={passage.index}>
              <button
                type="button"
                title={clock(passage.startMs)}
                aria-label={m.voice_passage_play({ time: formatOffset(passage.startMs - start) })}
                onClick={() => void player.play(episodeId, passage.startMs)}
                className="corner-xs bg-neutral-2 px-xs py-xxs font-data text-body-xs tabular-nums transition-[background-color] duration-motion ease-motion control-hover:bg-neutral-3 focus-ring motion-reduce:transition-none"
              >
                {formatOffset(passage.startMs - start)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The other unnamed voices of the transcript: what « Fusionner avec… » offers. */
function mergeCandidates(detail: EpisodeDetail, label: string): EpisodeVoice[] {
  return episodeVoices(detail.speakers).filter(
    (entry) =>
      entry.label !== label &&
      detail.speakers.find((speaker) => speaker.label === entry.label)?.person === null,
  );
}

/** « Fusionner avec… »: the voice picked is the same person; both become one. */
function MergeList({
  entry,
  candidates,
  guessFor,
  isRecognition,
  onMerge,
}: {
  entry: EpisodeVoice;
  candidates: readonly EpisodeVoice[];
  guessFor: (label: string) => VoiceMatch | null;
  isRecognition: (label: string) => boolean;
  onMerge: (other: string) => void;
}) {
  return (
    <>
      <PopoverTitle>{m.voice_merge()}</PopoverTitle>
      <PopoverDescription>
        {m.voice_merge_hint({ name: voiceName(entry.voice) })}
      </PopoverDescription>
      <ul aria-label={m.voice_merge()} className="flex flex-col">
        {candidates.map((candidate) => (
          <li key={candidate.label}>
            <Button
              variant="ghost"
              className="w-full justify-start"
              onClick={() => onMerge(candidate.label)}
            >
              <span className="min-w-0 flex-1 truncate text-start">
                <VoiceLabel
                  voice={candidate}
                  guess={guessFor(candidate.label)}
                  recognized={isRecognition(candidate.label)}
                />
              </span>
              <span className="text-body-xs tabular-nums text-cte-text-muted">
                {formatDuration(candidate.voicedMs)}
              </span>
            </Button>
          </li>
        ))}
      </ul>
    </>
  );
}
