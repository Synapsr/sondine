import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DAY_MS,
  EVERY_DAY,
  NIGHT,
  keepingOf,
  keepsNothing,
  recordingTypeOf,
  scheduleEndAt,
  scheduleSpans,
  scheduleTouches,
  validWindow,
} from "./zones";

describe("keepingOf", () => {
  it("keeps everything without zones", () => {
    expect(keepingOf([])).toEqual({ text: true, audio: true, deleteAfterMs: null });
  });

  it("adds zones up: text only and audio only keep nothing", () => {
    const both = keepingOf(["text_only", "audio_only"]);
    expect(both).toEqual({ text: false, audio: false, deleteAfterMs: null });
    expect(keepsNothing(both)).toBe(true);
  });

  it("takes the shortest time and keeps what no zone took", () => {
    expect(keepingOf(["delete_week", "text_only", "delete_day"])).toEqual({
      text: true,
      audio: false,
      deleteAfterMs: DAY_MS,
    });
  });
});

describe("recordingTypeOf", () => {
  it("goes by context, then by size", () => {
    expect(recordingTypeOf({ context: "call", size: "conversation" })).toBe("calls");
    expect(recordingTypeOf({ context: "media", size: "conversation" })).toBe("media");
    expect(recordingTypeOf({ context: "dictation", size: "moment" })).toBe("dictations");
    expect(recordingTypeOf({ context: "in_person", size: "conversation" })).toBe("conversations");
    expect(recordingTypeOf({ context: "mixed", size: "trace" })).toBe("traces");
    expect(recordingTypeOf({ context: null, size: null })).toBe("moments");
  });
});

const at = (text: string) => new Date(text).getTime();

describe("schedules", () => {
  const timeZone = process.env["TZ"];
  beforeEach(() => {
    process.env["TZ"] = "Europe/Paris";
  });
  afterEach(() => {
    if (timeZone === undefined) delete process.env["TZ"];
    else process.env["TZ"] = timeZone;
  });

  it("crosses midnight and belongs to the day it starts", () => {
    const spans = scheduleSpans(
      [NIGHT],
      at("2026-11-10T02:00:00+01:00"),
      at("2026-11-10T03:00:00+01:00"),
    );
    expect(spans).toEqual([
      { startMs: at("2026-11-09T23:00:00+01:00"), endMs: at("2026-11-10T07:00:00+01:00") },
    ]);
    expect(scheduleEndAt([NIGHT], at("2026-11-10T06:59:00+01:00"))).toBe(
      at("2026-11-10T07:00:00+01:00"),
    );
    expect(scheduleEndAt([NIGHT], at("2026-11-10T07:00:00+01:00"))).toBeNull();
  });

  it("follows the clock across a DST change", () => {
    // 2026-10-25: Paris goes from +02:00 to +01:00 at 03:00.
    const spans = scheduleSpans(
      [NIGHT],
      at("2026-10-25T05:00:00+01:00"),
      at("2026-10-25T05:00:00+01:00"),
    );
    expect(spans).toEqual([
      { startMs: at("2026-10-24T23:00:00+02:00"), endMs: at("2026-10-25T07:00:00+01:00") },
    ]);
  });

  it("only touches the given days", () => {
    const weekends = [{ days: [0, 6] as const, startMinute: 0, endMinute: 1440 }];
    // 2026-11-09 is a Monday.
    expect(
      scheduleTouches(weekends, at("2026-11-09T10:00:00+01:00"), at("2026-11-09T11:00:00+01:00")),
    ).toBe(false);
    expect(
      scheduleTouches(weekends, at("2026-11-08T10:00:00+01:00"), at("2026-11-08T11:00:00+01:00")),
    ).toBe(true);
  });

  it("refuses empty or equal bounds and repeated days", () => {
    expect(validWindow({ days: EVERY_DAY, startMinute: 60, endMinute: 60 })).toBe(false);
    expect(validWindow({ days: [], startMinute: 0, endMinute: 60 })).toBe(false);
    expect(validWindow({ days: [1, 1], startMinute: 0, endMinute: 60 })).toBe(false);
    expect(validWindow(NIGHT)).toBe(true);
  });
});
