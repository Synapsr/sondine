import type {
  EpisodeAnalysisState,
  EpisodeContext,
  EpisodeSize,
  EpisodeSummary,
  PersonRef,
} from "@sondine/api";
import type { BadgeProps } from "@sondine/ui/components/badge";
import { m } from "../paraglide/messages.js";
import { getLocale } from "../paraglide/runtime.js";
import { dayNoonMs, dayOf, relativeDay } from "./day";
import { siteMark } from "./site-mark";
import { durationParts, formatClock } from "./time";
import type { Voice } from "./voices";

// The words every screen uses for episodes, voices, days and lengths, in the
// current language.

type BadgeVariant = NonNullable<BadgeProps["variant"]>;

const contextText: Record<EpisodeContext, () => string> = {
  call: () => m.episode_context_call(),
  in_person: () => m.episode_context_in_person(),
  media: () => m.episode_context_media(),
  mixed: () => m.episode_context_mixed(),
  dictation: () => m.episode_context_dictation(),
  imported: () => m.episode_context_imported(),
};

const sizeText: Record<EpisodeSize, () => string> = {
  trace: () => m.episode_size_trace(),
  moment: () => m.episode_size_moment(),
  conversation: () => m.episode_size_conversation(),
};

/**
 * « Appel · zoom.us », « Dictée · Hex », « En personne », « En personne ·
 * iPhone » (the phone mark, ADR 032, with « heure incertaine » when the
 * phone's clock was not plausible, the name typed on the phone, ADR 008, and
 * « aussi sur le Mac » when the Mac recorded the same meeting); null before
 * the first grouping pass.
 */
export function contextLabel(episode: EpisodeSummary): string | null {
  if (episode.context === null) return null;
  // A site with its own mark (YouTube, Vimeo, Twitch) names what played it,
  // as its icon does: « Média · YouTube », not the browser.
  const [first] = episode.apps;
  const app = episode.page !== null && siteMark(episode.page) !== null ? episode.page : first;
  return [
    // A phone recording of the user alone reads as a note (ADR 039).
    episode.note ? m.episode_context_note() : contextText[episode.context](),
    ...(app === undefined ? [] : [app.name]),
    ...(episode.phone === null ? [] : [m.episode_phone()]),
    ...(episode.phone?.timeUncertain === true ? [m.episode_phone_time_uncertain()] : []),
    ...(episode.phone?.name == null ? [] : [episode.phone.name]),
    ...(episode.alsoRecordedBy === null
      ? []
      : [episode.alsoRecordedBy === "mac" ? m.episode_also_on_mac() : m.episode_also_on_phone()]),
  ].join(" · ");
}

/** « Gardé à 14:32 »: the user kept a moment of it (« Garder les 2 dernières minutes »); null otherwise. */
export function keptLabel(episode: EpisodeSummary): string | null {
  return episode.keptAtMs === null ? null : m.episode_kept_at({ time: clock(episode.keptAtMs) });
}

/** « YouTube · Le titre », or the site's name alone when no title is kept (ADR 023). */
export function pageLabel(page: NonNullable<EpisodeSummary["page"]>): string {
  return page.title === "" ? page.name : `${page.name} · ${page.title}`;
}

export function sizeLabel(size: EpisodeSize | null): string {
  return sizeText[size ?? "moment"]();
}

export const analysisBadge: Record<
  EpisodeAnalysisState,
  { readonly variant: BadgeVariant; readonly label: () => string }
> = {
  pending: { variant: "neutral", label: () => m.episode_analysis_pending() },
  queued: { variant: "neutral", label: () => m.episode_analysis_queued() },
  running: { variant: "warning", label: () => m.episode_analysis_running() },
  complete: { variant: "success", label: () => m.episode_analysis_complete() },
  failed: { variant: "error", label: () => m.episode_analysis_failed() },
  stale: { variant: "warning", label: () => m.episode_analysis_stale() },
};

/** Whether « Transcrire maintenant » applies: a closed episode not transcribed or being transcribed. */
export function canTranscribe(episode: EpisodeSummary): boolean {
  return (
    episode.state === "closed" &&
    episode.analysisState !== "running" &&
    episode.analysisState !== "complete"
  );
}

/** The name of someone Sondine recognized, not confirmed by the user: « Marie* » (ADR 030). */
export const unconfirmed = (name: string): string => m.voice_unconfirmed({ name });

/** A voice as every screen names it; « Marie* » when Sondine only recognized it. */
export function voiceName(voice: Voice): string {
  switch (voice.kind) {
    case "self":
      return voice.recognized === true ? unconfirmed(m.voice_self()) : m.voice_self();
    case "person":
      return voice.recognized === true ? unconfirmed(voice.name) : voice.name;
    case "other":
      return m.voice_number({ number: String(voice.number) });
    case "unknown":
      return m.voice_unknown();
    case "track":
      return voice.track === "microphone" ? m.voice_track_microphone() : m.voice_track_computer();
  }
}

