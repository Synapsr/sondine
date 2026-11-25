import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeLostSpans,
  farSideRegions,
  loadAppTapsBetween,
  loadCallsBetween,
  loadListensBetween,
  callRecording,
  ongoingCall,
  recordCallActive,
  recordListenActive,
  recordSpanEnded,
  touchSpans,
  type CallActiveInput,
} from "./calls";
import {
  closeSpeechRegion,
  openSpeechRegion,
  recordEpoch,
  upsertApp,
  upsertTrackRun,
} from "./capture-import";
import { seedEpisode, t0, tempDatabase, type TempDatabase } from "./test-helpers";

let temp: TempDatabase;
beforeEach(() => {
  temp = tempDatabase();
});
afterEach(() => temp.cleanup());

/** A clock `sec` seconds into a boot that started at `t0`. */
const at = (sec: number) => ({ wallMs: t0 + sec * 1000, continuousUs: sec * 1_000_000 });

const active = (uid: string, sec: number, sessionId = "session-1"): CallActiveInput => ({
  uid,
  sessionId,
  bundleId: "us.zoom.xos",
  via: "call_app",
  inputDeviceUid: "BuiltInMicrophoneDevice",
  at: at(sec),
  nowMs: t0 + sec * 1000,
});

const callRows = () =>
  temp.db.client
    .prepare(
      `SELECT uid, started_wall_ms, ended_wall_ms, end_reason, last_seen_wall_ms FROM calls ORDER BY id`,
    )
    .all();

