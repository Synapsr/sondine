import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as z from "zod";
import {
  COUNTED_EVENTS,
  MAX_USAGE_REPORT_BYTES,
  USAGE_COUNTS,
  USAGE_ERRORS,
  USAGE_REPORT_VERSION,
  usageCount,
  usageError,
  usageInstalled,
  usageMemory,
  UsageReport,
} from "../src/index";

const report = {
  v: 1,
  id: "5f0c2d5e-8f0b-4b7e-9a3a-2f1d7f7f5b10",
  day: "2026-11-24",
  app: "0.7.0",
  macos: "27.0",
  memory: "32plus",
  installed: "7-13",
  activeDays: 5,
  onboarding: "done",
  actions: {
    desktop: { conversation_opened: 5, window_opened: 3 },
    mcp: { transcripts_searched: 3 },
  },
  errors: { transcription_deadline: 1 },
};

describe("the daily report (ADR 042)", () => {
  it("accepts its example", () => {
    expect(UsageReport.parse(report)).toEqual(report);
  });

  it("refuses anything else: another field, a free string, an exact count, a name", () => {
    const refused: object[] = [
      { ...report, user: "someone" },
      { ...report, at: "10:05" },
      { ...report, active: true },
      { ...report, id: "stable" },
      // A UUID v7 or v1 would carry a time or a machine.
      { ...report, id: "01a0c2d5-8f0b-7b7e-9a3a-2f1d7f7f5b10" },
      { ...report, day: "2026-02-30" },
      { ...report, day: "2026-11-24T10:05:00Z" },
      { ...report, app: "0.7.0-someone" },
      { ...report, macos: "27.0.1" },
      { ...report, memory: "36" },
      { ...report, installed: "8" },
      { ...report, activeDays: 8 },
      { ...report, activeDays: 4.5 },
      { ...report, onboarding: "elsewhere" },
      { ...report, actions: { desktop: { conversation_opened: 4 } } },
      { ...report, actions: { desktop: { "Réunion avec Camille": 1 } } },
      { ...report, actions: { desktop: { day_viewed: 1 } } },
      { ...report, actions: { desktop: { compute_beta_joined: 1 } } },
      { ...report, actions: { mcp: { episode_deleted: 1 } } },
      { ...report, actions: { tv: {} } },
      { ...report, errors: { "ENOENT /Users/camille": 1 } },
    ];
    for (const other of refused) {
      expect(UsageReport.safeParse(other).success, JSON.stringify(other)).toBe(false);
    }
  });

  it("fits far under the Worker's limit with everything in it", () => {
    const all = (names: readonly string[]) => Object.fromEntries(names.map((name) => [name, 500]));
    const full = {
      ...report,
      actions: {
        desktop: all(COUNTED_EVENTS.desktop),
        mcp: all(COUNTED_EVENTS.mcp),
        mobile: all(COUNTED_EVENTS.mobile),
      },
      errors: all(USAGE_ERRORS),
    };
    UsageReport.parse(full);
    expect(JSON.stringify(full).length).toBeLessThan(MAX_USAGE_REPORT_BYTES / 2);
  });

  it("rounds counts down, and bands memory and age", () => {
    expect([1, 2, 3, 4, 9, 10, 49, 99, 499, 5_000].map(usageCount)).toEqual([
      1, 2, 3, 3, 5, 10, 20, 50, 200, 500,
    ]);
    expect(USAGE_COUNTS[0]).toBe(1);
    const gib = 1024 ** 3;
    expect([8, 16, 24, 32, 64].map((gb) => usageMemory(gb * gib))).toEqual([
      "lt16",
      "16-31",
      "16-31",
      "32plus",
      "32plus",
    ]);
    expect([-1, 0, 1, 2, 6, 7, 13, 14, 27, 28, 89, 90, 900].map(usageInstalled)).toEqual([
      "0",
      "0",
      "1",
      "2-6",
      "2-6",
      "7-13",
      "7-13",
      "14-27",
      "14-27",
      "28-89",
      "28-89",
      "90plus",
      "90plus",
    ]);
  });

  it("names only failures it knows", () => {
    expect(usageError("transcription", "deadline")).toBe("transcription_deadline");
    expect(usageError("journal", "not-json")).toBe("journal_not_json");
    expect(usageError("journal", "claude_signed_out")).toBe("journal_other");
    expect(usageError("model", "/Users/camille/x")).toBe("model_other");
    expect(usageError("transcription", "a sentence that was said")).toBe("transcription_other");
  });

  it("cannot change shape without a new version of the question", () => {
    // Names may join the lists of events and errors; the rest is what people said yes to.
    const schema = z.toJSONSchema(UsageReport, { io: "input" }) as {
      properties: Record<string, unknown>;
    };
    const { actions, errors, ...rest } = schema.properties;
    const shape = JSON.stringify({
      rest,
      actions: Object.keys((actions as { properties: object }).properties),
      errors: typeof errors,
      counts: USAGE_COUNTS,
    });
    expect(createHash("sha256").update(shape).digest("hex").slice(0, 16)).toBe("199a8653282aeab7");
    expect(USAGE_REPORT_VERSION).toBe(1);
  });
});
