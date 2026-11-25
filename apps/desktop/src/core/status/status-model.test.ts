import type { HelperEvent } from "@sondine/protocol";
import { describe, expect, it } from "vitest";
import { applyHelperEvent, initialStatus } from "./status-model";

const mic = "input:BuiltInMicrophoneDevice";
const start = initialStatus(1_000, { microphone: false, systemAudio: false });
const apply = (status: typeof start, event: HelperEvent, nowMs: number) =>
  applyHelperEvent(status, event, nowMs, null);

describe("status model: spool problems", () => {
  it("lists a track whose spool stopped writing until the helper resumes it", () => {
    const full = apply(
      start,
      { type: "error", code: "disk.full", message: "full", fatal: false, trackKey: mic },
      2_000,
    );
    expect(full.spool).toEqual([{ trackKey: mic, code: "disk.full", sinceMs: 2_000 }]);
    expect(full.helper.lastError?.code).toBe("disk.full");

    // A later report keeps the outage's start.
    const again = apply(
      full,
      { type: "error", code: "spool.io", message: "eio", fatal: false, trackKey: mic },
      5_000,
    );
    expect(again.spool).toEqual([{ trackKey: mic, code: "spool.io", sinceMs: 2_000 }]);

    const other = apply(
      again,
      { type: "warning", code: "spool.resumed", message: "back", trackKey: "system:other" },
      6_000,
    );
    expect(other.spool).toHaveLength(1);
    const resumed = apply(
      other,
      { type: "warning", code: "spool.resumed", message: "back", trackKey: mic },
      7_000,
    );
    expect(resumed.spool).toEqual([]);
  });

  it("ignores other errors and warnings", () => {
    const status = apply(
      apply(start, { type: "error", code: "capture.failed", message: "x", fatal: false }, 2_000),
      { type: "warning", code: "tap.rebuilt", message: "y" },
      3_000,
    );
    expect(status.spool).toEqual([]);
  });
});

describe("status model: speech heard now", () => {
  const runId = "6f1c2c1e-6e0b-4c55-9b6a-1d4a3c2b1a00";
  const at = { hostTicks: 1n, continuousNs: 1n };
  const withTrack = {
    ...start,
    tracks: [
      {
        trackKey: mic,
        runId,
        kind: "input" as const,
        name: "Micro",
        stream: "running" as const,
        measuredRate: 16_000,
        level: null,
        speaking: false,
        ringOverflows: 0,
        droppedSamples: 0,
        openedAtMs: 1_000,
      },
    ],
  };

  it("follows the VAD's regions on their track, for the top bar's wave", () => {
    const open = apply(
      withTrack,
      {
        type: "region.open",
        regionId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
        trackKey: mic,
        runId,
        epoch: 1,
        startSample: 16_000,
        at,
      },
      2_000,
    );
    expect(open.tracks[0]?.speaking).toBe(true);
    const closed = apply(
      open,
      {
        type: "region.close",
        trackKey: mic,
        runId,
        regionId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
        startSample: 16_000,
        endSample: 32_000,
        closeReason: "silence",
        speechProbability: { mean: 0.8, max: 0.9 },
        level: { mean: -30, peak: -10 },
        at,
        foreground: [],
      },
      3_000,
    );
    expect(closed.tracks[0]?.speaking).toBe(false);
    // Another run's region changes nothing.
    const elsewhere = apply(
      closed,
      {
        type: "region.open",
        regionId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4e",
        trackKey: "system:other",
        runId: "7f1c2c1e-6e0b-4c55-9b6a-1d4a3c2b1a00",
        epoch: 1,
        startSample: 0,
        at,
      },
      4_000,
    );
    expect(elsewhere).toBe(closed);
  });
});
