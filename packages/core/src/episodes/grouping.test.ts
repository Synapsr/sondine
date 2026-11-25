import { describe, expect, it } from "vitest";

import {
  GROUPING_V4,
  GROUPING_VERSION,
  GroupingInputError,
  groupEpisodes,
  type BoundaryConstraint,
  type Episode,
  type GroupingInput,
} from "./grouping";
import type {
  AppContext,
  CallTransition,
  DictationSpan,
  EchoFlag,
  SpeechRegion,
  SystemEvent,
  TrackKind,
} from "./types";

const ns = (seconds: number): bigint => BigInt(Math.round(seconds * 1000)) * 1_000_000n;

const MIC = "input:BuiltInMicrophoneDevice";
const USB_MIC = "input:USB-Yeti";
const ZOOM = "app:us.zoom.xos";
const SAFARI = "app:com.apple.Safari";
const SYSTEM = "system:other";

const NO_APP: AppContext = { isCallApp: false, callActive: false };

interface RegionSpec {
  readonly kind?: TrackKind;
  readonly app?: AppContext;
  readonly voicedMs?: number;
  readonly echo?: EchoFlag;
}

function region(
  id: string,
  trackKey: string,
  start: number,
  end: number,
  spec: RegionSpec = {},
): SpeechRegion {
  const trackKind: TrackKind =
    spec.kind ??
    (trackKey.startsWith("input:") ? "input" : trackKey.startsWith("app:") ? "app" : "system");
  const base: SpeechRegion = {
    id,
    trackKey,
    trackKind,
    startNs: ns(start),
    endNs: ns(end),
    voicedMs: spec.voicedMs ?? Math.round((end - start) * 1000),
    appContext: spec.app ?? NO_APP,
  };
  return spec.echo === undefined ? base : { ...base, echoFlag: spec.echo };
}

const call = (
  at: number,
  state: CallTransition["state"],
  callKey = "us.zoom.xos",
): CallTransition => ({
  atNs: ns(at),
  callKey,
  bundleId: callKey,
  state,
});

const event = (at: number, kind: SystemEvent["kind"], trackKey?: string): SystemEvent =>
  trackKey === undefined ? { atNs: ns(at), kind } : { atNs: ns(at), kind, trackKey };

const zoomApp: AppContext = { bundleId: "us.zoom.xos", isCallApp: true, callActive: true };
const zoomMic: AppContext = { bundleId: "us.zoom.xos", isCallApp: true, callActive: true };
const safari: AppContext = { bundleId: "com.apple.Safari", isCallApp: false, callActive: false };

function ids(episode: Episode | undefined): readonly string[] {
  return episode?.regionIds ?? [];
}

/** Regions of `length` seconds every `period` seconds from `from` to `to`. */
function steady(
  prefix: string,
  trackKey: string,
  from: number,
  to: number,
  period: number,
  length: number,
  spec: RegionSpec = {},
) {
  const out: SpeechRegion[] = [];
  for (let t = from, i = 0; t + length <= to; t += period, i += 1) {
    out.push(region(`${prefix}${String(i).padStart(4, "0")}`, trackKey, t, t + length, spec));
  }
  return out;
}

describe("in-person café", () => {
  const regions = [
    region("a1", MIC, 0, 5),
    region("a2", MIC, 8, 20),
    region("a3", MIC, 30, 50),
    region("a4", MIC, 90, 100), // 40 s pause: same conversation
    region("b1", MIC, 150, 160), // 50 s pause: new episode
    region("b2", MIC, 170, 175),
  ];

  it("splits at 45 s of silence and closes on the gap", () => {
    const result = groupEpisodes({ regions, untilNs: ns(300) });
    expect(result.version).toBe(GROUPING_VERSION);
    expect(result.episodes.map(ids)).toEqual([
      ["a1", "a2", "a3", "a4"],
      ["b1", "b2"],
    ]);
    const [first, second] = result.episodes;
    expect(first).toMatchObject({
      key: "a1",
      context: "in_person",
      provisional: false,
      closeReason: "gap",
      closesAtNs: null,
      startNs: ns(0),
      endNs: ns(100),
      voicedMs: 47_000,
      trackKeys: [MIC],
      lanes: [{ kind: "in_person" }],
    });
    expect(second).toMatchObject({ provisional: false, closeReason: "gap" });
  });

  it("treats exactly 45 s of silence as a boundary and 44.999 s as a pause", () => {
    const at = groupEpisodes({
      regions: [region("x", MIC, 0, 10), region("y", MIC, 55, 60)],
      untilNs: ns(200),
    });
    expect(at.episodes.map(ids)).toEqual([["x"], ["y"]]);
    const below = groupEpisodes({
      regions: [region("x", MIC, 0, 10), region("y", MIC, 54.999, 60)],
      untilNs: ns(200),
    });
    expect(below.episodes.map(ids)).toEqual([["x", "y"]]);
  });

  it("keeps the last episode provisional until its gap elapses", () => {
    const open = groupEpisodes({ regions, untilNs: ns(200) });
    const last = open.episodes.at(-1);
    expect(last).toMatchObject({ provisional: true, closeReason: null, closesAtNs: ns(175 + 45) });
    const closed = groupEpisodes({ regions, untilNs: ns(220) });
    expect(closed.episodes.at(-1)).toMatchObject({ provisional: false, closeReason: "gap" });
  });

  it("follows the conversation across a mic change and records it", () => {
    const result = groupEpisodes({
      regions: [region("m1", MIC, 0, 10), region("m2", USB_MIC, 20, 30)],
      events: [event(15, "device-change", USB_MIC)],
      untilNs: ns(100),
    });
    expect(result.episodes.map(ids)).toEqual([["m1", "m2"]]);
    expect(result.episodes[0]?.trackKeys).toEqual([USB_MIC, MIC].toSorted());
    expect(result.episodes[0]?.discontinuities).toEqual([event(15, "device-change", USB_MIC)]);
  });
});

