import type { JournalCommitment, JournalVoice } from "@sondine/api";
import { addDays, dayOf } from "../../lib/day";
import { unconfirmed } from "../../lib/labels";
import { voiceNumber } from "../../lib/voices";
import { m } from "../../paraglide/messages.js";
import { getLocale } from "../../paraglide/runtime.js";

// How the journal reads (ADR 028): its voices named as the transcript names
// them now (« Marie », « Voix 2 », « Moi »), or, for a voice nobody named,
// whom Sondine takes it for, to confirm (« Marie ? », ADR 030); a
// commitment's people and date in a few words. A line's own words are the
// model's, or the user's.

/** A voice's name now: the person's, « Moi », or its number among the others. */
export function journalVoiceName(voice: JournalVoice, voices: readonly JournalVoice[]): string {
  if (voice.self) return m.voice_self();
  if (voice.name !== null) return voice.name;
  if (voice.ordinal === null) return m.voice_unknown();
  const self = voices.find((candidate) => candidate.self)?.ordinal ?? null;
  return m.voice_number({ number: String(voiceNumber(voice.ordinal, self)) });
}

/** A voice as it is read: Sondine's guess too, « Marie ? », « Marie* » once recognized (ADR 030). */
export function journalVoiceHeard(voice: JournalVoice, voices: readonly JournalVoice[]): string {
  const guess = voice.name === null && !voice.self ? voice.guess : null;
  if (guess === null) return journalVoiceName(voice, voices);
  const name = guess.person.self ? m.voice_self() : guess.person.name;
  return guess.recognized ? unconfirmed(name) : m.voice_guess({ name });
}

/**
 * The line with `{P2}` replaced by the voice's name (the user's names only:
 * what the user edits); an unknown ref stays as written.
 */
export function journalText(text: string, voices: readonly JournalVoice[]): string {
  return journalPieces(text, voices)
    .map((piece) => (typeof piece === "string" ? piece : journalVoiceName(piece, voices)))
    .join("");
}

/** The line to read and not edit, in a list or the calendar: a voice Sondine recognized is named too. */
export function journalReading(text: string, voices: readonly JournalVoice[]): string {
  return journalPieces(text, voices)
    .map((piece) =>
      typeof piece === "string"
        ? piece
        : piece.guess?.recognized === true
          ? journalVoiceHeard(piece, voices)
          : journalVoiceName(piece, voices),
    )
    .join("");
}

/** A line's words, with its voices where `{P2}` stood, to show each as it should read. */
export type JournalPiece = string | JournalVoice;

export function journalPieces(text: string, voices: readonly JournalVoice[]): JournalPiece[] {
  const pieces: JournalPiece[] = [];
  let from = 0;
  for (const match of text.matchAll(/\{(P\d+)\}/g)) {
    const voice = voices.find((candidate) => candidate.ref === match[1]);
    if (voice === undefined) continue;
    if (match.index > from) pieces.push(text.slice(from, match.index));
    pieces.push(voice);
    from = match.index + match[0].length;
  }
  if (from < text.length) pieces.push(text.slice(from));
  return pieces;
}

const capitalized = (text: string) => text.charAt(0).toLocaleUpperCase(getLocale()) + text.slice(1);

/** A commitment's text, starting with a capital as a line does. */
export function commitmentText(commitment: JournalCommitment): string {
  return capitalized(journalText(commitment.text, commitment.voices));
}

/** A commitment's text in pieces, starting with a capital as a line does. */
export function commitmentPieces(commitment: JournalCommitment): JournalPiece[] {
  const [first, ...rest] = journalPieces(commitment.text, commitment.voices);
  return typeof first === "string"
    ? [capitalized(first), ...rest]
    : first === undefined
      ? []
      : [first, ...rest];
}

/** A translated sentence with voices put where its placeholders were. */
function withVoices(template: string, voices: readonly JournalVoice[]): JournalPiece[] {
  const pieces: JournalPiece[] = [];
  template.split(/(⟦\d⟧)/).forEach((part) => {
    const index = /^⟦(\d)⟧$/.exec(part)?.[1];
    const voice = index === undefined ? undefined : voices[Number(index)];
    if (voice !== undefined) pieces.push(voice);
    else if (part !== "") pieces.push(part);
  });
  return pieces;
}

/**
 * Who promised it to whom, when it is not the user's own promise to no one:
 * « à Marie », « Marie », « Marie → moi ».
 */
