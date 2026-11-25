import { DayJsonV2, TranscriptJsonV2, type EpisodeDetail } from "@sondine/api";
import { describe, expect, it } from "vitest";
import { dayDocument, transcriptDocument } from "./transcript-export";

// Messages resolve to English in tests (no stored or OS locale).

const START = Date.UTC(2026, 10, 6, 13, 5, 0);

const segment = (id: number, speakerLabel: string | null, atS: number, text: string) => ({
  id,
  trackRunId: 1,
  startMs: START + atS * 1000,
  endMs: START + atS * 1000 + 1_500,
  speakerLabel,
  self: speakerLabel === "mic/0/1",
  text,
  lang: "fr",
  edited: false,
  highlights: [],
  app: null,
  mediaMs: null,
});

const detail = (segments: EpisodeDetail["segments"]): EpisodeDetail => ({
  episode: {
    id: 7,
    state: "closed",
    context: "call",
    size: "conversation",
    sizeProvisional: false,
    analysisState: "complete",
    startedAtMs: START,
    endedAtMs: START + 600_000,
    voicedMs: 300_000,
    firstWords: null,
    speakerCount: 2,
    apps: [{ bundleId: "us.zoom.xos", name: "zoom.us" }],
    people: [],
    recognized: [],
    live: false,
    page: null,
    phone: null,
    alsoRecordedBy: null,
    keptAtMs: null,
    note: false,
    tags: [],
  },
  kindOverride: null,
  requested: false,
  recognized: true,
  neighbours: { previous: null, next: null },
  tracks: [],
  speakers: [
    {
      label: "mic/0/1",
      ordinal: 1,
      voicedMs: 3_000,
      trackKind: "input",
      self: true,
      person: null,
      recognized: null,
      suggestion: null,
    },
    {
      label: "sys/0/1",
      ordinal: 2,
      voicedMs: 1_500,
      trackKind: "app",
      self: false,
      person: null,
      recognized: null,
      suggestion: null,
    },
  ],
  segments,
  context: [],
  privacy: { zones: [], kept: false, audioGone: false, noText: false },
  sameMoments: [],
  analysis: null,
});

const call = detail([
  segment(1, "mic/0/1", 1, "Bonjour, on commence ?"),
  segment(2, "mic/0/1", 3, "Le *budget* d'abord."),
  segment(3, "sys/0/1", 65.25, "D'accord --> <je note>."),
]);

