import type { CallContext, EpisodeSummary } from "@sondine/api";
import { describe, expect, it } from "vitest";
import { callMenu, callView, clip, monogram, whenLabel } from "./call-menu";

const now = new Date(2026, 10, 9, 15, 0).getTime();

const conversation = (id: number, startedAtMs: number, firstWords: string | null) =>
  ({ id, startedAtMs, firstWords }) as EpisodeSummary;

const context = (patch: Partial<NonNullable<CallContext["call"]>> = {}): CallContext => ({
  call: {
    callId: 4,
    episodeId: 12,
    dismissed: false,
    people: [
      {
        person: { id: 2, name: "Marie", self: false },
        similarity: 0.82,
        confidence: 0.999,
        recognizedAtMs: now,
        conversations: [
          conversation(
            9,
            new Date(2026, 10, 9, 10, 5).getTime(),
            "On reprend le budget de la semaine prochaine, avec les chiffres de lundi",
          ),
          conversation(7, new Date(2026, 10, 8, 18, 30).getTime(), null),
        ],
      },
    ],
    ...patch,
  },
  notch: { openOnHover: true },
});

describe("the call in the menu bar and beside the notch", () => {
  it("gives the notch each conversation's day and first words apart", () => {
    expect(callView(context(), "fr", now)).toEqual({
      callId: 4,
      title: "Marie ?",
      people: [
        {
          personId: 2,
          label: "Marie ?",
          monogram: "M",
          conversations: [
            {
              episodeId: 9,
              when: "Aujourd’hui 10:05",
              words: "On reprend le budget de la semaine prochain…",
            },
            { episodeId: 7, when: "Hier 18:30", words: null },
          ],
          none: null,
        },
      ],
      dismiss: "Masquer pour cet appel",
      openOnHover: true,
    });
  });

  it("names the person as a guess and lists her last conversations, then hides", () => {
    expect(callMenu(callView(context(), "fr", now))).toEqual({
      title: "Marie ?",
      items: [
        { kind: "person", label: "Marie ?", personId: 2 },
        {
          kind: "conversation",
          label: "Aujourd’hui 10:05 · On reprend le budget de la semaine prochain…",
          episodeId: 9,
        },
        { kind: "conversation", label: "Hier 18:30", episodeId: 7 },
        { kind: "dismiss", label: "Masquer pour cet appel", callId: 4 },
      ],
    });
  });

  it("shows nothing without a call, a suggestion, or once hidden", () => {
    expect(callView(null, "en", now)).toBeNull();
    expect(callView({ call: null, notch: { openOnHover: true } }, "en", now)).toBeNull();
    expect(callView(context({ people: [] }), "en", now)).toBeNull();
    expect(callView(context({ dismissed: true }), "en", now)).toBeNull();
    expect(callMenu(null)).toBeNull();
  });

  it("says when there is no conversation before the call", () => {
    const view = callView(
      context({
        people: [
          {
            person: { id: 3, name: "élodie", self: false },
            similarity: 0.75,
            confidence: 0.999,
            recognizedAtMs: now,
            conversations: [],
          },
        ],
      }),
      "fr",
      now,
    );
    expect(callMenu(view)?.items).toEqual([
      { kind: "person", label: "élodie ?", personId: 3 },
      { kind: "none", label: "Aucune conversation avant" },
      { kind: "dismiss", label: "Masquer pour cet appel", callId: 4 },
    ]);
    expect(view?.people[0]?.monogram).toBe("É");
  });

  it("keeps a letter whole in the monogram, within what the notch takes", () => {
    expect(monogram("  zoé", "fr")).toBe("Z");
    expect(monogram("👩🏽‍💻 Ana", "en")).toBe("👩🏽‍💻");
    // A family of four is 19 UTF-16 units: its first person stands for it.
    expect(monogram("👨🏽‍👩🏽‍👧🏽‍👦🏽 Martin", "fr")).toBe("👨");
    expect(monogram("", "en")).toBe("?");
  });

  it("never cuts the first words inside an emoji", () => {
    const words = `${"a".repeat(42)}😀 la suite`;
    expect(clip(words, 44)).toBe(`${"a".repeat(42)}…`);
    expect(clip(`${"a".repeat(41)}😀 la suite`, 44)).toBe(`${"a".repeat(41)}😀…`);
    expect(clip("court", 44)).toBe("court");
  });

  it("dates older conversations by their day", () => {
    expect(whenLabel(new Date(2026, 10, 3, 9, 15).getTime(), now, "fr")).toBe(
      "mardi 3 novembre 09:15",
    );
    expect(whenLabel(new Date(2026, 10, 9, 9, 15).getTime(), now, "en")).toBe("Today 9:15 AM");
  });
});