describe("calls", () => {
  it("records a call once however often its events are replayed", () => {
    expect(recordCallActive(temp.db, active("c1", 10)).status).toBe("inserted");
    expect(recordCallActive(temp.db, active("c1", 10)).status).toBe("duplicate");
    expect(recordSpanEnded(temp.db, "calls", { uid: "c1", at: at(70), nowMs: t0 }).status).toBe(
      "updated",
    );
    expect(recordSpanEnded(temp.db, "calls", { uid: "c1", at: at(70), nowMs: t0 }).status).toBe(
      "duplicate",
    );
    // A replayed `active` after the end does not reopen it.
    expect(recordCallActive(temp.db, active("c1", 10)).status).toBe("duplicate");
    expect(callRows()).toEqual([
      {
        uid: "c1",
        started_wall_ms: t0 + 10_000,
        ended_wall_ms: t0 + 70_000,
        end_reason: "ended",
        last_seen_wall_ms: t0 + 70_000,
      },
    ]);
    const app = temp.db.client.prepare("SELECT bundle_id FROM apps").all();
    expect(app).toEqual([{ bundle_id: "us.zoom.xos" }]);
  });

  it("drops an `ended` for a call never seen active", () => {
    expect(recordSpanEnded(temp.db, "calls", { uid: "ghost", at: at(5), nowMs: t0 })).toEqual({
      spanId: null,
      status: "unknown",
    });
    expect(callRows()).toEqual([]);
  });

  it("moves last-seen for the named open calls only, never back", () => {
    for (const uid of ["named", "other", "ended"]) recordCallActive(temp.db, active(uid, 10));
    recordSpanEnded(temp.db, "calls", { uid: "ended", at: at(20), nowMs: t0 });
    expect(touchSpans(temp.db, "calls", { uids: ["named", "ended"], at: at(50) })).toBe(1);
    expect(touchSpans(temp.db, "calls", { uids: ["named"], at: at(30) })).toBe(0);
    expect(touchSpans(temp.db, "calls", { uids: [], at: at(60) })).toBe(0);
    expect(callRows().map((row) => [row["uid"], row["last_seen_wall_ms"]])).toEqual([
      ["named", t0 + 50_000],
      ["other", t0 + 10_000],
      ["ended", t0 + 20_000],
    ]);
  });

  it("closes the calls a snapshot did not replay at their last-seen clock", () => {
    recordCallActive(temp.db, active("old", 10, "session-1"));
    touchSpans(temp.db, "calls", { uids: ["old"], at: at(40) });
    recordCallActive(temp.db, active("new", 95, "session-2"));
    // The snapshot's clock vouches for its replays, not for the call it left out.
    expect(
      closeLostSpans(temp.db, "calls", { replayed: new Set(["new"]), at: at(120), nowMs: t0 }),
    ).toBe(1);
    expect(callRows()).toMatchObject([
      {
        uid: "old",
        ended_wall_ms: t0 + 40_000,
        end_reason: "lost",
        last_seen_wall_ms: t0 + 40_000,
      },
      { uid: "new", ended_wall_ms: null, end_reason: null, last_seen_wall_ms: t0 + 120_000 },
    ]);
    // A late `ended` sets the exact end; a later replay of a lost call reopens it.
    recordSpanEnded(temp.db, "calls", { uid: "old", at: at(50), nowMs: t0 });
    expect(callRows()[0]).toMatchObject({ ended_wall_ms: t0 + 50_000, end_reason: "ended" });
    closeLostSpans(temp.db, "calls", { replayed: new Set(), at: null, nowMs: t0 });
    expect(callRows()[1]).toMatchObject({
      uid: "new",
      end_reason: "lost",
      ended_wall_ms: t0 + 120_000,
    });
    expect(recordCallActive(temp.db, active("new", 95, "session-2")).status).toBe("updated");
    expect(callRows()[1]).toMatchObject({ uid: "new", ended_wall_ms: null, end_reason: null });
  });

  it("never ends a call before it started", () => {
    recordCallActive(temp.db, active("c1", 10));
    recordSpanEnded(temp.db, "calls", { uid: "c1", at: at(8), nowMs: t0 });
    expect(callRows()[0]).toMatchObject({ ended_wall_ms: t0 + 10_000, end_reason: "ended" });
  });

  it("loads the calls that meet a window, active ones reaching now", () => {
    recordCallActive(temp.db, active("before", 0));
    recordSpanEnded(temp.db, "calls", { uid: "before", at: at(20), nowMs: t0 });
    recordCallActive(temp.db, active("during", 100));
    expect(loadCallsBetween(temp.db, t0 + 50_000, t0 + 500_000).map((call) => call.uid)).toEqual([
      "during",
    ]);
    expect(loadCallsBetween(temp.db, t0, t0 + 500_000)).toMatchObject([
      { uid: "before", ended: at(20), endReason: "ended", via: "call_app" },
      { uid: "during", started: at(100), ended: null, endReason: null },
    ]);
  });

  it("keeps listen spans apart from calls, with the same replay rules", () => {
    const listen = (uid: string, sec: number) => ({
      uid,
      sessionId: "session-1",
      bundleId: "anomaly.hex",
      via: "app" as const,
      at: at(sec),
      nowMs: t0 + sec * 1000,
    });
    recordCallActive(temp.db, active("call", 5));
    expect(recordListenActive(temp.db, listen("hex-1", 10)).status).toBe("inserted");
    expect(recordListenActive(temp.db, listen("hex-1", 10)).status).toBe("duplicate");
    expect(
      recordSpanEnded(temp.db, "listens", { uid: "hex-1", at: at(14), nowMs: t0 }).status,
    ).toBe("updated");
    recordListenActive(temp.db, listen("hex-2", 30));
    touchSpans(temp.db, "listens", { uids: ["hex-2"], at: at(40) });
    // The snapshot replays the call only: the open listen span is lost at its last-seen clock.
    expect(closeLostSpans(temp.db, "listens", { replayed: new Set(), at: at(50), nowMs: t0 })).toBe(
      1,
    );
    expect(loadListensBetween(temp.db, t0, t0 + 100_000)).toMatchObject([
      { uid: "hex-1", bundleId: "anomaly.hex", via: "app", ended: at(14), endReason: "ended" },
      { uid: "hex-2", started: at(30), ended: at(40), endReason: "lost" },
    ]);
    expect(loadCallsBetween(temp.db, t0, t0 + 100_000)).toMatchObject([
      { uid: "call", ended: null },
    ]);
  });

  it("loads app track runs with their clocks, open ones without an end", () => {
    const { trackRunId } = upsertTrackRun(temp.db, {
      uid: "tap-1",
      trackKey: "app:us.zoom.xos",
      sourceKind: "app",
      app: { bundleId: "us.zoom.xos", name: "zoom.us", seenAtMs: t0 },
      startedWallMs: t0 + 10_000,
      nowMs: t0,
    });
    recordEpoch(temp.db, {
      trackRunId,
      seq: 1,
      reason: "run_start",
      sampleStart: 0,
      timebaseNumer: 125,
      timebaseDenom: 3,
      anchorHostTicks: 1n,
      anchorContinuousUs: 10_000_000,
      anchorWallMs: t0 + 10_000,
    });
    expect(loadAppTapsBetween(temp.db, t0, t0 + 60_000)).toEqual([
      { bundleId: "us.zoom.xos", start: at(10), endContinuousUs: null },
    ]);
    upsertTrackRun(temp.db, {
      uid: "tap-1",
      trackKey: "app:us.zoom.xos",
      sourceKind: "app",
      startedWallMs: t0 + 10_000,
      state: "closed",
      endedWallMs: t0 + 40_000,
      endReason: "released",
      sampleEnd: 30 * 16_000,
      nowMs: t0,
    });
    expect(loadAppTapsBetween(temp.db, t0, t0 + 60_000)).toEqual([
      { bundleId: "us.zoom.xos", start: at(10), endContinuousUs: 40_000_000 },
    ]);
    expect(loadAppTapsBetween(temp.db, t0 + 50_000, t0 + 60_000)).toEqual([]);
  });
});