export function commitmentPeople(commitment: JournalCommitment): JournalPiece[] | null {
  const { who, to } = commitment;
  const [a, b] = ["⟦0⟧", "⟦1⟧"];
  if (who === null || who.self) {
    return to === null ? null : withVoices(m.journal_to({ name: a }), [to]);
  }
  return to?.self === true
    ? withVoices(m.journal_from_to_me({ name: a }), [who])
    : to === null
      ? [who]
      : withVoices(m.journal_from_to({ from: a, to: b }), [who, to]);
}

export type DueTone = "past" | "soon" | "later";

/** « aujourd'hui », « demain », « jeudi 12 nov. », and whether it is past. */
export function dueLabel(due: string, today: string): { text: string; tone: DueTone } {
  if (due === today) return { text: m.journal_due_today(), tone: "soon" };
  if (due === addDays(today, 1)) return { text: m.journal_due_tomorrow(), tone: "soon" };
  const [year = 1970, month = 1, day = 1] = due.split("-").map(Number);
  const date = new Date(year, month - 1, day, 12);
  const text = new Intl.DateTimeFormat(getLocale(), {
    weekday: "long",
    day: "numeric",
    month: "short",
    ...(due.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }),
  }).format(date);
  return { text, tone: due < today ? "past" : "later" };
}

/**
 * Days an open commitment stays on today's list without a date close by
 * (Téo, 2026-11-10): older ones, or late by more, fold under « plus anciens ».
 */
export const RECENT_COMMITMENT_DAYS = 7;

/** The user's voice: named as them, or taken for them, recognized or to confirm (ADR 030). */
const isUser = (voice: JournalVoice | null) =>
  voice !== null && (voice.self || (voice.name === null && voice.guess?.person.self === true));

export interface CommitmentGroups {
  /** What the user promised and what was promised to them, of the last week. */
  readonly mine: JournalCommitment[];
  /** Theirs, made more than a week ago without a date, or late by more than a week. */
  readonly older: JournalCommitment[];
  /** Between other people. */
  readonly others: JournalCommitment[];
}

/**
 * Today's open commitments in three groups (Téo, 2026-11-10). A line the
 * user corrected, or their word standing alone, is theirs.
 */
export function commitmentGroups(
  commitments: readonly JournalCommitment[],
  today: string,
): CommitmentGroups {
  const cutoff = addDays(today, -RECENT_COMMITMENT_DAYS);
  const groups: CommitmentGroups = { mine: [], older: [], others: [] };
  for (const commitment of commitments) {
    const users =
      commitment.itemId === null ||
      commitment.edited ||
      isUser(commitment.who) ||
      isUser(commitment.to);
    if (!users) groups.others.push(commitment);
    else if ((commitment.due ?? dayOf(commitment.startMs)) < cutoff) groups.older.push(commitment);
    else groups.mine.push(commitment);
  }
  return groups;
}

export interface CommitmentBoard {
  /** The user's, due before today. */
  readonly late: JournalCommitment[];
  /** The user's, due today or in the next 7 days. */
  readonly soon: JournalCommitment[];
  /** The user's, due after that. */
  readonly later: JournalCommitment[];
  /** The user's, without a date, newest first. */
  readonly undated: JournalCommitment[];
  /** Between other people. */
  readonly others: JournalCommitment[];
}

/**
 * Open commitments of every day by when they are due (the Commitments page,
 * Téo, 2026-11-19): late, the next 7 days and later sooner first, undated
 * newest first; others' apart, as on Today.
 */
export function commitmentBoard(
  commitments: readonly JournalCommitment[],
  today: string,
): CommitmentBoard {
  const week = addDays(today, RECENT_COMMITMENT_DAYS);
  const board: CommitmentBoard = { late: [], soon: [], later: [], undated: [], others: [] };
  for (const commitment of commitments) {
    const users =
      commitment.itemId === null ||
      commitment.edited ||
      isUser(commitment.who) ||
      isUser(commitment.to);
    if (!users) board.others.push(commitment);
    else if (commitment.due === null) board.undated.push(commitment);
    else if (commitment.due < today) board.late.push(commitment);
    else if (commitment.due <= week) board.soon.push(commitment);
    else board.later.push(commitment);
  }
  const byDue = (a: JournalCommitment, b: JournalCommitment) =>
    (a.due ?? "").localeCompare(b.due ?? "") || a.startMs - b.startMs;
  return {
    late: board.late.toSorted(byDue),
    soon: board.soon.toSorted(byDue),
    later: board.later.toSorted(byDue),
    undated: board.undated.toSorted((a, b) => b.startMs - a.startMs),
    others: board.others,
  };
}

/** The people a commitment names, the user left out: who committed and to whom. */
export function commitmentNames(commitment: JournalCommitment): string[] {
  return [commitment.who, commitment.to].flatMap((voice) =>
    voice === null || voice.self || voice.name === null ? [] : [voice.name],
  );
}
