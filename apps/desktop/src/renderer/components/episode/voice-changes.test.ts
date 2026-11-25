import type { EpisodeDetail, EpisodeSpeaker, TranscriptSegment } from "@sondine/api";
import { describe, expect, it } from "vitest";
import { mergedIn, namedIn, passagesOf, refusedIn, unnamedIn } from "./voice-changes";

const speaker = (ordinal: number, patch: Partial<EpisodeSpeaker> = {}): EpisodeSpeaker => ({
  label: `v${ordinal}`,
  ordinal,
  voicedMs: ordinal * 1_000,
  trackKind: "system",
  self: false,
  person: null,
  recognized: null,
  suggestion: null,
  ...patch,
});

const match = (person: { id: number; name: string; self: boolean }) => ({
  person,
  similarity: 0.7,
  confidence: 0.995,
  references: 4,
  dictations: 0,
  reads: 0,
});

const marie = { id: 4, name: "Marie", self: false };

const line = (startS: number, endS: number, label: string | null) =>
  ({ startMs: startS * 1000, endMs: endS * 1000, speakerLabel: label }) satisfies Pick<
    TranscriptSegment,
    "startMs" | "endMs" | "speakerLabel"
  >;

function detail(speakers: EpisodeSpeaker[], labels: (string | null)[] = []): EpisodeDetail {
  return {
    episode: { people: [], recognized: [] },
    speakers,
    segments: labels.map((label, index) => ({ id: index + 1, ...line(index, index + 1, label) })),
  } as unknown as EpisodeDetail;
}

describe("a voice's answer, shown at once", () => {
  it("names the voice: no longer a guess, and the person joins the episode's people", () => {
    const before = detail([speaker(1, { recognized: match(marie) }), speaker(2)]);
    const after = namedIn(before, "v1", marie);
    expect(after.speakers[0]).toMatchObject({ person: marie, recognized: null, suggestion: null });
    expect(after.speakers[1]).toBe(before.speakers[1]);
    expect(after.episode.people).toEqual([marie]);
    expect(before.speakers[0]?.person).toBeNull();
  });

  it("keeps the title and the badges together: one of two « Marie* » named, then « Non » to a guess", () => {
    const two = {
      ...detail([
        speaker(1, { recognized: match(marie) }),
        speaker(2, { recognized: match(marie) }),
      ]),
    };
    const before = { ...two, episode: { ...two.episode, recognized: [marie] } };
    const named = namedIn(before, "v1", marie);
    expect([named.episode.people, named.episode.recognized]).toEqual([[marie], []]);
    expect(unnamedIn(named, "v1").episode).toMatchObject({ people: [], recognized: [marie] });
    const once = refusedIn(before, "v1", marie.id);
    expect(once.episode.recognized).toEqual([marie]);
    expect(refusedIn(once, "v2", marie.id).episode.recognized).toEqual([]);
  });

  it("names the user: the voice guessed as the user stops being it", () => {
    const self = { id: 1, name: "Téo", self: true };
    const after = namedIn(detail([speaker(1, { self: true }), speaker(2)]), "v2", self);
    expect(after.speakers.map((entry) => entry.self)).toEqual([false, true]);
    expect(after.episode.people).toEqual([self]);
  });

  it("takes back a guess on « Non », and a name on « Retirer le nom »", () => {
    const refused = refusedIn(detail([speaker(1, { suggestion: match(marie) })]), "v1", 4);
    expect(refused.speakers[0]?.suggestion).toBeNull();
    const unnamed = unnamedIn(detail([speaker(1, { person: marie })]), "v1");
    expect(unnamed.speakers[0]?.person).toBeNull();
  });

  it("merges the later voice into the earlier one, sentences and time, numbering again", () => {
    const before = detail(
      [speaker(1), speaker(2), speaker(3), speaker(4)],
      ["v1", "v3", "v2", "v3", "v4"],
    );
    const after = mergedIn(before, "v3", "v2");
    expect(after.speakers.map((entry) => [entry.label, entry.ordinal, entry.voicedMs])).toEqual([
      ["v1", 1, 1_000],
      ["v2", 2, 5_000],
      ["v4", 3, 4_000],
    ]);
    expect(after.segments.map((segment) => segment.speakerLabel)).toEqual([
      "v1",
      "v2",
      "v2",
      "v2",
      "v4",
    ]);
    expect(mergedIn(before, "v3", "v9")).toBe(before);
  });
});

describe("a voice's passages", () => {
  it("runs a voice's sentences together until another voice or a long silence", () => {
    const passages = passagesOf(
      [
        line(0, 2, "a"),
        line(2, 4, "a"),
        line(4, 6, "b"),
        line(6, 8, "a"),
        line(100, 102, "a"),
        line(102, 103, null),
        line(103, 104, "c"),
      ],
      new Set(["a", "c"]),
    );
    expect(passages).toEqual([
      { index: 0, startMs: 0, endMs: 4_000 },
      { index: 3, startMs: 6_000, endMs: 8_000 },
      { index: 4, startMs: 100_000, endMs: 102_000 },
      { index: 6, startMs: 103_000, endMs: 104_000 },
    ]);
  });
});