/**
 * The people heard in an episode as they read, the user first: those the user
 * named, and those Sondine recognized (ADR 030), marked « Marie* ».
 */
export function peopleThere(
  episode: EpisodeSummary,
): { readonly name: string; readonly self: boolean }[] {
  const named = (person: PersonRef) => (person.self ? m.voice_self() : person.name);
  return [
    ...episode.people.map((person) => ({ name: named(person), self: person.self })),
    ...episode.recognized.map((person) => ({
      name: unconfirmed(named(person)),
      self: person.self,
    })),
  ].toSorted((a, b) => Number(b.self) - Number(a.self));
}

/**
 * Who was there: « Moi, Marie* », « Marie et 1 autre voix », or « 3 voix »
 * before anyone is named or recognized; null for a single unnamed voice.
 */
export function voicesLabel(episode: EpisodeSummary): string | null {
  const names = peopleThere(episode).map((person) => person.name);
  if (names.length === 0) {
    return episode.speakerCount >= 2 ? m.today_voices({ count: episode.speakerCount }) : null;
  }
  const others = Math.max(0, episode.speakerCount - names.length);
  const list = names.join(", ");
  return others === 0 ? list : m.today_people_others({ names: list, count: others });
}

/**
 * A voice's confidence (ADR 030) as a percentage, never rounded up: « 87 % »,
 * one decimal from 99 %, where « 100 % » would claim a certainty, and
 * « < 1 % » below one.
 */
export function confidenceLabel(confidence: number): string {
  const format = (value: number) =>
    new Intl.NumberFormat(getLocale(), {
      style: "percent",
      maximumFractionDigits: value >= 0.99 ? 1 : 0,
      roundingMode: "floor",
    }).format(value);
  // Under 1 %, « < 1 % » rather than a « 0 % » that would say never.
  return confidence < 0.01 ? `< ${format(0.01)}` : format(Math.min(confidence, 0.999));
}

/** « 11 min », « 6 s », « 1 h 05 ». */
export function formatDuration(ms: number): string {
  const parts = durationParts(ms);
  switch (parts.unit) {
    case "seconds":
      return m.duration_seconds({ seconds: String(parts.seconds) });
    case "minutes":
      return m.duration_minutes({ minutes: String(parts.minutes) });
    case "hours":
      return m.duration_hours({
        hours: String(parts.hours),
        minutes: String(parts.minutes).padStart(2, "0"),
      });
  }
}

export function clock(ms: number): string {
  return formatClock(ms, getLocale());
}

/** « 11:10 – 11:34 », « 16:31 – en cours », « 14:22 » within one minute. */
export function timeRange(startMs: number, endMs: number | null): string {
  const start = clock(startMs);
  if (endMs === null) return m.time_range({ start, end: m.episode_state_open_lower() });
  const end = clock(endMs);
  return end === start ? start : m.time_range({ start, end });
}

/** How long an episode lasts so far. */
export function episodeLength(episode: EpisodeSummary, nowMs: number): number {
  return (episode.endedAtMs ?? nowMs) - episode.startedAtMs;
}

const capitalize = (text: string) => text.charAt(0).toLocaleUpperCase() + text.slice(1);

function dateText(day: string, withYear: boolean): string {
  return capitalize(
    new Intl.DateTimeFormat(getLocale(), {
      weekday: "long",
      day: "numeric",
      month: "long",
      ...(withYear ? { year: "numeric" } : {}),
    }).format(dayNoonMs(day)),
  );
}

/** « Jeudi 5 novembre », with the year when it is not this year's. */
export function longDate(day: string, today: string): string {
  return dateText(day, day.slice(0, 4) !== today.slice(0, 4));
}

/** « Jeudi 5 novembre 2026 », for what is read later (an exported file). */
export function fullDate(day: string): string {
  return dateText(day, true);
}

/** « Aujourd'hui », « Hier », or the date. */
export function dayTitle(day: string, today: string): string {
  switch (relativeDay(day, today)) {
    case "today":
      return m.day_today();
    case "yesterday":
      return m.day_yesterday();
    case "other":
      return longDate(day, today);
  }
}

/** « 14:05 » today, « Hier, 14:05 » before. */
export function dayClock(ms: number, nowMs: number = Date.now()): string {
  const today = dayOf(nowMs);
  const day = dayOf(ms);
  return day === today ? clock(ms) : `${dayTitle(day, today)}, ${clock(ms)}`;
}

/** A playback rate as the speed control shows it: « 1,5× ». */
export function rateLabel(rate: number): string {
  return `${new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 1 }).format(rate)}×`;
}
