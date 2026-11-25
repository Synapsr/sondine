import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordCallActive, recordSpanEnded } from "./calls";
import { closeSpeechRegion, openSpeechRegion, upsertApp, upsertTrackRun } from "./capture-import";
import {
  loadEpisodeApps,
  loadRunSpeakers,
  loadSelfSpeakers,
  type EpisodeAppsInput,
} from "./episode-sources";
import { getEpisodeDetail } from "./episodes-store";
import { publishAnalysis } from "./publish";
import {
  at,
  seedEpisode,
  seedTrackRun,
  segment,
  startRun,
  t0,
  tempDatabase,
  turn,
  type TempDatabase,
} from "./test-helpers";

let temp: TempDatabase;
beforeEach(() => {
  temp = tempDatabase();
});
afterEach(() => temp.cleanup());

const MIC = "input:BuiltInMicrophoneDevice";
const SYSTEM = "system:other";

function systemRun(): number {
  return upsertTrackRun(temp.db, {
    uid: `system-${Math.random()}`,
    trackKey: SYSTEM,
    sourceKind: "system",
    startedWallMs: t0,
    nowMs: t0,
  }).trackRunId;
}

/** A closed region of a run joined to an episode. */
function addRegion(
  episodeId: number,
  trackRunId: number,
  start: number,
  end: number,
  attributedAppId: number | null = null,
): void {
  const opened = openSpeechRegion(temp.db, {
    trackRunId,
    sampleStart: at(start),
    wallStartMs: t0 + start * 1000,
    vadVersion: "test",
    attributedAppId,
  });
  closeSpeechRegion(temp.db, {
    trackRunId,
    sampleStart: at(start),
    sampleEnd: at(end),
    wallEndMs: t0 + end * 1000,
    endReason: "silence",
  });
  temp.db.client
    .prepare(
      `INSERT INTO episode_regions (episode_id, speech_region_id, grouping_version, slice_sample_start)
       VALUES (?, ?, 'grouping/2', ?)`,
    )
    .run(episodeId, opened.speechRegionId, at(start));
}

const setContext = (episodeId: number, context: string) =>
  temp.db.client.prepare("UPDATE episodes SET context = ? WHERE id = ?").run(context, episodeId);

function call(uid: string, bundleId: string, from: number, to: number | null): void {
  recordCallActive(temp.db, {
    uid,
    sessionId: "s",
    bundleId,
    via: "call_app",
    inputDeviceUid: null,
    at: { wallMs: t0 + from * 1000, continuousUs: from * 1_000_000 },
    nowMs: t0,
  });
  if (to !== null) {
    recordSpanEnded(temp.db, "calls", {
      uid,
      at: { wallMs: t0 + to * 1000, continuousUs: to * 1_000_000 },
      nowMs: t0,
    });
  }
}

describe("episode apps", () => {
  it("names the call app first, then attributed apps by voiced time; none in person", () => {
    upsertApp(temp.db, { bundleId: "us.zoom.xos", name: "zoom.us", seenAtMs: t0 });
    const music = upsertApp(temp.db, { bundleId: "com.apple.Music", seenAtMs: t0 }).appId;
    const callEpisode = seedEpisode(temp.db, [[10, 20]]);
    setContext(callEpisode.episodeId, "call");
    const system = systemRun();
    addRegion(callEpisode.episodeId, system, 21, 30);
    call("c1", "us.zoom.xos", 5, 100);
    call("c2", "com.example.Other", 300, 400); // outside the episode

    const media = seedEpisode(temp.db, [[500, 501]]);
    setContext(media.episodeId, "media");
    addRegion(media.episodeId, system, 510, 540, music);

    const inPerson = seedEpisode(temp.db, [[60, 70]]);
    setContext(inPerson.episodeId, "in_person");

    const episodes: EpisodeAppsInput[] = [
      {
        id: callEpisode.episodeId,
        context: "call",
        startedAtMs: t0 + 10_000,
        endedAtMs: t0 + 30_000,
      },
      { id: media.episodeId, context: "media", startedAtMs: t0 + 500_000, endedAtMs: t0 + 540_000 },
      {
        id: inPerson.episodeId,
        context: "in_person",
        startedAtMs: t0 + 60_000,
        endedAtMs: t0 + 70_000,
      },
    ];
    const apps = loadEpisodeApps(temp.db, episodes, t0 + 1_000_000);
    expect(apps.get(callEpisode.episodeId)).toEqual([{ bundleId: "us.zoom.xos", name: "zoom.us" }]);
    // No name stored: the bundle ID stands in.
    expect(apps.get(media.episodeId)).toEqual([
      { bundleId: "com.apple.Music", name: "com.apple.Music" },
    ]);
    expect(apps.get(inPerson.episodeId)).toBeUndefined();
  });
});

describe("speakers and self", () => {
  function publishCall() {
    const mic = seedTrackRun(temp.db);
    const episode = seedEpisode(temp.db, [[0, 60]], mic);
    setContext(episode.episodeId, "call");
    const system = systemRun();
    addRegion(episode.episodeId, system, 0, 60);
    const runId = startRun(temp.db, episode.episodeId, "asr");
    const result = publishAnalysis(temp.db, {
      episodeId: episode.episodeId,
      stage: "asr",
      runId,
      inputGeneration: 1,
      segments: [
        segment(system, 0, 30, "far side", `${SYSTEM}/0/0`),
        segment(mic, 1, 21, "me", `${MIC}/0/0`),
        segment(mic, 22, 30, "far side again, through the speakers", `${MIC}/0/1`),
      ],
      turns: [
        turn(system, 0, 30, `${SYSTEM}/0/0`),
        turn(mic, 1, 21, `${MIC}/0/0`),
        turn(mic, 22, 30, `${MIC}/0/1`),
      ],
    });
    expect(result.published).toBe(true);
    return { episodeId: episode.episodeId, runId };
  }

  it("gives each speaker the kind of track it was heard on", () => {
    const { runId } = publishCall();
    expect(loadRunSpeakers(temp.db, runId).map((s) => [s.label, s.trackKind])).toEqual([
      [`${SYSTEM}/0/0`, "system"],
      [`${MIC}/0/0`, "input"],
      [`${MIC}/0/1`, "input"],
    ]);
  });

  it("finds the user's voice in a call only, and exposes it in the detail", () => {
    const { episodeId } = publishCall();
    expect(loadSelfSpeakers(temp.db, [episodeId])).toEqual(
      new Map([[episodeId, { label: `${MIC}/0/0`, ordinal: 2 }]]),
    );
    expect(getEpisodeDetail(temp.db, episodeId)?.speakers.map((s) => s.trackKind)).toEqual([
      "system",
      "input",
      "input",
    ]);
    setContext(episodeId, "in_person");
    expect(loadSelfSpeakers(temp.db, [episodeId])).toEqual(new Map());
  });
});