describe("Zoom call with mic and app tracks", () => {
  const regions = [
    region("p1", MIC, 60, 70), // before the call
    ...steady("zm", MIC, 105, 400, 20, 8, { app: zoomMic }),
    ...steady("za", ZOOM, 112, 400, 20, 6, { app: zoomApp }),
    // four minutes waiting in silence, still the same episode
    ...steady("zl", MIC, 640, 990, 30, 10, { app: zoomMic }),
    region("echo1", MIC, 113, 117, { app: zoomMic, echo: { kind: "echo", ofTrackKey: ZOOM } }),
    region("q1", MIC, 1010, 1020), // after the call
  ];
  const calls = [call(100, "active"), call(500, "ended"), call(520, "active"), call(1000, "ended")];

  it("groups mic and app speech into one call episode tied to call state", () => {
    const result = groupEpisodes({ regions, calls, untilNs: ns(1200) });
    expect(result.episodes.map((e) => e.context)).toEqual(["in_person", "call", "in_person"]);
    const [before, theCall, after] = result.episodes;
    expect(ids(before)).toEqual(["p1"]);
    expect(before?.closeReason).toBe("call-started");
    expect(theCall?.trackKeys).toEqual([MIC, ZOOM].toSorted());
    expect(theCall?.regionIds.some((id) => id.startsWith("zm"))).toBe(true);
    expect(theCall?.regionIds.some((id) => id.startsWith("za"))).toBe(true);
    expect(theCall?.regionIds.some((id) => id.startsWith("zl"))).toBe(true);
    expect(theCall).toMatchObject({
      closeReason: "call-ended",
      provisional: false,
      hiddenRegionIds: ["echo1"],
      bundleIds: ["us.zoom.xos"],
      lanes: [{ kind: "call", callKey: "us.zoom.xos", sessionStartNs: ns(100) }],
    });
    expect(ids(after)).toEqual(["q1"]);
  });

  it("does not count the echo copy as voiced time", () => {
    const result = groupEpisodes({ regions, calls, untilNs: ns(1200) });
    const theCall = result.episodes[1];
    const live = regions.filter((r) => theCall?.regionIds.includes(r.id) === true);
    expect(theCall?.voicedMs).toBe(live.reduce((sum, r) => sum + r.voicedMs, 0));
    expect(theCall?.regionIds).not.toContain("echo1");
  });

  it("stays provisional while the call is active and for the rejoin window after it ends", () => {
    const before = regions.filter((r) => r.endNs <= ns(450));
    const during = groupEpisodes({ regions: before, calls: calls.slice(0, 1), untilNs: ns(450) });
    const lastEnd = before
      .filter((r) => r.id.startsWith("z"))
      .reduce((end, r) => (r.endNs > end ? r.endNs : end), 0n);
    expect(during.episodes.find((e) => e.context === "call")).toMatchObject({
      provisional: true,
      closesAtNs: lastEnd + GROUPING_V4.callSilenceGapNs,
    });
    const justEnded = groupEpisodes({
      regions: regions.filter((r) => r.endNs <= ns(1000)),
      calls,
      untilNs: ns(1030),
    });
    expect(justEnded.episodes.find((e) => e.context === "call")).toMatchObject({
      provisional: true,
      closesAtNs: ns(1000) + GROUPING_V4.callRejoinGapNs,
    });
  });

  it("closes a call after 5 min without speech, the call still on", () => {
    const silenceS = Number(GROUPING_V4.callSilenceGapNs / 1_000_000_000n);
    const result = groupEpisodes({
      regions: [
        region("hi", MIC, 10, 20, { app: zoomMic }),
        region("far", ZOOM, 22, 30, { app: zoomApp }),
        region("later", MIC, 30 + silenceS, 40 + silenceS, { app: zoomMic }),
      ],
      calls: [call(0, "active")],
      untilNs: ns(60 + silenceS),
    });
    expect(result.episodes.map((e) => [ids(e), e.context, e.closeReason])).toEqual([
      [["hi", "far"], "call", "gap"],
      [["later"], "call", null],
    ]);
    expect(result.episodes[1]?.lanes).toEqual(result.episodes[0]?.lanes);
  });

  it("splits two calls separated by more than the rejoin window", () => {
    const result = groupEpisodes({
      regions: [region("c1", MIC, 10, 20), region("c2", MIC, 110, 120)],
      calls: [call(0, "active"), call(30, "ended"), call(100, "active"), call(130, "ended")],
      untilNs: ns(300),
    });
    expect(result.episodes.map(ids)).toEqual([["c1"], ["c2"]]);
    expect(result.episodes.map((e) => e.closeReason)).toEqual(["call-ended", "call-ended"]);
  });

  it("infers a call from region evidence when no transition was recorded", () => {
    const result = groupEpisodes({
      regions: [
        region("i1", MIC, 0, 10, { app: zoomMic }),
        region("i2", ZOOM, 70, 80, { app: zoomApp }),
        region("i3", MIC, 100, 110, { app: zoomMic }),
      ],
      untilNs: ns(400),
    });
    expect(result.episodes.map(ids)).toEqual([["i1"], ["i2", "i3"]]);
    expect(result.episodes.every((e) => e.context === "call")).toBe(true);
  });
});

