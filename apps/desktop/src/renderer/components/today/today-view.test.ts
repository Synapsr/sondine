import type { EpisodeSummary, MomentHour } from "@sondine/api";
import { describe, expect, it } from "vitest";
import { hourSummary, mergePages, timelineItems, timelineParts } from "./today-view";

const H = 3_600_000;
const DAY = new Date(2026, 10, 5).getTime();

const conversation = (id: number, startedAtMs: number): EpisodeSummary => ({
  id,
  state: "closed",
  context: "in_person",
  size: "conversation",
  sizeProvisional: false,
  analysisState: "complete",
  startedAtMs,
  endedAtMs: startedAtMs + 600_000,
  voicedMs: 300_000,
  firstWords: null,
  speakerCount: 2,
  apps: [],
  people: [],
  recognized: [],
  live: false,
  page: null,
  phone: null,
  alsoRecordedBy: null,
  keptAtMs: null,
  note: false,
  tags: [],
});

const hour = (h: number, previews: string[] = [], untranscribed = 0): MomentHour => ({
  hour: h,
  startMs: DAY + h * H,
  moments: Math.max(previews.length, 1),
  untranscribed,
  previews: previews.map((firstWords, index) => ({ episodeId: 100 + index, firstWords })),
  apps: [],
});

const keys = (items: ReturnType<typeof timelineItems>) =>
  items.map((item) =>
    item.kind === "hour" ? `${item.hour.hour}h` : `${item.kind[0]}${item.episode.id}`,
  );

describe("today's timeline", () => {
  it("interleaves conversations and hours, a conversation above the hour it started in", () => {
    const conversations = [
      conversation(3, DAY + 16 * H + 31 * 60_000),
      conversation(2, DAY + 15 * H + 2 * 60_000),
      conversation(1, DAY + 16 * H),
    ];
    const hours = [hour(16), hour(15), hour(14)];
    expect(keys(timelineItems(conversations, hours, true))).toEqual([
      "c3",
      "c1",
      "16h",
      "c2",
      "15h",
      "14h",
    ]);
  });

  it("holds back hours older than the conversations loaded so far", () => {
    const conversations = [conversation(9, DAY + 15 * H + 2 * 60_000)];
    const hours = [hour(16), hour(15), hour(14)];
    expect(keys(timelineItems(conversations, hours, false))).toEqual(["16h", "c9"]);
    expect(keys(timelineItems([], hours, true))).toEqual(["16h", "15h", "14h"]);
  });

  it("puts media and dictations in the same thread, held back like hours", () => {
    const conversations = [conversation(1, DAY + 15 * H)];
    const shorts = [
      conversation(7, DAY + 16 * H),
      conversation(8, DAY + 15 * H),
      conversation(9, DAY + 9 * H),
    ];
    expect(keys(timelineItems(conversations, [hour(15)], true, shorts))).toEqual([
      "s7",
      "c1",
      "s8",
      "15h",
      "s9",
    ]);
    expect(keys(timelineItems(conversations, [], false, shorts))).toEqual(["s7", "c1", "s8"]);
  });

  it("merges pages without repeating an episode", () => {
    const a = conversation(1, DAY);
    const b = conversation(2, DAY + H);
    expect(mergePages([[b, a], [a]]).map((episode) => episode.id)).toEqual([2, 1]);
  });

  it("previews an hour, or says nothing in it has text yet", () => {
    expect(
      hourSummary(hour(14, ["On décale à 15 h ?", "Tu peux me renvoyer le lien ?"], 1)),
    ).toEqual({
      kind: "previews",
      texts: ["On décale à 15 h ?", "Tu peux me renvoyer le lien ?"],
      untranscribed: 1,
    });
    expect(hourSummary(hour(16, [], 2))).toEqual({ kind: "untranscribed" });
  });

  it("cuts the timeline into evening, afternoon and morning, newest first", () => {
    const items = timelineItems(
      [conversation(1, DAY + 9 * H), conversation(2, DAY + 14 * H), conversation(3, DAY + 19 * H)],
      [hour(10, ["clés"])],
      true,
    );
    expect(timelineParts(items).map((part) => [part.part, part.items.length])).toEqual([
      ["evening", 1],
      ["afternoon", 1],
      ["morning", 2],
    ]);
  });
});
