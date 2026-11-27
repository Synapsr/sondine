import { BundleId, EpisodeContext, EpisodeSize } from "@sondine/api";
import * as z from "zod";
import { isDay } from "../lib/day";

// The screens' URL state, parsed leniently: a value that does not parse is
// dropped instead of failing the route, so an old or hand-edited link still
// opens the screen.

const lenient = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

export const TodaySearch = z.object({
  /** The day shown; today when absent. */
  day: lenient(z.string().refine(isDay)),
  /** The media lane is shown or hidden; absent, the first run's goal says (ADR 037). */
  media: lenient(z.boolean()),
  /** The dictations lane is shown or hidden; absent, the first run's goal says. */
  dictations: lenient(z.boolean()),
});
export type TodaySearch = z.output<typeof TodaySearch>;

/** The calendar's zoom (Téo, 2026-11-19): its day is Today's view, kept in the calendar. */
export const CalendarZoom = z.enum(["day", "week", "month"]);
export type CalendarZoom = z.output<typeof CalendarZoom>;

export const CalendarSearch = z.object({
  /** A week when absent. */
  zoom: lenient(CalendarZoom),
  /** The day shown, or a day in the week or month shown; today when absent. */
  day: lenient(z.string().refine(isDay)),
  /** At the day's zoom, the media and dictations shown, as on Today. */
  media: lenient(z.boolean()),
  dictations: lenient(z.boolean()),
});
export type CalendarSearch = z.output<typeof CalendarSearch>;

export const SearchPeriod = z.enum(["today", "7d", "30d"]);
export type SearchPeriod = z.output<typeof SearchPeriod>;

/** The search screen's filters; a conversation opened from it keeps them for the way back. */
const searchFilters = {
  /** All dates when absent. */
  period: lenient(SearchPeriod),
  /** All sizes when absent. */
  sizes: lenient(z.array(EpisodeSize).min(1).max(3)),
  /** All contexts when absent. */
  contexts: lenient(z.array(EpisodeContext).min(1).max(6)),
  /** Only what was said while this app (bundle ID) was in front; any app when absent. */
  app: lenient(BundleId),
  /** Only the recordings with this tag (ADR 039); every recording when absent. */
  tag: lenient(z.string().trim().min(1).max(60)),
};

export const SearchScreenSearch = z.object({
  q: lenient(z.string().max(200)),
  ...searchFilters,
});
export type SearchScreenSearch = z.output<typeof SearchScreenSearch>;

export const EpisodeSearch = z.object({
  /** Wall-clock time to start playing at (a search hit's start). */
  t: lenient(z.number().int().nonnegative()),
  /** The search the episode was opened from, highlighted in the transcript. */
  q: lenient(z.string().trim().min(1).max(200)),
  ...searchFilters,
});
export type EpisodeSearch = z.output<typeof EpisodeSearch>;

/** The filters of a search screen's or a conversation's URL state, without the rest. */
export function filtersOf(search: SearchScreenSearch | EpisodeSearch) {
  return {
    ...(search.period === undefined ? {} : { period: search.period }),
    ...(search.sizes === undefined ? {} : { sizes: search.sizes }),
    ...(search.contexts === undefined ? {} : { contexts: search.contexts }),
    ...(search.app === undefined ? {} : { app: search.app }),
    ...(search.tag === undefined ? {} : { tag: search.tag }),
  };
}

export const JournalSearch = z.object({
  /** The day shown; today when absent. */
  day: lenient(z.string().refine(isDay)),
});
export type JournalSearch = z.output<typeof JournalSearch>;

export const ChatSearch = z.object({
  /** The discussion open; a new one when absent. */
  d: lenient(z.number().int().positive()),
});
export type ChatSearch = z.output<typeof ChatSearch>;

/** A section of Settings, each its own page (Téo, 2026-11-19). */
export const SettingsPage = z.enum([
  "general",
  "transcription",
  "vocabulary",
  "journal",
  "listening",
  "privacy",
  "voices",
  "phone",
  "agents",
  "statistics",
  "data",
  "advanced",
]);
export type SettingsPage = z.output<typeof SettingsPage>;

/** The tabs Settings had before its pages: old links still land on the right page. */
const SettingsTab = z.enum(["general", "listening", "voices", "devices", "statistics", "advanced"]);

export const SettingsSearch = z.object({
  tab: lenient(SettingsTab),
});
export type SettingsSearch = z.output<typeof SettingsSearch>;

/** The page an old `?tab=` link meant. */
export function pageOfTab(tab: z.output<typeof SettingsTab>): SettingsPage {
  return tab === "devices" ? "phone" : tab;
}