describe("call heard through system:other (no app tap)", () => {
  // The helper taps no app yet: the far side of a call plays on system:other,
  // and the call comes from the helper's call events (one id per active span).
  const zoomCall = (
    at: number,
    state: CallTransition["state"],
    callId: string,
  ): CallTransition => ({
    ...call(at, state),
    callId,
  });
  const attributed = (bundleId: string): AppContext => ({
    ...NO_APP,
    attributedBundleId: bundleId,
  });

  it("groups the mic and the far side on system:other into one call", () => {
    const result = groupEpisodes({
      regions: [
        region("p1", MIC, 10, 15),
        region("m1", MIC, 105, 110),
        region("f1", SYSTEM, 112, 120),
        region("f2", SYSTEM, 130, 140, { app: attributed("us.zoom.xos") }),
        region("m2", MIC, 141, 150),
      ],
      calls: [zoomCall(100, "active", "c1"), zoomCall(200, "ended", "c1")],
      untilNs: ns(400),
    });
    expect(result.episodes.map((e) => [e.context, ...e.regionIds])).toEqual([
      ["in_person", "p1"],
      ["call", "m1", "f1", "f2", "m2"],
    ]);
    expect(result.episodes[1]).toMatchObject({
      trackKeys: [MIC, SYSTEM].toSorted(),
      closeReason: "call-ended",
      provisional: false,
    });
  });

  it("keeps one call when it restarts within 45 s under another id, two calls after", () => {
    const regions = [
      region("a", MIC, 10, 20),
      region("f", SYSTEM, 22, 28),
      region("b", MIC, 80, 90),
    ];
    const rejoined = groupEpisodes({
      regions,
      calls: [
        zoomCall(0, "active", "c1"),
        zoomCall(40, "ended", "c1"),
        zoomCall(70, "active", "c2"),
        zoomCall(100, "ended", "c2"),
      ],
      untilNs: ns(400),
    });
    expect(rejoined.episodes.map((e) => [e.context, ...e.regionIds])).toEqual([
      ["call", "a", "f", "b"],
    ]);
    const apart = groupEpisodes({
      regions,
      calls: [
        zoomCall(0, "active", "c1"),
        zoomCall(30, "ended", "c1"),
        zoomCall(76, "active", "c2"),
        zoomCall(100, "ended", "c2"),
      ],
      untilNs: ns(400),
    });
    expect(apart.episodes.map((e) => [e.context, ...e.regionIds])).toEqual([
      ["call", "a", "f"],
      ["call", "b"],
    ]);
  });

  it("joins overlapping spans of one app, as after a helper restart", () => {
    const result = groupEpisodes({
      regions: [region("a", MIC, 10, 20), region("b", MIC, 70, 80), region("c", MIC, 140, 150)],
      // The old helper's span was closed late; the new helper's span started before that.
      calls: [
        zoomCall(0, "active", "old"),
        zoomCall(90, "ended", "old"),
        zoomCall(60, "active", "new"),
        zoomCall(160, "ended", "new"),
      ],
      untilNs: ns(400),
    });
    expect(result.episodes.map((e) => [e.context, ...e.regionIds])).toEqual([
      ["call", "a", "b", "c"],
    ]);
  });

  it("keeps a call that ends where it starts closed, in either order", () => {
    // A helper that died after reporting the call, before its next clock:
    // recovery closes the call at its start.
    const regions = [region("m", MIC, 10, 12)];
    for (const calls of [
      [zoomCall(0, "active", "c1"), zoomCall(0, "ended", "c1")],
      [zoomCall(0, "ended", "c1"), zoomCall(0, "active", "c1")],
      // Without ids too, a call that was not on starts and stops there.
      [call(0, "ended"), call(0, "active")],
    ]) {
      const result = groupEpisodes({ regions, calls, untilNs: ns(1000) });
      expect(result.episodes.map((e) => [e.context, e.provisional, ...e.regionIds])).toEqual([
        ["in_person", false, "m"],
      ]);
    }
    // Without ids, a call that was on stops and restarts there: it goes on.
    const restarted = groupEpisodes({
      regions: [region("m", MIC, 500, 502)],
      calls: [call(0, "active"), call(30, "active"), call(30, "ended")],
      untilNs: ns(700),
    });
    expect(restarted.episodes.map((e) => [e.context, e.provisional])).toEqual([["call", true]]);
  });

  it("lets a closed instant join its app's spans within the rejoin window", () => {
    const result = groupEpisodes({
      regions: [region("a", MIC, 50, 60), region("b", MIC, 115, 125)],
      calls: [
        zoomCall(0, "active", "c1"),
        zoomCall(60, "ended", "c1"),
        // 30 s after c1 and 30 s before c3: one call with both.
        zoomCall(90, "active", "lost"),
        zoomCall(90, "ended", "lost"),
        zoomCall(120, "active", "c3"),
        zoomCall(130, "ended", "c3"),
      ],
      untilNs: ns(1000),
    });
    expect(result.episodes.map((e) => [e.context, e.closeReason, ...e.regionIds])).toEqual([
      ["call", "call-ended", "a", "b"],
    ]);
  });

  it("gives the same episodes when call events are replayed", () => {
    const regions = [
      region("m", MIC, 10, 20),
      region("f", SYSTEM, 25, 30),
      region("q", MIC, 300, 310),
    ];
    const once = [zoomCall(0, "active", "c1"), zoomCall(60, "ended", "c1")];
    const replayed = [...once, zoomCall(0, "active", "c1"), ...once, zoomCall(60, "ended", "c1")];
    expect(groupEpisodes({ regions, calls: replayed, untilNs: ns(400) })).toEqual(
      groupEpisodes({ regions, calls: once, untilNs: ns(400) }),
    );
  });

  it("keeps a video of another app on system:other out of the call", () => {
    const result = groupEpisodes({
      regions: [
        region("m", MIC, 10, 20),
        region("v1", SYSTEM, 12, 40, { app: attributed("com.apple.Safari") }),
        region("f", SYSTEM, 45, 50),
      ],
      calls: [zoomCall(0, "active", "c1"), zoomCall(100, "ended", "c1")],
      untilNs: ns(400),
    });
    expect(result.episodes.map((e) => [e.context, ...e.regionIds])).toEqual([
      ["call", "m", "f"],
      ["media", "v1"],
    ]);
    // The media lane is unchanged by attribution: system:other stays one source.
    expect(result.episodes[1]?.lanes).toEqual([{ kind: "media", sourceKey: SYSTEM }]);
  });

  it("leaves system:other to media while the call app has its own tap", () => {
    const result = groupEpisodes({
      regions: [
        region("m", MIC, 10, 20),
        region("z", ZOOM, 21, 30, {
          app: { bundleId: "us.zoom.xos", isCallApp: true, callActive: true },
        }),
        region("v", SYSTEM, 32, 40),
        region("after", SYSTEM, 140, 150),
      ],
      calls: [zoomCall(0, "active", "c1"), zoomCall(200, "ended", "c1")],
      appTaps: [{ bundleId: "us.zoom.xos", startNs: ns(5), endNs: ns(100) }],
      untilNs: ns(600),
    });
    expect(result.episodes.map((e) => [e.context, ...e.regionIds])).toEqual([
      ["call", "m", "z", "after"],
      ["media", "v"],
    ]);
  });

  it("splits a region straddling the call's end by its midpoint", () => {
    const result = groupEpisodes({
      regions: [
        region("in", MIC, 50, 64), // midpoint 57: during the call
        region("out", SYSTEM, 58, 70), // midpoint 64: after it
        region("late", MIC, 66, 72),
      ],
      calls: [zoomCall(0, "active", "c1"), zoomCall(60, "ended", "c1")],
      untilNs: ns(400),
    });
    expect(result.episodes.map((e) => [e.context, ...e.regionIds])).toEqual([
      ["call", "in"],
      ["media", "out"],
      ["in_person", "late"],
    ]);
  });

  it("never changes a closed call episode as regions and call events stream in", () => {
    const input: GroupingInput = {
      regions: [
        region("p", MIC, 0, 10),
        ...steady("m", MIC, 60, 300, 20, 6),
        ...steady("f", SYSTEM, 70, 300, 20, 5),
        region("v", SYSTEM, 150, 158, { app: attributed("com.apple.Safari") }),
        ...steady("n", MIC, 400, 600, 25, 8),
      ],
      calls: [
        zoomCall(50, "active", "c1"),
        zoomCall(180, "ended", "c1"),
        zoomCall(200, "active", "c2"),
        zoomCall(320, "ended", "c2"),
      ],
      untilNs: ns(800),
    };
    const full = groupEpisodes(input);
    expect(full.episodes.map((e) => e.context)).toEqual([
      "in_person",
      "call",
      "media",
      "in_person",
    ]);
    for (let cut = 5; cut <= 800; cut += 5) {
      const untilNs = ns(cut);
      const prefix = groupEpisodes({
        regions: input.regions
          .filter((r) => r.startNs <= untilNs)
          .map((r) => (r.endNs > untilNs ? { ...r, endNs: untilNs } : r)),
        calls: (input.calls ?? []).filter((c) => c.atNs <= untilNs),
        untilNs,
      });
      for (const episode of prefix.episodes.filter((e) => !e.provisional)) {
        const later = full.episodes.find((e) => e.key === episode.key);
        expect(later?.regionIds, `cut at ${cut} s`).toEqual(episode.regionIds);
        expect(later?.context).toBe(episode.context);
      }
    }
  });

  it("rejects an app tap that ends before it starts", () => {
    expect(() =>
      groupEpisodes({
        regions: [],
        appTaps: [{ bundleId: "us.zoom.xos", startNs: ns(10), endNs: ns(5) }],
        untilNs: ns(20),
      }),
    ).toThrow(GroupingInputError);
  });
});

/** A region of Yab's own track, with the page its link reported. */
function yabTrack(pageKey?: string): AppContext {
  return {
    bundleId: "dev.serafim.fast",
    ...(pageKey === undefined ? {} : { pageKey }),
    isCallApp: false,
    callActive: false,
  };
}

/** A `system:other` region's context: the app macOS named, and the page its browser played. */
function named(bundleId: string | undefined, pageKey?: string): AppContext {
  return {
    ...(bundleId === undefined ? {} : { attributedBundleId: bundleId }),
    ...(pageKey === undefined ? {} : { pageKey }),
    isCallApp: false,
    callActive: false,
  };
}

