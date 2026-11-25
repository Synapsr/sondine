import type { EpisodeSpeaker } from "@sondine/api";
import { describe, expect, it } from "vitest";
import {
  episodeVoices,
  sameVoice,
  voiceGroups,
  voiceOf,
  voiceOfLabel,
  voicesByLabel,
} from "./voices";

const speaker = (ordinal: number, self = false, voicedMs = 1_000): EpisodeSpeaker => ({
  label: `track/0/${ordinal}`,
  ordinal,
  voicedMs,
  trackKind: self ? "input" : "system",
  self,
  person: null,
  recognized: null,
  suggestion: null,
});

/** Sondine's recognition of a voice as `person` (ADR 030). */
const match = (person: { id: number; name: string; self: boolean }) => ({
  person,
  similarity: 0.7,
  confidence: 0.999,
  references: 4,
  dictations: 0,
  reads: 0,
});

describe("voices", () => {
  it("names a voice the user named, keeps its number, and reads the user's own name as « Moi »", () => {
    const marie = { id: 4, name: "Marie", self: false };
    const voices = episodeVoices([
      { ...speaker(1), person: marie },
      { ...speaker(2), person: { id: 1, name: "Téo", self: true } },
      speaker(3),
    ]);
    expect(voices.map((entry) => entry.voice)).toEqual([
      { kind: "self" },
      { kind: "person", personId: 4, name: "Marie", number: 1 },
      { kind: "other", number: 2 },
    ]);
    const [, named] = voices;
    expect(
      named !== undefined &&
        sameVoice(named.voice, { kind: "person", personId: 4, name: "M.", number: 9 }),
    ).toBe(true);
  });

  it("reads a recognized voice as its person, in place of the guessed user, but not in exports", () => {
    const speakers = [
      // Sondine is sure of the user's voice: the API moved `self` from the call's guess to it.
      speaker(1, false, 9_000),
      { ...speaker(2, true), recognized: match({ id: 1, name: "Téo", self: true }) },
      { ...speaker(3), recognized: match({ id: 4, name: "Marie", self: false }) },
    ];
    expect(episodeVoices(speakers).map((entry) => [entry.label, entry.voice])).toEqual([
      ["track/0/2", { kind: "self", recognized: true }],
      ["track/0/1", { kind: "other", number: 1 }],
      ["track/0/3", { kind: "person", personId: 4, name: "Marie", number: 2, recognized: true }],
    ]);
    // What leaves the app names nobody Sondine recognized, the user's own voice aside.
    expect([...voicesByLabel(speakers, { recognized: false }).values()]).toEqual([
      { kind: "self" },
      { kind: "other", number: 1 },
      { kind: "other", number: 2 },
    ]);
  });

  it("keeps the call's « Moi » when the far side only likely is the user, in one badge", () => {
    const voices = episodeVoices([
      speaker(1, true, 9_000),
      { ...speaker(2), recognized: match({ id: 1, name: "Téo", self: true }) },
      speaker(3),
    ]);
    expect(voices.map((entry) => entry.voice).slice(0, 2)).toEqual([
      { kind: "self" },
      { kind: "self", recognized: true },
    ]);
    expect(voiceGroups(voices)[0]).toMatchObject({ key: "self", voice: { kind: "self" } });
    expect(voiceGroups(voices)).toHaveLength(2);
  });

  it("reads a hit of a recognized voice as its person, marked, a named one unmarked", () => {
    const marie = { id: 4, name: "Marie", self: false };
    expect(voiceOf(2, false, 1, null, marie)).toMatchObject({ name: "Marie", recognized: true });
    expect(voiceOf(2, false, 1, marie, null)).toEqual({
      kind: "person",
      personId: 4,
      name: "Marie",
      number: 1,
    });
  });

  it("numbers the voices of an in-person talk by their ordinal", () => {
    expect(episodeVoices([speaker(1), speaker(2)]).map((entry) => entry.voice)).toEqual([
      { kind: "other", number: 1 },
      { kind: "other", number: 2 },
    ]);
  });

  it("calls the user's voice « Moi », lists it first, and skips it in the numbering", () => {
    const voices = episodeVoices([speaker(1), speaker(2, true, 9_000), speaker(3)]);
    expect(voices.map((entry) => [entry.label, entry.voice])).toEqual([
      ["track/0/2", { kind: "self" }],
      ["track/0/1", { kind: "other", number: 1 }],
      ["track/0/3", { kind: "other", number: 2 }],
    ]);
    expect(voices[0]?.voicedMs).toBe(9_000);
  });

  it("numbers a search hit like its episode, from the user's ordinal", () => {
    expect(voiceOf(3, false, 2)).toEqual({ kind: "other", number: 2 });
    expect(voiceOf(1, false, 2)).toEqual({ kind: "other", number: 1 });
    expect(voiceOf(2, true, 2)).toEqual({ kind: "self" });
    expect(voiceOf(3, false, null)).toEqual({ kind: "other", number: 3 });
    expect(voiceOf(null, false, null)).toEqual({ kind: "unknown" });
  });

  it("finds a segment's voice from its speaker label", () => {
    const voices = voicesByLabel([speaker(1, true), speaker(2)]);
    expect(voiceOfLabel(voices, "track/0/2")).toEqual({ kind: "other", number: 1 });
    expect(voiceOfLabel(voices, "track/0/9")).toEqual({ kind: "unknown" });
    expect(voiceOfLabel(voices, null)).toEqual({ kind: "unknown" });
  });

  it("compares voices", () => {
    expect(sameVoice({ kind: "self" }, { kind: "self" })).toBe(true);
    expect(sameVoice({ kind: "other", number: 1 }, { kind: "other", number: 1 })).toBe(true);
    expect(sameVoice({ kind: "other", number: 1 }, { kind: "other", number: 2 })).toBe(false);
    expect(sameVoice({ kind: "self" }, { kind: "other", number: 1 })).toBe(false);
    expect(sameVoice({ kind: "unknown" }, { kind: "unknown" })).toBe(true);
  });
});

describe("one badge per person (ADR 038)", () => {
  it("adds up a person's voices, keeps « Moi » one, and leaves unknown voices apart", () => {
    const jules = { id: 7, name: "Jules", self: false };
    const groups = voiceGroups(
      episodeVoices([
        { ...speaker(1, false, 46_000), person: jules },
        { ...speaker(2, true, 19_000), person: { id: 1, name: "Téo", self: true } },
        { ...speaker(3, false, 5_000), person: jules },
        { ...speaker(4, false, 1_000) },
        { ...speaker(5, false, 2_000), recognized: match(jules) },
      ]),
    );
    expect(groups.map((group) => [group.key, group.voicedMs, group.entries.length])).toEqual([
      ["self", 19_000, 1],
      ["person:7", 53_000, 3],
      ["voice:track/0/4", 1_000, 1],
    ]);
    // A voice the user named reads the badge, not one Sondine only recognized.
    expect(groups[1]?.voice).toEqual({ kind: "person", personId: 7, name: "Jules", number: 1 });
  });

  it("reads a badge of recognized voices only as recognized", () => {
    const [group] = voiceGroups(
      episodeVoices([{ ...speaker(1), recognized: match({ id: 3, name: "Inès", self: false }) }]),
    );
    expect(group?.voice).toMatchObject({ kind: "person", personId: 3, recognized: true });
  });
});
