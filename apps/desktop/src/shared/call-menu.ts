import type { CallContext } from "@sondine/api";
import { NOTCH_MONOGRAM_MAX, NOTCH_WORDS_MAX } from "@sondine/protocol";
import { m } from "../renderer/paraglide/messages.js";

// Call context in the menu bar and beside the notch (ADR 025): « Marie ? »
// next to Sondine's icon and beside the notch while a call goes on with
// someone recognized; her last conversations at the top of the menu, and in
// the notch when the pointer rests on it. Both read one view, made here with
// every word translated, so the notch helper has no strings of its own.
// Environment-free, so it is tested in Node.

export interface CallConversation {
  readonly episodeId: number;
  /** « Aujourd’hui 10:05 », « Hier 18:30 », « mardi 3 novembre 09:15 ». */
  readonly when: string;
  /** The conversation's first words, clipped; null when it has none. */
  readonly words: string | null;
}

export interface CallPersonView {
  readonly personId: number;
  /** « Marie ? »: always a guess. */
  readonly label: string;
  /** Her initial, beside the notch. */
  readonly monogram: string;
  readonly conversations: readonly CallConversation[];
  /** « Aucune conversation avant » when there is none. */
  readonly none: string | null;
}

export interface CallView {
  readonly callId: number;
  /** The first person suggested, as the menu bar and the notch name her. */
  readonly title: string;
  readonly people: readonly CallPersonView[];
  /** « Masquer pour cet appel ». */
  readonly dismiss: string;
  /** The notch opens when the pointer rests on it; otherwise on a click. */
  readonly openOnHover: boolean;
}

export type CallMenuItem =
  /** Opens the person's page. */
  | { readonly kind: "person"; readonly label: string; readonly personId: number }
  /** Opens a conversation. */
  | { readonly kind: "conversation"; readonly label: string; readonly episodeId: number }
  | { readonly kind: "none"; readonly label: string }
  /** « Masquer pour cet appel ». */
  | { readonly kind: "dismiss"; readonly label: string; readonly callId: number };

export interface CallMenu {
  /** Next to the icon: the first person suggested. */
  readonly title: string;
  readonly items: readonly CallMenuItem[];
}

/** First words kept, in the menu and in the notch (its wire's bound). */
const WORDS = NOTCH_WORDS_MAX;

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** « Aujourd’hui 14:05 », « Hier 09:12 », « mardi 4 novembre 16:40 ». */
export function whenLabel(ms: number, nowMs: number, locale: string): string {
  const date = new Date(ms);
  const today = new Date(nowMs);
  const yesterday = new Date(nowMs);
  yesterday.setDate(today.getDate() - 1);
  const options = { locale: locale === "fr" ? "fr" : "en" } as const;
  const day = sameDay(date, today)
    ? m.day_today({}, options)
    : sameDay(date, yesterday)
      ? m.day_yesterday({}, options)
      : new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long" }).format(
          date,
        );
  // As the window writes times (`formatClock`).
  const time = new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(date);
  return `${day} ${time}`;
}

const graphemes = (text: string) => [
  ...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text),
];

/**
 * At most `length` UTF-16 units, as JavaScript and the notch count them,
 * cut between two characters a person reads (never inside an emoji), with
 * « … » when cut.
 */
export function clip(text: string, length: number): string {
  if (text.length <= length) return text;
  let kept = "";
  for (const { segment } of graphemes(text)) {
    if (kept.length + segment.length > length - 1) break;
    kept += segment;
  }
  return `${kept.trimEnd()}…`;
}

/**
 * The first letter of a name, as one character a person reads (an accent or
 * an emoji stays whole), or its first code point when that character is
 * longer than the notch takes.
 */
export function monogram(name: string, locale: string): string {
  const first = graphemes(name.trim())[0]?.segment.toLocaleUpperCase(locale);
  if (first === undefined) return "?";
  if (first.length <= NOTCH_MONOGRAM_MAX) return first;
  return String.fromCodePoint(first.codePointAt(0) ?? 0x3f);
}

/** What the call shows; null when there is nothing to show. */
export function callView(
  context: CallContext | null,
  locale: "en" | "fr",
  nowMs: number,
): CallView | null {
  const call = context?.call ?? null;
  if (call === null || call.dismissed || call.people.length === 0) return null;
  const options = { locale };
  const people = call.people.map(({ person, conversations }): CallPersonView => ({
    personId: person.id,
    label: m.voice_guess({ name: person.name }, options),
    monogram: monogram(person.name, locale),
    conversations: conversations.map((conversation) => ({
      episodeId: conversation.id,
      when: whenLabel(conversation.startedAtMs, nowMs, locale),
      words: conversation.firstWords === null ? null : clip(conversation.firstWords, WORDS),
    })),
    none: conversations.length === 0 ? m.call_menu_none({}, options) : null,
  }));
  return {
    callId: call.callId,
    title: people[0]?.label ?? "",
    people,
    dismiss: m.call_menu_dismiss({}, options),
    openOnHover: context?.notch.openOnHover ?? true,
  };
}

/** The menu's call section; null when there is nothing to show. */
export function callMenu(view: CallView | null): CallMenu | null {
  if (view === null) return null;
  const items: CallMenuItem[] = [];
  for (const person of view.people) {
    items.push({ kind: "person", label: person.label, personId: person.personId });
    if (person.none !== null) items.push({ kind: "none", label: person.none });
    for (const { episodeId, when, words } of person.conversations) {
      items.push({
        kind: "conversation",
        label: words === null ? when : `${when} · ${words}`,
        episodeId,
      });
    }
  }
  items.push({ kind: "dismiss", label: view.dismiss, callId: view.callId });
  return { title: view.title, items };
}