describe("YouTube in Safari while talking", () => {
  const video = steady("yt", SAFARI, 0, 600, 15, 12, { app: safari });
  const talk = [region("t1", MIC, 100, 110), region("t2", MIC, 120, 130)];
  const echoes = [
    region("e1", MIC, 30.2, 42.2, { echo: { kind: "echo", ofTrackKey: SAFARI } }),
    region("e2", MIC, 45.1, 57.1, { echo: { kind: "echo", ofTrackKey: SAFARI } }),
  ];

  it("keeps media and mic speech in separate episodes", () => {
    const result = groupEpisodes({ regions: [...video, ...talk, ...echoes], untilNs: ns(900) });
    expect(result.episodes.map((e) => e.context)).toEqual(["media", "in_person"]);
    const [media, inPerson] = result.episodes;
    expect(media?.regionIds).toHaveLength(video.length);
    expect(media?.lanes).toEqual([{ kind: "media", sourceKey: "com.apple.Safari" }]);
    expect(media?.hiddenRegionIds).toEqual(["e1", "e2"]);
    expect(ids(inPerson)).toEqual(["t1", "t2"]);
  });

  it("keeps one media episode when attribution moves from system:other to the app tap", () => {
    const result = groupEpisodes({
      regions: [
        region("s1", SYSTEM, 0, 10, { app: safari }),
        region("s2", SAFARI, 12, 20, { app: safari }),
      ],
      untilNs: ns(400),
    });
    expect(result.episodes.map(ids)).toEqual([["s1", "s2"]]);
    expect(result.episodes[0]?.context).toBe("media");
  });

  it("uses the media gap, not the in-person gap", () => {
    const result = groupEpisodes({
      regions: [
        region("v1", SAFARI, 0, 10, { app: safari }),
        region("v2", SAFARI, 100, 110, { app: safari }),
      ],
      untilNs: ns(400),
    });
    expect(result.episodes.map(ids)).toEqual([["v1", "v2"]]);
    const split = groupEpisodes({
      regions: [
        region("v1", SAFARI, 0, 10, { app: safari }),
        region("v2", SAFARI, 130, 140, { app: safari }),
      ],
      untilNs: ns(400),
    });
    expect(split.episodes.map(ids)).toEqual([["v1"], ["v2"]]);
  });

  it("splits media by the page its browser reported", () => {
    const yab = (pageKey?: string): AppContext => ({
      attributedBundleId: "dev.serafim.fast",
      ...(pageKey === undefined ? {} : { pageKey }),
      isCallApp: false,
      callActive: false,
    });
    const result = groupEpisodes({
      regions: [
        region("a1", SYSTEM, 0, 10, { app: yab("youtube.com/watch?v=a") }),
        region("a2", SYSTEM, 20, 30, { app: yab("youtube.com/watch?v=a") }),
        // The next video, within the media gap: an episode of its own.
        region("b1", SYSTEM, 40, 50, { app: yab("youtube.com/watch?v=b") }),
        // No page reported (two tabs played, or the link said nothing): the one going on.
        region("n1", SYSTEM, 60, 70, { app: yab() }),
        // After the media gap, no page: an episode without one.
        region("n2", SYSTEM, 200, 210, { app: yab() }),
      ],
      untilNs: ns(600),
    });
    expect(result.episodes.map(ids)).toEqual([["a1", "a2"], ["b1", "n1"], ["n2"]]);
    expect(result.episodes.map((episode) => episode.context)).toEqual(["media", "media", "media"]);
    expect(result.episodes.map((episode) => episode.lanes)).toEqual([
      [{ kind: "media", sourceKey: SYSTEM }],
      [{ kind: "media", sourceKey: SYSTEM }],
      [{ kind: "media", sourceKey: SYSTEM }],
    ]);
    expect(result.episodes.map((episode) => episode.pageKey)).toEqual([
      "youtube.com/watch?v=a",
      "youtube.com/watch?v=b",
      null,
    ]);
  });

  it("keeps a video one episode when its page is known for a minute of it (Yab, 2026-11-10)", () => {
    const track = "app:dev.serafim.fast";
    const videoKey = "youtube.com/watch?v=GtJKFhztgdM";
    // 13:51 to 14:12 in regions of about a minute; only the one around 14:01 met a play.
    const regions = Array.from({ length: 21 }, (_, index) =>
      region(`r${index}`, track, index * 60, index * 60 + 58, {
        app: yabTrack(index === 10 ? videoKey : undefined),
      }),
    );
    const result = groupEpisodes({ regions, untilNs: ns(21 * 60) });
    expect(result.episodes.map((episode) => [episode.regionIds.length, episode.pageKey])).toEqual([
      [21, videoKey],
    ]);
  });

  it("starts the next episode where another known page starts, whatever came between", () => {
    const track = "app:dev.serafim.fast";
    const result = groupEpisodes({
      regions: [
        region("n1", track, 0, 10, { app: yabTrack() }),
        region("a1", track, 20, 30, { app: yabTrack("youtube.com/watch?v=a") }),
        region("n2", track, 40, 50, { app: yabTrack() }),
        region("b1", track, 60, 70, { app: yabTrack("youtube.com/watch?v=b") }),
        region("n3", track, 80, 90, { app: yabTrack() }),
      ],
      untilNs: ns(600),
    });
    expect(result.episodes.map(ids)).toEqual([
      ["n1", "a1", "n2"],
      ["b1", "n3"],
    ]);
    expect(result.episodes.map((episode) => episode.closeReason)).toEqual(["page-changed", "gap"]);
  });

  it("never splits on a page while the episode's speech still overlaps, prefix or not", () => {
    const track = "app:dev.serafim.fast";
    const pair = (aEnd: number, bEnd: number) => [
      region("a", track, 0, aEnd, { app: yabTrack("youtube.com/watch?v=a") }),
      region("b", track, 20, bEnd, { app: yabTrack("youtube.com/watch?v=b") }),
    ];
    const whole = groupEpisodes({ regions: pair(100, 30), untilNs: ns(600) });
    // At 25 s both regions are still open: clipped to now.
    const prefix = groupEpisodes({ regions: pair(25, 25), untilNs: ns(25) });
    expect(whole.episodes.map(ids)).toEqual([["a", "b"]]);
    expect(prefix.episodes.map(ids)).toEqual([["a", "b"]]);
    expect(prefix.episodes[0]?.closeReason).toBeNull();
  });

  it("lets another app's sound on system:other leave a page's episode", () => {
    const result = groupEpisodes({
      regions: [
        region("v1", SYSTEM, 0, 10, { app: named("dev.serafim.fast", "youtube.com/watch?v=a") }),
        // No app named (several held their output): it joins.
        region("u1", SYSTEM, 20, 30, { app: named(undefined) }),
        region("m1", SYSTEM, 40, 50, { app: named("com.apple.Music") }),
      ],
      untilNs: ns(600),
    });
    expect(result.episodes.map(ids)).toEqual([["v1", "u1"], ["m1"]]);
  });

  it("keeps one page's media together across a pause shorter than the media gap", () => {
    const page = { ...safari, pageKey: "netflix.com/watch/81" };
    const result = groupEpisodes({
      regions: [
        region("p1", SAFARI, 0, 10, { app: page }),
        region("p2", SAFARI, 100, 110, { app: page }),
      ],
      untilNs: ns(400),
    });
    expect(result.episodes.map(ids)).toEqual([["p1", "p2"]]);
  });

  it("keeps a video watched during a call out of the call", () => {
    const result = groupEpisodes({
      regions: [
        region("cm", MIC, 10, 20, { app: zoomMic }),
        region("ca", ZOOM, 22, 30, { app: zoomApp }),
        region("vd", SAFARI, 15, 40, { app: { ...safari, callActive: true } }),
      ],
      calls: [call(0, "active"), call(60, "ended")],
      untilNs: ns(400),
    });
    expect(result.episodes.map((e) => [e.context, ...e.regionIds])).toEqual([
      ["call", "cm", "ca"],
      ["media", "vd"],
    ]);
  });

  it("leaves an echo without its source and self-playback unassigned", () => {
    const result = groupEpisodes({
      regions: [
        region("lonely", MIC, 0, 5, { echo: { kind: "echo", ofTrackKey: SAFARI } }),
        region("replay", MIC, 10, 15, { echo: { kind: "self-playback" } }),
      ],
      untilNs: ns(100),
    });
    expect(result.episodes).toEqual([]);
    expect(result.unassigned).toEqual([
      { regionId: "lonely", reason: "echo-without-source" },
      { regionId: "replay", reason: "self-playback" },
    ]);
  });

  it("attaches a duplicate mic copy to the episode it duplicates", () => {
    const result = groupEpisodes({
      regions: [
        region("main", MIC, 0, 10),
        region("dup", USB_MIC, 0.1, 10.1, { echo: { kind: "duplicate", ofTrackKey: MIC } }),
      ],
      untilNs: ns(100),
    });
    expect(result.episodes).toHaveLength(1);
    expect(result.episodes[0]).toMatchObject({
      regionIds: ["main"],
      hiddenRegionIds: ["dup"],
      voicedMs: 10_000,
    });
  });
});