describe("the call going on (ADR 025)", () => {
  const ZOOM = { bundleId: "us.zoom.xos", name: "zoom.us", seenAtMs: t0 };
  const s = (sec: number) => Math.round(sec * 16_000);

  /** A region of `trackRunId` from `from` to `to` seconds (open without `to`), in the episode. */
  function region(
    episodeId: number,
    trackRunId: number,
    from: number,
    to: number | null,
    attributedAppId: number | null = null,
  ) {
    const opened = openSpeechRegion(temp.db, {
      trackRunId,
      sampleStart: s(from),
      wallStartMs: t0 + from * 1000,
      vadVersion: "test",
      attributedAppId,
    });
    if (to !== null) {
      closeSpeechRegion(temp.db, {
        trackRunId,
        sampleStart: s(from),
        sampleEnd: s(to),
        wallEndMs: t0 + to * 1000,
        endReason: "silence",
      });
    }
    temp.db.client
      .prepare(
        `INSERT INTO episode_regions (episode_id, speech_region_id, grouping_version, slice_sample_start)
         VALUES (?, ?, 'grouping/4', ?)`,
      )
      .run(episodeId, opened.speechRegionId, s(from));
  }

  function openCall(seedFrom: number) {
    const { episodeId, trackRunId: mic } = seedEpisode(temp.db, [[seedFrom, seedFrom + 2]]);
    temp.db.client
      .prepare("UPDATE episodes SET state = 'open', context = 'call' WHERE id = ?")
      .run(episodeId);
    return { episodeId, mic };
  }

  it("finds the call's open episode, never an older call's", () => {
    expect(ongoingCall(temp.db, t0 + 100_000)).toBeNull();
    const before = openCall(5);
    recordCallActive(temp.db, active("c1", 50));
    // The episode left open by the call before has no speech since this one began.
    expect(ongoingCall(temp.db, t0 + 100_000)).toMatchObject({
      bundleId: "us.zoom.xos",
      episodeId: null,
    });
    // An open region left from before the call does not count as its speech.
    const stale = openSpeechRegion(temp.db, {
      trackRunId: before.mic,
      sampleStart: s(8),
      wallStartMs: t0 + 8_000,
      vadVersion: "test",
    });
    temp.db.client
      .prepare(
        `INSERT INTO episode_regions (episode_id, speech_region_id, grouping_version, slice_sample_start)
         VALUES (?, ?, 'grouping/4', ?)`,
      )
      .run(before.episodeId, stale.speechRegionId, s(8));
    expect(ongoingCall(temp.db, t0 + 100_000)?.episodeId).toBeNull();
    const now = openCall(60);
    expect(ongoingCall(temp.db, t0 + 100_000)).toMatchObject({
      episodeId: now.episodeId,
      startedWallMs: t0 + 50_000,
    });
    expect(now.episodeId).not.toBe(before.episodeId);
    recordSpanEnded(temp.db, "calls", { uid: "c1", at: at(90), nowMs: t0 });
    expect(ongoingCall(temp.db, t0 + 100_000)).toBeNull();
  });

  it("says what was recorded of a call that ended, never an older call's", () => {
    recordCallActive(temp.db, active("c1", 50));
    const recorded = () =>
      callRecording(temp.db, { bundleId: "us.zoom.xos", sinceMs: t0 + 50_000 });
    expect(recorded()).toBeNull();
    openCall(5);
    expect(recorded()).toBeNull();
    const { episodeId } = openCall(60);
    recordSpanEnded(temp.db, "calls", { uid: "c1", at: at(90), nowMs: t0 });
    expect(recorded()).toEqual({ episodeId, durationMs: 2_000, open: true });
    // Another app's recording is not this call's.
    const other = upsertApp(temp.db, { ...ZOOM, bundleId: "com.hnc.Discord" }).appId;
    temp.db.client
      .prepare("UPDATE episodes SET primary_app_id = ? WHERE id = ?")
      .run(other, episodeId);
    expect(recorded()).toBeNull();
    const zoom = upsertApp(temp.db, ZOOM).appId;
    temp.db.client
      .prepare("UPDATE episodes SET primary_app_id = ?, state = 'closed' WHERE id = ?")
      .run(zoom, episodeId);
    expect(recorded()).toMatchObject({ episodeId, open: false });
  });

  it("hears the call app's tap and its attributed system sound, never the mic or other sound", () => {
    const { episodeId, mic } = openCall(10);
    const tap = upsertTrackRun(temp.db, {
      uid: "tap",
      trackKey: "app:us.zoom.xos",
      sourceKind: "app",
      app: ZOOM,
      startedWallMs: t0,
      nowMs: t0,
    }).trackRunId;
    const system = upsertTrackRun(temp.db, {
      uid: "system",
      trackKey: "system:other",
      sourceKind: "system",
      startedWallMs: t0,
      nowMs: t0,
    }).trackRunId;
    const zoom = upsertApp(temp.db, ZOOM).appId;
    const music = upsertApp(temp.db, {
      bundleId: "com.spotify.client",
      name: "Spotify",
      seenAtMs: t0,
    }).appId;
    region(episodeId, mic, 20, 25);
    region(episodeId, tap, 30, 40);
    region(episodeId, system, 50, 55, zoom);
    region(episodeId, system, 60, 65, music);
    region(episodeId, system, 70, 75);
    region(episodeId, tap, 80, null);
    const far = (sinceSeconds: number) =>
      farSideRegions(temp.db, {
        episodeId,
        bundleId: "us.zoom.xos",
        sinceWallMs: t0 + sinceSeconds * 1000,
      }).map((r) => [r.trackRunId, r.sampleStart, r.sampleEnd]);
    expect(far(0)).toEqual([
      [tap, s(30), s(40)],
      [system, s(50), s(55)],
      [tap, s(80), null],
    ]);
    // Only the current span: a region that ended before it is someone else's.
    expect(far(45)).toEqual([
      [system, s(50), s(55)],
      [tap, s(80), null],
    ]);
  });
});