describe("transcript export", () => {
  it("writes Markdown turns with their voice and offset, markup escaped", () => {
    const text = transcriptDocument(call, "md", null) ?? "";
    const [heading, blank, meta, ...turns] = text.split("\n");
    expect(heading).toMatch(/^# .*2026 · /u);
    expect(blank).toBe("");
    expect(meta).toBe("10 min · Call · zoom.us");
    expect(turns).toEqual([
      "",
      "**Me** · 00:01",
      "Bonjour, on commence ? Le \\*budget\\* d'abord.",
      "",
      "**Voice 1** · 01:05",
      "D'accord --\\> \\<je note\\>.",
      "",
    ]);
  });

  it("times SRT cues on the audio's first sample, one per segment", () => {
    expect(transcriptDocument(call, "srt", START - 500)).toBe(
      [
        "1",
        "00:00:01,500 --> 00:00:03,000",
        "Me: Bonjour, on commence ?",
        "",
        "2",
        "00:00:03,500 --> 00:00:05,000",
        "Me: Le *budget* d'abord.",
        "",
        "3",
        "00:01:05,750 --> 00:01:07,250",
        "Voice 1: D'accord → <je note>.",
        "",
      ].join("\n"),
    );
  });

  it("writes WebVTT voices and escapes the text", () => {
    const text = transcriptDocument(call, "vtt", null) ?? "";
    expect(text.startsWith("WEBVTT\n\n00:00:01.000 --> 00:00:02.500\n<v Me>Bonjour")).toBe(true);
    expect(text).toContain("00:01:05.250 --> 00:01:06.750\n<v Voice 1>D'accord → &lt;je note&gt;.");
  });

  it("writes JSON that validates against sondine.transcript/2", () => {
    const text =
      transcriptDocument(
        detail([
          { ...segment(1, "mic/0/1", 2, "Bonjour  à   tous"), edited: true },
          segment(2, "sys/0/1", 5, "Salut"),
        ]),
        "json",
        null,
      ) ?? "";
    const parsed = TranscriptJsonV2.parse(JSON.parse(text));
    expect(parsed.episode).toMatchObject({ id: 7, startedAt: "2026-11-06T13:05:00.000Z" });
    expect(parsed.speakers.map((speaker) => [speaker.label, speaker.name, speaker.self])).toEqual([
      ["mic/0/1", "Me", true],
      ["sys/0/1", "Voice 1", false],
    ]);
    expect(parsed.segments[0]).toMatchObject({
      start: "2026-11-06T13:05:02.000Z",
      offsetMs: 2_000,
      speaker: "mic/0/1",
      text: "Bonjour à tous",
      edited: true,
    });
  });

  it("puts a day's transcripts in one document, in time order, in Markdown or JSON", () => {
    const morning = detail([segment(1, "mic/0/1", 2, "Bonjour")]);
    const later = {
      ...detail([segment(2, "sys/0/1", 5, "Plus tard")]),
      episode: { ...morning.episode, id: 8, startedAtMs: START + 3_600_000, endedAtMs: null },
    };
    const empty = {
      ...detail([segment(3, null, 1, "   ")]),
      episode: { ...morning.episode, id: 9 },
    };
    const md = dayDocument("2026-11-06", [later, empty, morning], "md") ?? "";
    expect(md.indexOf("Bonjour")).toBeLessThan(md.indexOf("Plus tard"));
    expect(md.match(/^## /gmu)).toHaveLength(2);
    const json = DayJsonV2.parse(
      JSON.parse(dayDocument("2026-11-06", [later, morning], "json") ?? ""),
    );
    expect(json.episodes.map((episode) => episode.episode.id)).toEqual([7, 8]);
    expect(dayDocument("2026-11-06", [empty], "md")).toBeNull();
  });

  it("takes the context the user added, as text: notes, links, files by name", () => {
    const withContext: EpisodeDetail = {
      ...call,
      context: [
        {
          id: 1,
          kind: "note",
          addedAtMs: START + 700_000,
          atMs: START,
          segmentId: null,
          pinned: false,
          text: "Ordre du *jour*",
          title: null,
          file: null,
        },
        {
          id: 2,
          kind: "link",
          addedAtMs: START + 701_000,
          atMs: START + 3_000,
          segmentId: 2,
          pinned: true,
          text: "https://example.com/a (b)",
          title: "Budget",
          file: null,
        },
        {
          id: 3,
          kind: "image",
          addedAtMs: START + 702_000,
          atMs: START,
          segmentId: null,
          pinned: false,
          text: "",
          title: "capture.png",
          file: {
            mediaType: "image/png",
            bytes: 2_048,
            preview: "sondine-media://context/3?v=0123456789abcdef",
            transcript: null,
          },
        },
      ],
    };
    const md = transcriptDocument(withContext, "md", null) ?? "";
    expect(md).toContain("## Context\n\n- Ordre du \\*jour\\*\n");
    expect(md).toMatch(/- \d.* · \[Budget\]\(https:\/\/example\.com\/a%20%28b%29\)/u);
    expect(md).toContain("- capture.png (image/png, 2");
    expect(md).not.toContain("sondine-media");
    const json = TranscriptJsonV2.parse(
      JSON.parse(transcriptDocument(withContext, "json", null) ?? ""),
    );
    expect(json.context.map((item) => [item.kind, item.pinnedAt !== null])).toEqual([
      ["note", false],
      ["link", true],
      ["image", false],
    ]);
    expect(json.context[2]?.file).toEqual({ mediaType: "image/png", bytes: 2_048 });
  });

  it("has nothing to take without words", () => {
    expect(transcriptDocument(detail([]), "md", null)).toBeNull();
    expect(transcriptDocument(detail([segment(1, null, 0, "  ")]), "srt", null)).toBeNull();
  });
});