describe("dictation apps listening", () => {
  const hex = (start: number, end: number | null): DictationSpan => ({
    bundleId: "anomaly.hex",
    startNs: ns(start),
    endNs: end === null ? null : ns(end),
  });

  it("gives mic speech inside a dictation its own lane, apart from the talk around it", () => {
    const result = groupEpisodes({
      regions: [
        region("talk-1", MIC, 0, 5),
        region("dictate", MIC, 20, 32),
        region("talk-2", MIC, 40, 44),
      ],
      dictations: [hex(19, 33)],
      untilNs: ns(300),
    });
    const dictation = result.episodes.find((e) => e.context === "dictation");
    expect(ids(dictation)).toEqual(["dictate"]);
    expect(dictation?.lanes).toEqual([{ kind: "dictation", bundleId: "anomaly.hex" }]);
    const talk = result.episodes.find((e) => e.context === "in_person");
    expect(ids(talk)).toEqual(["talk-1", "talk-2"]);
  });

  it("closes a dictation on silence, not when the app lets go of the microphone", () => {
    const result = groupEpisodes({
      regions: [region("a", MIC, 10, 14), region("b", MIC, 30, 34), region("c", MIC, 100, 104)],
      dictations: [hex(5, null)],
      untilNs: ns(110),
    });
    expect(result.episodes.map((e) => [ids(e), e.context, e.closeReason])).toEqual([
      [["a", "b"], "dictation", "gap"],
      [["c"], "dictation", null],
    ]);
    expect(result.episodes[1]?.closesAtNs).toBe(ns(104) + GROUPING_V4.inPersonGapNs);
  });

  it("counts only the first minutes of an app that keeps listening", () => {
    const windowS = Number(GROUPING_V4.dictationWindowNs / 1_000_000_000n);
    const result = groupEpisodes({
      regions: [region("early", MIC, 60, 64), region("late", MIC, windowS + 100, windowS + 104)],
      dictations: [hex(0, null)],
      untilNs: ns(windowS + 400),
    });
    expect(result.episodes.map((e) => [ids(e), e.context])).toEqual([
      [["early"], "dictation"],
      [["late"], "in_person"],
    ]);
  });

  it("keeps a dictation said during a call apart, and never takes phone recordings or app audio", () => {
    const result = groupEpisodes({
      regions: [
        region("dictate", MIC, 20, 30),
        region("far-side", ZOOM, 22, 28, { app: zoomApp }),
        region("talk", MIC, 32, 36),
        region("phone", "phone:iphone", 50, 60, { kind: "phone" }),
        region("video", SAFARI, 50, 60, { app: safari }),
      ],
      calls: [call(10, "active"), call(40, "ended")],
      dictations: [hex(15, 31), hex(45, 100)],
      untilNs: ns(400),
    });
    expect(result.episodes.map((e) => [ids(e), e.context])).toEqual([
      [["dictate"], "dictation"],
      [["far-side", "talk"], "call"],
      [["phone"], "in_person"],
      [["video"], "media"],
    ]);
  });

  it("gives a region to one app only: the one that started listening first", () => {
    const voiceInk: DictationSpan = {
      bundleId: "com.prakashjoshipax.VoiceInk",
      startNs: ns(8),
      endNs: ns(30),
    };
    const result = groupEpisodes({
      regions: [region("both", MIC, 10, 20)],
      dictations: [voiceInk, hex(9, 30)],
      untilNs: ns(300),
    });
    expect(result.episodes).toHaveLength(1);
    expect(result.episodes[0]?.lanes).toEqual([
      { kind: "dictation", bundleId: "com.prakashjoshipax.VoiceInk" },
    ]);
  });

  it("is mixed when a manual merge joins a dictation to the talk after it", () => {
    const result = groupEpisodes({
      regions: [region("dictate", MIC, 10, 20), region("talk", MIC, 30, 40)],
      dictations: [hex(9, 21)],
      constraints: [{ kind: "merge", startNs: ns(10), endNs: ns(40), origin: "manual", seq: 1 }],
      untilNs: ns(300),
    });
    expect(result.episodes.map((e) => [ids(e), e.context])).toEqual([
      [["dictate", "talk"], "mixed"],
    ]);
  });
});

describe("sleep in the middle", () => {
  it("closes an in-person episode at sleep even inside the gap", () => {
    const result = groupEpisodes({
      regions: [region("s1", MIC, 0, 10), region("s2", MIC, 20, 30), region("s3", MIC, 42, 50)],
      events: [event(35, "sleep"), event(40, "wake")],
      untilNs: ns(200),
    });
    expect(result.episodes.map(ids)).toEqual([["s1", "s2"], ["s3"]]);
    expect(result.episodes.map((e) => e.closeReason)).toEqual(["sleep", "gap"]);
  });

  it("treats a wake without its sleep as a boundary too", () => {
    const result = groupEpisodes({
      regions: [region("w1", MIC, 0, 10), region("w2", MIC, 20, 30)],
      events: [event(15, "wake")],
      untilNs: ns(200),
    });
    expect(result.episodes.map(ids)).toEqual([["w1"], ["w2"]]);
  });

  it("splits a call across sleep and keeps both halves in the call", () => {
    const result = groupEpisodes({
      regions: [
        region("k1", MIC, 300, 310, { app: zoomMic }),
        region("k2", MIC, 700, 710, { app: zoomMic }),
      ],
      calls: [call(0, "active"), call(900, "ended")],
      events: [event(500, "sleep"), event(600, "wake")],
      untilNs: ns(1000),
    });
    expect(result.episodes.map(ids)).toEqual([["k1"], ["k2"]]);
    expect(result.episodes.map((e) => e.closeReason)).toEqual(["sleep", "call-ended"]);
    expect(result.episodes.every((e) => e.context === "call")).toBe(true);
  });

  it("closes at pause and does not merge across resume", () => {
    const result = groupEpisodes({
      regions: [region("u1", MIC, 0, 10), region("u2", MIC, 25, 30)],
      events: [event(12, "pause"), event(20, "resume")],
      untilNs: ns(200),
    });
    expect(result.episodes.map((e) => e.closeReason)).toEqual(["paused", "gap"]);
  });

  it("closes an open episode when sleep arrives before its gap elapses", () => {
    const result = groupEpisodes({
      regions: [region("o1", MIC, 0, 10)],
      events: [event(20, "sleep")],
      untilNs: ns(25),
    });
    expect(result.episodes[0]).toMatchObject({ provisional: false, closeReason: "sleep" });
  });

  it("does not split on a capture restart", () => {
    const result = groupEpisodes({
      regions: [region("r1", MIC, 0, 10), region("r2", MIC, 30, 40)],
      events: [event(12, "capture-restart")],
      untilNs: ns(200),
    });
    expect(result.episodes.map(ids)).toEqual([["r1", "r2"]]);
    expect(result.episodes[0]?.discontinuities.map((e) => e.kind)).toEqual(["capture-restart"]);
  });
});

