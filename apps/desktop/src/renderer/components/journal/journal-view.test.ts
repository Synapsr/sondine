import type { JournalCommitment, JournalVoice } from "@sondine/api";
import { describe, expect, it } from "vitest";
import {
  commitmentGroups,
  commitmentPeople,
  commitmentPieces,
  journalPieces,
  journalReading,
  journalText,
  journalVoiceHeard,
} from "./journal-view";

// Messages resolve to English in tests.

const voice = (ref: string, ordinal: number, extra: Partial<JournalVoice> = {}): JournalVoice => ({
  ref,
  name: null,
  self: false,
  ordinal,
  guess: null,
  ...extra,
});

const marie = voice("P1", 1, {
  guess: { person: { id: 2, name: "Marie", self: false }, confidence: 0.91, recognized: false },
});
const jean = voice("P2", 2, { name: "Jean" });

describe("the journal's voices", () => {
  it("cuts a line into words and voices, an unknown ref left as written", () => {
    expect(journalPieces("{P1} parle à {P2} de {P9}.", [marie, jean])).toEqual([
      marie,
      " parle à ",
      jean,
      " de {P9}.",
    ]);
  });

  it("keeps the user's names in the text to edit, and shows a guess where a sentence is cited", () => {
    expect(journalText("{P1} parle à {P2}", [marie, jean])).toBe("Voice 1 parle à Jean");
    expect(journalVoiceHeard(marie, [marie, jean])).toBe("Marie?");
    expect(journalVoiceHeard(jean, [marie, jean])).toBe("Jean");
  });

  it("names a recognized voice, marked, where the line is only read", () => {
    const sure = voice("P1", 1, {
      guess: { person: { id: 2, name: "Marie", self: false }, confidence: 0.995, recognized: true },
    });
    expect(journalVoiceHeard(sure, [sure, jean])).toBe("Marie*");
    expect(journalReading("{P1} parle à {P2}", [sure, jean])).toBe("Marie* parle à Jean");
    // Under 99 %, and in the text to edit, it stays a number.
    expect(journalReading("{P1} parle à {P2}", [marie, jean])).toBe("Voice 1 parle à Jean");
    expect(journalText("{P1} parle à {P2}", [sure, jean])).toBe("Voice 1 parle à Jean");
  });

  it("puts the voices of a commitment where its sentence names them", () => {
    const commitment = (who: JournalVoice | null, to: JournalVoice | null) =>
      ({ text: "{P1} envoie le devis", who, to, voices: [marie, jean] }) as JournalCommitment;
    expect(commitmentPeople(commitment(marie, jean))).toEqual([marie, " → ", jean]);
    expect(commitmentPeople(commitment(null, marie))).toEqual(["to ", marie]);
    expect(commitmentPieces(commitment(marie, null))).toEqual([marie, " envoie le devis"]);
  });
});

const noon = (day: string) => new Date(`${day}T12:00:00`).getTime();

describe("today's commitments", () => {
  const me = voice("P1", 1, { self: true });
  const takenForMe = voice("P3", 3, {
    guess: { person: { id: 1, name: "Téo", self: true }, confidence: 0.99, recognized: true },
  });
  let next = 1;
  const commitment = (
    who: JournalVoice | null,
    to: JournalVoice | null,
    made: string,
    extra: Partial<JournalCommitment> = {},
  ): JournalCommitment => ({
    itemId: next++,
    markId: null,
    episodeId: 1,
    text: "envoyer le devis",
    voices: [me, marie, jean, takenForMe],
    edited: false,
    status: "open",
    stale: false,
    startMs: noon(made),
    citations: [],
    who,
    to,
    due: null,
    dueText: null,
    ...extra,
  });

  it("keeps the user's and those made to them, folds the others' and the old ones", () => {
    const today = "2026-11-10";
    const mine = commitment(me, jean, "2026-11-09");
    const toMe = commitment(jean, takenForMe, "2026-11-04");
    const others = commitment(marie, jean, "2026-11-09");
    const old = commitment(me, null, "2026-11-02");
    const oldButDue = commitment(me, null, "2026-11-01", { due: "2026-11-12" });
    const lateLong = commitment(jean, me, "2026-11-09", { due: "2026-11-02" });
    const corrected = commitment(marie, jean, "2026-11-09", { edited: true });
    const markAlone = commitment(null, null, "2026-11-08", { itemId: null, markId: 4 });
    const groups = commitmentGroups(
      [mine, toMe, others, old, oldButDue, lateLong, corrected, markAlone],
      today,
    );
    expect(groups.mine).toEqual([mine, toMe, oldButDue, corrected, markAlone]);
    expect(groups.older).toEqual([old, lateLong]);
    expect(groups.others).toEqual([others]);
  });
});
