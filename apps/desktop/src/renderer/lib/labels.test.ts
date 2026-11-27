import type { EpisodeSummary } from "@sondine/api";
import { describe, expect, it } from "vitest";
import { confidenceLabel, contextLabel, voicesLabel } from "./labels";

// Messages resolve to English in tests.

const episode = (
  speakerCount: number,
  people: EpisodeSummary["people"],
  recognized: EpisodeSummary["recognized"] = [],
): EpisodeSummary => ({
  id: 1,
  state: "closed",
  context: "in_person",
  size: "conversation",
  sizeProvisional: false,
  analysisState: "complete",
  startedAtMs: 0,
  endedAtMs: 60_000,
  voicedMs: 30_000,
  firstWords: null,
  speakerCount,
  apps: [],
  people,
  recognized,
  live: false,
  page: null,
  phone: null,
  alsoRecordedBy: null,
  keptAtMs: null,
  note: false,
  tags: [],
});

describe("voices label", () => {
  it("names who was there, the user as Me, and counts the others", () => {
    const marie = { id: 2, name: "Marie", self: false };
    const me = { id: 1, name: "Téo", self: true };
    expect(voicesLabel(episode(2, [me, marie]))).toBe("Me, Marie");
    expect(voicesLabel(episode(3, [marie]))).toBe("Marie and 2 other voices");
    expect(voicesLabel(episode(2, [marie]))).toBe("Marie and 1 other voice");
    expect(voicesLabel(episode(3, []))).toBe("3 voices");
    expect(voicesLabel(episode(1, []))).toBeNull();
  });

  it("counts recognized people as there, the user first", () => {
    const marie = { id: 2, name: "Marie", self: false };
    const me = { id: 1, name: "Téo", self: true };
    expect(voicesLabel(episode(3, [marie], [me]))).toBe("Me*, Marie and 1 other voice");
  });
});

describe("confidence label", () => {
  it("never rounds up, and keeps a decimal from 99 %", () => {
    expect(confidenceLabel(0.876)).toBe("87%");
    expect(confidenceLabel(0.9969)).toBe("99.6%");
    expect(confidenceLabel(0.99999)).toBe("99.9%");
    expect(confidenceLabel(0.001)).toBe("< 1%");
  });
});

describe("context label", () => {
  it("names YouTube, not the browser that played it, and any other site's browser", () => {
    const safari = { bundleId: "com.apple.Safari", name: "Safari" };
    const page = (site: string, name: string) => ({ site, name, title: "", url: "", video: false });
    const media = { ...episode(1, []), context: "media" as const, apps: [safari] };
    expect(contextLabel({ ...media, page: page("youtube.com", "YouTube") })).toBe(
      "Media · YouTube",
    );
    expect(contextLabel({ ...media, page: page("netflix.com", "Netflix") })).toBe("Media · Safari");
    expect(contextLabel({ ...media, page: page("music.youtube.com", "YouTube Music") })).toBe(
      "Media · Safari",
    );
  });

  it("marks a phone recording, says when its time is uncertain, and gives its name", () => {
    expect(contextLabel(episode(1, []))).toBe("In person");
    expect(contextLabel({ ...episode(1, []), phone: { timeUncertain: false, name: null } })).toBe(
      "In person · iPhone",
    );
    expect(contextLabel({ ...episode(1, []), phone: { timeUncertain: true, name: null } })).toBe(
      "In person · iPhone · time uncertain",
    );
    expect(
      contextLabel({ ...episode(1, []), phone: { timeUncertain: false, name: "Budget" } }),
    ).toBe("In person · iPhone · Budget");
  });

  it("reads a phone recording of the user alone as a note (ADR 039)", () => {
    expect(
      contextLabel({ ...episode(1, []), phone: { timeUncertain: false, name: null }, note: true }),
    ).toBe("Note · iPhone");
  });

  it("says when the other device recorded the same meeting (ADR 032)", () => {
    expect(
      contextLabel({
        ...episode(1, []),
        phone: { timeUncertain: false, name: null },
        alsoRecordedBy: "mac",
      }),
    ).toBe("In person · iPhone · also on the Mac");
    expect(
      contextLabel({
        ...episode(1, []),
        phone: { timeUncertain: false, name: "Budget" },
        alsoRecordedBy: "mac",
      }),
    ).toBe("In person · iPhone · Budget · also on the Mac");
    expect(contextLabel({ ...episode(1, []), alsoRecordedBy: "phone" })).toBe(
      "In person · also on the iPhone",
    );
  });
});