describe("3 h cap", () => {
  const capSeconds = Number(GROUPING_V4.capNs / 1_000_000_000n);

  it("splits a long in-person stretch at its longest gap", () => {
    const head = steady("h", MIC, 0, 5000, 30, 20);
    const tail = steady("t", MIC, 5040, 4 * 3600, 30, 20);
    const result = groupEpisodes({ regions: [...head, ...tail], untilNs: ns(4 * 3600 + 100) });
    expect(result.episodes).toHaveLength(2);
    const [first, second] = result.episodes;
    expect(first?.regionIds).toEqual(head.map((r) => r.id));
    expect(first?.closeReason).toBe("cap");
    expect(second?.regionIds).toEqual(tail.map((r) => r.id));
    expect(result.episodes.every((e) => e.endNs - e.startNs <= GROUPING_V4.capNs)).toBe(true);
  });

  it("cuts uniform speech as close to the cap as possible", () => {
    const regions = steady("u", MIC, 0, 4 * 3600, 30, 20);
    const result = groupEpisodes({ regions, untilNs: ns(4 * 3600 + 100) });
    expect(result.episodes).toHaveLength(2);
    const first = result.episodes[0];
    expect(first?.closeReason).toBe("cap");
    expect(Number((first?.endNs ?? 0n) / 1_000_000_000n)).toBeGreaterThan(capSeconds - 60);
  });

  it("splits a long call and keeps both parts in the call", () => {
    const regions = steady("lc", MIC, 10, 4 * 3600, 20, 15, { app: zoomMic });
    const result = groupEpisodes({ regions, calls: [call(0, "active")], untilNs: ns(4 * 3600) });
    expect(result.episodes.length).toBeGreaterThanOrEqual(2);
    expect(result.episodes.every((e) => e.context === "call")).toBe(true);
    expect(result.episodes[0]?.closeReason).toBe("cap");
    expect(result.episodes.at(-1)).toMatchObject({
      provisional: true,
      closesAtNs: (regions.at(-1)?.endNs ?? 0n) + GROUPING_V4.callSilenceGapNs,
    });
    expect(result.episodes.flatMap((e) => e.regionIds)).toEqual(regions.map((r) => r.id));
  });

  it("cuts contiguous regions at a region boundary when no silence exists", () => {
    // Segmenter max-duration cuts start the next region at the same sample.
    const regions = steady("c", MIC, 0, capSeconds + 60, 60, 60);
    const result = groupEpisodes({ regions, untilNs: ns(capSeconds + 200) });
    expect(result.episodes.map((e) => e.regionIds.length)).toEqual([180, 1]);
    expect(result.episodes[0]).toMatchObject({ closeReason: "cap", endNs: GROUPING_V4.capNs });
    expect(result.episodes.some((e) => e.exceedsCap)).toBe(false);
  });

  it("cuts overlapping call tracks at a region boundary when no silence exists", () => {
    const mic = steady("m", MIC, 0, capSeconds + 600, 60, 60, { app: zoomMic });
    const app = steady("a", ZOOM, 30, capSeconds + 600, 60, 60, { app: zoomApp });
    const regions = [...mic, ...app];
    const result = groupEpisodes({
      regions,
      calls: [call(0, "active")],
      untilNs: ns(capSeconds + 600),
    });
    expect(result.episodes.map((e) => e.closeReason)).toEqual(["cap", null]);
    expect(result.episodes.some((e) => e.exceedsCap)).toBe(false);
    expect(result.episodes.flatMap((e) => e.regionIds).toSorted()).toEqual(
      regions.map((r) => r.id).toSorted(),
    );
  });

  it("cuts an automatic merge of contiguous speech into cap-sized episodes", () => {
    const talk = steady("m", MIC, 0, 7200, 60, 60);
    const video = steady("v", SAFARI, 7200, 14_400, 60, 60, { app: safari });
    const result = groupEpisodes({
      regions: [...talk, ...video],
      constraints: [{ kind: "merge", startNs: 0n, endNs: ns(14_400), origin: "auto", seq: 1 }],
      untilNs: ns(15_000),
    });
    expect(result.episodes.map((e) => e.regionIds.length)).toEqual([180, 60]);
    expect(result.episodes.some((e) => e.exceedsCap)).toBe(false);
  });

  it("flags one region longer than the cap instead of cutting inside it", () => {
    const result = groupEpisodes({
      regions: [region("long", SYSTEM, 0, capSeconds + 10)],
      untilNs: ns(capSeconds + 500),
    });
    expect(result.episodes[0]).toMatchObject({ exceedsCap: true, regionIds: ["long"] });
  });
});

describe("constraints", () => {
  const regions = [
    region("a", MIC, 0, 10),
    region("b", MIC, 20, 30),
    region("c", MIC, 100, 110),
    region("v", SAFARI, 0, 40, { app: safari }),
  ];
  const untilNs = ns(1000);
  const split = (
    at: number,
    seq: number,
    origin: "auto" | "manual" = "manual",
    trackKeys?: readonly string[],
  ): BoundaryConstraint =>
    trackKeys === undefined
      ? { kind: "split", atNs: ns(at), origin, seq }
      : { kind: "split", atNs: ns(at), origin, seq, trackKeys };
  const merge = (
    start: number,
    end: number,
    seq: number,
    origin: "auto" | "manual" = "manual",
    trackKeys?: readonly string[],
  ): BoundaryConstraint =>
    trackKeys === undefined
      ? { kind: "merge", startNs: ns(start), endNs: ns(end), origin, seq }
      : { kind: "merge", startNs: ns(start), endNs: ns(end), origin, seq, trackKeys };

  it("applies a manual split only to episodes on the given tracks", () => {
    const result = groupEpisodes({
      regions,
      constraints: [split(15, 1, "manual", [MIC])],
      untilNs,
    });
    expect(result.episodes.map(ids)).toEqual([["a"], ["v"], ["b"], ["c"]]);
    expect(result.episodes[0]).toMatchObject({ closeReason: "manual-split", constraintSeqs: [1] });
  });

  it("cuts a region in two when a manual split falls inside it", () => {
    const long = region("long", MIC, 0, 60);
    const dup = region("dup", USB_MIC, 40, 50, { echo: { kind: "duplicate", ofTrackKey: MIC } });
    const result = groupEpisodes({ regions: [long, dup], constraints: [split(30, 1)], untilNs });
    expect(result.episodes).toMatchObject([
      {
        key: "long",
        regionIds: ["long"],
        regionSlices: [{ regionId: "long", startNs: ns(0), endNs: ns(30) }],
        startNs: ns(0),
        endNs: ns(30),
        voicedMs: 30_000,
        closeReason: "manual-split",
        constraintSeqs: [1],
        hiddenRegionIds: [],
      },
      {
        key: `long@${ns(30)}`,
        regionIds: ["long"],
        regionSlices: [{ regionId: "long", startNs: ns(30), endNs: ns(60) }],
        startNs: ns(30),
        endNs: ns(60),
        voicedMs: 30_000,
        constraintSeqs: [1],
        hiddenRegionIds: ["dup"],
      },
    ]);
  });

  it("splits at the requested instant, not at the nearest region midpoint", () => {
    const result = groupEpisodes({
      regions: [region("r1", MIC, 0, 60), region("r2", MIC, 60, 70)],
      constraints: [split(20, 1)],
      untilNs,
    });
    expect(result.episodes.map((e) => [e.startNs, e.endNs, ...e.regionIds])).toEqual([
      [ns(0), ns(20), "r1"],
      [ns(20), ns(70), "r1", "r2"],
    ]);
  });

  it("joins the slices of a region again when a later merge covers the split", () => {
    const result = groupEpisodes({
      regions: [region("long", MIC, 0, 60)],
      constraints: [split(30, 1), merge(0, 60, 2)],
      untilNs,
    });
    expect(result.episodes).toMatchObject([
      { key: "long", regionIds: ["long"], regionSlices: [], voicedMs: 60_000 },
    ]);
  });

  it("merges in-person episodes across a long pause", () => {
    const result = groupEpisodes({
      regions,
      constraints: [merge(0, 110, 1, "manual", [MIC])],
      untilNs,
    });
    expect(result.episodes.map(ids)).toEqual([["a", "b", "c"], ["v"]]);
    expect(result.episodes[0]?.context).toBe("in_person");
  });

  it("marks a merge of talk and media as mixed", () => {
    const result = groupEpisodes({ regions, constraints: [merge(0, 40, 1)], untilNs });
    expect(result.episodes.map((e) => [e.context, ...e.regionIds])).toEqual([
      ["mixed", "a", "v", "b"],
      ["in_person", "c"],
    ]);
  });

  it("lets a manual split win over an automatic merge", () => {
    const result = groupEpisodes({
      regions,
      constraints: [split(15, 1, "manual", [MIC]), merge(0, 110, 2, "auto", [MIC])],
      untilNs,
    });
    expect(result.episodes.filter((e) => e.context === "in_person").map(ids)).toEqual([
      ["a"],
      ["b", "c"],
    ]);
  });

  it("lets the latest manual assertion win between two manual ones", () => {
    const mergedLast = groupEpisodes({
      regions,
      constraints: [split(15, 1, "manual", [MIC]), merge(0, 30, 2, "manual", [MIC])],
      untilNs,
    });
    expect(mergedLast.episodes.filter((e) => e.context === "in_person").map(ids)).toEqual([
      ["a", "b"],
      ["c"],
    ]);
    const splitLast = groupEpisodes({
      regions,
      constraints: [merge(0, 30, 1, "manual", [MIC]), split(15, 2, "manual", [MIC])],
      untilNs,
    });
    expect(splitLast.episodes.filter((e) => e.context === "in_person").map(ids)).toEqual([
      ["a"],
      ["b"],
      ["c"],
    ]);
  });

  it("ignores a split outside every episode and a merge with one target", () => {
    const result = groupEpisodes({
      regions,
      constraints: [split(60, 1), merge(100, 105, 2)],
      untilNs,
    });
    expect(result.episodes.map(ids)).toEqual(groupEpisodes({ regions, untilNs }).episodes.map(ids));
  });

  it("caps an automatic merge but not a manual one", () => {
    const capSeconds = Number(GROUPING_V4.capNs / 1_000_000_000n);
    const far = [region("f1", MIC, 0, 10), region("f2", MIC, capSeconds + 100, capSeconds + 110)];
    const auto = groupEpisodes({
      regions: far,
      constraints: [merge(0, capSeconds + 110, 1, "auto")],
      untilNs: ns(capSeconds + 1000),
    });
    expect(auto.episodes.map(ids)).toEqual([["f1"], ["f2"]]);
    const manual = groupEpisodes({
      regions: far,
      constraints: [merge(0, capSeconds + 110, 1)],
      untilNs: ns(capSeconds + 1000),
    });
    expect(manual.episodes.map(ids)).toEqual([["f1", "f2"]]);
    expect(manual.episodes[0]?.exceedsCap).toBe(true);
  });

  it("keeps a merged episode open while one part is open", () => {
    const result = groupEpisodes({
      regions: [region("x", MIC, 0, 10), region("y", MIC, 100, 110)],
      constraints: [merge(0, 110, 1)],
      untilNs: ns(120),
    });
    expect(result.episodes[0]).toMatchObject({
      provisional: true,
      closeReason: null,
      closesAtNs: ns(155),
    });
  });
});

describe("episodes the user ended (ADR 044)", () => {
  const DISCORD = "app:com.hnc.Discord";
  const discord: AppContext = {
    bundleId: "com.hnc.Discord",
    isCallApp: false,
    callActive: false,
  };
  const discordCall = [call(0, "active", "com.hnc.Discord")];
  const end = (at: number, lane: string) => ({ atNs: ns(at), lane });
  const CALL = "call:com.hnc.Discord";

  it("closes a call that goes on, and opens another one for what is said next", () => {
    const regions = [
      region("me", MIC, 10, 20),
      region("them", DISCORD, 22, 30, { app: discord }),
      region("later", MIC, 45, 50),
    ];
    const ends = [end(40, CALL)];
    const before = groupEpisodes({
      regions: regions.slice(0, 2),
      calls: discordCall,
      ends,
      untilNs: ns(41),
    });
    expect(before.episodes).toHaveLength(1);
    expect(before.episodes[0]).toMatchObject({
      context: "call",
      provisional: false,
      closeReason: "manual-end",
    });
    const after = groupEpisodes({ regions, calls: discordCall, ends, untilNs: ns(60) });
    expect(after.episodes.map(ids)).toEqual([["me", "them"], ["later"]]);
    expect(after.episodes[0]).toEqual(before.episodes[0]);
    expect(after.episodes[1]).toMatchObject({ context: "call", provisional: true });
    expect(after.version).toBe("grouping/6");
  });

  it("makes no empty episode when nothing is said afterwards", () => {
    const { episodes } = groupEpisodes({
      regions: [region("a", MIC, 0, 5)],
      ends: [end(8, "in_person")],
      untilNs: ns(600),
    });
    expect(episodes.map((episode) => [episode.key, episode.closeReason])).toEqual([
      ["a", "manual-end"],
    ]);
  });

  it("cuts a region said across the end, the same as it goes on", () => {
    const ends = [end(40, "in_person")];
    const at = (until: number) =>
      groupEpisodes({
        regions: [region("a", MIC, 0, 5), region("b", MIC, 30, until)],
        ends,
        untilNs: ns(until),
      }).episodes;
    // Exactly at the end there is nothing after it yet.
    expect(at(40).map(ids)).toEqual([["a", "b"]]);
    for (const until of [41, 50, 400]) {
      const [head, tail] = at(until);
      expect(ids(head)).toEqual(["a", "b"]);
      expect(head).toMatchObject({ endNs: ns(40), closeReason: "manual-end", voicedMs: 15_000 });
      expect(head?.regionSlices).toEqual([{ regionId: "b", startNs: ns(30), endNs: ns(40) }]);
      expect(tail).toMatchObject({ key: `b@${ns(40)}`, startNs: ns(40), context: "in_person" });
    }
  });

  it("keeps media, a dictation and another call going on", () => {
    const { episodes } = groupEpisodes({
      regions: [
        region("me", MIC, 0, 60),
        region("them", DISCORD, 0, 60, { app: discord }),
        region("video", SAFARI, 0, 60, { app: safari }),
        region("zoom", ZOOM, 0, 60, { app: { ...zoomApp, isCallApp: false, callActive: false } }),
        region("hex", USB_MIC, 35, 60),
      ],
      calls: [...discordCall, call(0, "active")],
      dictations: [{ bundleId: "com.kitlangton.Hex", startNs: ns(34), endNs: null }],
      ends: [end(40, CALL)],
      untilNs: ns(60),
    });
    const byContext = (id: string) => episodes.filter((episode) => ids(episode).includes(id));
    expect(byContext("video")).toHaveLength(1);
    expect(byContext("zoom")).toHaveLength(1);
    expect(byContext("hex")).toHaveLength(1);
    expect(byContext("them")).toHaveLength(2);
    expect(byContext("me")).toHaveLength(2);
  });

  it("keeps two episodes when the call comes back within 45 s", () => {
    const { episodes } = groupEpisodes({
      regions: [region("a", MIC, 10, 20), region("b", MIC, 40, 50)],
      calls: [
        ...discordCall,
        call(25, "ended", "com.hnc.Discord"),
        call(35, "active", "com.hnc.Discord"),
      ],
      ends: [end(22, CALL)],
      untilNs: ns(60),
    });
    expect(episodes.map(ids)).toEqual([["a"], ["b"]]);
    expect(episodes.map((episode) => episode.context)).toEqual(["call", "call"]);
  });

  it("puts a region learned late on its side of the end, whatever the order", () => {
    const late = region("late", MIC, 32, 36);
    const regions = [region("a", MIC, 10, 20), region("b", MIC, 45, 50), late];
    const ends = [end(40, CALL)];
    const { episodes } = groupEpisodes({ regions, calls: discordCall, ends, untilNs: ns(60) });
    expect(episodes.map(ids)).toEqual([["a", "late"], ["b"]]);
    expect(
      groupEpisodes({
        regions: regions.toReversed(),
        calls: discordCall,
        ends: ends.toReversed(),
        untilNs: ns(60),
      }).episodes,
    ).toEqual(episodes);
  });

  it("cuts a region whose middle falls in the ended call though its start did not", () => {
    // Said from before the call; as it goes on, its middle is in the call.
    const { episodes } = groupEpisodes({
      regions: [region("them", DISCORD, 31, 35, { app: discord }), region("me", MIC, 10, 100)],
      calls: [call(30, "active", "com.hnc.Discord")],
      ends: [end(40, CALL)],
      untilNs: ns(100),
    });
    expect(episodes.map((episode) => [ids(episode), episode.context])).toEqual([
      [["me"], "in_person"],
      [["them"], "call"],
      [["me"], "call"],
    ]);
    expect(episodes[2]).toMatchObject({ startNs: ns(40) });
  });

  it("ends twice within one sentence", () => {
    const { episodes } = groupEpisodes({
      regions: [region("a", MIC, 0, 60)],
      ends: [end(20, "in_person"), end(40, "in_person")],
      untilNs: ns(60),
    });
    expect(
      episodes.map((episode) => [episode.startNs, episode.endNs, episode.closeReason]),
    ).toEqual([
      [ns(0), ns(20), "manual-end"],
      [ns(20), ns(40), "manual-end"],
      [ns(40), ns(60), null],
    ]);
  });

  it("ignores an end still to come", () => {
    const regions = [region("a", MIC, 0, 5)];
    const untilNs = ns(8);
    expect(groupEpisodes({ regions, untilNs, ends: [end(9, "in_person")] })).toEqual(
      groupEpisodes({ regions, untilNs }),
    );
  });
});

describe("determinism and stability", () => {
  const scenario: GroupingInput = {
    regions: [
      region("p1", MIC, 60, 70),
      ...steady("zm", MIC, 105, 400, 20, 8, { app: zoomMic }),
      ...steady("za", ZOOM, 112, 400, 20, 6, { app: zoomApp }),
      ...steady("yt", SAFARI, 300, 900, 15, 12, { app: safari }),
      region("e1", MIC, 330.2, 342.2, { echo: { kind: "echo", ofTrackKey: SAFARI } }),
      region("q1", MIC, 1010, 1020),
      region("q2", MIC, 1040, 1050),
      region("r1", MIC, 1200, 1210),
    ],
    calls: [call(100, "active"), call(500, "ended")],
    events: [event(1100, "sleep"), event(1150, "wake"), event(1205, "device-change", MIC)],
    untilNs: ns(1400),
  };

  it("does not depend on input order", () => {
    const shuffled: GroupingInput = {
      ...scenario,
      regions: scenario.regions.toReversed(),
      calls: (scenario.calls ?? []).toReversed(),
      events: (scenario.events ?? []).toReversed(),
    };
    expect(groupEpisodes(shuffled)).toEqual(groupEpisodes(scenario));
  });

  /** Replays `input` as if grouping ran at each cut, with open regions clipped. */
  function expectPrefixStable(input: GroupingInput, cuts: readonly number[]): number {
    const full = groupEpisodes(input);
    const fullByKey = new Map(full.episodes.map((e) => [e.key, e]));
    let compared = 0;
    for (const cut of cuts) {
      const untilNs = ns(cut);
      const prefix = groupEpisodes({
        regions: input.regions
          .filter((r) => r.startNs <= untilNs)
          .map((r) => (r.endNs > untilNs ? { ...r, endNs: untilNs } : r)),
        calls: (input.calls ?? []).filter((c) => c.atNs <= untilNs),
        events: (input.events ?? []).filter((e) => e.atNs <= untilNs),
        untilNs,
      });
      for (const episode of prefix.episodes.filter((e) => !e.provisional)) {
        const later = fullByKey.get(episode.key);
        expect(later?.regionIds, `cut at ${cut} s, episode ${episode.key}`).toEqual(
          episode.regionIds,
        );
        expect(later?.closeReason, `cut at ${cut} s, episode ${episode.key}`).toBe(
          episode.closeReason,
        );
        expect(later?.context).toBe(episode.context);
        compared += 1;
      }
    }
    return compared;
  }

  it("never changes an episode once it is closed (prefix stability)", () => {
    const cuts = Array.from({ length: 201 }, (_, i) => i * 7);
    expect(expectPrefixStable(scenario, cuts)).toBeGreaterThan(100);
  });

  it("keeps cap cuts stable as a long stretch grows", () => {
    const input: GroupingInput = {
      regions: [...steady("h", MIC, 0, 5000, 30, 20), ...steady("t", MIC, 5040, 4 * 3600, 30, 20)],
      untilNs: ns(4 * 3600 + 100),
    };
    const cuts = Array.from({ length: 50 }, (_, i) => i * 300);
    expect(expectPrefixStable(input, cuts)).toBeGreaterThan(5);
  });

  it("assigns every region exactly once", () => {
    const result = groupEpisodes(scenario);
    const seen = [
      ...result.episodes.flatMap((e) => [...e.regionIds, ...e.hiddenRegionIds]),
      ...result.unassigned.map((u) => u.regionId),
    ];
    expect(seen.toSorted()).toEqual(scenario.regions.map((r) => r.id).toSorted());
  });
});

describe("input validation", () => {
  it("rejects malformed input", () => {
    expect(() => groupEpisodes({ regions: [region("a", MIC, 10, 5)], untilNs: ns(100) })).toThrow(
      GroupingInputError,
    );
    expect(() =>
      groupEpisodes({
        regions: [region("a", MIC, 0, 5), region("a", MIC, 6, 7)],
        untilNs: ns(100),
      }),
    ).toThrow(/duplicate/u);
    expect(() => groupEpisodes({ regions: [region("a", MIC, 0, 500)], untilNs: ns(100) })).toThrow(
      /untilNs/u,
    );
    expect(() =>
      groupEpisodes({
        regions: [region("a", MIC, 0, 5, { voicedMs: Number.NaN })],
        untilNs: ns(100),
      }),
    ).toThrow(/voicedMs/u);
    expect(() =>
      groupEpisodes({ regions: [], calls: [call(200, "active")], untilNs: ns(100) }),
    ).toThrow(GroupingInputError);
    expect(() =>
      groupEpisodes({
        regions: [],
        constraints: [{ kind: "merge", startNs: ns(10), endNs: ns(5), origin: "manual", seq: 1 }],
        untilNs: ns(100),
      }),
    ).toThrow(GroupingInputError);
  });

  it("returns no episodes for no speech", () => {
    expect(groupEpisodes({ regions: [], untilNs: 0n })).toEqual({
      version: GROUPING_VERSION,
      episodes: [],
      unassigned: [],
    });
  });
});
